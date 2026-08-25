import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { ChangelistsDragAndDropController } from './dragAndDropController';
import { createPersistenceStore } from './persistence';
import { ChangelistsStatusBarItem } from './statusBar';
import { ChangelistsTreeDataProvider } from './treeDataProvider';

/** Held only so deactivate() can flush debounced persistence; nothing else reads it. */
let activeProvider: ChangelistsTreeDataProvider | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const persistMode = vscode.workspace.getConfiguration('changelists').get<'workspaceState' | 'file'>(
    'persistTo',
    'workspaceState'
  );
  const store = createPersistenceStore(persistMode, context.workspaceState);

  const provider = new ChangelistsTreeDataProvider(store);
  const dragAndDropController = new ChangelistsDragAndDropController();

  const treeView = vscode.window.createTreeView('changelists.view', {
    treeDataProvider: provider,
    dragAndDropController,
    showCollapseAll: true,
    canSelectMany: true,
  });

  const statusBarItem = new ChangelistsStatusBarItem(provider);
  context.subscriptions.push(
    treeView,
    provider,
    statusBarItem,
    provider.onDidChangeTreeData(() => statusBarItem.refresh())
  );

  registerCommands(context, provider);

  // `persistTo` changing mid-session means we must re-load state from the *other*
  // backend (workspaceState <-> .vscode/changelists.json) rather than keep whatever's
  // already in memory; re-running initialize() does exactly that (see its idempotency
  // note in treeDataProvider.ts). `defaultListName` only matters for repos that don't
  // have a persisted state yet, but re-initializing is cheap enough to not special-case it.
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
