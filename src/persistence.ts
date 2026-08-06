import * as vscode from 'vscode';
import { ChangelistState, createEmptyState } from './types';

const STATE_KEY = 'changelists.state.v1';
const FILE_RELATIVE_PATH = '.vscode/changelists.json';

/** Git leaves these in a file it couldn't auto-merge. Detected explicitly so the user
 *  gets "your changelists file has a merge conflict" rather than a bare JSON parse
 *  error, which is the single most likely way file-mode breaks on a shared branch
 *  (PRD §12's open question about team-shared `.vscode/changelists.json`). */
const CONFLICT_MARKERS = /^(<{7}|={7}|>{7})/m;

export class ChangelistsConflictError extends Error {
  constructor(readonly fileUri: vscode.Uri) {
    super('The changelists file has unresolved merge conflict markers.');
    this.name = 'ChangelistsConflictError';
  }
}

/** Storage backend for a repo's ChangelistState. Two implementations exist
 *  (workspaceState / file) per the `changelists.persistTo` setting — see PRD §7.5/§7.6.
 *  Keyed per-repo root so a multi-repo workspace keeps each repository's changelists
 *  independent. */
export interface PersistenceStore {
  load(repoRoot: vscode.Uri, defaultListName: string): Promise<ChangelistState>;
  save(repoRoot: vscode.Uri, state: ChangelistState): Promise<void>;
  /** Fires when the backing store changed underneath us (file mode only: a teammate's
   *  edit arriving via `git pull`, a branch switch, a hand edit). No-op for
   *  workspaceState, which only this extension instance can write. */
  watch?(repoRoot: vscode.Uri, onExternalChange: () => void): vscode.Disposable;
}

class WorkspaceStateStore implements PersistenceStore {
  constructor(private readonly memento: vscode.Memento) {}

  private key(repoRoot: vscode.Uri): string {
    return `${STATE_KEY}:${repoRoot.toString()}`;
  }

  async load(repoRoot: vscode.Uri, defaultListName: string): Promise<ChangelistState> {
    const stored = this.memento.get<ChangelistState>(this.key(repoRoot));
    return stored ? normalize(stored) : createEmptyState(defaultListName);
  }

  async save(repoRoot: vscode.Uri, state: ChangelistState): Promise<void> {
    await this.memento.update(this.key(repoRoot), state);
  }
}

class FileStore implements PersistenceStore {
  /** Content this store itself last wrote, per file. Used to ignore the file-watcher
   *  event caused by our own save() — without this, every save would round-trip into a
   *  reload, which at best wastes work and at worst fights the user's in-flight edits. */
  private readonly lastWritten = new Map<string, string>();

  private fileUri(repoRoot: vscode.Uri): vscode.Uri {
    return vscode.Uri.joinPath(repoRoot, FILE_RELATIVE_PATH);
  }

  async load(repoRoot: vscode.Uri, defaultListName: string): Promise<ChangelistState> {
    const uri = this.fileUri(repoRoot);
    let text: string;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      text = Buffer.from(bytes).toString('utf8');
    } catch (err) {
      if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') {
        return createEmptyState(defaultListName);
      }
      throw err;
    }

    if (CONFLICT_MARKERS.test(text)) {
      // Deliberately thrown rather than swallowed: silently picking a side of a merge
      // conflict would quietly discard a teammate's changelists. The caller surfaces
      // this and leaves the file untouched for the user to resolve.
      throw new ChangelistsConflictError(uri);
    }

    try {
      const parsed: unknown = JSON.parse(text);
      if (isChangelistState(parsed)) {
        return normalize(parsed);
      }
    } catch {
      // fall through to the shared warning below
    }
    void vscode.window.showWarningMessage(
      `Changelists: ${FILE_RELATIVE_PATH} is malformed; starting from an empty state. It will be rewritten on the next change.`
    );
    return createEmptyState(defaultListName);
  }

  async save(repoRoot: vscode.Uri, state: ChangelistState): Promise<void> {
    const dir = vscode.Uri.joinPath(repoRoot, '.vscode');
    try {
      await vscode.workspace.fs.createDirectory(dir);
    } catch {
      // already exists — fine
    }
    const text = serialize(state);
    this.lastWritten.set(this.fileUri(repoRoot).toString(), text);
    await vscode.workspace.fs.writeFile(this.fileUri(repoRoot), Buffer.from(text, 'utf8'));
  }

  watch(repoRoot: vscode.Uri, onExternalChange: () => void): vscode.Disposable {
    const uri = this.fileUri(repoRoot);
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(repoRoot, FILE_RELATIVE_PATH)
    );
    const handle = async (): Promise<void> => {
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        if (Buffer.from(bytes).toString('utf8') === this.lastWritten.get(uri.toString())) {
          return; // our own write echoing back
        }
      } catch {
        // deleted, or unreadable — treat as an external change worth reacting to
      }
      onExternalChange();
    };
    return vscode.Disposable.from(
      watcher,
      watcher.onDidChange(handle),
      watcher.onDidCreate(handle),
      watcher.onDidDelete(handle)
    );
  }
}

/** Serializes with sorted keys and one entry per line.
 *
 *  The ordering is the entire point: assignments are a set, but JSON.stringify preserves
 *  insertion order, so two teammates whose files differ only in *when* they touched a
 *  path would produce diffs — and merge conflicts — over semantically identical content.
 *  Sorting makes the file a deterministic function of its content, so git only ever sees
 *  a conflict where the two sides genuinely disagree. */
function serialize(state: ChangelistState): string {
  const ordered: ChangelistState = {
    changelists: [...state.changelists].sort(compareById),
    assignments: [...state.assignments].sort(
      (a, b) => a.filePath.localeCompare(b.filePath) || a.changelistId.localeCompare(b.changelistId)
    ),
    hunkAssignments: [...(state.hunkAssignments ?? [])].sort(
      (a, b) => a.filePath.localeCompare(b.filePath) || a.hunkId.localeCompare(b.hunkId)
    ),
  };
  return JSON.stringify(ordered, null, 2) + '\n';
}

function compareById(a: { id: string; isDefault: boolean }, b: { id: string; isDefault: boolean }): number {
  // Default first, so the file reads naturally; everything else by stable id.
  if (a.isDefault !== b.isDefault) {
    return a.isDefault ? -1 : 1;
  }
  return a.id.localeCompare(b.id);
}

/** Repairs states persisted by older versions or hand-edited files, so the rest of the
 *  codebase can rely on ChangelistManager's invariants (exactly one default, at most one
 *  active, no assignments pointing at changelists that don't exist). */
function normalize(state: ChangelistState): ChangelistState {
  const changelists = [...state.changelists];
  if (changelists.length === 0) {
    return createEmptyState('Default');
  }
  if (!changelists.some((c) => c.isDefault)) {
    changelists[0] = { ...changelists[0], isDefault: true };
  }
  if (!changelists.some((c) => c.isActive && !c.shelf)) {
    const fallback = changelists.findIndex((c) => c.isDefault);
    changelists[fallback] = { ...changelists[fallback], isActive: true };
  }
  let seenActive = false;
  const deduped = changelists.map((c) => {
    if (!c.isActive) {
      return c;
    }
    if (seenActive) {
      return { ...c, isActive: false };
    }
    seenActive = true;
    return c;
  });

  const ids = new Set(deduped.map((c) => c.id));
  return {
    changelists: deduped,
    assignments: (state.assignments ?? []).filter((a) => ids.has(a.changelistId)),
    hunkAssignments: (state.hunkAssignments ?? []).filter((h) => ids.has(h.changelistId)),
  };
}

function isChangelistState(value: unknown): value is ChangelistState {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return Array.isArray(v.changelists) && Array.isArray(v.assignments);
}

export function createPersistenceStore(
  mode: 'workspaceState' | 'file',
  memento: vscode.Memento
): PersistenceStore {
  return mode === 'file' ? new FileStore() : new WorkspaceStateStore(memento);
}
