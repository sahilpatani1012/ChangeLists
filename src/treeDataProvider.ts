import * as vscode from 'vscode';
import { ChangelistManager } from './changelistManager';
import { discoverRepositories, watchRepositoryDiscovery } from './gitService';
import { ChangelistsConflictError, PersistenceStore } from './persistence';
import { RepositoryContext } from './repositoryContext';
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
  private readonly disposables: vscode.Disposable[] = [];
  private discoveryWatcher: vscode.Disposable | undefined;

  /** Stable ChangelistNode instances, keyed `${repoRoot}::${changelistId}`.
   *
   *  Required for scoped refresh to work at all: `onDidChangeTreeData.fire(element)`
   *  matches by object identity, so handing VS Code a freshly-built node object each
   *  time would make every scoped fire a silent no-op and force us back to full
   *  re-renders. */
  private readonly nodeCache = new Map<string, ChangelistNode>();

  /** Last-rendered content signature per changelist, for diffing (PRD §9: "diff against
   *  previous state and patch the tree view" rather than re-rendering everything on
   *  every git status poll — those fire on every save and focus change). */
  private readonly signatures = new Map<string, string>();

  constructor(private readonly store: PersistenceStore) {}

  async initialize(): Promise<void> {
    await this.rediscoverRepositories();
    this.discoveryWatcher?.dispose();
    this.discoveryWatcher = watchRepositoryDiscovery(() => void this.rediscoverRepositories());
    this.disposables.push(this.discoveryWatcher);
  }

  private config() {
    const cfg = vscode.workspace.getConfiguration('changelists');
    return {
      defaultListName: cfg.get<string>('defaultListName', 'Default'),
      autoAssignToActive: cfg.get<boolean>('autoAssignNewFilesToActive', true),
    };
  }

  private async rediscoverRepositories(): Promise<void> {
    const repos = await discoverRepositories();
    void vscode.commands.executeCommand('setContext', 'changelists.noRepo', repos.length === 0);

    for (const ctx of this.contexts) {
      ctx.dispose();
    }
    this.nodeCache.clear();
    this.signatures.clear();

    const { defaultListName, autoAssignToActive } = this.config();
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
      const manager = new ChangelistManager(state.changelists.length ? state : createEmptyState(defaultListName));
      const context = new RepositoryContext(repo, manager, this.store, () => this.refreshChanged());
      this.disposables.push(
        context,
        repo.onDidChangeState(() => void context.refreshLiveChanges(this.config().autoAssignToActive))
      );
      const externalWatch = this.store.watch?.(repo.rootUri, () => {
        // A teammate's changelists.json arrived (pull/branch switch/hand edit). Reload
        // from scratch rather than merging in-memory state over it — the file is the
        // source of truth in file mode, and a silent three-way merge here is exactly the
        // kind of guess that loses somebody's grouping.
        void this.initialize();
      });
      if (externalWatch) {
        this.disposables.push(externalWatch);
      }
      this.contexts.push(context);
      await context.refreshLiveChanges(autoAssignToActive);
    }
    this._onDidChangeTreeData.fire();
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
    const nextSignatures = new Map<string, string>();
    const changedKeys: string[] = [];

    for (const context of this.contexts) {
      const grouped = context.manager.getFilesGroupedByChangelist(context.liveChanges, context.hunkIndex);
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
    for (const key of changedKeys) {
      const node = this.nodeCache.get(key);
      // A changelist the user has never expanded has no cached node yet; there is
      // nothing rendered to patch, so nothing to fire.
      if (node) {
        this._onDidChangeTreeData.fire(node);
      }
    }
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
      this.contexts.map((c) => ({ label: c.label, context: c })),
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
        return this.contexts.map((context) => ({ kind: 'repo', context }));
      }
      return this.contexts.length === 1 ? this.changelistNodes(this.contexts[0]) : [];
    }
    if (node.kind === 'repo') {
      return this.changelistNodes(node.context);
    }
    if (node.kind === 'changelist') {
      const grouped = node.context.manager.getFilesGroupedByChangelist(
        node.context.liveChanges,
        node.context.hunkIndex
      );
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
      .sort((a, b) => (a.isDefault === b.isDefault ? 0 : a.isDefault ? 1 : -1))
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
    item.description = node.context.repo.branchName;
    item.contextValue = 'repo';
    return item;
  }

  private changelistTreeItem(node: ChangelistNode): vscode.TreeItem {
    const { changelist, context } = node;
    const grouped = context.manager.getFilesGroupedByChangelist(context.liveChanges, context.hunkIndex);
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
    // Bold, and a focusBorder-colored ring on the icon, is how the design spec (D1/L1
    // in the reference mockup) marks the active list; TreeItem has no "bold" API of its
    // own, so the resourceUri-less label styling comes from the icon distinction above
    // plus the `(active)` suffix, which also keeps the state legible to screen readers.
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

  dispose(): void {
    for (const ctx of this.contexts) {
      ctx.dispose();
    }
    vscode.Disposable.from(...this.disposables).dispose();
    this._onDidChangeTreeData.dispose();
  }
}

export function statusLetter(kind: ChangeKind): string {
  return STATUS_LETTER[kind];
}
