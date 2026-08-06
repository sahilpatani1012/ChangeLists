import * as vscode from 'vscode';
import { errorMessage, resolveChangelistTarget } from './shared';
import { ChangelistsTreeDataProvider, ChangelistTreeNode } from '../treeDataProvider';
import { ShelfInfo } from '../types';

function autoAssignSetting(): boolean {
  return vscode.workspace.getConfiguration('changelists').get<boolean>('autoAssignNewFilesToActive', true);
}

/** "Shelve Changelist" (PRD §10 v2) — WebStorm-style shelve: snapshots each file as a
 *  patch or raw content (gitService.shelvePaths — no `git stash` involved, see
 *  ShelvedFile's doc comment in types.ts) and reverts them from the working tree.
 *  Order is load-bearing: capture+revert first, and only record the shelf once
 *  gitService confirms it succeeded — if we marked it shelved first and the capture
 *  then failed, the extension would show files as safely tucked away that are in fact
 *  still sitting in the tree. */
export async function shelveChangelistCommand(
  provider: ChangelistsTreeDataProvider,
  node?: ChangelistTreeNode
): Promise<void> {
  const target = await resolveChangelistTarget(provider, node, 'Select a changelist to shelve');
  if (!target) {
    return;
  }
  const { context, changelist } = target;

  if (changelist.shelf) {
    void vscode.window.showInformationMessage(`"${changelist.name}" is already shelved.`);
    return;
  }
  if (changelist.isDefault) {
    void vscode.window.showErrorMessage(
      'The Default changelist cannot be shelved — it is where newly modified files land.'
    );
    return;
  }

  const entries =
    context.manager.getFilesGroupedByChangelist(context.liveChanges, context.hunkIndex).get(changelist.id) ?? [];
  if (entries.length === 0) {
    void vscode.window.showInformationMessage(`"${changelist.name}" has no files to shelve.`);
    return;
  }

  // Shelving works at whole-file granularity: it reverts paths in the working tree, and
  // a file whose hunks are split would drag another changelist's hunks out of the tree
  // with it. Refuse rather than silently over-reach.
  const partial = entries.filter((e) => e.split && e.split.ownedHunks < e.split.totalHunks);
  if (partial.length > 0) {
    void vscode.window.showErrorMessage(
      `"${changelist.name}" owns only part of ${partial.length === 1 ? `"${partial[0].filePath}"` : `${partial.length} files`}. ` +
        'Reunite the split hunks before shelving, so another changelist\'s work is not shelved along with it.'
    );
    return;
  }

  const fileWord = entries.length === 1 ? 'file' : 'files';
  const confirm = await vscode.window.showWarningMessage(
    `Shelve "${changelist.name}"? Its ${entries.length} ${fileWord} will be saved aside and removed from your working tree until you unshelve.`,
    { modal: true },
    'Shelve'
  );
  if (confirm !== 'Shelve') {
    return;
  }

  try {
    const files = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Shelving "${changelist.name}"…` },
      () => context.repo.shelvePaths(entries)
    );
    const shelf: ShelfInfo = { shelvedAt: new Date().toISOString(), files };
    context.manager.shelveChangelist(changelist.id, shelf);
    await context.refreshLiveChanges(autoAssignSetting());
    void vscode.window.showInformationMessage(`Shelved ${entries.length} ${fileWord} from "${changelist.name}".`);
  } catch (err) {
    void vscode.window.showErrorMessage(`Shelve failed: ${errorMessage(err)}`);
  }
}

/** "Unshelve Changelist" — writes the shelved snapshot back to the working tree, then
 *  re-attaches the original assignments *before* refreshing git status, so the
 *  returning files land back in this changelist rather than being auto-assigned into
 *  whatever is currently Active. */
export async function unshelveChangelistCommand(
  provider: ChangelistsTreeDataProvider,
  node?: ChangelistTreeNode
): Promise<void> {
  const target = await resolveChangelistTarget(provider, node, 'Select a changelist to unshelve');
  if (!target) {
    return;
  }
  const { context, changelist } = target;

  if (!changelist.shelf) {
    void vscode.window.showInformationMessage(`"${changelist.name}" is not shelved.`);
    return;
  }

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Unshelving "${changelist.name}"…` },
      () => context.repo.unshelvePaths(changelist.shelf!.files)
    );
    const shelf = context.manager.unshelveChangelist(changelist.id);
    await context.refreshLiveChanges(autoAssignSetting());

    const count = shelf.files.length;
    const fileWord = count === 1 ? 'file' : 'files';
    void vscode.window.showInformationMessage(`Restored ${count} ${fileWord} to "${changelist.name}".`);
  } catch (err) {
    // The shelf record is untouched on failure (unshelveChangelist() hasn't run yet),
    // so the snapshot is still intact and safe to retry after resolving whatever
    // stopped `git apply` (typically the file having since diverged from HEAD).
    void vscode.window.showErrorMessage(
      `Unshelve failed: ${errorMessage(err)}. The shelved snapshot is unchanged — resolve the conflict and try again.`
    );
  }
}
