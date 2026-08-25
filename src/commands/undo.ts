import * as vscode from 'vscode';
import { ChangelistsTreeDataProvider, ChangelistTreeNode } from '../treeDataProvider';

/** "Undo Last Changelist Change" — reverses the last deliberate grouping change: a move, a
 *  rename, a create, a delete, a split reunited.
 *
 *  One step deep, and it undoes *grouping* only: nothing here touches the working tree, so
 *  it can never take back a commit, a discard, or a shelve. Reconciliation is excluded on
 *  purpose — it reacts to git rather than to the user, and letting it set the undo point
 *  would mean the thing you actually wanted back had already been buried by a save. */
export async function undoCommand(
  provider: ChangelistsTreeDataProvider,
  node?: ChangelistTreeNode
): Promise<void> {
  const context = await provider.resolveContext(node);
  if (!context) {
    return;
  }
  const action = context.manager.undoableAction;
  if (!action) {
    void vscode.window.showInformationMessage('Changelists: nothing to undo.');
    return;
  }
  const undone = context.manager.undo();
  if (undone) {
    void vscode.window.showInformationMessage(`Changelists: undid ${undone}.`);
  }
}
