# Changelog

All notable changes to the Changelists extension are documented here.

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
