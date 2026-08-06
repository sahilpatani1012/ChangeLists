# Changelog

All notable changes to the Changelists extension are documented here.

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
