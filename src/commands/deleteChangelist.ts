import * as vscode from 'vscode';
import { errorMessage, isDeletable, resolveChangelistTarget } from './shared';
import { ChangelistsTreeDataProvider, ChangelistTreeNode } from '../treeDataProvider';

/** "Delete Changelist" — Default is rejected outright (menu already hides this command
 *  for it via contextValue, but Command Palette invocation has no such guard, so we
 *  re-check here). Non-empty lists get a modal confirmation before their files are
 *  moved to Default, per `changelists.confirmOnDeleteNonEmpty` (PRD §7.6, §11: "moves
 *  files to Default rather than losing the assignment"). */
export async function deleteChangelistCommand(
  provider: ChangelistsTreeDataProvider,
  node?: ChangelistTreeNode
): Promise<void> {
  const target = await resolveChangelistTarget(provider, node, 'Select a changelist to delete', {
    filter: isDeletable,
    reject: (c) =>
      c.isDefault
        ? 'The Default changelist cannot be deleted.'
        : `"${c.name}" is shelved — unshelve it before deleting, so its shelved work isn't orphaned.`,
    empty: 'Changelists: there is no changelist that can be deleted.',
  });
  if (!target) {
    return;
  }
  const { context, changelist } = target;

  if (changelist.isDefault) {
    void vscode.window.showErrorMessage('The Default changelist cannot be deleted.');
    return;
  }

  const grouped = context.manager.getFilesGroupedByChangelist(context.liveChanges, context.hunkIndex);
  const fileCount = grouped.get(changelist.id)?.length ?? 0;
  const confirmOnNonEmpty = vscode.workspace
    .getConfiguration('changelists')
    .get<boolean>('confirmOnDeleteNonEmpty', true);

  if (fileCount > 0 && confirmOnNonEmpty) {
    const defaultName = context.manager.getDefaultChangelist().name;
    const choice = await vscode.window.showWarningMessage(
      `Delete "${changelist.name}"? Its ${fileCount} file${fileCount === 1 ? '' : 's'} will be moved to "${defaultName}", not discarded.`,
      { modal: true },
      'Delete'
    );
    if (choice !== 'Delete') {
      return;
    }
  }

  try {
    context.manager.deleteChangelist(changelist.id);
  } catch (err) {
    void vscode.window.showErrorMessage(errorMessage(err));
  }
}
