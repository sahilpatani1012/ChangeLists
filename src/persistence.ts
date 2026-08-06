import * as vscode from 'vscode';
import { ChangelistState, createEmptyState } from './types';

const STATE_KEY = 'changelists.state.v1';
const FILE_RELATIVE_PATH = '.vscode/changelists.json';

/** Storage backend for a repo's ChangelistState. Two implementations exist
 *  (workspaceState / file) per the `changelists.persistTo` setting — see PRD §7.5/§7.6
 *  and the open question in §12 about why file-mode isn't the default (merge conflicts
 *  on shared JSON across teammates). Keyed per-repo root so a multi-repo workspace keeps
 *  each repository's changelists independent. */
export interface PersistenceStore {
  load(repoRoot: vscode.Uri, defaultListName: string): Promise<ChangelistState>;
  save(repoRoot: vscode.Uri, state: ChangelistState): Promise<void>;
}

class WorkspaceStateStore implements PersistenceStore {
  constructor(private readonly memento: vscode.Memento) {}

  private key(repoRoot: vscode.Uri): string {
    return `${STATE_KEY}:${repoRoot.toString()}`;
  }

  async load(repoRoot: vscode.Uri, defaultListName: string): Promise<ChangelistState> {
    const stored = this.memento.get<ChangelistState>(this.key(repoRoot));
    return stored ?? createEmptyState(defaultListName);
  }

  async save(repoRoot: vscode.Uri, state: ChangelistState): Promise<void> {
    await this.memento.update(this.key(repoRoot), state);
  }
}

class FileStore implements PersistenceStore {
  private fileUri(repoRoot: vscode.Uri): vscode.Uri {
    return vscode.Uri.joinPath(repoRoot, FILE_RELATIVE_PATH);
  }

  async load(repoRoot: vscode.Uri, defaultListName: string): Promise<ChangelistState> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.fileUri(repoRoot));
      const parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
      if (isChangelistState(parsed)) {
        return parsed;
      }
      // Malformed file (hand-edited, merge conflict markers, etc.) — don't throw and
      // don't silently discard the user's on-disk data by overwriting it; fall back to
      // an empty state in memory but leave the broken file alone until the next save().
      void vscode.window.showWarningMessage(
        'Changelists: .vscode/changelists.json is malformed; starting from an empty state. The file will be fixed on next save.'
      );
      return createEmptyState(defaultListName);
    } catch (err) {
      if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') {
        return createEmptyState(defaultListName);
      }
      throw err;
    }
  }

  async save(repoRoot: vscode.Uri, state: ChangelistState): Promise<void> {
    const dir = vscode.Uri.joinPath(repoRoot, '.vscode');
    try {
      await vscode.workspace.fs.createDirectory(dir);
    } catch {
      // already exists — fine
    }
    const bytes = Buffer.from(JSON.stringify(state, null, 2) + '\n', 'utf8');
    await vscode.workspace.fs.writeFile(this.fileUri(repoRoot), bytes);
  }
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
