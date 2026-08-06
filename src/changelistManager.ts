import { randomUUID } from 'crypto';
import {
  Changelist,
  ChangelistAssignment,
  ChangelistFileEntry,
  ChangelistState,
  GitFileChange,
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

  constructor(initialState: ChangelistState) {
    this._state = initialState;
  }

  get state(): Readonly<ChangelistState> {
    return this._state;
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

  getActiveChangelist(): Changelist {
    return this._state.changelists.find((c) => c.isActive) ?? this.getDefaultChangelist();
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
      changelists: this._state.changelists
        .filter((c) => c.id !== id)
        .map((c) => (wasActive && c.id === defaultList.id ? { ...c, isActive: true } : c)),
      assignments: nextAssignments,
    };
    this.notify();
    return { movedFilePaths };
  }

  setActiveChangelist(id: string): void {
    if (!this.getChangelist(id)) {
      throw new Error('Changelist not found.');
    }
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
    const restored: ChangelistAssignment[] = shelf.files.map((f) => ({
      filePath: f.filePath,
      changelistId: id,
    }));
    const restoredPaths = new Set(restored.map((r) => r.filePath));
    this._state = {
      changelists: this._state.changelists.map((c) =>
        c.id === id ? { ...c, shelf: undefined } : c
      ),
      // Drop any assignment that has since been created for the same path in another
      // list (the user modified the file again while it was shelved) — the unshelved
      // list wins, since the user explicitly asked for its contents back.
      assignments: [...this._state.assignments.filter((a) => !restoredPaths.has(a.filePath)), ...restored],
    };
    this.notify();
    return shelf;
  }

  getChangelistIdForFile(filePath: RepoRelativePath): string | undefined {
    return this._state.assignments.find((a) => a.filePath === filePath)?.changelistId;
  }

  assignFile(filePath: RepoRelativePath, changelistId: string): void {
    this.assignFiles([filePath], changelistId);
  }

  assignFiles(filePaths: readonly RepoRelativePath[], changelistId: string): void {
    const target = this.getChangelist(changelistId);
    if (!target) {
      throw new Error('Changelist not found.');
    }
    if (target.shelf) {
      throw new Error(`"${target.name}" is shelved; unshelve it before moving files into it.`);
    }
    const targets = new Set(filePaths);
    const remaining = this._state.assignments.filter((a) => !targets.has(a.filePath));
    const additions: ChangelistAssignment[] = filePaths.map((filePath) => ({ filePath, changelistId }));
    this._state = { ...this._state, assignments: [...remaining, ...additions] };
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
   *  responsible for dropping/carrying over assignments that no longer match reality. */
  getFilesGroupedByChangelist(liveChanges: readonly GitFileChange[]): Map<string, ChangelistFileEntry[]> {
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
      const list = grouped.get(assignment.changelistId);
      if (!list) {
        continue;
      }
      list.push({ ...change, changelistId: assignment.changelistId });
    }
    return grouped;
  }
}
