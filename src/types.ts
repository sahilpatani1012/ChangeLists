/** Core domain model. No `vscode` imports here — keeps changelistManager unit-testable
 *  without spinning up the extension host (see src/test/suite/changelistManager.test.ts). */

/** Repo-relative, forward-slash-normalized file path. Always relative to the owning
 *  repository's root, never absolute — see gitService.toRepoRelative(). */
export type RepoRelativePath = string;

export type ChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';

/** One file as captured at shelve time — WebStorm-style: a snapshot the extension owns
 *  outright, not a `git stash` entry. Tracked, HEAD-known content (modified/deleted)
 *  is captured as a unified diff against HEAD, since that's reversible with plain
 *  `git apply` and is human-inspectable. Content with no HEAD blob (untracked/added,
 *  and the "new path" side of a rename) has no meaningful diff to compute, so the raw
 *  file content is captured instead. `kind` is recorded either way because once the
 *  file leaves the working tree it no longer appears in git status at all — the tree
 *  view has no other way to render its M/A/D/R/U letter while shelved. */
export type ShelvedFile =
  | { filePath: RepoRelativePath; kind: 'modified' | 'deleted'; storage: 'patch'; patch: string }
  | {
      filePath: RepoRelativePath;
      kind: 'added' | 'untracked' | 'renamed';
      storage: 'content';
      /** base64-encoded, so binary files round-trip safely. */
      content: string;
      renamedFrom?: RepoRelativePath;
    };

/** Set on a changelist while its contents are shelved. */
export interface ShelfInfo {
  shelvedAt: string;
  files: ShelvedFile[];
}

export interface Changelist {
  readonly id: string;
  name: string;
  description?: string;
  readonly isDefault: boolean;
  isActive: boolean;
  /** Present iff this changelist is currently shelved (v2, PRD §10). */
  shelf?: ShelfInfo;
}

export interface ChangelistAssignment {
  filePath: RepoRelativePath;
  changelistId: string;
}

export interface ChangelistState {
  changelists: Changelist[];
  assignments: ChangelistAssignment[];
}

/** One file as currently reported by git status, prior to changelist grouping. */
export interface GitFileChange {
  readonly filePath: RepoRelativePath;
  readonly kind: ChangeKind;
  /** Present only when kind === 'renamed'; the path it was renamed from. */
  readonly renamedFrom?: RepoRelativePath;
  readonly staged: boolean;
}

/** A file as it will be rendered under a changelist group in the tree. */
export interface ChangelistFileEntry {
  readonly filePath: RepoRelativePath;
  readonly kind: ChangeKind;
  readonly renamedFrom?: RepoRelativePath;
  readonly staged: boolean;
  readonly changelistId: string;
}

/** Result of reconciling persisted assignments against live git status. Returned by
 *  changelistManager.reconcile() so callers (and tests) can observe what moved without
 *  re-deriving it from before/after snapshots. */
export interface ReconciliationResult {
  /** Files newly seen (no prior assignment) and where they landed. */
  newlyAssigned: ChangelistAssignment[];
  /** Files that were assigned but are no longer modified; assignment was dropped. */
  droppedAssignments: ChangelistAssignment[];
  /** Renamed files whose assignment carried over from old path to new path. */
  carriedOverRenames: Array<{ from: RepoRelativePath; to: RepoRelativePath; changelistId: string }>;
}

export function createEmptyState(defaultListName: string): ChangelistState {
  const defaultList: Changelist = {
    id: 'default',
    name: defaultListName,
    isDefault: true,
    isActive: true,
  };
  return { changelists: [defaultList], assignments: [] };
}
