import * as vscode from 'vscode';
import { errorMessage, resolveChangelistTarget } from './shared';
import { ChangelistsTreeDataProvider, ChangelistTreeNode } from '../treeDataProvider';

/** "Rename…" — allowed on Default too (PRD §7.1: "Default… cannot be deleted, only
 *  renamed"), so this isn't gated on isDefault the way delete is. Works from the
 *  Command Palette (prompts for repo + changelist) as well as from a tree node. */
export async function renameChangelistCommand(
  provider: ChangelistsTreeDataProvider,
  node?: ChangelistTreeNode
): Promise<void> {
  const target = await resolveChangelistTarget(provider, node, 'Select a changelist to rename');
  if (!target) {
    return;
  }
  const { context, changelist } = target;

  const name = await vscode.window.showInputBox({
    title: 'Rename Changelist',
    value: changelist.name,
    valueSelection: [0, changelist.name.length],
    validateInput: (value) => {
      if (value.trim().length === 0) {
        return 'Name cannot be empty.';
      }
      if (!context.manager.isNameAvailable(value, changelist.id)) {
        return `A changelist named "${value.trim()}" already exists.`;
      }
      return undefined;
    },
  });
  if (name === undefined) {
    return;
  }
  try {
    context.manager.renameChangelist(changelist.id, name);
  } catch (err) {
    void vscode.window.showErrorMessage(errorMessage(err));
  }
}
