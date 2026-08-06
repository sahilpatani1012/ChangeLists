import * as vscode from 'vscode';
import { ChangelistManager } from './changelistManager';
import { GitRepository } from './gitService';
import { PersistenceStore } from './persistence';
import { GitFileChange, HunkIndex } from './types';

/** Bundles the three pieces every command/UI surface needs for one repository: the
 *  domain manager, the git-facing wrapper, and the latest status snapshot used to
 *  render/validate against. One RepositoryContext exists per repo the workspace has
 *  open — see PRD §4 non-goals ("treat each repo independently, no cross-repo merging"). */
export class RepositoryContext implements vscode.Disposable {
  liveChanges: GitFileChange[] = [];
  /** hunkIds per splittable file, refreshed alongside liveChanges. Empty until the
   *  first refresh; consumers treat a missing entry as "this file isn't split". */
  hunkIndex: HunkIndex = new Map();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    readonly repo: GitRepository,
    readonly manager: ChangelistManager,
    private readonly store: PersistenceStore,
    private readonly onChanged: () => void
  ) {
    this.disposables.push(
      manager.onDidChangeState(() => {
        void this.persist();
        this.onChanged();
      })
    );
  }

  get label(): string {
    return this.repo.rootUri.path.split('/').filter(Boolean).pop() ?? this.repo.rootUri.fsPath;
  }

  async refreshLiveChanges(autoAssignToActive: boolean): Promise<void> {
    this.liveChanges = this.repo.getFileChanges();
    this.manager.reconcile(this.liveChanges, { autoAssignToActive });
    // Diffing every modified file is the expensive part of a refresh, so it's skipped
    // entirely unless some file actually has hunk overrides to reconcile. Repos with no
    // split files — the overwhelmingly common case — never pay for it.
    this.hunkIndex = (this.manager.state.hunkAssignments ?? []).length
      ? await this.repo.buildHunkIndex(this.liveChanges)
      : new Map();
    this.manager.reconcileHunks(this.hunkIndex);
    // reconcile()/reconcileHunks() call onChanged (via manager.onDidChangeState) only
    // when they actually mutated state; still fire a render-only refresh here so file
    // status changes (e.g. a modified file's kind flipping) are reflected even when no
    // assignment moved.
    this.onChanged();
  }

  private async persist(): Promise<void> {
    await this.store.save(this.repo.rootUri, this.manager.state);
  }

  dispose(): void {
    vscode.Disposable.from(...this.disposables).dispose();
  }
}
