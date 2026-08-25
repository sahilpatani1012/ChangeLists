import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { ChangelistsDragAndDropController } from './dragAndDropController';
import { initializeLog } from './log';
import { ShelfStore } from './shelfStore';
import { ChangelistsStatusBarItem } from './statusBar';
import { ChangelistsTreeDataProvider } from './treeDataProvider';

/** Held only so deactivate() can flush debounced persistence; nothing else reads it. */
let activeProvider: ChangelistsTreeDataProvider | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // First, so every later step has somewhere to report to.
  context.subscriptions.push(initializeLog());

  // Shelved file payloads live in the extension's own storage rather than in the state
  // file: in `file` mode that state is `.vscode/changelists.json`, which teams are told to
  // commit, and shelved work has no business being published into a repository.
  // `storageUri` is undefined when no workspace is open, in which case there are no repos
  // to shelve from either and globalStorageUri is a harmless stand-in.
  const shelves = new ShelfStore(context.storageUri ?? context.globalStorageUri);

  // The provider selects its own backend from `changelists.persistTo` and re-selects it
  // whenever that setting changes, so the memento is all it needs from here.
  const provider = new ChangelistsTreeDataProvider(context.workspaceState, shelves);
  const dragAndDropController = new ChangelistsDragAndDropController();

  const treeView = vscode.window.createTreeView('changelists.view', {
    treeDataProvider: provider,
    dragAndDropController,
    showCollapseAll: true,
    canSelectMany: true,
  });

  provider.setTreeView(treeView);

  const statusBarItem = new ChangelistsStatusBarItem(provider);
  context.subscriptions.push(
    treeView,
    provider,
    statusBarItem,
    provider.onDidChangeTreeData(() => statusBarItem.refresh())
  );

  registerCommands(context, provider);

  // `persistTo` changing mid-session means re-loading from the *other* backend
  // (workspaceState <-> .vscode/changelists.json). initialize() re-selects the store and
  // carries existing state across — see adoptStore() in treeDataProvider.ts.
  // `defaultListName` only matters for repos with no persisted state yet, but
  // re-initializing is cheap enough not to special-case it.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('changelists.persistTo') || e.affectsConfiguration('changelists.defaultListName')) {
        void provider
          .initialize()
          .then(() => statusBarItem.refresh())
          .catch((err) =>
            vscode.window.showErrorMessage(
              `Changelists: could not reload after a settings change — ${
                err instanceof Error ? err.message : String(err)
              }`
            )
          );
      }
    })
  );

  activeProvider = provider;
  await provider.initialize();
  statusBarItem.refresh();
}

export async function deactivate(): Promise<void> {
  // All disposables were registered on context.subscriptions during activate(); VS Code
  // disposes them automatically on deactivation. The one thing disposal can't cover is
  // persistence: it is debounced (see repositoryContext.ts), so a changelist created in
  // the last few hundred milliseconds may still be sitting in a timer. VS Code awaits
  // this function, which makes it the only chance to get that write to disk.
  const provider = activeProvider;
  activeProvider = undefined;
  await provider?.flushPendingWrites();
}
