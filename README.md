# Changelists

JetBrains/WebStorm-style named changelists for VS Code: group modified files into
named, persistent sets and commit each one independently, without your other
in-progress work bleeding into the same commit.

This is additive to VS Code's built-in **Source Control** view, not a replacement for
it — Changelists reads git status through the built-in `vscode.git` extension's API and
never touches its UI or state. See `PRD.md` for the full product spec this scaffold
implements against.

## What's implemented (v1 scaffold)

- Create / rename / delete changelists; a `Default` list always exists and can be
  renamed but not deleted.
- One changelist is "Active" at a time; new modified files auto-join it
  (`changelists.autoAssignNewFilesToActive`).
- Move files between changelists via drag-and-drop or the file's context menu → "Move
  to Changelist…" (multi-select aware).
- "Commit Changelist…" stages and commits **only** that group's files
  (`git add -- <paths>` + `git commit -m "…" -- <paths>`), leaving everything else in
  the working tree untouched. Warns before proceeding if other files are already
  staged outside the changelist.
- Reconciliation against live git status on every refresh: files no longer modified
  drop out of their changelist; renamed files (as reported by git) carry their
  changelist assignment over to the new path; new modified files land in Active (or
  Default).
- Status bar item showing the active changelist; click to switch (or create a new one).
- Every action is also a Command Palette entry (`Changelists: …`), not just a
  right-click.
- Persistence per repository, either in VS Code's `workspaceState` (per-machine,
  default) or `.vscode/changelists.json` (team-shareable) — see
  `changelists.persistTo`.

## v2 progress

- **Shelve / unshelve per changelist** — done, WebStorm-style rather than
  `git stash`-based. "Shelve Changelist" snapshots each file itself — a unified diff
  against HEAD for tracked content (modified/deleted), or a raw base64 copy for content
  with no HEAD blob (untracked/added, and a rename's new path) — then reverts the
  working tree for those paths (`git checkout HEAD --` for tracked files, delete +
  restore-old-path for untracked/renamed). The snapshot lives inside the changelist's
  own persisted state, not in git's stash ref at all. Unshelving reapplies it (`git
  apply` for patches, a direct file write for content) and restores the original
  file→changelist assignments. See `ShelvedFile` in `src/types.ts` and
  `gitService.shelvePaths`/`unshelvePaths` for the mechanics, including the one known
  limitation: a shelved rename's pre-rename path is restored from HEAD while shelved
  and deleted again on unshelve, so edits made to that path *while shelved* don't
  survive — a narrow, documented edge case rather than a silent one.

  Default can't be shelved and shelving the active list hands Active back to Default,
  so newly-modified files always have a live list to land in.

## Not yet built (see PRD §9/§10 for the full v2/v3 roadmap)

- Hunk-level (partial-file) changelists.
- Team-shareable JSON merge-conflict handling (v2 item 3).
- The mockup's dedicated webview commit view (multi-line message box + "Amend last
  commit" checkbox as a real checkbox) — v1's commit flow uses chained native
  QuickInputs instead (single-line message, amend offered as a QuickPick step when a
  HEAD commit exists). Functionally equivalent, less visually rich; see the comment
  atop `src/commands/commitChangelist.ts`.
- The integration test in `src/test/suite/extension.test.ts` is a activation/command
  smoke test, not the full tree-view/commit-flow coverage the PRD's NFR section calls
  for — it's a starting point to build fixture-repo-backed tests on top of (see
  "Testing" below).

## Project layout

```
src/
  extension.ts            — activation: wires provider, drag&drop, status bar, commands
  types.ts                 — domain model (Changelist, assignments, reconciliation result)
  changelistManager.ts      — core CRUD + reconciliation logic; zero vscode imports, unit-tested
  gitService.ts             — reads status via vscode.git's API; stages/commits via simple-git
  persistence.ts            — workspaceState- or file-backed store for changelist state
  repositoryContext.ts      — bundles {repo, manager} per open repository + wires persistence
  treeDataProvider.ts        — renders the Changelists tree view
  dragAndDropController.ts  — file → changelist drag-and-drop
  statusBar.ts               — active-changelist status bar item
  api/git.d.ts                — trimmed type declarations for vscode.git's exported API
  api/gitStatus.ts             — real (bundleable) mirror of vscode.git's Status enum
  commands/                   — one handler per user-facing action, plus shared.ts helpers
  test/
    unit/                      — plain node:test unit tests (changelistManager reconciliation)
    suite/, runTest.ts          — @vscode/test-electron integration test scaffold
```

## Setup

```
npm install
npm run compile   # type-check
npm run lint
```

## Testing

Two independent test paths, matching the PRD's NFR split between pure-logic unit tests
and extension-host integration tests:

```
npm run test:unit         # node:test, runs directly — no VS Code binary needed
npm run test:integration  # @vscode/test-electron — downloads a real VS Code build
```

`test:unit` covers `changelistManager`'s reconciliation logic (new-file assignment,
dropped assignments, rename carry-over, duplicate-name rejection, delete/active-list
interactions) with zero `vscode` dependency, so it runs in any plain Node 18+
environment. `test:integration` needs network access the first time (to fetch the VS
Code test binary) and a real display/Electron-capable environment, so it isn't run as
part of building this scaffold — `npm run test:unit` is what `npm test` runs by default.

## Running the extension

```
npm run build   # esbuild bundle -> dist/extension.js
```

Then open this folder in VS Code and press F5 (Run Extension) to launch an Extension
Development Host with Changelists loaded, or package it with `npm run package` (needs
`vsce`, already a devDependency) and install the resulting `.vsix`.

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `changelists.defaultListName` | `"Default"` | Name of the list that always exists. |
| `changelists.persistTo` | `"workspaceState"` | `"workspaceState"` (per-machine) or `"file"` (`.vscode/changelists.json`, shareable — see PRD §12 for the merge-conflict caveat of doing this on a shared branch). |
| `changelists.autoAssignNewFilesToActive` | `true` | Auto-assign newly modified/untracked files to the active changelist instead of Default. |
| `changelists.confirmOnDeleteNonEmpty` | `true` | Confirm before deleting a changelist that still has files. |

## Design reference

This implementation follows a separately-provided HTML mockup ("Changelists Panel")
covering all 8 tree/menu/dialog states in both Dark Modern and Light Modern, plus a
component spec table of exact VS Code theme-token mappings
(`gitDecoration.*ResourceForeground`, `list.activeSelectionBackground`, row heights,
etc.). That mockup is a rendered design artifact, not source-controllable, and isn't
checked into this repo — its token choices are what `treeDataProvider.ts`'s status
letters, the QuickInput copy in `commands/`, and the empty-state row wording are
matched against.
