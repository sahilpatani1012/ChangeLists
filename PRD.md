# Product Requirements Document: "Changelists" — a VS Code Extension

## 1. Overview

Build a VS Code extension called **Changelists** that brings JetBrains/WebStorm-style
changelists to VS Code. A changelist is a **named, persistent group of modified files**
that the developer can commit, review, or discard independently of other in-progress
work — letting a developer keep multiple unrelated changes staged in parallel without
them bleeding into one commit.

VS Code's native Source Control view treats all working-tree changes as one flat list.
This extension adds a second, complementary panel where the same files can be organized
into user-defined groups, each with its own scoped commit action.

Git itself has no native concept of changelists. This is purely an editor-side
abstraction — the extension tracks a file → changelist mapping locally and uses
pathspec-scoped git commands (e.g. `git commit -m "msg" -- file1.ts file2.ts`) to commit
only the files in a given group.

## 2. Problem Statement

Developers who work on several small, unrelated changes at once (a bugfix + a
refactor + a WIP feature, say) have no clean way in VS Code to keep them mentally and
operationally separate before commit time. They either commit everything together, or
resort to manual `git add <path>` juggling. WebStorm/IntelliJ users who move to VS Code
consistently cite this as their most-missed feature.

## 3. Goals

- Let users create, rename, and delete named changelists.
- Let users assign/move files between changelists (drag-and-drop, context menu, command
  palette, keyboard).
- Let users commit a single changelist's files without touching other pending changes.
- Persist changelist assignments across VS Code restarts.
- Reconcile assignments automatically against live git status (handle new, deleted,
  renamed, and externally-staged files gracefully).
- Feel native — same iconography, theming, and interaction patterns as VS Code's
  built-in Source Control view.

## 4. Non-Goals (v1)

- Hunk-level (partial-file) changelists — splitting one file's diff across two lists.
  This requires diff parsing and generating partial patches; scope for a v2.
- Shelve/unshelve (stash-per-changelist) equivalent — v2/v3 stretch.
- Multi-repo workspace support beyond "just works per-folder" — treat each repo
  independently, no cross-repo changelist merging.
- Replacing or modifying VS Code's built-in Git extension — this extension is additive
  and read-only with respect to `vscode.git`'s own state.

## 5. Target User & Personas

Primary: a developer coming from WebStorm/IntelliJ/Rider who relies on Local Changes
grouping daily and finds VS Code's flat SCM list a downgrade. Comfortable with git,
wants speed and low friction, not a heavyweight GUI.

## 6. User Stories

1. As a developer, I can create a new changelist named "Auth refactor" so I can group
   related files separately from my other WIP.
2. As a developer, when I edit a file that isn't yet assigned to any changelist, it
   automatically lands in a "Default" changelist so nothing gets lost.
3. As a developer, I can drag a file from one changelist to another, or right-click →
   "Move to Changelist…".
4. As a developer, I can right-click a changelist and choose "Commit Changelist…" to
   commit only its files with their own commit message.
5. As a developer, I can set one changelist as "Active" so newly modified files default
   into it instead of Default.
6. As a developer, if I stage/unstage or externally modify files outside the extension
   (e.g. via terminal `git add`), the panel reconciles without losing my groupings.
7. As a developer, I can see at a glance how many files and what change types
   (Modified/Added/Deleted/Renamed) are in each changelist, matching VS Code's status
   color/letter conventions.
8. As a developer, I can rename or delete a changelist; deleting one moves its files
   back to Default rather than discarding changes.

## 7. Functional Requirements

### 7.1 Changelist Management
- Create changelist (name + optional description/comment, matching WebStorm's dialog).
- Rename changelist.
- Delete changelist (files return to Default; confirm if non-empty).
- Set changelist as "Active" (visually distinguished, e.g. bold label or a dot marker).
- A "Default" changelist always exists and cannot be deleted, only renamed.

### 7.2 File Assignment
- New/modified files with no existing assignment auto-join the Active changelist.
- Move file(s) between changelists via:
  - Drag-and-drop in the tree view.
  - Right-click context menu → "Move to Changelist" → submenu/quick-pick of targets
    (+ "New Changelist…" option inline).
  - Multi-select support (standard VS Code ctrl/cmd+click, shift+click).
- Files no longer modified (reverted to HEAD) are removed from their changelist
  automatically on refresh.

### 7.3 Git Integration & Scoped Commits
- "Commit Changelist" runs a pathspec-scoped commit: stage only that group's files,
  commit with the provided message, leave all other changelists' files untouched in the
  working tree.
- Support amend on the most recent commit if it's a natural fit for the UX (optional,
  mirror VS Code's own amend checkbox pattern).
- Read current git status via the built-in `vscode.git` extension's API
  (`vscode.extensions.getExtension('vscode.git').exports.getAPI(1)`) rather than
  shelling out for status — use it as the source of truth for what's modified, then
  overlay changelist grouping on top.
- Actual staging/commit operations may shell out to git directly (via `child_process` or
  a thin wrapper like `simple-git`) since the `vscode.git` API's commit surface doesn't
  support arbitrary pathspec scoping.

### 7.4 UI/UX Requirements
- New view container / panel titled "Changelists" (separate from, not replacing, the
  built-in Source Control view), using VS Code's `TreeView` API.
- Each changelist renders as a collapsible group node with:
  - Name, active indicator, file count badge.
  - Child nodes = files, each showing filename, relative path, and a status letter/color
    matching VS Code convention (M/A/D/R/U, using the same color tokens as the built-in
    SCM view via `resourceUri` + `FileDecoration` or `ThemeColor`).
- Context menus (right-click) at both changelist level and file level, using VS Code's
  `menus` contribution point (`view/item/context`).
- Command palette entries for every action (create/rename/delete/commit/move) — no
  action should be mouse-only.
- Status bar item showing the current Active changelist name; clicking it opens a
  quick-pick to switch.
- Empty states: a changelist with 0 files shows a subdued placeholder row, not a blank
  gap.
- Use built-in Codicons for all iconography (no custom icon font) so the extension
  inherits theme changes automatically.

### 7.5 Persistence
- Store the file → changelist mapping in a workspace-scoped store — either
  `context.workspaceState` or a `.vscode/changelists.json` file (prefer the latter if
  the user wants it shareable/committable across a team; make this a setting).
- On extension activation, reconcile stored mapping against live `git status`: drop
  entries for files no longer modified, and surface unassigned modified files into
  Default (or Active).
- Handle renames: if git reports a rename (old path → new path) between refreshes,
  carry the changelist assignment over to the new path where possible.

### 7.6 Settings (`contributes.configuration`)
- `changelists.defaultListName` (string, default `"Default"`)
- `changelists.persistTo` (`"workspaceState"` | `"file"`, default `"workspaceState"`)
- `changelists.autoAssignNewFilesToActive` (boolean, default `true`)
- `changelists.confirmOnDeleteNonEmpty` (boolean, default `true`)

## 8. Technical Architecture

### 8.1 High-level architecture
```
extension.ts                 — activation, command registration, view registration
/src
  changelistManager.ts        — core domain logic: CRUD on changelists, file assignment,
                                 reconciliation against git status
  gitService.ts                — wraps vscode.git API for status reads; wraps child_process
                                 / simple-git for scoped commit/stage operations
  persistence.ts               — load/save mapping (workspaceState or .vscode/changelists.json)
  treeDataProvider.ts           — implements vscode.TreeDataProvider for the Changelists view
  dragAndDropController.ts     — implements vscode.TreeDragAndDropController for moving files
  statusBar.ts                 — active changelist indicator
  commands/
    createChangelist.ts
    renameChangelist.ts
    deleteChangelist.ts
    moveFile.ts
    commitChangelist.ts
    setActiveChangelist.ts
```

### 8.2 Key VS Code APIs
- `vscode.window.createTreeView` + `TreeDataProvider` — main panel rendering.
- `vscode.TreeDragAndDropController` — drag-and-drop between groups.
- `vscode.extensions.getExtension('vscode.git').exports.getAPI(1)` — read live repo
  state (modified/added/deleted files, HEAD, branch).
- `vscode.workspace.workspaceState` and/or `vscode.workspace.fs` — persistence.
- `vscode.commands.registerCommand` — all user-triggered actions.
- `contributes.views`, `contributes.viewsContainers`, `contributes.menus`,
  `contributes.commands`, `contributes.configuration` in `package.json`.

### 8.3 Data model
```ts
interface Changelist {
  id: string;
  name: string;
  description?: string;
  isDefault: boolean;
  isActive: boolean;
}

interface ChangelistAssignment {
  filePath: string;        // repo-relative
  changelistId: string;
}

interface ChangelistState {
  changelists: Changelist[];
  assignments: ChangelistAssignment[];
}
```

### 8.4 File/folder structure
Standard `yo code` TypeScript extension scaffold, strict TS, esbuild or webpack bundling
for the packaged extension, `vsce` for publishing.

## 9. Non-Functional Requirements

- TypeScript strict mode; no `any` in core domain logic.
- Must remain responsive on repos with 1,000+ changed files — avoid full-tree re-renders
  on every git status poll; diff against previous state and patch the tree view.
- No telemetry collection by default.
- Must respect both light and dark themes with zero hardcoded colors — use `ThemeColor`
  and `ThemeIcon` throughout.
- Unit tests for `changelistManager.ts` reconciliation logic (the trickiest part —
  renames, deletions, externally-staged files).
- Integration tests using `@vscode/test-electron` for the tree view and commit flow.

## 10. Milestones / Phased Rollout

**v1 (MVP)**
- Create/rename/delete changelists, Default list, Active list concept.
- File assignment via context menu + drag-and-drop.
- Scoped commit per changelist.
- Persistence + reconciliation.
- Status bar active-list indicator.

**v2**
- Hunk-level (partial file) changelist splitting.
- Shelve/unshelve per changelist (stash equivalent).
- Team-shareable `.vscode/changelists.json` mode polished (merge conflict handling on
  the JSON file itself).

**v3 (stretch)**
- Changelist-scoped diff view / review mode.
- Integration with PR creation flows (open a PR pre-scoped to one changelist's files).

## 11. Acceptance Criteria (v1 "done")

- [ ] User can create, rename, delete a changelist from both UI and command palette.
- [ ] Modifying a tracked file causes it to appear under the correct changelist within
      one status-poll cycle, without manual refresh.
- [ ] Dragging a file to another changelist moves it and persists immediately.
- [ ] "Commit Changelist" only includes that group's files in the resulting git commit —
      verified by inspecting `git show --stat` on the resulting commit.
- [ ] Restarting VS Code preserves all changelist names and assignments.
- [ ] Deleting a non-empty changelist prompts for confirmation and moves files to
      Default rather than losing the assignment.
- [ ] Renaming a file in git (detected as a rename) keeps it in its original changelist.
- [ ] All actions are theme-consistent in both a light and a dark built-in theme.

## 12. Risks & Open Questions

- **Two SCM-like panels may confuse users at first** — mitigate with clear panel title
  ("Changelists") and onboarding walkthrough/README, not by touching the built-in panel.
- **Reconciliation edge cases** (interactive rebase, stash pop, external git GUI use)
  need careful handling so the mapping doesn't silently corrupt — recommend defensive
  "unknown file → Default" fallback rather than dropping data.
- **Team-shared `.vscode/changelists.json` mode** raises merge-conflict-on-json
  questions if two teammates both edit changelists in a shared branch — decide whether
  v1 keeps this workspaceState-only (per-machine) to sidestep the issue entirely.
- **Open question:** should committing a changelist also unstage everything else the
  user had manually staged outside the extension? Recommend: warn and ask, don't
  silently override.

## 13. Appendix: Example Scoped Commit Command

```
git commit -m "Refactor auth token handling" -- src/auth/token.ts src/auth/refresh.ts
```

This commits only the two listed paths, regardless of what else is modified or staged
in the working tree, leaving other changes untouched for their own changelists.
