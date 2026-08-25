import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import simpleGit, { SimpleGit } from 'simple-git';
import type { API as GitAPI, GitExtension, Repository as VscodeGitRepo, Change } from './api/git';
import { Status } from './api/gitStatus';
import { describePatchDefect, parseUnifiedDiff } from './hunks';
import { ChangeKind, GitFileChange, RepoRelativePath, ShelvedFile } from './types';

/** One file's contribution to a scoped commit. `partialPatch` is set only when the
 *  changelist owns a subset of the file's hunks; otherwise the whole file is staged. */
export interface ScopedCommitFile {
  readonly filePath: RepoRelativePath;
  /** The pre-rename path, when this file is a rename. Staged alongside `filePath` so the
   *  commit records the old path's removal instead of leaving a duplicate behind. */
  readonly renamedFrom?: RepoRelativePath;
  readonly partialPatch?: string;
}

/** Config forced onto every git invocation this extension makes, via `-c`.
 *
 *  `diff.noprefix` and `diff.mnemonicPrefix` are the load-bearing pair. Both change the
 *  `a/`…`b/` prefixes in a diff header, and `git apply` defaults to `-p1` — so a user who
 *  sets either one turns every patch we generate into one git itself refuses to read
 *  ("git diff header lacks filename information when removing 1 leading pathname
 *  component"). That breaks unshelve and hunk-scoped commits: the two paths where a
 *  generated patch is the only copy of the user's work.
 *
 *  `color.ui` is belt-and-braces alongside the explicit `--no-color` below: `color.ui =
 *  always` puts ANSI escapes into piped output, which no amount of parsing recovers from.
 *
 *  Pinned here rather than at each call site so there is exactly one place to audit, and
 *  so a diff and the `apply` that reverses it can never disagree about prefixes. */
const PINNED_GIT_CONFIG = ['diff.noprefix=false', 'diff.mnemonicPrefix=false', 'color.ui=false'];

/** Reads live status via the built-in vscode.git extension's API (source of truth for
 *  "what's modified" — PRD §7.3), and performs staging/commit via the git CLI (simple-git)
 *  because vscode.git's own API does not expose pathspec-scoped commit. This is the only
 *  place in the extension that shells out to git; everything else in the codebase talks
 *  to a GitRepository instance, never to `child_process` or `simple-git` directly. */
export class GitRepository {
  private readonly git: SimpleGit;

  constructor(private readonly repo: VscodeGitRepo) {
    this.git = simpleGit({ baseDir: repo.rootUri.fsPath, config: PINNED_GIT_CONFIG });
  }

  get rootUri(): vscode.Uri {
    return this.repo.rootUri;
  }

  get onDidChangeState(): vscode.Event<void> {
    return this.repo.state.onDidChange;
  }

  get branchName(): string | undefined {
    return this.repo.state.HEAD?.name;
  }

  toRepoRelative(uri: vscode.Uri): RepoRelativePath {
    const rel = path.relative(this.repo.rootUri.fsPath, uri.fsPath);
    return rel.split(path.sep).join('/');
  }

  toAbsoluteUri(relPath: RepoRelativePath): vscode.Uri {
    return vscode.Uri.joinPath(this.repo.rootUri, relPath);
  }

  /** Snapshot of every currently-modified/staged/untracked file, deduplicated by path.
   *  A file present in both the index and the working tree (partially staged) is
   *  reported once, `staged: true`, with the `kind` reflecting the working-tree diff —
   *  that's the state the user would actually see change on their next edit. */
  getFileChanges(): GitFileChange[] {
    const state = this.repo.state;
    const stagedPaths = new Set<string>();
    for (const change of state.indexChanges) {
      stagedPaths.add(this.toRepoRelative(change.uri));
    }

    // A rename is recorded in the index; editing the file afterwards adds a plain
    // modification of the *new* path to the working tree, which the overlay below would
    // otherwise let win — dropping the rename linkage entirely. That linkage is what
    // reconcile() uses to carry the changelist across, what commitScoped() uses to stage
    // the old path's removal, and what discardChanges() needs to restore it, so remember
    // it here and re-attach it when the working-tree pass overwrites the index entry.
    const renamedFromByPath = new Map<RepoRelativePath, RepoRelativePath>();
    for (const change of state.indexChanges) {
      if (statusToChangeKind(change.status) !== 'renamed' || !change.originalUri) {
        continue;
      }
      const to = this.toRepoRelative(change.uri);
      const from = this.toRepoRelative(change.originalUri);
      if (from !== to) {
        renamedFromByPath.set(to, from);
      }
    }

    const byPath = new Map<string, GitFileChange>();
    const record = (change: Change, filePath: string, staged: boolean): void => {
      const entry = this.toGitFileChange(change, filePath, staged, renamedFromByPath.get(filePath));
      if (entry) {
        byPath.set(filePath, entry);
      } else {
        // statusToChangeKind() returned undefined (Status.IGNORED) — not a change kind
        // we surface at all, so make sure a stale entry from an earlier pass (e.g. this
        // path showed up in indexChanges before becoming ignored) doesn't linger.
        byPath.delete(filePath);
      }
    };

    // Index-only changes first (files staged but with no further working-tree edits).
    for (const change of state.indexChanges) {
      record(change, this.toRepoRelative(change.uri), true);
    }
    // Working-tree changes overlay/override — this is the "current" state for a file
    // that's been edited again after being staged.
    for (const change of state.workingTreeChanges) {
      const filePath = this.toRepoRelative(change.uri);
      record(change, filePath, stagedPaths.has(filePath));
    }
    // Some vscode.git versions surface untracked files separately rather than inside
    // workingTreeChanges with Status.UNTRACKED; cover both shapes defensively.
    for (const change of state.untrackedChanges ?? []) {
      const filePath = this.toRepoRelative(change.uri);
      if (!byPath.has(filePath)) {
        record(change, filePath, false);
      }
    }

    return [...byPath.values()];
  }

  private toGitFileChange(
    change: Change,
    filePath: RepoRelativePath,
    staged: boolean,
    indexRenamedFrom?: RepoRelativePath
  ): GitFileChange | undefined {
    const rawKind = statusToChangeKind(change.status);
    if (!rawKind) {
      return undefined;
    }
    // Only a working-tree *modification* is re-labelled: that's the rename-then-edit case
    // (git's own `RM` status), where the file really is still a rename and every consumer
    // — status letter, commit pathspec, discard, shelve — wants to treat it as one.
    // Any other working-tree status over a renamed path is left exactly as reported.
    const kind = rawKind === 'modified' && indexRenamedFrom ? 'renamed' : rawKind;
    if (kind !== 'renamed') {
      return { filePath, kind, staged };
    }
    const from = (change.originalUri ? this.toRepoRelative(change.originalUri) : undefined) ?? indexRenamedFrom;
    return { filePath, kind, renamedFrom: from === filePath ? undefined : from, staged };
  }

  /** Paths currently staged in the index that are NOT in `excluding` — used to warn the
   *  user before a scoped commit might leave unrelated staged content sitting around
   *  (PRD §12 open question: warn and ask, never silently override). */
  getOtherStagedPaths(excluding: ReadonlySet<RepoRelativePath>): RepoRelativePath[] {
    return this.repo.state.indexChanges
      .map((c) => this.toRepoRelative(c.uri))
      .filter((p) => !excluding.has(p));
  }

  async getHeadCommitMessage(): Promise<string | undefined> {
    try {
      const log = await this.git.log({ maxCount: 1 });
      return log.latest?.message;
    } catch {
      return undefined;
    }
  }

  /** Stages exactly `paths` (covers modified/deleted/untracked/renamed-pair paths) and
   *  commits only their content — other staged or unstaged files are left exactly as
   *  they were. Mirrors the two-step form documented in the PRD appendix:
   *    git add -- <paths>
   *    git commit -m "<message>" -- <paths>
   *  `git add` is used first (rather than relying on `git commit -- <paths>` alone) so
   *  untracked and deleted paths are picked up uniformly — plain pathspec-scoped commit
   *  only reliably covers already-tracked, modified content.
   *  `amend` is best-effort: combining --amend with a pathspec replaces only the listed
   *  paths' content in the previous commit's tree, which is correct for "add these files
   *  to my last commit" but is *not* a general-purpose commit editor — surface this
   *  caveat in the UI (commitChangelist command) rather than hiding it here. */
  async commitScoped(paths: RepoRelativePath[], message: string, options: { amend?: boolean } = {}): Promise<void> {
    if (paths.length === 0) {
      throw new Error('Cannot commit an empty changelist.');
    }
    await this.git.raw(['add', '--', ...paths]);
    const args = ['commit', '-m', message];
    if (options.amend) {
      args.splice(1, 0, '--amend');
    }
    args.push('--', ...paths);
    await this.git.raw(args);
  }

  /** The single place a diff against HEAD is produced. `-U3` and `--no-color` are
   *  explicit rather than inherited so a user's `diff.context`/`color.ui` config can't
   *  change the shape of what we parse into hunks, and `--no-ext-diff` keeps a configured
   *  external difftool from replacing the machine-readable output entirely; the prefix
   *  settings that `git apply` depends on are pinned instance-wide (PINNED_GIT_CONFIG).
   *
   *  `binary: true` is for captures that have to be *restored* later — without it git
   *  reports "Binary files a/x and b/x differ", which records that a file changed but not
   *  how. Hunk parsing never needs it (a binary file has no hunks to split either way),
   *  so it stays opt-in rather than costing every diff the encoded blob. */
  private diffAgainstHead(filePath: RepoRelativePath, options: { binary?: boolean } = {}): Promise<string> {
    const args = ['diff', '--no-color', '--no-ext-diff', '-U3'];
    if (options.binary) {
      args.push('--binary');
    }
    args.push('HEAD', '--', filePath);
    return this.git.raw(args);
  }

  /** Unified diff of one file against HEAD, for hunk parsing. */
  async getFileDiff(filePath: RepoRelativePath): Promise<string> {
    return this.diffAgainstHead(filePath);
  }

  /** Builds the hunkId index the manager needs for split rendering/reconciliation.
   *  Only `modified` files can be split: added/untracked files have no HEAD blob to
   *  diff against, and deleted/renamed files have no meaningful partial state — the UI
   *  refuses to split those, so there's no point paying for their diffs here. */
  async buildHunkIndex(entries: readonly GitFileChange[]): Promise<Map<RepoRelativePath, string[]>> {
    const index = new Map<RepoRelativePath, string[]>();
    const splittable = entries.filter((e) => e.kind === 'modified');
    await Promise.all(
      splittable.map(async (entry) => {
        try {
          const parsed = parseUnifiedDiff(await this.getFileDiff(entry.filePath));
          if (parsed) {
            index.set(entry.filePath, parsed.hunks.map((h) => h.id));
          }
        } catch {
          // A file we can't diff simply isn't splittable; it still renders whole.
        }
      })
    );
    return index;
  }

  /** Commits a changelist whose files include at least one *partially* selected file.
   *
   *  A pathspec commit can't express "only these hunks of this file", so this builds the
   *  commit through the index instead: reset the index to HEAD, stage exactly what the
   *  changelist owns (whole files via `add`, partial files via `apply --cached`), then
   *  commit with no pathspec so the commit is precisely the index we just constructed.
   *
   *  The cost is that any *unrelated* staging the user had is cleared — the index is a
   *  single global slot and there's no way to build a different tree without disturbing
   *  it. No content is lost (working-tree files are never touched here, and `--cached`
   *  keeps the partial application index-only), but the user's staging bookkeeping is
   *  reset, so commitChangelistCommand warns before taking this path. On failure the
   *  original index is restored from the tree snapshot taken up front. */
  async commitScopedWithHunks(
    files: readonly ScopedCommitFile[],
    message: string,
    options: { amend?: boolean } = {}
  ): Promise<void> {
    if (files.length === 0) {
      throw new Error('Cannot commit an empty changelist.');
    }
    const savedIndexTree = (await this.git.raw(['write-tree'])).trim();
    let committed = false;
    try {
      await this.git.raw(['read-tree', 'HEAD']);
      for (const file of files) {
        if (file.partialPatch) {
          await this.applyPatchToIndex(file.partialPatch);
        } else {
          await this.git.raw(['add', '--', file.filePath]);
        }
        if (file.renamedFrom) {
          // `read-tree HEAD` put the old path back in the index, and nothing above stages
          // its removal — a pathspec commit gets this for free, this path does not. Left
          // out, the commit adds the new file and keeps the old one, so the "rename" lands
          // as a copy. `--ignore-unmatch` keeps this harmless if HEAD never had the path.
          await this.git.raw(['rm', '--cached', '--force', '--ignore-unmatch', '--', file.renamedFrom]);
        }
      }
      const args = ['commit', '-m', message];
      if (options.amend) {
        args.splice(1, 0, '--amend');
      }
      await this.git.raw(args);
      committed = true;
    } finally {
      if (!committed) {
        // Roll the index back to exactly what the user had before we touched it.
        await this.git.raw(['read-tree', savedIndexTree]).catch(() => undefined);
      }
    }
  }

  private async applyPatchToIndex(patch: string): Promise<void> {
    const tmpFile = path.join(os.tmpdir(), `changelists-${randomUUID()}.patch`);
    await fs.writeFile(tmpFile, patch, 'utf8');
    try {
      await this.git.raw(['apply', '--cached', '--whitespace=nowarn', tmpFile]);
    } finally {
      await fs.rm(tmpFile, { force: true });
    }
  }

  /** WebStorm-style shelve: snapshots each file as either a unified diff against HEAD
   *  (tracked content — modified/deleted) or raw content (no HEAD blob — added/
   *  untracked, and the new-path side of a rename), then reverts the working tree for
   *  those paths. Deliberately does not touch `git stash` at all — see ShelvedFile's
   *  doc comment in types.ts for why.
   *
   *  Capture happens for *every* entry before anything is reverted, so a failure
   *  partway through capture leaves the working tree completely untouched — the caller
   *  (shelveChangelistCommand) only commits the changelist to "shelved" after this
   *  entire call resolves, so an error here never leaves the changelist's own state
   *  out of sync with the working tree. */
  async shelvePaths(entries: readonly GitFileChange[]): Promise<ShelvedFile[]> {
    if (entries.length === 0) {
      throw new Error('Cannot shelve an empty changelist.');
    }

    const captured: ShelvedFile[] = [];
    for (const entry of entries) {
      if (entry.kind === 'modified' || entry.kind === 'deleted') {
        const patch = await this.diffAgainstHead(entry.filePath, { binary: true });
        // Verified before anything is reverted, because the revert below is what makes
        // this patch the only remaining copy of the change. Capturing an unappliable
        // patch and reverting anyway is how "shelve" turns into "silently discard".
        const defect = describePatchDefect(patch);
        if (defect) {
          throw new Error(
            `Cannot shelve "${entry.filePath}": ${defect}, so unshelving could not restore it. ` +
              'Nothing has been changed in your working tree.'
          );
        }
        captured.push({ filePath: entry.filePath, kind: entry.kind, storage: 'patch', patch });
      } else {
        // added / untracked / renamed: no HEAD blob to diff against (a rename's new
        // path is, from HEAD's perspective, indistinguishable from a brand-new file),
        // so capture the working-tree bytes directly.
        const bytes = await vscode.workspace.fs.readFile(this.toAbsoluteUri(entry.filePath));
        captured.push({
          filePath: entry.filePath,
          kind: entry.kind,
          storage: 'content',
          content: Buffer.from(bytes).toString('base64'),
          renamedFrom: entry.renamedFrom,
        });
      }
    }

    for (const entry of entries) {
      if (entry.kind === 'modified' || entry.kind === 'deleted') {
        await this.git.raw(['checkout', 'HEAD', '--', entry.filePath]);
      } else {
        await vscode.workspace.fs.delete(this.toAbsoluteUri(entry.filePath), { useTrash: false });
        if (entry.kind === 'renamed' && entry.renamedFrom) {
          // Bring the pre-rename path back so the working tree returns to exactly its
          // pre-shelve shape. Known limitation: if the user edited renamedFrom again
          // before shelving (nonsensical since it no longer existed, but the API can't
          // prevent it) or edits it between shelve and unshelve, that content is not
          // preserved — unshelvePaths() deletes it again unconditionally.
          await this.git.raw(['checkout', 'HEAD', '--', entry.renamedFrom]);
        }
      }
    }

    return captured;
  }

  /** Reverses shelvePaths(): applies each patch via `git apply`, writes each raw
   *  content snapshot back to disk, and — for a shelved rename — removes the
   *  pre-rename path again so the rename re-takes effect. */
  async unshelvePaths(files: readonly ShelvedFile[]): Promise<void> {
    for (const file of files) {
      if (file.storage === 'patch') {
        if (file.patch.trim().length === 0) {
          continue; // nothing was actually different from HEAD when this was captured
        }
        const tmpFile = path.join(os.tmpdir(), `changelists-${randomUUID()}.patch`);
        await fs.writeFile(tmpFile, file.patch, 'utf8');
        try {
          await this.git.raw(['apply', '--whitespace=nowarn', tmpFile]);
        } finally {
          await fs.rm(tmpFile, { force: true });
        }
      } else {
        const uri = this.toAbsoluteUri(file.filePath);
        await vscode.workspace.fs.writeFile(uri, Buffer.from(file.content, 'base64'));
        if (file.kind === 'renamed' && file.renamedFrom) {
          await vscode.workspace.fs.delete(this.toAbsoluteUri(file.renamedFrom), { useTrash: false });
        }
      }
    }
  }

  /** Reverts `filePath` to HEAD (modified/deleted files) or removes it (untracked/added,
   *  and the new-path side of a rename). Implemented directly rather than via the git
   *  extension's internal `git.clean` command, whose signature expects an SCM `Resource`
   *  object minted by the git extension itself and isn't a supported cross-extension
   *  surface.
   *
   *  Branching is on "does HEAD have a blob at this path" rather than on `kind`, because
   *  that is the only question `git checkout HEAD -- <path>` actually cares about — it
   *  fails with "pathspec did not match any file(s) known to git" for anything HEAD has
   *  never seen, which covers renames (the new path) and staged additions alike. */
  async discardChanges(entry: GitFileChange): Promise<void> {
    if (entry.renamedFrom) {
      // Undo a rename the way git models one: drop the new path, restore the original.
      // Doing it in the other order would leave both paths present.
      await this.removeUntracked(entry.filePath);
      await this.git.raw(['checkout', 'HEAD', '--', entry.renamedFrom]);
      return;
    }
    if (entry.kind === 'untracked' || entry.kind === 'added') {
      await this.removeUntracked(entry.filePath);
      return;
    }
    await this.git.raw(['checkout', 'HEAD', '--', entry.filePath]);
  }

  /** Removes a path HEAD has no blob for: clears any index entry (a staged addition or
   *  the new half of a rename has one; a plain untracked file doesn't, hence
   *  `--ignore-unmatch`), then sends the file to the OS trash so it stays recoverable —
   *  the confirmation only promises it can't be undone *from within Changelists*. */
  private async removeUntracked(filePath: RepoRelativePath): Promise<void> {
    await this.git.raw(['rm', '--cached', '--force', '--ignore-unmatch', '--', filePath]);
    try {
      await vscode.workspace.fs.delete(this.toAbsoluteUri(filePath), { useTrash: true });
    } catch (err) {
      // Already gone from disk — the index entry was the only thing left to clean up.
      if (!(err instanceof vscode.FileSystemError && err.code === 'FileNotFound')) {
        throw err;
      }
    }
  }

  async openDiff(filePath: RepoRelativePath): Promise<void> {
    // Delegate to the built-in Git extension's own diff command so the diff view is
    // pixel-identical to the one the Source Control panel opens — we don't attempt to
    // reconstruct its `git:` content-provider URI scheme ourselves.
    await vscode.commands.executeCommand('git.openChange', this.toAbsoluteUri(filePath));
  }

  async openFile(filePath: RepoRelativePath): Promise<void> {
    await vscode.commands.executeCommand('vscode.open', this.toAbsoluteUri(filePath));
  }
}

function statusToChangeKind(status: Status): ChangeKind | undefined {
  switch (status) {
    case Status.INDEX_ADDED:
    case Status.INTENT_TO_ADD:
    case Status.ADDED_BY_US:
    case Status.ADDED_BY_THEM:
      return 'added';
    case Status.MODIFIED:
    case Status.INDEX_MODIFIED:
    case Status.TYPE_CHANGED:
    case Status.BOTH_MODIFIED:
      return 'modified';
    case Status.DELETED:
    case Status.INDEX_DELETED:
    case Status.DELETED_BY_US:
    case Status.DELETED_BY_THEM:
    case Status.BOTH_DELETED:
      return 'deleted';
    case Status.INDEX_RENAMED:
    case Status.INTENT_TO_RENAME:
      return 'renamed';
    case Status.UNTRACKED:
      return 'untracked';
    case Status.IGNORED:
      return undefined;
    case Status.INDEX_COPIED:
      return 'added';
    default:
      return 'modified';
  }
}

/** Discovers one GitRepository per repo the built-in git extension has opened, filtered
 *  to the current workspace. Returns an empty array (never throws) if the git extension
 *  is missing/disabled/not yet initialized — callers should treat that as "no repo" and
 *  show the `changelists.noRepo` welcome view rather than erroring. */
export async function discoverRepositories(): Promise<GitRepository[]> {
  const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!ext) {
    return [];
  }
  const gitExtension = ext.isActive ? ext.exports : await ext.activate();
  if (!gitExtension.enabled) {
    return [];
  }
  const api: GitAPI = gitExtension.getAPI(1);
  if (api.state !== 'initialized') {
    await new Promise<void>((resolve) => {
      const sub = api.onDidChangeState((state) => {
        if (state === 'initialized') {
          sub.dispose();
          resolve();
        }
      });
    });
  }
  return api.repositories.map((r) => new GitRepository(r));
}

export function watchRepositoryDiscovery(onChange: () => void): vscode.Disposable {
  const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!ext?.isActive) {
    return new vscode.Disposable(() => undefined);
  }
  const api = ext.exports.getAPI(1);
  const subs = [api.onDidOpenRepository(onChange), api.onDidCloseRepository(onChange)];
  return vscode.Disposable.from(...subs);
}
