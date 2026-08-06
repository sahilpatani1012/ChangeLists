# Changelists

JetBrains/WebStorm-style named changelists for VS Code: group your modified files into
named sets and commit each one independently, without your other in-progress work
bleeding into the same commit.

Git has no native concept of a changelist — this is an editor-side abstraction. The
extension keeps its own file→changelist mapping and drives git with pathspec-scoped
commands, so a changelist commit contains exactly its own files and nothing else.

It is **additive** to VS Code's built-in Source Control view, never a replacement:
status is read through the built-in `vscode.git` extension's API, and its UI and state
are left alone.

## Features

**Changelists.** Create, rename, and delete named lists. A `Default` list always exists
— it can be renamed but not deleted, and deleting any other list moves its files to
Default rather than discarding them. One list is *Active* at a time; newly modified
files land there automatically.

**Assigning files.** Drag and drop between groups, or right-click → *Move to
Changelist…*. Both are multi-select aware. Every action also has a Command Palette entry
(`Changelists: …`) — nothing is mouse-only.

**Scoped commits.** *Commit Changelist…* stages and commits only that list's files
(`git add -- <paths>` then `git commit -m … -- <paths>`), leaving everything else in the
working tree untouched. If you have files staged outside the changelist, it says so and
asks before proceeding rather than silently overriding your staging.

**Hunk-level splitting.** A file's hunks can belong to different changelists. *Split
Hunks to Changelist…* lists the file's hunks and moves the ones you pick; *Reunite
Hunks* puts them back. A split file shows up under each owning changelist with a
`2/5 hunks` marker. Committing a partially-owned file builds the commit through the
index so only the owned hunks land in it.

**Shelving.** *Shelve Changelist* sets a list's work aside and takes it out of your
working tree; *Unshelve* brings it back, into the same changelist it came from. This is
the extension's own snapshot, **not** `git stash` — nothing appears in `git stash list`
and there's no stash ref to renumber underneath you.

**Review.** *Review Changelist (Open All Diffs)* opens a diff editor per file, in path
order, so one changelist's work can be read start to finish.

**Reconciliation.** On every refresh, assignments are reconciled against live git
status: files reverted to HEAD drop out, renamed files carry their changelist across to
the new path, and anything unrecognised falls back to Default rather than being dropped.

**Status bar.** The active changelist is shown next to the branch; click it to switch or
create one.

## Installing

Grab the packaged `changelists-1.0.0.vsix` and either:

- **In VS Code**: Extensions view (`Ctrl+Shift+X`) → `...` menu → *Install from VSIX…*
- **From a terminal**: `code --install-extension changelists-1.0.0.vsix`

Requires VS Code 1.85+, the built-in Git extension enabled, and `git` on your `PATH`
(the extension shells out for staging, commit, diff, and patch application).

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `changelists.defaultListName` | `"Default"` | Name of the list that always exists. |
| `changelists.persistTo` | `"workspaceState"` | `"workspaceState"` (per-machine) or `"file"` (`.vscode/changelists.json`, shareable — see below). |
| `changelists.autoAssignNewFilesToActive` | `true` | Auto-assign newly modified files to the active changelist instead of Default. |
| `changelists.confirmOnDeleteNonEmpty` | `true` | Confirm before deleting a changelist that still has files. |

### Sharing changelists with a team

Set `changelists.persistTo` to `"file"` and the state lives in
`.vscode/changelists.json`, which you can commit. The file is written with sorted keys
and stable ordering so it's a deterministic function of its content — two people
touching unrelated changelists won't produce a spurious diff, and git only reports a
conflict where they genuinely disagree. If a conflict does land, the extension detects
the markers, tells you which file, and leaves it alone for you to resolve rather than
guessing a winner. External changes (a `git pull`, a branch switch) are picked up
automatically.

`workspaceState` remains the default because it's per-machine and sidesteps the question
entirely.

## Known limitations

These are deliberate boundaries, not bugs waiting to be found:

- **Only `modified` files can be split by hunk.** Added and untracked files have no
  HEAD blob to diff against; deleted and renamed files have no coherent half-applied
  state.
- **Committing a partially-owned file clears unrelated staging.** The index is a single
  global slot, and there's no way to build a different tree without disturbing it. No
  content is lost — working-tree files are never touched — but you'll need to re-stage.
  The commit dialog warns before taking this path.
- **A changelist owning only part of a file can't be shelved.** Shelving reverts whole
  paths, so it would drag another changelist's hunks out of the tree with it. Reunite
  the hunks first.
- **A shelved rename's pre-rename path** is restored from HEAD while shelved and deleted
  again on unshelve, so edits made to that path *while shelved* don't survive.
- **The commit form is native QuickInputs**, not a webview: single-line message, with
  amend offered as a follow-up pick. Functionally complete, visually plainer than the
  design mockup's dedicated commit panel.

## Project layout

```
src/
  extension.ts             — activation: wires provider, drag&drop, status bar, commands
  types.ts                  — domain model (changelists, assignments, shelves, hunk refs)
  changelistManager.ts       — CRUD, assignment, reconciliation; zero vscode imports, unit-tested
  hunks.ts                    — unified-diff parsing, hunk identity, subset-patch generation
  gitService.ts               — status via vscode.git's API; commit/shelve/diff via git CLI
  persistence.ts              — workspaceState or .vscode/changelists.json, with conflict handling
  repositoryContext.ts        — per-repo bundle of {repo, manager, live status, hunk index}
  treeDataProvider.ts          — the Changelists tree, with signature-diffed granular refresh
  dragAndDropController.ts    — file → changelist drag-and-drop
  statusBar.ts                 — active-changelist indicator
  api/                          — trimmed vscode.git type declarations + its Status enum
  commands/                     — one module per user-facing action
  test/
    unit/                        — node:test suites (manager + hunk arithmetic)
    suite/, runTest.ts            — @vscode/test-electron integration scaffold
```

## Development

```
npm install
npm run compile      # type-check
npm run lint
npm run test:unit    # 39 tests, plain Node — no VS Code binary needed
npm run build        # esbuild bundle -> dist/extension.js
npm run package      # -> changelists-1.0.0.vsix
```

Press <kbd>F5</kbd> to launch an Extension Development Host with the extension loaded
(this runs the watch build first automatically).

### Testing

`npm run test:unit` covers the parts worth proving in isolation: reconciliation
(rename carry-over, dropped assignments, shelve/unshelve round-trips) and the hunk
line-number arithmetic that makes subset patches apply cleanly. It has no `vscode`
dependency, so it runs anywhere with Node 18+.

`npm run test:integration` drives a real VS Code instance via `@vscode/test-electron`.
It needs to download a VS Code build on first run, so it isn't part of the default
`npm test`. The suite currently covers activation and command registration; extending it
to the tree view and commit flow needs a fixture repo passed via `runTests({ launchArgs
})` in `src/test/runTest.ts`.

## Design reference

Built against a separately-provided HTML mockup ("Changelists Panel") covering all
tree/menu/dialog states in Dark Modern and Light Modern, plus a component spec table of
VS Code theme tokens (`gitDecoration.*ResourceForeground`,
`list.activeSelectionBackground`, row heights). That mockup is a rendered artifact and
isn't checked in; its token choices are what the tree rendering, QuickInput copy, and
empty-state wording here are matched against.

## License

MIT — see the `LICENSE` file included with this extension.
