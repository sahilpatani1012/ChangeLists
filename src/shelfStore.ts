import { createHash } from 'crypto';
import * as vscode from 'vscode';
import { ChangelistState, ShelvedFile, ShelvedFileMeta, toShelvedFileMeta } from './types';

/** Durable storage for shelved file *payloads* — the patches and base64 contents that a
 *  shelve captures and an unshelve replays.
 *
 *  Deliberately not part of ChangelistState. In `file` mode that state is
 *  `.vscode/changelists.json`, which the README tells teams to commit; putting shelved
 *  work in it publishes private WIP (and whatever happens to be in those files) into the
 *  repository. Payloads live here instead, under the extension's own workspace storage:
 *  outside the repo, per-machine, and never a candidate for `git add`.
 *
 *  One file per changelist, so unshelving one list never rewrites another's snapshot and
 *  a corrupt payload can only cost the changelist it belongs to. */
export class ShelfStore {
  constructor(private readonly root: vscode.Uri) {}

  private fileUri(repoRoot: vscode.Uri, changelistId: string): vscode.Uri {
    // The repo root is hashed rather than embedded: it is an absolute path, so it carries
    // characters no filesystem accepts in a name, and its length is unbounded.
    const repoKey = createHash('sha1').update(repoRoot.toString()).digest('hex').slice(0, 16);
    const listKey = createHash('sha1').update(changelistId).digest('hex').slice(0, 16);
    return vscode.Uri.joinPath(this.root, 'shelves', repoKey, `${listKey}.json`);
  }

  async save(repoRoot: vscode.Uri, changelistId: string, files: readonly ShelvedFile[]): Promise<void> {
    const uri = this.fileUri(repoRoot, changelistId);
    await vscode.workspace.fs.createDirectory(uri.with({ path: uri.path.replace(/\/[^/]+$/, '') }));
    await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(files), 'utf8'));
  }

  /** Returns undefined when nothing is stored — which, for a changelist the state says is
   *  shelved, means the payload is missing rather than empty. Callers must tell the user
   *  rather than reporting a successful unshelve of nothing. */
  async load(repoRoot: vscode.Uri, changelistId: string): Promise<ShelvedFile[] | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.fileUri(repoRoot, changelistId));
      const parsed: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
      return Array.isArray(parsed) ? (parsed as ShelvedFile[]) : undefined;
    } catch {
      return undefined;
    }
  }

  async delete(repoRoot: vscode.Uri, changelistId: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(this.fileUri(repoRoot, changelistId), { useTrash: false });
    } catch {
      // Already gone; nothing to clean up.
    }
  }
}

/** Moves shelf payloads out of state written before the shelf store existed.
 *
 *  Up to 1.0 the patches and base64 contents lived inline in ChangelistState — which in
 *  `file` mode meant inside the committed `.vscode/changelists.json`. Without this, a
 *  changelist shelved by an earlier version would still render as shelved but have no
 *  retrievable contents, which is the one failure a shelve must never have.
 *
 *  Returns the rewritten state, or undefined when there was nothing to move. */
export async function migrateInlineShelves(
  shelves: ShelfStore,
  repoRoot: vscode.Uri,
  state: ChangelistState
): Promise<ChangelistState | undefined> {
  const legacy = state.changelists.filter((c) => c.shelf?.files.some(hasInlinePayload));
  if (legacy.length === 0) {
    return undefined;
  }
  for (const changelist of legacy) {
    const payloads = (changelist.shelf?.files ?? []).filter(hasInlinePayload);
    await shelves.save(repoRoot, changelist.id, payloads);
  }
  return {
    ...state,
    changelists: state.changelists.map((c) =>
      c.shelf ? { ...c, shelf: { ...c.shelf, files: c.shelf.files.map(toShelvedFileMeta) } } : c
    ),
  };
}

/** True for a shelf entry still carrying its content, i.e. one written before 1.1. */
function hasInlinePayload(file: ShelvedFileMeta | ShelvedFile): file is ShelvedFile {
  return 'storage' in file;
}
