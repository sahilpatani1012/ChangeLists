import { randomUUID } from 'crypto';
import {
  Changelist,
  ChangelistAssignment,
  ChangelistFileEntry,
  ChangelistState,
  DroppedHunkAssignment,
  GitFileChange,
  HunkAssignment,
  HunkIndex,
  MovableRow,
  ReconciliationResult,
  RepoRelativePath,
  ShelfInfo,
} from './types';

/** Core domain logic for one repository's changelists: CRUD, file assignment, and
 *  reconciliation against live git status. Deliberately has zero `vscode` imports so it
 *  can be unit-tested under plain Node (see src/test/suite/changelistManager.test.ts) —
 *  all I/O (persistence, git reads/writes, UI) lives in the callers that wrap this class. */
export class ChangelistManager {
  private _state: ChangelistState;
  private readonly listeners = new Set<() => void>();

  /** The state as it was before the last mutation, for undo.
   *
   *  Nearly free, because state is already immutable and replaced wholesale on every
   *  mutation — the previous object is sitting there either way. One step deep on purpose:
   *  this is a safety net for "that moved the wrong thing", not a history, and a deeper
   *  stack would invite the expectation that it survives a reload, which it does not. */
  private _undoState: ChangelistState | undefined;
  private _undoLabel: string | undefined;

  constructor(initialState: ChangelistState) {
    this._state = initialState;
  }

  get state(): Readonly<ChangelistState> {
    return this._state;
  }

  /** What undo() would reverse, for the menu and the confirmation, or undefined when
   *  there is nothing to undo. */
  get undoableAction(): string | undefined {
    return this._undoLabel;
  }

  /** Restores the state from before the last mutation. Returns what it reversed. */
  undo(): string | undefined {
    if (!this._undoState) {
      return undefined;
    }
    const label = this._undoLabel;
    this._state = this._undoState;
    // Deliberately not stacking: undoing is itself a mutation, but making it undoable
    // would turn one keystroke into a toggle nobody asked for.
    this._undoState = undefined;
    this._undoLabel = undefined;
    this.notify();
    return label;
  }

  /** Records the current state as the undo point, under a human-readable label. Called by
   *  the mutations a user performs deliberately — not by reconcile(), which reacts to git
   *  rather than to the user, and whose churn would otherwise bury the real undo point. */
  private checkpoint(label: string): void {
    this._undoState = this._state;
    this._undoLabel = label;
  }

  /** Fires after every mutating call (create/rename/delete/assign/reconcile/setActive).
   *  Callers wire this to persistence + tree/status-bar refresh; kept as a plain
   *  pub-sub rather than vscode.EventEmitter to keep this file dependency-free. */
  onDidChangeState(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private notify(): void {
    for (const l of this.listeners) {
      l();
    }
  }

  getChangelists(): readonly Changelist[] {
    return this._state.changelists;
  }

  getChangelist(id: string): Changelist | undefined {
    return this._state.changelists.find((c) => c.id === id);
  }

  getDefaultChangelist(): Changelist {
    const found = this._state.changelists.find((c) => c.isDefault);
    if (!found) {
      throw new Error('Invariant violated: no default changelist exists.');
    }
    return found;
  }

  /** The list reconcile() drops newly modified files into.
   *
   *  A shelved list is skipped even if it is somehow flagged active — setActiveChangelist()
   *  refuses to make one active and normalize() clears the flag on load, so this is the
   *  third line of defence rather than the first. It matters because the failure is
   *  invisible: a shelved list renders its snapshot instead of live git status, so files
   *  auto-assigned into one simply disappear from the tree until it is unshelved. */
  getActiveChangelist(): Changelist {
    return this._state.changelists.find((c) => c.isActive && !c.shelf) ?? this.getDefaultChangelist();
  }

  /** Case-insensitive uniqueness check used both internally and by command-side
   *  QuickInput validateInput, so the same rule governs both surfaces. */
  isNameAvailable(name: string, excludingId?: string): boolean {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      return false;
    }
    return !this._state.changelists.some(
      (c) => c.id !== excludingId && c.name.toLowerCase() === trimmed.toLowerCase()
    );
  }

  createChangelist(name: string, description?: string): Changelist {
    const trimmed = name.trim();
    if (!this.isNameAvailable(trimmed)) {
      throw new Error(`A changelist named "${trimmed}" already exists.`);
    }
    this.checkpoint(`creating "${trimmed}"`);
    const changelist: Changelist = {
      id: randomUUID(),
      name: trimmed,
      description: description?.trim() || undefined,
      isDefault: false,
      isActive: false,
    };
    this._state = { ...this._state, changelists: [...this._state.changelists, changelist] };
    this.notify();
    return changelist;
  }

  renameChangelist(id: string, newName: string): void {
    const trimmed = newName.trim();
    if (!this.isNameAvailable(trimmed, id)) {
      throw new Error(`A changelist named "${trimmed}" already exists.`);
    }
    const target = this.getChangelist(id);
    if (!target) {
      throw new Error('Changelist not found.');
    }
    this.checkpoint(`renaming "${target.name}"`);
    this._state = {
      ...this._state,
      changelists: this._state.changelists.map((c) => (c.id === id ? { ...c, name: trimmed } : c)),
    };
    this.notify();
  }

  setDescription(id: string, description: string | undefined): void {
    if (!this.getChangelist(id)) {
      throw new Error('Changelist not found.');
    }
    this.checkpoint('editing a description');
    this._state = {
      ...this._state,
      changelists: this._state.changelists.map((c) =>
        c.id === id ? { ...c, description: description?.trim() || undefined } : c
      ),
    };
    this.notify();
  }

  /** Deletes a non-default changelist, moving its files back to Default rather than
   *  discarding the assignment data (PRD §7.1, §11 acceptance criteria). If the deleted
   *  list was active, Default becomes the new active list so autoAssignNewFilesToActive
   *  always has somewhere to land. Returns the file paths that were moved, so the caller
   *  can decide whether/how to surface a confirmation summary. */
  deleteChangelist(id: string): { movedFilePaths: RepoRelativePath[] } {
    const target = this.getChangelist(id);
    if (!target) {
      throw new Error('Changelist not found.');
    }
    if (target.isDefault) {
      throw new Error('The Default changelist cannot be deleted.');
    }
    if (target.shelf) {
      throw new Error(`"${target.name}" is shelved. Unshelve it before deleting, so its shelved work isn't orphaned.`);
    }
    this.checkpoint(`deleting "${target.name}"`);
    const defaultList = this.getDefaultChangelist();
    const movedFilePaths: RepoRelativePath[] = [];
    const nextAssignments = this._state.assignments.map((a) => {
      if (a.changelistId !== id) {
        return a;
      }
      movedFilePaths.push(a.filePath);
      return { ...a, changelistId: defaultList.id };
    });
    const wasActive = target.isActive;
    this._state = {
      ...this._state,
      changelists: this._state.changelists
        .filter((c) => c.id !== id)
        .map((c) => (wasActive && c.id === defaultList.id ? { ...c, isActive: true } : c)),
      assignments: nextAssignments,
      // The deleted list's files moved to Default, so their hunk overrides must follow
      // rather than dangle at a changelist id that no longer exists.
      hunkAssignments: (this._state.hunkAssignments ?? []).map((h) =>
        h.changelistId === id ? { ...h, changelistId: defaultList.id } : h
      ),
    };
    this.notify();
    return { movedFilePaths };
  }

  setActiveChangelist(id: string): void {
    const target = this.getChangelist(id);
    if (!target) {
      throw new Error('Changelist not found.');
    }
    if (target.shelf) {
      // Without this the shelve/unshelve guardrails are decorative: newly modified files
      // auto-assign into the active list, so activating a shelved one strands them inside
      // a changelist whose contents aren't in the working tree at all.
      throw new Error(`"${target.name}" is shelved; unshelve it before making it active.`);
    }
    this.checkpoint(`activating "${target.name}"`);
    this._state = {
      ...this._state,
      changelists: this._state.changelists.map((c) => ({ ...c, isActive: c.id === id })),
    };
    this.notify();
  }

  isShelved(id: string): boolean {
    return this.getChangelist(id)?.shelf !== undefined;
  }

  /** Marks a changelist shelved and *removes* its assignments, recording them in the
   *  shelf instead. Removing them (rather than special-casing shelved lists throughout
   *  reconcile) is deliberate: once shelved, the files genuinely are absent from the
   *  working tree, so reconcile's normal "drop what git no longer reports" path stays
   *  correct with no extra branches. unshelveChangelist() restores them verbatim.
   *
   *  Shelving the active list hands Active back to Default, and Default itself can't be
   *  shelved — together these keep the invariant that reconcile's auto-assign target is
   *  never a shelved list, which would otherwise strand newly-modified files inside a
   *  changelist whose contents aren't even in the working tree. */
  shelveChangelist(id: string, shelf: ShelfInfo): void {
    const target = this.getChangelist(id);
    if (!target) {
      throw new Error('Changelist not found.');
    }
    if (target.isDefault) {
      throw new Error('The Default changelist cannot be shelved.');
    }
    if (target.shelf) {
      throw new Error(`"${target.name}" is already shelved.`);
    }
    const defaultList = this.getDefaultChangelist();
    const wasActive = target.isActive;
    this._state = {
      ...this._state,
      changelists: this._state.changelists.map((c) => {
        if (c.id === id) {
          return { ...c, shelf, isActive: false };
        }
        if (wasActive && c.id === defaultList.id) {
          return { ...c, isActive: true };
        }
        return c;
      }),
      assignments: this._state.assignments.filter((a) => a.changelistId !== id),
      // Shelving is refused for partially-owned files (see commands/shelve.ts), so the
      // only overrides referencing this list are ones whose file it owns outright;
      // drop them with the assignments they belonged to.
      hunkAssignments: (this._state.hunkAssignments ?? []).filter((h) => h.changelistId !== id),
    };
    this.notify();
  }

  /** Clears the shelf and restores the assignments captured at shelve time. Callers
   *  must write the shelved content back to the working tree *before* calling this and
   *  only refresh git status *after* — restoring assignments first is what stops
   *  reconcile from auto-assigning the just-restored files into whatever list is
   *  currently Active. */
  unshelveChangelist(id: string): ShelfInfo {
    const target = this.getChangelist(id);
    if (!target?.shelf) {
      throw new Error('That changelist is not shelved.');
    }
    const shelf = target.shelf;
    this.applyUnshelved(id, shelf.files.map((f) => f.filePath));
    return shelf;
  }

  /** Records that some of a shelf's files made it back into the working tree.
   *
   *  Anything still shelved stays shelved, so a retry after a partial failure resumes
   *  instead of replaying patches that already applied — `git apply` cannot apply the same
   *  patch twice, so replaying is not merely wasteful but guaranteed to fail. Returns how
   *  many files are still waiting, so the caller can word the result honestly. */
  applyUnshelved(id: string, restoredPaths: readonly RepoRelativePath[]): { remaining: number } {
    const target = this.getChangelist(id);
    if (!target?.shelf) {
      throw new Error('That changelist is not shelved.');
    }
    const done = new Set(restoredPaths);
    const stillShelved = target.shelf.files.filter((f) => !done.has(f.filePath));
    const restored: ChangelistAssignment[] = [...done].map((filePath) => ({ filePath, changelistId: id }));

    this._state = {
      ...this._state,
      changelists: this._state.changelists.map((c) =>
        c.id === id
          ? { ...c, shelf: stillShelved.length > 0 ? { ...target.shelf!, files: stillShelved } : undefined }
          : c
      ),
      // Drop any assignment that has since been created for the same path in another
      // list (the user modified the file again while it was shelved) — the unshelved
      // list wins, since the user explicitly asked for its contents back.
      assignments: [...this._state.assignments.filter((a) => !done.has(a.filePath)), ...restored],
      // Likewise for hunk overrides on those paths: the shelved snapshot is whole-file,
      // so any split created while it was away no longer describes this content.
      hunkAssignments: (this._state.hunkAssignments ?? []).filter((h) => !done.has(h.filePath)),
    };
    this.notify();
    return { remaining: stillShelved.length };
  }

  getChangelistIdForFile(filePath: RepoRelativePath): string | undefined {
    return this._state.assignments.find((a) => a.filePath === filePath)?.changelistId;
  }

  assignFile(filePath: RepoRelativePath, changelistId: string): void {
    this.assignFiles([filePath], changelistId);
  }

  /** Moves whole files. Any per-hunk override on a moved path is dropped: the file is
   *  going somewhere as a unit, so a split of it no longer describes anything. */
  assignFiles(filePaths: readonly RepoRelativePath[], changelistId: string): void {
    this.moveRows(
      filePaths.map((filePath) => ({ filePath, changelistId: '' })),
      changelistId
    );
  }

  /** Moves whatever the given tree rows represent into `changelistId`.
   *
   *  This exists because "move this row" and "move this file" are not the same operation
   *  once a file is split. A split file renders one row per owning changelist, each
   *  showing only that changelist's share — so moving the row under *Bugfix* must move
   *  Bugfix's hunks, not relocate the file. Routing every move (drag-and-drop, the context
   *  menu, the hunk picker) through one method is what keeps those two cases from drifting
   *  apart again.
   *
   *  Applied as a single state replacement so a multi-row move is one mutation — one
   *  persist, one tree refresh — rather than N of each. */
  moveRows(rows: readonly MovableRow[], changelistId: string): void {
    const target = this.getChangelist(changelistId);
    if (!target) {
      throw new Error('Changelist not found.');
    }
    if (target.shelf) {
      throw new Error(`"${target.name}" is shelved; unshelve it before moving files into it.`);
    }

    const wholeFiles = new Set<RepoRelativePath>();
    const hunkMoves = new Map<RepoRelativePath, Set<string>>();
    const totalHunksByPath = new Map<RepoRelativePath, number>();
    for (const row of rows) {
      if (row.totalHunks !== undefined) {
        totalHunksByPath.set(row.filePath, row.totalHunks);
      }
      if (!row.hunkIds || row.hunkIds.length === 0) {
        wholeFiles.add(row.filePath);
        continue;
      }
      const moving = hunkMoves.get(row.filePath) ?? new Set<string>();
      for (const hunkId of row.hunkIds) {
        moving.add(hunkId);
      }
      hunkMoves.set(row.filePath, moving);
    }

    // A selection covering every hunk of a file is a whole-file move — whether it came
    // from one row (the picker, with everything ticked) or from selecting all of a split
    // file's rows at once. Checked after the union rather than per row, because neither
    // half of a two-row selection covers the file on its own. Leaving the file-level
    // assignment behind here would list the file under a changelist that owns none of it,
    // and hand its hunks to Default the next time the destination was deleted.
    for (const [filePath, moving] of hunkMoves) {
      const total = totalHunksByPath.get(filePath);
      if (total !== undefined && moving.size >= total) {
        wholeFiles.add(filePath);
      }
    }
    for (const filePath of wholeFiles) {
      hunkMoves.delete(filePath);
    }

    this.checkpoint(rows.length === 1 ? `moving "${rows[0].filePath}"` : `moving ${rows.length} files`);
    let assignments: ChangelistAssignment[] = this._state.assignments;
    let hunkAssignments: HunkAssignment[] = [...this.hunkAssignments];

    if (wholeFiles.size > 0) {
      assignments = [
        ...assignments.filter((a) => !wholeFiles.has(a.filePath)),
        ...[...wholeFiles].map((filePath): ChangelistAssignment => ({ filePath, changelistId })),
      ];
      hunkAssignments = hunkAssignments.filter((h) => !wholeFiles.has(h.filePath));
    }

    for (const [filePath, moving] of hunkMoves) {
      const fileOwner = assignments.find((a) => a.filePath === filePath)?.changelistId;
      if (!fileOwner) {
        // Not in any changelist yet, so there is no file-level assignment for these hunks
        // to be an exception to. Skipped rather than thrown: one unassignable path
        // shouldn't abort a multi-row move.
        continue;
      }
      const kept = hunkAssignments.filter((h) => h.filePath !== filePath || !moving.has(h.hunkId));
      // Hunks landing back on the file's own changelist drop their override rather than
      // being stored redundantly, which is what lets isSplit() stay honest and lets a
      // fully-reunited file return to the cheap non-split rendering path.
      const added: HunkAssignment[] =
        changelistId === fileOwner ? [] : [...moving].map((hunkId) => ({ filePath, hunkId, changelistId }));
      hunkAssignments = [...kept, ...added];
    }

    this._state = { ...this._state, assignments, hunkAssignments };
    this.notify();
  }

  /** Reconciles persisted assignments against a fresh git-status snapshot:
   *   - assignments whose file is no longer modified are dropped
   *   - assignments whose file was renamed (per the rename entry's `renamedFrom`) are
   *     carried over to the new path, preserving changelist membership
   *   - modified/untracked files with no assignment yet are auto-assigned to the active
   *     changelist (or Default, if `autoAssignToActive` is off)
   *  Mutates internal state and returns a summary of what moved — see ReconciliationResult
   *  and PRD §7.5/§11 ("Renaming a file in git keeps it in its original changelist"). */
  reconcile(liveChanges: readonly GitFileChange[], options: { autoAssignToActive: boolean }): ReconciliationResult {
    const result: ReconciliationResult = { newlyAssigned: [], droppedAssignments: [], carriedOverRenames: [] };
    const liveByPath = new Map(liveChanges.map((c) => [c.filePath, c]));
    const consumedRenameTargets = new Set<RepoRelativePath>();

    const nextAssignments: ChangelistAssignment[] = [];
    for (const assignment of this._state.assignments) {
      if (liveByPath.has(assignment.filePath)) {
        nextAssignments.push(assignment);
        continue;
      }
      const renameMatch = liveChanges.find(
        (c) => c.kind === 'renamed' && c.renamedFrom === assignment.filePath && !consumedRenameTargets.has(c.filePath)
      );
      if (renameMatch) {
        consumedRenameTargets.add(renameMatch.filePath);
        const carried: ChangelistAssignment = { filePath: renameMatch.filePath, changelistId: assignment.changelistId };
        nextAssignments.push(carried);
        result.carriedOverRenames.push({
          from: assignment.filePath,
          to: renameMatch.filePath,
          changelistId: assignment.changelistId,
        });
        continue;
      }
      // Last resort before dropping: match ignoring case. On Windows and macOS the same
      // file can be reported under different casing than the assignment was stored with
      // (a workspace reopened via a differently-cased path, a case-only rename), and
      // dropping here would silently move the user's file to Default. Re-keyed to the
      // casing git is reporting now, so the next pass matches exactly.
      const caseMatch = liveChanges.find(
        (c) =>
          !consumedRenameTargets.has(c.filePath) &&
          c.filePath !== assignment.filePath &&
          c.filePath.toLowerCase() === assignment.filePath.toLowerCase() &&
          !this._state.assignments.some((a) => a.filePath === c.filePath)
      );
      if (caseMatch) {
        consumedRenameTargets.add(caseMatch.filePath);
        nextAssignments.push({ filePath: caseMatch.filePath, changelistId: assignment.changelistId });
        result.carriedOverRenames.push({
          from: assignment.filePath,
          to: caseMatch.filePath,
          changelistId: assignment.changelistId,
        });
        continue;
      }
      result.droppedAssignments.push(assignment);
    }

    const targetListId = (options.autoAssignToActive ? this.getActiveChangelist() : this.getDefaultChangelist()).id;
    const nowAssignedPaths = new Set(nextAssignments.map((a) => a.filePath));
    for (const change of liveChanges) {
      if (nowAssignedPaths.has(change.filePath)) {
        continue;
      }
      const newAssignment: ChangelistAssignment = { filePath: change.filePath, changelistId: targetListId };
      nextAssignments.push(newAssignment);
      nowAssignedPaths.add(change.filePath);
      result.newlyAssigned.push(newAssignment);
    }

    this._state = { ...this._state, assignments: nextAssignments };
    if (result.newlyAssigned.length || result.droppedAssignments.length || result.carriedOverRenames.length) {
      this.notify();
    }
    return result;
  }

  /** Pure view-builder: groups the latest git-status snapshot by changelist for
   *  rendering. Call reconcile() first — entries for paths not present in `liveChanges`
   *  are silently skipped rather than shown stale, since reconcile() is what's
   *  responsible for dropping/carrying over assignments that no longer match reality.
   *
   *  Passing `hunkIndex` enables split rendering: a file whose hunks span several
   *  changelists yields one entry per owning changelist. Omit it (or pass an index
   *  without that file) and every file renders whole, which is what the status-bar and
   *  commit-count paths want. */
  getFilesGroupedByChangelist(
    liveChanges: readonly GitFileChange[],
    hunkIndex?: HunkIndex
  ): Map<string, ChangelistFileEntry[]> {
    const byPath = new Map(liveChanges.map((c) => [c.filePath, c]));
    const grouped = new Map<string, ChangelistFileEntry[]>();
    for (const cl of this._state.changelists) {
      // A shelved list has no assignments (shelveChangelist() moved them into the
      // shelf), so its rows come from the shelf snapshot instead of live git status.
      grouped.set(
        cl.id,
        cl.shelf
          ? cl.shelf.files.map((f) => ({
              filePath: f.filePath,
              kind: f.kind,
              staged: false,
              changelistId: cl.id,
            }))
          : []
      );
    }
    for (const assignment of this._state.assignments) {
      const change = byPath.get(assignment.filePath);
      if (!change) {
        continue;
      }
      const allHunks = hunkIndex?.get(assignment.filePath);
      const overrides = this.hunkOverridesFor(assignment.filePath);

      if (!allHunks || overrides.size === 0) {
        // Not split: the file belongs wholly to its assigned changelist.
        grouped.get(assignment.changelistId)?.push({ ...change, changelistId: assignment.changelistId });
        continue;
      }

      // Split: bucket every hunk by its effective owner (explicit override, else the
      // file-level assignment) and emit one row per owning changelist.
      const byOwner = new Map<string, string[]>();
      for (const hunkId of allHunks) {
        const owner = overrides.get(hunkId) ?? assignment.changelistId;
        const bucket = byOwner.get(owner);
        if (bucket) {
          bucket.push(hunkId);
        } else {
          byOwner.set(owner, [hunkId]);
        }
      }
      for (const [changelistId, hunkIds] of byOwner) {
        grouped.get(changelistId)?.push({
          ...change,
          changelistId,
          split: { hunkIds, ownedHunks: hunkIds.length, totalHunks: allHunks.length },
        });
      }
    }
    return grouped;
  }

  // ---- hunk-level splitting (PRD §10 v2) ------------------------------------------

  private get hunkAssignments(): readonly HunkAssignment[] {
    return this._state.hunkAssignments ?? [];
  }

  /** hunkId → changelistId for one file, covering only hunks explicitly moved away
   *  from the file's own changelist. */
  private hunkOverridesFor(filePath: RepoRelativePath): Map<string, string> {
    const map = new Map<string, string>();
    for (const h of this.hunkAssignments) {
      if (h.filePath === filePath) {
        map.set(h.hunkId, h.changelistId);
      }
    }
    return map;
  }

  getHunkOverrides(filePath: RepoRelativePath): ReadonlyMap<string, string> {
    return this.hunkOverridesFor(filePath);
  }

  /** True once at least one of `filePath`'s hunks lives in a different changelist than
   *  the file itself. */
  isSplit(filePath: RepoRelativePath): boolean {
    const fileOwner = this.getChangelistIdForFile(filePath);
    return this.hunkAssignments.some((h) => h.filePath === filePath && h.changelistId !== fileOwner);
  }

  /** Moves specific hunks of `filePath` into `changelistId`.
   *
   *  Pass `totalHunks` wherever the caller knows it (the hunk picker does, the tree rows
   *  do): selecting every hunk is then recognised as a whole-file move rather than
   *  producing a file whose assignment says one changelist while every one of its hunks
   *  says another. */
  assignHunks(
    filePath: RepoRelativePath,
    hunkIds: readonly string[],
    changelistId: string,
    options: { totalHunks?: number } = {}
  ): void {
    if (!this.getChangelistIdForFile(filePath)) {
      throw new Error('That file is not in any changelist yet.');
    }
    this.moveRows([{ filePath, changelistId: '', hunkIds, totalHunks: options.totalHunks }], changelistId);
  }

  /** Reunites every hunk of `filePath` under the file's own changelist. */
  clearHunkAssignments(filePath: RepoRelativePath): void {
    if (!this.hunkAssignments.some((h) => h.filePath === filePath)) {
      return;
    }
    this.checkpoint(`reuniting "${filePath}"`);
    this._state = {
      ...this._state,
      hunkAssignments: this.hunkAssignments.filter((h) => h.filePath !== filePath),
    };
    this.notify();
  }

  /** Drops hunk overrides whose hunk no longer exists in the file's current diff, or
   *  whose file/changelist has gone away.
   *
   *  Hunk ids are content-derived (see hunks.ts), so editing a hunk changes its id and
   *  the override is dropped — the hunk falls back to the file's changelist rather than
   *  being silently attributed to a list the user last chose for *different* content.
   *  That is the deliberate conservative choice called for by PRD §12's "defensive
   *  fallback rather than dropping data" guidance: the file itself keeps its assignment,
   *  only the finer-grained override lapses. */
  reconcileHunks(
    hunkIndex: HunkIndex,
    options: { undiffable?: ReadonlySet<RepoRelativePath> } = {}
  ): { droppedHunkAssignments: DroppedHunkAssignment[] } {
    const dropped: DroppedHunkAssignment[] = [];
    const kept: HunkAssignment[] = [];
    const liveChangelistIds = new Set(this._state.changelists.map((c) => c.id));

    for (const h of this.hunkAssignments) {
      // "We could not read this file's diff" is not "this hunk is gone". Treating them the
      // same turns one flaky `git diff` — a momentary index lock, a file briefly held open
      // — into the permanent, silent loss of a split the user set up by hand.
      if (options.undiffable?.has(h.filePath)) {
        kept.push(h);
        continue;
      }
      if (!liveChangelistIds.has(h.changelistId)) {
        dropped.push({ ...h, reason: 'changelist-gone' });
        continue;
      }
      if (!this.getChangelistIdForFile(h.filePath)) {
        dropped.push({ ...h, reason: 'file-gone' });
        continue;
      }
      if (!(hunkIndex.get(h.filePath)?.includes(h.hunkId) ?? false)) {
        dropped.push({ ...h, reason: 'hunk-changed' });
        continue;
      }
      kept.push(h);
    }

    if (dropped.length > 0) {
      this._state = { ...this._state, hunkAssignments: kept };
      this.notify();
    }
    return { droppedHunkAssignments: dropped };
  }
}
