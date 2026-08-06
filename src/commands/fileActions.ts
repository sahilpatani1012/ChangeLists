import * as vscode from 'vscode';
import { errorMessage } from './shared';
import { ChangelistTreeNode, FileNode } from '../treeDataProvider';

function asFileNode(node?: ChangelistTreeNode): FileNode | undefined {
  return node?.kind === 'file' ? node : undefined;
}

/** "Open File" — also the tree item's default click command (D1/D4 mockups: clicking a
 *  file row opens it, same as the built-in SCM view). */
export async function openFileCommand(node?: ChangelistTreeNode): Promise<void> {
  const fileNode = asFileNode(node);
  if (!fileNode) {
    return;
  }
  await fileNode.context.repo.openFile(fileNode.entry.filePath);
}

/** "Open Diff" — delegates to the built-in Git extension's own diff editor
 *  (gitService.openDiff), so the diff view is identical to the one Source Control opens. */
export async function openDiffCommand(node?: ChangelistTreeNode): Promise<void> {
  const fileNode = asFileNode(node);
  if (!fileNode) {
    return;
  }
  await fileNode.context.repo.openDiff(fileNode.entry.filePath);
}

/** "Discard Changes" — destructive; always confirmed via a modal, matching the built-in
 *  Source Control view's own discard confirmation. Reverts to HEAD (modified/deleted)
 *  or deletes from disk via Trash (untracked/added) — see gitService.discardChanges. */
export async function discardChangesCommand(node?: ChangelistTreeNode): Promise<void> {
  const fileNode = asFileNode(node);
  if (!fileNode) {
    return;
  }
  const { entry, context } = fileNode;
  const verb = entry.kind === 'untracked' || entry.kind === 'added' ? 'Delete' : 'Discard changes to';
  const choice = await vscode.window.showWarningMessage(
    `${verb} "${entry.filePath}"? This cannot be undone from within Changelists.`,
    { modal: true },
    entry.kind === 'untracked' || entry.kind === 'added' ? 'Delete' : 'Discard Changes'
  );
  if (choice === undefined) {
    return;
  }
  try {
    await context.repo.discardChanges(entry);
    const autoAssignToActive = vscode.workspace
      .getConfiguration('changelists')
      .get<boolean>('autoAssignNewFilesToActive', true);
    await context.refreshLiveChanges(autoAssignToActive);
  } catch (err) {
    void vscode.window.showErrorMessage(`Discard failed: ${errorMessage(err)}`);
  }
}
