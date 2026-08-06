import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { ChangelistsDragAndDropController } from './dragAndDropController';
import { createPersistenceStore } from './persistence';
import { ChangelistsStatusBarItem } from './statusBar';
import { ChangelistsTreeDataProvider } from './treeDataProvider';

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
        void provider.initialize().then(() => statusBarItem.refresh());
      }
    })
  );

  await provider.initialize();
  statusBarItem.refresh();
}

export function deactivate(): void {
  // All disposables were registered on context.subscriptions during activate(); VS Code
  // disposes them automatically on deactivation. Nothing else holds process-level state
  // (no timers, no open file handles) that needs explicit teardown here.
}
