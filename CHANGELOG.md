# Changelog

All notable changes to the Changelists extension are documented here.

## 1.1.0

A correctness pass over 1.0.0, prompted by a full audit of the extension. The headline is
that nothing here changes what the extension is for — it changes how often it does the
right thing when git, the filesystem, or the user's configuration is not the happy path.

**Data loss.** Shelving a modified binary file destroyed the change: the capture used
`git diff` without `--binary`, which reports *that* a binary file differs but not *how*,
and the working tree was reverted anyway. Every diff now flows through one hardened
helper (`--binary`, `--no-color`, `--no-ext-diff`, `-U3`) with `diff.noprefix`,
`diff.mnemonicPrefix` and `color.ui` pinned via `-c` — a user who set any of those turned
every patch the extension generated into one `git apply` refuses to read, breaking
unshelve and hunk-scoped commits. Captures are now validated *before* the working tree is
touched, so a shelve that cannot be reversed does not happen at all.

**Shelved contents no longer live in `.vscode/changelists.json`.** That file is the one
the README tells teams to commit, and it held full patches and base64 copies of shelved
work. Payloads moved to the extension's own workspace storage; the state file keeps only
which paths are shelved. Existing shelves are migrated on load. Shelving refuses files
over 16 MB.

**Unshelve resumes instead of replaying.** A partial failure used to leave a
half-restored tree and a shelf that could only ever replay patches `git apply` would
reject — the "resolve the conflict and try again" the error suggested was not actually
possible. What landed stays landed; only the rest stays shelved.

**Switching `changelists.persistTo` no longer discards everything.** The setting had no
effect until a window reload, and then started from an empty state in the other backend.
The store is now selected per discovery pass and existing state is carried across.

**Moving a split file's row moves that row.** Drag-and-drop and the context menu carried
only file paths, so dropping the row under *Bugfix* relocated the whole file — moving the
hunks you weren't touching and leaving Bugfix's behind. Every move now runs through one
`moveRows()` method that knows the difference between a file and one changelist's share
of it, and selecting every hunk is recognised as a whole-file move.

**Shelved changelists can no longer be Active.** The guardrail was asserted in a comment
and enforced nowhere, so newly modified files could auto-assign into a changelist whose
contents are not in the working tree — where they simply vanished from the tree.

**Merge conflicts appear.** `mergeChanges` was never read, so the panel under-reported
during a merge or rebase and a scoped commit built from it silently excluded the
conflicted files. Conflicted files now render as such and block a commit.

**Also fixed:** discarding a renamed file or a staged new file failed outright
(`pathspec did not match`); renaming a file and then editing it lost the rename linkage;
hunk-scoped commits dropped the rename side; a transient `git diff` failure permanently
deleted that file's hunk assignments; persistence failures were swallowed entirely;
file-watcher registrations doubled on every reload in `file` mode; concurrent discovery
passes could render a repository twice; refreshes raced each other; the tree recomputed
its grouping twenty-one times per event on a ten-changelist repo; changelist order
rearranged itself on every restart; the status bar went stale until the view was opened;
and there were two Collapse All buttons.

**`simple-git` is gone.** It accounted for most of the bundle while being used for little
more than argument passing; a direct `child_process` wrapper replaces it. The production
bundle drops from 118 KB to 60 KB, patches reach `git apply` over **stdin** instead of via
a world-readable temp file in `os.tmpdir()`, failures carry git's own stderr rather than a
paraphrase, and a missing `git` binary is now named as such. Diff concurrency is capped
explicitly at 8 — previously it was bounded only as a side effect of the wrapper's own
scheduler.

**Undo.** *Undo Last Changelist Change* reverses the last grouping change: a move, rename,
create, delete, or reunite. One step deep, grouping only — it cannot take back a commit, a
discard, or a shelve. Reconciliation deliberately does not set the undo point, so an
ordinary save can't bury what you wanted back.

**Added:** an output channel recording what reconciliation moved; editable changelist
descriptions (`ChangelistManager.setDescription` existed and was reachable from nowhere);
keybindings within the view; multi-select for Open File, Open Diff and Discard Changes;
a schema version with stricter state validation; and a distinct empty state for "git is
disabled" versus "no repository here".

**Testing.** Unit coverage is up from 39 tests to 105, including a suite that drives the
real `git` binary. The integration suite now runs against a fixture repository in a real
extension host, which is what finally verified — rather than assumed — that `vscode.git`
reports the new path of a rename in `Change.uri`. A CI workflow runs the checks on Linux,
Windows and macOS.

**Still open, deliberately:** the commit message is still single-line. Multi-paragraph
bodies need either a custom `SourceControlInputBox` or a webview, which is a feature
rather than a fix.

## 1.0.0

Completes the PRD: everything in the v1 MVP, v2, and the v3 review item is now built.

**Hunk-level changelists (v2).** A single file's hunks can now live in different
changelists. "Split Hunks to Changelist…" on a file row lists its hunks (pre-checked
with the ones this changelist already owns) and moves the selected set; "Reunite Hunks"
undoes it. A split file appears under each owning changelist showing `2/5 hunks`
instead of a status letter. Committing a partially-owned file rebuilds the commit
through the index (`read-tree HEAD` → selective `add`/`apply --cached` → `commit`),
because a pathspec commit can't express "only these hunks" — the one cost is that
unrelated staging gets cleared, which the commit dialog now warns about explicitly.
Hunk identity is a content hash, so it survives edits *elsewhere* in the file and lapses
safely (falling back to the file's own changelist) when the hunk itself is edited.

**Changelist-scoped review (v3).** "Review Changelist (Open All Diffs)" opens a diff
editor per file in path order, so one changelist's work can be read end to end.

**Team-shareable `.vscode/changelists.json` (v2).** The file is now serialized with
sorted keys and stable ordering, so it's a deterministic function of its content and git
only sees a conflict where two people genuinely disagree. Unresolved conflict markers
are detected and reported as such (with "Open File" / "Retry") instead of surfacing as a
JSON parse error, and the file is left untouched rather than overwritten. External
changes — a teammate's edit arriving via `git pull`, a branch switch — are watched and
reloaded, ignoring the extension's own writes.

**Performance (NFR §9).** The tree no longer re-renders wholesale on every git status
poll (which fires on every save and focus change). Each changelist's rendered content is
diffed against a signature and only genuinely-changed groups are refreshed, with a full
refresh reserved for when the set of changelists itself changes.

**Fixed:** deleting or shelving a changelist silently discarded every hunk override in
the repository — the state object was rebuilt without carrying them across. Deleting a
changelist now moves its hunk overrides to Default, mirroring the file-level rule.

Also added: MIT `LICENSE`, and unit coverage is up to 39 tests.

## 0.3.0

Changed shelve/unshelve to go away from `git stash`.

Shelving now snapshots each file itself instead of pushing a git stash entry: a
unified diff against HEAD for tracked content (modified/deleted), or a raw base64
copy for content with no HEAD blob (untracked/added, and a rename's new-path side).
The snapshot lives in the changelist's own persisted state, not in git's stash ref —
so there's no `stash@{n}` renumbering to worry about, and nothing shows up in
`git stash list` for a teammate to be confused by. See `ShelvedFile` in
`src/types.ts` and `gitService.shelvePaths`/`unshelvePaths`.

## 0.2.0

Added shelve/unshelve per changelist, built on `git stash push -u -m … -- <paths>`
scoped to that changelist's files, with the resulting stash's commit SHA recorded
(rather than a `stash@{n}` ref, which shifts as other stashes are pushed/dropped).
Superseded by 0.3.0's non-stash approach; kept here for the record since the
underlying shelve/unshelve UX (archive icon, restoring assignments on unshelve,
Default/Active guardrails) carried forward unchanged.

## 0.1.0

Initial v1 scaffold, built from the PRD:

- Changelist CRUD (create/rename/delete), with a protected `Default` list.
- Active-list concept with auto-assignment of newly modified files.
- Drag-and-drop and context-menu ("Move to Changelist…") file assignment, multi-select
  aware.
- "Commit Changelist…" — pathspec-scoped commit (`git add --` + `git commit -- <paths>`)
  so only that changelist's files are committed.
- Reconciliation against live git status: drops stale assignments, carries renamed
  files over to their new path, auto-assigns new files to Active/Default.
- Status bar active-list indicator and switcher.
- Every action also reachable from the Command Palette.
- Persistence via `workspaceState` or `.vscode/changelists.json`
  (`changelists.persistTo`).
