import * as vscode from 'vscode';
import { ChangelistManager } from './changelistManager';
import { GitRepository } from './gitService';
import { logDroppedHunks, logError, logReconciliation } from './log';
import { PersistenceStore } from './persistence';
import { ShelfStore } from './shelfStore';
import { CoalescingRunner, Debouncer } from './scheduling';
import { ChangelistFileEntry, DroppedHunkAssignment, GitFileChange, HunkIndex } from './types';

/** How long to wait for quiet before acting on git's state events. `onDidChange` fires on
 *  every save, every index touch and every focus change, and a refresh costs a `git diff`
 *  per split file — so a burst (a formatter rewriting twenty files, a branch switch)
 *  should cost one pass, not twenty. Short enough to stay imperceptible. */
const REFRESH_DEBOUNCE_MS = 200;

/** Persisting is cheap but not free: in `file` mode every write rewrites
 *  `.vscode/changelists.json`, which appears in the user's own git status and wakes our
 *  own file watcher. Batching a burst of mutations into one write keeps that churn down.
 *  Deliberately short, because this window is also how much work an abrupt shutdown could
 *  lose — deactivate() flushes, but only if it gets the chance to run. */
const PERSIST_DEBOUNCE_MS = 300;

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
  private groupedCache: Map<string, ChangelistFileEntry[]> | undefined;

  /** Whatever the most recent refresh request asked for. Read at the top of every pass so
   *  a re-queued run picks up the current setting rather than the one in force when the
   *  first of the coalesced requests arrived. */
  private autoAssignToActive = true;
  private readonly refreshRunner = new CoalescingRunner(() => this.runRefresh());
  private readonly refreshDebouncer = new Debouncer(REFRESH_DEBOUNCE_MS, () => {
    void this.refreshLiveChanges(this.autoAssignToActive).catch(reportRefreshFailure);
  });

  private readonly persistRunner = new CoalescingRunner(() => this.runPersist());
  private readonly persistDebouncer = new Debouncer(PERSIST_DEBOUNCE_MS, () => {
    void this.persistRunner.trigger();
  });
  /** Latched so a persistently unwritable store reports once, not once per keystroke. */
  private persistFailureReported = false;

  constructor(
    readonly repo: GitRepository,
    readonly manager: ChangelistManager,
    /** Shelved file payloads, kept out of ChangelistState so they never reach a shared
     *  `.vscode/changelists.json`. See shelfStore.ts. */
    readonly shelves: ShelfStore,
    private readonly store: PersistenceStore,
    private readonly onChanged: () => void
  ) {
    this.disposables.push(
      manager.onDidChangeState(() => {
        this.groupedCache = undefined;
        this.persistDebouncer.schedule();
        this.onChanged();
      })
    );
  }

  /** The current snapshot grouped by changelist, computed once per refresh.
   *
   *  Every caller used to rebuild it: once in the tree's change-detection pass, again per
   *  expanded changelist in getChildren(), and a third time *per changelist item* just to
   *  read a count for the badge — so ten changelists meant twenty-one full walks of the
   *  assignment list on every git event. Invalidated whenever the manager mutates or a
   *  refresh replaces the snapshot, which is exactly when it could go stale. */
  get grouped(): Map<string, ChangelistFileEntry[]> {
    if (!this.groupedCache) {
      this.groupedCache = this.manager.getFilesGroupedByChangelist(this.liveChanges, this.hunkIndex);
    }
    return this.groupedCache;
  }

  /** Folder name, as the tree and the repository picker show it. */
  get label(): string {
    return this.repo.rootUri.path.split('/').filter(Boolean).pop() ?? this.repo.rootUri.fsPath;
  }

  /** The parent folder, shown beside the label when two open repositories share a name —
   *  `~/work/web` and `~/oss/web` otherwise render as two identical rows. */
  get parentLabel(): string | undefined {
    const segments = this.repo.rootUri.path.split('/').filter(Boolean);
    return segments.length > 1 ? segments[segments.length - 2] : undefined;
  }

  /** Debounced entry point for high-frequency triggers (git's own state events). Fire and
   *  forget: callers that need to observe the result await refreshLiveChanges() instead. */
  scheduleRefresh(autoAssignToActive: boolean): void {
    this.autoAssignToActive = autoAssignToActive;
    this.refreshDebouncer.schedule();
  }

  /** Refreshes now, superseding any debounced pass. Awaiting this guarantees the caller
   *  observes a snapshot taken at or after the call — see CoalescingRunner. */
  async refreshLiveChanges(autoAssignToActive: boolean): Promise<void> {
    this.autoAssignToActive = autoAssignToActive;
    this.refreshDebouncer.cancel();
    await this.refreshRunner.trigger();
  }

  private async runRefresh(): Promise<void> {
    const autoAssignToActive = this.autoAssignToActive;
    this.groupedCache = undefined;
    this.liveChanges = this.repo.getFileChanges();
    logReconciliation(this.label, this.manager.reconcile(this.liveChanges, { autoAssignToActive }));
    // Diffing every modified file is the expensive part of a refresh, so it's skipped
    // entirely unless some file actually has hunk overrides to reconcile. Repos with no
    // split files — the overwhelmingly common case — never pay for it.
    const scan = (this.manager.state.hunkAssignments ?? []).length
      ? await this.repo.buildHunkIndex(this.liveChanges)
      : undefined;
    this.hunkIndex = scan?.index ?? new Map();
    if (scan) {
      const { droppedHunkAssignments } = this.manager.reconcileHunks(scan.index, {
        undiffable: scan.undiffable,
      });
      logDroppedHunks(this.label, droppedHunkAssignments);
      this.reportLapsedSplits(droppedHunkAssignments);
    }
    this.groupedCache = undefined;
    // reconcile()/reconcileHunks() call onChanged (via manager.onDidChangeState) only
    // when they actually mutated state; still fire a render-only refresh here so file
    // status changes (e.g. a modified file's kind flipping) are reflected even when no
    // assignment moved.
    this.onChanged();
  }

  /** Tells the user when a split they set up has stopped applying.
   *
   *  Hunk identity is a content hash, so editing a split hunk changes its id and the
   *  override lapses — the hunk falls back to the file's own changelist. That fallback is
   *  the right call (attributing edited content to a changelist chosen for *different*
   *  content would be worse), but doing it silently means a split quietly evaporates while
   *  the user is looking elsewhere. Only 'hunk-changed' is reported: the other reasons are
   *  the ordinary consequence of something the user just did, like committing the file. */
  private reportLapsedSplits(dropped: readonly DroppedHunkAssignment[]): void {
    const files = [...new Set(dropped.filter((d) => d.reason === 'hunk-changed').map((d) => d.filePath))];
    if (files.length === 0) {
      return;
    }
    void vscode.window.showInformationMessage(
      files.length === 1
        ? `Changelists: the split of "${files[0]}" lapsed — those hunks were edited, so they are back in the file's own changelist.`
        : `Changelists: splits lapsed on ${files.length} files — their hunks were edited, so they are back in each file's own changelist.`
    );
  }

  private async runPersist(): Promise<void> {
    try {
      await this.store.save(this.repo.rootUri, this.manager.state);
      this.persistFailureReported = false;
    } catch (err) {
      // Swallowing this means the user loses every changelist they made this session and
      // only discovers it on the next restart — so it is reported, but only once per
      // failure streak (a read-only `.vscode` would otherwise notify on every mutation).
      if (!this.persistFailureReported) {
        this.persistFailureReported = true;
        void vscode.window.showErrorMessage(
          `Changelists: could not save changelists for "${this.label}" — ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
  }

  /** Writes out anything the debounce is still holding, and waits for it to land.
   *
   *  Called before this context is torn down (a reload, a shutdown) so a changelist
   *  created moments ago isn't lost to a timer that never fired. */
  async flushPendingWrites(): Promise<void> {
    if (this.persistDebouncer.cancel()) {
      // There was queued work the timer would have done; do it now instead.
      await this.persistRunner.trigger();
      return;
    }
    // Nothing queued. Wait for any write already in flight rather than starting another —
    // otherwise every reload would rewrite every repo's state file just to prove it was
    // already written, which is the churn the debounce exists to avoid.
    await this.persistRunner.whenIdle();
  }

  /** Drops anything the debounce is holding, for the one case where the file on disk is
   *  authoritative and our in-memory state is the stale side: an external edit arriving
   *  via `git pull` or a branch switch. Flushing there would write our copy over the
   *  change we are about to load, which is exactly the silent overwrite the file-mode
   *  design refuses to do. */
  discardPendingWrites(): void {
    this.persistDebouncer.cancel();
  }

  dispose(): void {
    this.refreshDebouncer.cancel();
    this.persistDebouncer.cancel();
    vscode.Disposable.from(...this.disposables).dispose();
  }
}

function reportRefreshFailure(err: unknown): void {
  // Nothing actionable for the user here — a failed status read just means the tree is
  // briefly stale and the next git event will retry — so this stays out of the UI, but it
  // belongs somewhere findable rather than in the developer console.
  logError('Refresh failed', err);
}
