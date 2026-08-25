import * as vscode from 'vscode';
import { errorMessage, resolveChangelistTarget } from './shared';
import { ChangelistsTreeDataProvider, ChangelistTreeNode } from '../treeDataProvider';

/** "Edit Description…" — PRD §7.1 asks for "name + optional description/comment", but the
 *  description could only ever be set at creation time: `ChangelistManager.setDescription`
 *  was fully implemented and reachable from nowhere. Allowed on shelved lists too, since
 *  annotating one costs nothing and says nothing about the working tree. */
export async function editDescriptionCommand(
  provider: ChangelistsTreeDataProvider,
  node?: ChangelistTreeNode
): Promise<void> {
  const target = await resolveChangelistTarget(provider, node, 'Select a changelist to describe');
  if (!target) {
    return;
  }
  const { context, changelist } = target;

  const description = await vscode.window.showInputBox({
    title: `Description: ${changelist.name}`,
    value: changelist.description ?? '',
    prompt: 'What is this changelist for? Leave empty to clear.',
    placeHolder: 'e.g. Split out of the auth refactor — needs the API bump first',
  });
  if (description === undefined) {
    return;
  }
  try {
    context.manager.setDescription(changelist.id, description);
  } catch (err) {
    void vscode.window.showErrorMessage(errorMessage(err));
  }
}
