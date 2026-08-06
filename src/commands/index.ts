import * as vscode from 'vscode';
import { commitChangelistCommand } from './commitChangelist';
import { createChangelistCommand } from './createChangelist';
import { deleteChangelistCommand } from './deleteChangelist';
import { discardChangesCommand, openDiffCommand, openFileCommand } from './fileActions';
import { moveSelectionToChangelistCommand } from './moveFile';
import { renameChangelistCommand } from './renameChangelist';
import { setActiveChangelistCommand, switchActiveChangelistCommand } from './setActiveChangelist';
import { shelveChangelistCommand, unshelveChangelistCommand } from './shelve';
import { collapseAllCommand, refreshCommand } from './view';
import { ChangelistsTreeDataProvider, ChangelistTreeNode } from '../treeDataProvider';

/** Registers every `changelists.*` command against a single shared provider instance.
 *  Every command here is also reachable from the Command Palette (contributed
 *  unconditionally in package.json unless noted otherwise) — see PRD §7.4. */
export function registerCommands(
  extContext: vscode.ExtensionContext,
  provider: ChangelistsTreeDataProvider
): void {
  // `(...args: never[])` rather than `(...args: any[])` deliberately: it stores handlers
  // of any specific signature (each command below has its own param types) without an
  // explicit `any`, which `@typescript-eslint/no-explicit-any` (eslintrc) forbids. `never`
  // is a subtype of every parameter type, so the contravariant parameter check that
  // assignability relies on is satisfied regardless of the handler's real signature.
  const register = (id: string, handler: (...args: never[]) => unknown): void => {
    extContext.subscriptions.push(vscode.commands.registerCommand(id, handler));
  };

  register('changelists.createChangelist', (node?: ChangelistTreeNode) => createChangelistCommand(provider, node));
  register('changelists.renameChangelist', (node?: ChangelistTreeNode) => renameChangelistCommand(provider, node));
  register('changelists.deleteChangelist', (node?: ChangelistTreeNode) => deleteChangelistCommand(provider, node));
  register('changelists.setActiveChangelist', (node?: ChangelistTreeNode) =>
    setActiveChangelistCommand(provider, node)
  );
  register('changelists.switchActiveChangelist', () => switchActiveChangelistCommand(provider));
  register('changelists.commitChangelist', (node?: ChangelistTreeNode) => commitChangelistCommand(provider, node));
  register('changelists.shelveChangelist', (node?: ChangelistTreeNode) => shelveChangelistCommand(provider, node));
  register('changelists.unshelveChangelist', (node?: ChangelistTreeNode) =>
    unshelveChangelistCommand(provider, node)
  );
  register('changelists.moveSelectionToChangelist', (node?: ChangelistTreeNode, selection?: ChangelistTreeNode[]) =>
    moveSelectionToChangelistCommand(provider, node, selection)
  );
  register('changelists.openFile', (node?: ChangelistTreeNode) => openFileCommand(node));
  register('changelists.openDiff', (node?: ChangelistTreeNode) => openDiffCommand(node));
  register('changelists.discardChanges', (node?: ChangelistTreeNode) => discardChangesCommand(node));
  register('changelists.refresh', () => refreshCommand(provider));
  register('changelists.collapseAll', () => collapseAllCommand());
}
