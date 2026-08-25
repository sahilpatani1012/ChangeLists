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

/** What the tree needs to render one shelved row — and nothing more.
 *
 *  Kept separate from ShelvedFile because this half lives in ChangelistState, which in
 *  `file` mode is `.vscode/changelists.json`: a file the README tells teams to commit.
 *  Patches and base64 file contents have no business in a shared, committed artifact —
 *  that publishes private work-in-progress into the repository, and anything sensitive
 *  along with it. The payloads live in the shelf store instead (see shelfStore.ts). */
export interface ShelvedFileMeta {
  filePath: RepoRelativePath;
  kind: ChangeKind;
  renamedFrom?: RepoRelativePath;
}

/** Set on a changelist while its contents are shelved. */
export interface ShelfInfo {
  shelvedAt: string;
  files: ShelvedFileMeta[];
}

/** Strips a captured payload down to what ChangelistState is allowed to hold. Accepts
 *  metadata too, so it can be mapped over a mixed array while migrating state written
 *  before the payloads moved out. */
export function toShelvedFileMeta(file: ShelvedFileMeta | ShelvedFile): ShelvedFileMeta {
  const renamedFrom = 'renamedFrom' in file ? file.renamedFrom : undefined;
  return { filePath: file.filePath, kind: file.kind, ...(renamedFrom ? { renamedFrom } : {}) };
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

/** Overrides the *file-level* assignment for one hunk (PRD §10 v2, hunk-level splitting).
 *  Only exception-assignments are stored: a hunk with no entry here belongs to whichever
 *  changelist owns the file. That keeps the common "file isn't split at all" case free of
 *  per-hunk bookkeeping, and means a file's hunks can never all silently orphan
 *  themselves if their ids drift. */
export interface HunkAssignment {
  filePath: RepoRelativePath;
  hunkId: string;
  changelistId: string;
}

/** One row as the tree renders it, for moving. A whole file is a row with no `hunkIds`;
 *  one changelist's share of a split file is a row that names them. See
 *  ChangelistManager.moveRows() for why the distinction has to survive to the mover. */
export interface MovableRow {
  readonly filePath: RepoRelativePath;
  /** The changelist the row currently sits under. */
  readonly changelistId: string;
  /** Present only for a split row: the hunks this row represents. */
  readonly hunkIds?: readonly string[];
  /** The file's total hunk count, where the caller knows it, so a selection covering all
   *  of them is recognised as a whole-file move. */
  readonly totalHunks?: number;
}

/** Why a hunk override stopped applying. Only 'hunk-changed' is worth telling the user
 *  about: the others are the ordinary consequence of an action they just took (committing
 *  the file, reverting it, deleting the changelist). */
export type DroppedHunkReason = 'hunk-changed' | 'file-gone' | 'changelist-gone';

export type DroppedHunkAssignment = HunkAssignment & { reason: DroppedHunkReason };

/** Bumped when the persisted shape changes in a way a previous version would misread.
 *  Written by stateFile.serialize()/normalize(); state without it is pre-versioned (0.x
 *  through 1.0) and is upgraded on load. */
export const SCHEMA_VERSION = 2;

export interface ChangelistState {
  /** Absent in state written before 1.1. */
  version?: number;
  changelists: Changelist[];
  assignments: ChangelistAssignment[];
  /** Optional for backward compatibility with 0.x persisted state. */
  hunkAssignments?: HunkAssignment[];
}

/** One file as currently reported by git status, prior to changelist grouping. */
export interface GitFileChange {
  readonly filePath: RepoRelativePath;
  readonly kind: ChangeKind;
  /** Present only when kind === 'renamed'; the path it was renamed from. A file that was
   *  renamed and then edited reports `renamed` here rather than `modified` — git's own
   *  `RM` status — so this stays set through the edit. */
  readonly renamedFrom?: RepoRelativePath;
  readonly staged: boolean;
  /** Set for a file with unresolved merge conflicts. Such a file can be grouped and shown,
   *  but not split (its diff describes the conflict) and not committed. */
  readonly conflicted?: boolean;
}

/** A file as it will be rendered under a changelist group in the tree. When a file's
 *  hunks are split across changelists it yields one entry per owning changelist, each
 *  describing only that changelist's share via `split`. */
export interface ChangelistFileEntry {
  readonly filePath: RepoRelativePath;
  readonly kind: ChangeKind;
  readonly renamedFrom?: RepoRelativePath;
  readonly staged: boolean;
  readonly conflicted?: boolean;
  readonly changelistId: string;
  /** Present only for files whose hunks are split across multiple changelists. */
  readonly split?: {
    /** Hunk ids owned by this changelist. */
    readonly hunkIds: readonly string[];
    readonly ownedHunks: number;
    readonly totalHunks: number;
  };
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
  return { version: SCHEMA_VERSION, changelists: [defaultList], assignments: [], hunkAssignments: [] };
}

/** Maps each file that currently has a diff to the ids of the hunks it contains, in
 *  file order. Built by gitService.buildHunkIndex() from live `git diff` output and
 *  handed to the manager, which stays free of git and vscode imports. */
export type HunkIndex = ReadonlyMap<RepoRelativePath, readonly string[]>;
