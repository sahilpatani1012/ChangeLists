import * as vscode from 'vscode';
import { autoAssignSetting, errorMessage, isShelvable, isShelved, resolveChangelistTarget } from './shared';
import { ChangelistsTreeDataProvider, ChangelistTreeNode } from '../treeDataProvider';
import { ShelfInfo, toShelvedFileMeta } from '../types';

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
  const target = await resolveChangelistTarget(provider, node, 'Select a changelist to shelve', {
    filter: isShelvable,
    reject: (c) =>
      c.isDefault
        ? 'The Default changelist cannot be shelved — it is where newly modified files land.'
        : `"${c.name}" is already shelved.`,
    empty: 'Changelists: there is no changelist that can be shelved.',
  });
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
    context.grouped.get(changelist.id) ?? [];
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
    // Payloads first, state second: the state is what declares the changelist shelved, and
    // declaring it before the content is safely stored would point the user at a snapshot
    // that doesn't exist.
    await context.shelves.save(context.repo.rootUri, changelist.id, files);
    const shelf: ShelfInfo = { shelvedAt: new Date().toISOString(), files: files.map(toShelvedFileMeta) };
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
  const target = await resolveChangelistTarget(provider, node, 'Select a changelist to unshelve', {
    filter: isShelved,
    reject: (c) => `"${c.name}" is not shelved.`,
    empty: 'Changelists: nothing is shelved.',
  });
  if (!target) {
    return;
  }
  const { context, changelist } = target;

  if (!changelist.shelf) {
    void vscode.window.showInformationMessage(`"${changelist.name}" is not shelved.`);
    return;
  }

  const payloads = await context.shelves.load(context.repo.rootUri, changelist.id);
  if (!payloads) {
    void vscode.window.showErrorMessage(
      `Changelists: the shelved contents of "${changelist.name}" could not be found. ` +
        'Shelved file contents are stored per-machine, so a changelist shelved elsewhere cannot be unshelved here.'
    );
    return;
  }

  let result;
  try {
    result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Unshelving "${changelist.name}"…` },
      () => context.repo.unshelvePaths(payloads)
    );
  } catch (err) {
    void vscode.window.showErrorMessage(`Unshelve failed: ${errorMessage(err)}`);
    return;
  }

  // Whatever landed is recorded as landed, even when some files failed. Replaying an
  // already-applied patch cannot work, so a shelf that kept everything would make the
  // suggested retry impossible; keeping only the failures makes a retry resume.
  const { remaining } = context.manager.applyUnshelved(
    changelist.id,
    result.restored.map((f) => f.filePath)
  );
  if (remaining === 0) {
    await context.shelves.delete(context.repo.rootUri, changelist.id);
  } else {
    await context.shelves.save(
      context.repo.rootUri,
      changelist.id,
      result.failures.map((f) => f.file)
    );
  }
  await context.refreshLiveChanges(autoAssignSetting());

  const count = result.restored.length;
  const fileWord = count === 1 ? 'file' : 'files';
  if (result.failures.length === 0) {
    void vscode.window.showInformationMessage(`Restored ${count} ${fileWord} to "${changelist.name}".`);
    return;
  }
  void vscode.window.showWarningMessage(
    `Restored ${count} of ${count + result.failures.length} files to "${changelist.name}". ` +
      `${result.failures.length} still shelved: ${result.failures
        .map((f) => `${f.file.filePath} (${firstLine(f.message)})`)
        .join(', ')}. Resolve those and unshelve again — what already landed will not be reapplied.`
  );
}

/** git's failure messages are multi-line; a notification only has room for the first. */
function firstLine(message: string): string {
  return message.split(/\r?\n/)[0];
}
