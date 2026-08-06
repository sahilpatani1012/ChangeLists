import * as vscode from 'vscode';
import { ChangelistsTreeDataProvider } from '../treeDataProvider';

/** "Refresh" (view title bar) — forces an immediate re-read of git status + reconcile,
 *  rather than waiting for the next repo.state.onDidChange event. */
export async function refreshCommand(provider: ChangelistsTreeDataProvider): Promise<void> {
  await provider.refreshAll();
}

/** "Collapse All" (view title bar) — VS Code has a built-in generic command for this
 *  (`workbench.actions.treeView.<viewId>.collapseAll`), which the view's `navigation`
 *  menu group can bind to directly; this wrapper exists only so the command ID stays
 *  namespaced under `changelists.*` like every other action, per PRD §7.4 ("Command
 *  palette entries for every action"). */
export async function collapseAllCommand(): Promise<void> {
  await vscode.commands.executeCommand('workbench.actions.treeView.changelists.view.collapseAll');
}
