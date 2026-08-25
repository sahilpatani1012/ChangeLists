import * as vscode from 'vscode';
import { ChangelistManager } from './changelistManager';
import { discoverRepositories, GitRepository, watchRepositoryDiscovery } from './gitService';
import { ChangelistsConflictError, createPersistenceStore, PersistenceStore } from './persistence';
import { RepositoryContext } from './repositoryContext';
import { migrateInlineShelves, ShelfStore } from './shelfStore';
import { logError } from './log';
import { CoalescingRunner } from './scheduling';
import { Changelist, ChangelistFileEntry, ChangeKind, createEmptyState } from './types';

export interface RepoNode {
  readonly kind: 'repo';
  readonly context: RepositoryContext;
}
export interface ChangelistNode {
  readonly kind: 'changelist';
  readonly context: RepositoryContext;
  /** Mutable so the cached node (see nodeCache) can be re-pointed at the current
   *  immutable Changelist without breaking the object identity scoped refresh needs. */
  changelist: Changelist;
}
export interface FileNode {
  readonly kind: 'file';
  readonly context: RepositoryContext;
  readonly changelist: Changelist;
  readonly entry: ChangelistFileEntry;
}
export interface EmptyStateNode {
  readonly kind: 'empty';
  readonly context: RepositoryContext;
  readonly changelist: Changelist;
}

export type ChangelistTreeNode = RepoNode | ChangelistNode | FileNode | EmptyStateNode;

/** What to do with state still sitting in the persistence debounce when a discovery pass
 *  tears the current contexts down. See ChangelistsTreeDataProvider.initialize(). */
type PendingWrites = 'flush' | 'discard';

type PersistMode = 'workspaceState' | 'file';

const STATUS_LETTER: Record<ChangeKind, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
};

/** Renders every open repository's changelists as a tree, per PRD §7.4/§8.2. Also owns
 *  the set of RepositoryContexts (one per repo) — the extension's only other stateful
 *  singleton is the status bar item, which reads through this provider's contexts. */
export class ChangelistsTreeDataProvider implements vscode.TreeDataProvider<ChangelistTreeNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<ChangelistTreeNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private contexts: RepositoryContext[] = [];
  /** Everything created by the *current* discovery pass: the RepositoryContexts, their
   *  git state subscriptions, and their store watchers. Disposed wholesale at the top of
   *  the next pass.
   *
   *  Scoping matters more than it looks: these used to accumulate forever. A stale git
   *  subscription keeps driving a context that was already disposed, and — because a
   *  store watcher's handler re-enters discovery — every external change to
   *  `.vscode/changelists.json` left behind one more watcher than it found, so the count
   *  doubled per reload until the window became unusable. */
  private perPass: vscode.Disposable[] = [];
  private discoveryWatcher: vscode.Disposable | undefined;
  /** Serializes discovery. Concurrent callers join the running pass rather than starting
   *  a second one — two interleaved passes each reset `contexts` and then each append to
   *  it, leaving one repository rendered (and persisting) twice. The runner's re-run
   *  guarantees the last caller still gets a pass that began after it asked. */
  private readonly discoveryRunner = new CoalescingRunner(() => this.runDiscoveryPass());
  /** Latched by callers, consumed by the next pass. See initialize(). */
  private nextPendingWrites: PendingWrites = 'flush';

  /** Stable ChangelistNode instances, keyed `${repoRoot}::${changelistId}`.
   *
   *  Required for scoped refresh to work at all: `onDidChangeTreeData.fire(element)`
   *  matches by object identity, so handing VS Code a freshly-built node object each
   *  time would make every scoped fire a silent no-op and force us back to full
   *  re-renders. */
  private readonly nodeCache = new Map<string, ChangelistNode>();
  /** Repo nodes are cached for the same reason changelist nodes are: reveal() and scoped
   *  refresh both match by object identity. */
  private readonly repoNodeCache = new Map<string, RepoNode>();
  private treeView: vscode.TreeView<ChangelistTreeNode> | undefined;

  /** Last-rendered content signature per changelist, for diffing (PRD §9: "diff against
   *  previous state and patch the tree view" rather than re-rendering everything on
   *  every git status poll — those fire on every save and focus change). */
  private readonly signatures = new Map<string, string>();

  /** Selected from `changelists.persistTo` on every discovery pass. Previously built once
   *  during activation, which meant changing the setting did nothing until the window was
   *  reloaded — and then silently started from an empty state in the other backend. */
  private store: PersistenceStore;
  private storeMode: PersistMode | undefined;

  constructor(
    private readonly memento: vscode.Memento,
    private readonly shelves: ShelfStore
  ) {
    // Set before the first discovery pass completes, so the gap between activation and
    // discovery shows the welcome content rather than an unexplained blank panel.
    void vscode.commands.executeCommand('setContext', 'changelists.noRepo', true);
    this.store = createPersistenceStore(this.config().persistTo, memento);
    this.storeMode = this.config().persistTo;
  }

  /** Wired after construction, because the view needs this provider to exist first. Only
   *  used for reveal(). */
  setTreeView(view: vscode.TreeView<ChangelistTreeNode>): void {
    this.treeView = view;
  }

  /** Scrolls to and selects a changelist. Creating one otherwise left the user hunting for
   *  a new collapsed group somewhere in the list before they could put anything in it. */
  async revealChangelist(context: RepositoryContext, changelistId: string): Promise<void> {
    const node = this.nodeCache.get(this.nodeKey(context, changelistId));
    if (!node || !this.treeView?.visible) {
      return;
    }
    try {
      await this.treeView.reveal(node, { select: true, focus: false, expand: true });
    } catch {
      // reveal() rejects if the node isn't currently in the rendered tree; not worth
      // surfacing, since the list itself was still created.
    }
  }

  /** Required for reveal(). A changelist's parent is its repo node in a multi-repo
   *  workspace, and nothing at all when a single repo is rendered at the root. */
  getParent(node: ChangelistTreeNode): ChangelistTreeNode | undefined {
    if (node.kind === 'changelist' && this.contexts.length > 1) {
      return this.repoNode(node.context);
    }
    if (node.kind === 'file' || node.kind === 'empty') {
      return this.nodeCache.get(this.nodeKey(node.context, node.changelist.id));
    }
    return undefined;
  }

  private repoNode(context: RepositoryContext): RepoNode {
    const key = context.repo.rootUri.toString();
    const cached = this.repoNodeCache.get(key);
    if (cached) {
      return cached;
    }
    const created: RepoNode = { kind: 'repo', context };
    this.repoNodeCache.set(key, created);
    return created;
  }

  /** Discovers repositories and (re)builds a context for each. Safe to call concurrently
   *  and re-entrantly: a call arriving mid-pass joins the running one and asks it to go
   *  round again, so the last request always gets a pass that started after it.
   *
   *  `pendingWrites` decides what happens to state still sitting in the persistence
   *  debounce when the outgoing contexts are torn down — see RepositoryContext. Default
   *  'flush' keeps the user's recent work; the store watcher passes 'discard', because
   *  there the file on disk is the newer side. */
  async initialize(options: { pendingWrites?: PendingWrites } = {}): Promise<void> {
    // 'discard' latches: it means the file changed underneath us, which makes anything
    // queued in memory the stale side regardless of what any other caller asked for. The
    // flag survives until a pass consumes it, so a request arriving mid-pass still
    // governs the re-run that request triggers.
    if ((options.pendingWrites ?? 'flush') === 'discard') {
      this.nextPendingWrites = 'discard';
    }
    await this.discoveryRunner.trigger();
  }

  private async runDiscoveryPass(): Promise<void> {
    const pendingWrites = this.nextPendingWrites;
    this.nextPendingWrites = 'flush';
    await this.rediscoverRepositories(pendingWrites);
    // Re-armed each pass rather than once: the git extension may not have been active the
    // first time round, in which case watchRepositoryDiscovery() returned a no-op.
    this.discoveryWatcher?.dispose();
    this.discoveryWatcher = watchRepositoryDiscovery(() => {
      void this.initialize().catch(reportInitializeFailure);
    });
  }

  private config() {
    const cfg = vscode.workspace.getConfiguration('changelists');
    return {
      defaultListName: cfg.get<string>('defaultListName', 'Default'),
      autoAssignToActive: cfg.get<boolean>('autoAssignNewFilesToActive', true),
      persistTo: cfg.get<PersistMode>('persistTo', 'workspaceState'),
    };
  }

  private async rediscoverRepositories(pendingWrites: PendingWrites): Promise<void> {
    const { repositories: repos, gitAvailable } = await discoverRepositories();
    void vscode.commands.executeCommand('setContext', 'changelists.noRepo', repos.length === 0);
    void vscode.commands.executeCommand('setContext', 'changelists.gitUnavailable', !gitAvailable);

    // Settle the outgoing contexts before the loads below read the store again, so a
    // debounced write can't land on top of state we've already re-read.
    if (pendingWrites === 'flush') {
      await Promise.all(this.contexts.map((ctx) => ctx.flushPendingWrites()));
    } else {
      for (const ctx of this.contexts) {
        ctx.discardPendingWrites();
      }
    }
    // Contexts, their git subscriptions and their store watchers all die here together.
    vscode.Disposable.from(...this.perPass).dispose();
    this.perPass = [];
    this.nodeCache.clear();
    this.repoNodeCache.clear();
    this.signatures.clear();

    const { defaultListName, autoAssignToActive, persistTo } = this.config();
    await this.adoptStore(persistTo, repos, defaultListName);
    this.contexts = [];
    for (const repo of repos) {
      let state;
      try {
        state = await this.store.load(repo.rootUri, defaultListName);
      } catch (err) {
        if (err instanceof ChangelistsConflictError) {
          // Don't guess a winner and don't overwrite: skip this repo entirely this pass
          // so the file stays exactly as git left it, and re-run once it's resolved.
          void this.promptConflictResolution(err);
          continue;
        }
        throw err;
      }
      // store.load() already falls back to createEmptyState() when nothing was
      // persisted; this second guard only catches a hand-edited changelists.json that's
      // shape-valid (passes isChangelistState) but has an empty changelists array,
      // which would otherwise violate ChangelistManager's "a default always exists"
      // invariant the first time getDefaultChangelist() is called.
      // State written before 1.1 carries shelf payloads inline; move them into the shelf
      // store so an existing shelve stays retrievable — and so a shared changelists.json
      // stops carrying somebody's work-in-progress.
      try {
        const migrated = await migrateInlineShelves(this.shelves, repo.rootUri, state);
        if (migrated) {
          state = migrated;
          await this.store.save(repo.rootUri, migrated);
        }
      } catch (err) {
        void vscode.window.showWarningMessage(
          `Changelists: could not move shelved contents out of the state file for "${repo.rootUri.fsPath}" — ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
      const manager = new ChangelistManager(state.changelists.length ? state : createEmptyState(defaultListName));
      const context = new RepositoryContext(repo, manager, this.shelves, this.store, () => this.refreshChanged());
      this.perPass.push(
        context,
        // Debounced: this fires on every save, index touch and focus change, and a
        // refresh is not free once any file in the repo is split.
        repo.onDidChangeState(() => context.scheduleRefresh(this.config().autoAssignToActive))
      );
      const externalWatch = this.store.watch?.(repo.rootUri, () => {
        // A teammate's changelists.json arrived (pull/branch switch/hand edit). Reload
        // from scratch rather than merging in-memory state over it — the file is the
        // source of truth in file mode, and a silent three-way merge here is exactly the
        // kind of guess that loses somebody's grouping. Same reasoning discards our own
        // pending write instead of flushing it over what just arrived.
        void this.initialize({ pendingWrites: 'discard' }).catch(reportInitializeFailure);
      });
      if (externalWatch) {
        this.perPass.push(externalWatch);
      }
      this.contexts.push(context);
      await context.refreshLiveChanges(autoAssignToActive);
    }
    this._onDidChangeTreeData.fire();
  }

  /** Switches backends when `changelists.persistTo` changed, carrying existing state over.
   *
   *  Without the copy, flipping the setting reads an empty destination, reconcile drops
   *  every file into a fresh Default, and the next mutation persists that over the top —
   *  so a settings change silently destroyed every changelist. Repos already set up in the
   *  destination are left alone: the user configured those deliberately, and overwriting
   *  them would trade one silent loss for another. */
  private async adoptStore(mode: PersistMode, repos: readonly GitRepository[], defaultListName: string): Promise<void> {
    if (this.storeMode === mode) {
      return;
    }
    const previous = this.store;
    this.store = createPersistenceStore(mode, this.memento);
    this.storeMode = mode;

    const migrated: string[] = [];
    for (const repo of repos) {
      try {
        if ((await this.store.hasState(repo.rootUri)) || !(await previous.hasState(repo.rootUri))) {
          continue;
        }
        await this.store.save(repo.rootUri, await previous.load(repo.rootUri, defaultListName));
        migrated.push(repo.rootUri.path.split('/').filter(Boolean).pop() ?? repo.rootUri.fsPath);
      } catch (err) {
        // A single unreadable source (a conflicted file, a permissions problem) shouldn't
        // stop the other repos migrating, and shouldn't abort the pass either.
        void vscode.window.showWarningMessage(
          `Changelists: could not carry changelists over for "${repo.rootUri.fsPath}" — ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
    if (migrated.length > 0) {
      const destination = mode === 'file' ? '.vscode/changelists.json' : "VS Code's workspace storage";
      void vscode.window.showInformationMessage(
        `Changelists: moved changelists for ${migrated.length === 1 ? `"${migrated[0]}"` : `${migrated.length} repositories`} to ${destination}.`
      );
    }
  }

  private async promptConflictResolution(err: ChangelistsConflictError): Promise<void> {
    const open = 'Open File';
    const retry = 'Retry';
    const choice = await vscode.window.showErrorMessage(
      `Changelists: ${vscode.workspace.asRelativePath(err.fileUri)} has unresolved merge conflict markers. Resolve them to load this repository's changelists.`,
      open,
      retry
    );
    if (choice === open) {
      await vscode.window.showTextDocument(err.fileUri);
    } else if (choice === retry) {
      await this.initialize();
    }
  }

  async refreshAll(): Promise<void> {
    const { autoAssignToActive } = this.config();
    for (const ctx of this.contexts) {
      await ctx.refreshLiveChanges(autoAssignToActive);
    }
  }

  /** Fires the narrowest tree event that covers what actually changed.
   *
   *  git's `onDidChange` fires far more often than the rendered content changes (every
   *  save, every index touch, every focus change), and a bare `fire()` re-renders and
   *  re-sorts every row in every changelist — visible jank on the 1,000+ changed file
   *  repos PRD §9 calls out. So: rebuild each changelist's signature, and fire only for
   *  the ones whose signature moved. When the *set* of changelists changed, fall back to
   *  a full refresh, since added/removed groups can't be expressed as per-node events. */
  private refreshChanged(): void {
    // Drives the undo button's visibility. Recomputed here because this is the one place
    // every mutation funnels through.
    void vscode.commands.executeCommand(
      'setContext',
      'changelists.canUndo',
      this.contexts.some((c) => c.manager.undoableAction !== undefined)
    );
    const nextSignatures = new Map<string, string>();
    const changedKeys: string[] = [];

    for (const context of this.contexts) {
      const grouped = context.grouped;
      for (const changelist of context.manager.getChangelists()) {
        const key = this.nodeKey(context, changelist.id);
        const entries = grouped.get(changelist.id) ?? [];
        const signature = [
          changelist.name,
          changelist.isActive ? 'A' : '-',
          changelist.shelf ? 'S' : '-',
          ...entries
            .map((e) => `${e.filePath}:${e.kind}:${e.staged ? 's' : '-'}:${e.split?.ownedHunks ?? ''}/${e.split?.totalHunks ?? ''}`)
            .sort(),
        ].join('|');
        nextSignatures.set(key, signature);
        if (this.signatures.get(key) !== signature) {
          changedKeys.push(key);
        }
      }
    }

    const structureChanged =
      nextSignatures.size !== this.signatures.size ||
      [...nextSignatures.keys()].some((k) => !this.signatures.has(k));

    this.signatures.clear();
    for (const [k, v] of nextSignatures) {
      this.signatures.set(k, v);
    }

    if (structureChanged) {
      this._onDidChangeTreeData.fire();
      return;
    }
    let patched = false;
    for (const key of changedKeys) {
      const node = this.nodeCache.get(key);
      if (node) {
        this._onDidChangeTreeData.fire(node);
        patched = true;
      }
    }
    // A changelist the user has never expanded has no cached node, so there is nothing
    // rendered to patch — but other listeners still need to know. The status bar is one:
    // without this, switching the active changelist from the status bar itself left the
    // status bar showing the old name whenever the view had never been opened. Cheap,
    // because "nothing is cached" means "nothing is rendered".
    if (!patched && changedKeys.length > 0) {
      this._onDidChangeTreeData.fire();
    }
  }

  /** The parent folder, but only when another open repository shares this one's name —
   *  so the extra text is paid for only in the workspaces that need it. */
  private disambiguator(context: RepositoryContext): string | undefined {
    const collides = this.contexts.some((other) => other !== context && other.label === context.label);
    return collides ? context.parentLabel : undefined;
  }

  private nodeKey(context: RepositoryContext, changelistId: string): string {
    return `${context.repo.rootUri.toString()}::${changelistId}`;
  }

  getContexts(): readonly RepositoryContext[] {
    return this.contexts;
  }

  /** Resolves the RepositoryContext a command should act on: the one carried by the
   *  invoking tree node, if any; the sole open repo, if there's exactly one; otherwise
   *  prompts with a quick-pick (multi-repo workspace, invoked from the command palette). */
  async resolveContext(node?: ChangelistTreeNode): Promise<RepositoryContext | undefined> {
    if (node) {
      return node.context;
    }
    if (this.contexts.length === 1) {
      return this.contexts[0];
    }
    if (this.contexts.length === 0) {
      void vscode.window.showWarningMessage('Changelists: no git repository found in this workspace.');
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      this.contexts.map((c) => ({
        label: c.label,
        description: this.disambiguator(c),
        detail: c.repo.rootUri.fsPath,
        context: c,
      })),
      { placeHolder: 'Select a repository' }
    );
    return picked?.context;
  }

  getTreeItem(node: ChangelistTreeNode): vscode.TreeItem {
    switch (node.kind) {
      case 'repo':
        return this.repoTreeItem(node);
      case 'changelist':
        return this.changelistTreeItem(node);
      case 'file':
        return this.fileTreeItem(node);
      case 'empty':
        return this.emptyTreeItem(node);
    }
  }

  getChildren(node?: ChangelistTreeNode): ChangelistTreeNode[] {
    if (!node) {
      if (this.contexts.length > 1) {
        return this.contexts.map((context) => this.repoNode(context));
      }
      return this.contexts.length === 1 ? this.changelistNodes(this.contexts[0]) : [];
    }
    if (node.kind === 'repo') {
      return this.changelistNodes(node.context);
    }
    if (node.kind === 'changelist') {
      const grouped = node.context.grouped;
      const entries = (grouped.get(node.changelist.id) ?? []).slice().sort((a, b) => a.filePath.localeCompare(b.filePath));
      if (entries.length === 0) {
        return [{ kind: 'empty', context: node.context, changelist: node.changelist }];
      }
      return entries.map((entry) => ({ kind: 'file', context: node.context, changelist: node.changelist, entry }));
    }
    return [];
  }

  private changelistNodes(context: RepositoryContext): ChangelistNode[] {
    return context.manager
      .getChangelists()
      .slice()
      // Default last, everything else by name. Previously the non-default lists kept
      // whatever order the array happened to be in — creation order in a live session, but
      // UUID order once reloaded from disk, so the tree silently rearranged itself on every
      // restart.
      .sort((a, b) =>
        a.isDefault !== b.isDefault
          ? a.isDefault
            ? 1
            : -1
          : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      )
      .map((changelist) => {
        // Reuse the cached instance so refreshChanged()'s scoped fires match by
        // identity, but refresh its `changelist` payload — the Changelist objects are
        // replaced wholesale on every manager mutation (the state is immutable), so a
        // node holding the original would render a stale name/active flag forever.
        const key = this.nodeKey(context, changelist.id);
        const cached = this.nodeCache.get(key);
        if (cached) {
          cached.changelist = changelist;
          return cached;
        }
        const created: ChangelistNode = { kind: 'changelist', context, changelist };
        this.nodeCache.set(key, created);
        return created;
      });
  }

  private repoTreeItem(node: RepoNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.context.label, vscode.TreeItemCollapsibleState.Expanded);
    item.iconPath = new vscode.ThemeIcon('repo');
    item.description = [this.disambiguator(node.context), node.context.repo.branchName]
      .filter(Boolean)
      .join(' · ');
    item.tooltip = node.context.repo.rootUri.fsPath;
    item.contextValue = 'repo';
    return item;
  }

  private changelistTreeItem(node: ChangelistNode): vscode.TreeItem {
    const { changelist, context } = node;
    const grouped = context.grouped;
    const count = grouped.get(changelist.id)?.length ?? 0;

    if (changelist.shelf) {
      // Shelved lists collapse by default and read as inert: their files aren't in the
      // working tree, so an expanded group of rows you can't act on would misrepresent
      // the state. The archive icon + "shelved" text is the whole affordance.
      const item = new vscode.TreeItem(changelist.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `${context.repo.rootUri.toString()}::${changelist.id}`;
      item.iconPath = new vscode.ThemeIcon('archive');
      item.description = `${count} · shelved`;
      item.tooltip = new vscode.MarkdownString(
        `**${changelist.name}** — shelved ${new Date(changelist.shelf.shelvedAt).toLocaleString()}\n\n` +
          `${count} file${count === 1 ? '' : 's'} saved aside (not in your working tree).\n\nUnshelve to restore them.`
      );
      item.contextValue = 'changelistShelved';
      return item;
    }

    const item = new vscode.TreeItem(changelist.name, vscode.TreeItemCollapsibleState.Expanded);
    item.id = `${context.repo.rootUri.toString()}::${changelist.id}`;
    item.iconPath = new vscode.ThemeIcon(changelist.isActive ? 'circle-large-filled' : 'circle-large-outline');
    item.description = `${count}`;
    item.tooltip = changelist.description
      ? `${changelist.name}\n${changelist.description}`
      : changelist.name;
    // TreeItem has no "bold" API, and a FileDecoration would apply globally rather than
    // to this view, so the active list is marked two ways instead: a filled icon (above)
    // and the word "active" in the description — which is what a screen reader reads out.
    if (changelist.isActive) {
      item.description = `${count} · active`;
    }
    item.contextValue = changelist.isDefault ? 'changelistDefault' : 'changelist';
    return item;
  }

  private fileTreeItem(node: FileNode): vscode.TreeItem {
    const { entry, context } = node;
    const uri = context.repo.toAbsoluteUri(entry.filePath);
    const item = new vscode.TreeItem(uri, vscode.TreeItemCollapsibleState.None);
    const segments = entry.filePath.split('/');
    const fileName = segments[segments.length - 1] + (entry.kind === 'deleted' ? ' (deleted)' : '');
    const dir = segments.slice(0, -1).join('/');
    item.label = fileName;

    if (node.changelist.shelf) {
      // A shelved row describes a snapshot, not something in the working tree. Opening it
      // would show whatever HEAD has (or nothing at all), and discard/move/split would act
      // on content that isn't there. A contextValue outside the `changelistFile` family
      // keeps every file menu off it, and leaving `command` unset makes clicking the row
      // do nothing rather than something wrong.
      item.contextValue = 'shelvedFile';
      item.description = dir ? `${dir}  ${statusLetter(entry.kind)} · shelved` : `${statusLetter(entry.kind)} · shelved`;
      item.id = `${context.repo.rootUri.toString()}::${node.changelist.id}::${entry.filePath}`;
      item.resourceUri = uri;
      item.tooltip = new vscode.MarkdownString(
        `**${entry.filePath}**\n\n${entry.kind} · shelved\n\n` +
          `Not in your working tree. Unshelve "${node.changelist.name}" to bring it back.`
      );
      return item;
    }

    if (entry.conflicted) {
      // A conflicted file can be grouped and opened, but not split (its diff describes the
      // conflict rather than a set of changes to apportion) and not committed. The distinct
      // contextValue is what keeps Split Hunks off it.
      item.contextValue = 'changelistFileConflicted';
      item.description = dir ? `${dir}  conflict` : 'conflict';
      item.iconPath = new vscode.ThemeIcon('warning');
      item.resourceUri = uri;
      item.id = `${context.repo.rootUri.toString()}::${node.changelist.id}::${entry.filePath}`;
      item.command = { command: 'changelists.openFile', title: 'Open File', arguments: [node] };
      item.tooltip = new vscode.MarkdownString(
        `**${entry.filePath}**

Unresolved merge conflict. Resolve it before committing this changelist.`
      );
      return item;
    }

    // Status letter goes in description text rather than as a colored FileDecoration
    // badge: a FileDecorationProvider applies globally (Explorer, editor tabs, quick
    // open), not just this view, and every file we'd decorate is by definition already
    // decorated by vscode.git's own provider there — we'd just be drawing a duplicate
    // badge next to its. Keeping status text local to our own rows keeps this extension
    // additive/read-only with respect to vscode.git's own UI (PRD §4 non-goals).
    const partial = entry.split && entry.split.ownedHunks < entry.split.totalHunks;
    const statusText = partial
      ? `${entry.split!.ownedHunks}/${entry.split!.totalHunks} hunks`
      : statusLetter(entry.kind);
    item.description = dir ? `${dir}  ${statusText}` : statusText;
    item.resourceUri = uri;
    // The changelist id is part of the row id because a split file legitimately appears
    // under more than one changelist at once — without it the two rows would collide.
    item.id = `${context.repo.rootUri.toString()}::${node.changelist.id}::${entry.filePath}`;
    item.contextValue = partial ? 'changelistFileSplit' : 'changelistFile';
    item.command = { command: 'changelists.openFile', title: 'Open File', arguments: [node] };
    item.tooltip = new vscode.MarkdownString(
      `**${entry.filePath}**\n\n${entry.kind}${entry.renamedFrom ? ` (from \`${entry.renamedFrom}\`)` : ''}${
        entry.staged ? ' · staged' : ''
      }` +
        (partial
          ? `\n\nSplit: this changelist owns ${entry.split!.ownedHunks} of ${entry.split!.totalHunks} hunks.`
          : '')
    );
    return item;
  }

  private emptyTreeItem(node: EmptyStateNode): vscode.TreeItem {
    const item = new vscode.TreeItem('No changes', vscode.TreeItemCollapsibleState.None);
    item.description = undefined;
    item.contextValue = 'changelistEmptyState';
    // Italicized via resourceUri-less, icon-less styling matches the mockup's quiet
    // placeholder row; VS Code renders items with neither icon nor resourceUri in the
    // theme's muted "description" tone by default, so no explicit color is forced here.
    item.tooltip = `${node.changelist.name} has no modified files.`;
    return item;
  }

  /** Awaited by deactivate(): the persistence debounce means a changelist created in the
   *  last moments before shutdown can still be sitting in a timer. */
  async flushPendingWrites(): Promise<void> {
    await Promise.all(this.contexts.map((ctx) => ctx.flushPendingWrites()));
  }

  dispose(): void {
    this.discoveryWatcher?.dispose();
    this.discoveryWatcher = undefined;
    vscode.Disposable.from(...this.perPass).dispose();
    this.perPass = [];
    this.contexts = [];
    this._onDidChangeTreeData.dispose();
  }
}

function reportInitializeFailure(err: unknown): void {
  logError('Discovery failed', err);
  void vscode.window.showErrorMessage(
    `Changelists: could not load changelists — ${err instanceof Error ? err.message : String(err)}`
  );
}

export function statusLetter(kind: ChangeKind): string {
  return STATUS_LETTER[kind];
}
