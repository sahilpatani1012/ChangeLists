import * as vscode from 'vscode';
import { autoAssignSetting, errorMessage } from './shared';
import { ChangelistTreeNode, FileNode } from '../treeDataProvider';

/** VS Code invokes a `view/item/context` command with `(clickedNode, allSelectedNodes)`.
 *  Honouring the second argument is what makes `canSelectMany` mean anything for these
 *  commands — before, discarding twelve files meant twelve right-clicks and twelve modal
 *  confirmations, even though the tree happily let you select all twelve. */
function fileNodes(node?: ChangelistTreeNode, selection?: ChangelistTreeNode[]): FileNode[] {
  // Right-clicking a row outside the current selection acts on that row alone, matching
  // how VS Code's own SCM view behaves.
  if (node?.kind === 'file' && !(selection ?? []).includes(node)) {
    return [node];
  }
  const candidates = selection && selection.length > 0 ? selection : node ? [node] : [];
  return candidates.filter((n): n is FileNode => n.kind === 'file');
}

/** "Open File" — also the tree item's default click command (D1/D4 mockups: clicking a
 *  file row opens it, same as the built-in SCM view). */
export async function openFileCommand(node?: ChangelistTreeNode, selection?: ChangelistTreeNode[]): Promise<void> {
  for (const file of fileNodes(node, selection)) {
    await file.context.repo.openFile(file.entry.filePath);
  }
}

/** "Open Diff" — delegates to the built-in Git extension's own diff editor
 *  (gitService.openDiff), so the diff view is identical to the one Source Control opens. */
export async function openDiffCommand(node?: ChangelistTreeNode, selection?: ChangelistTreeNode[]): Promise<void> {
  for (const file of fileNodes(node, selection)) {
    // Untracked files have no HEAD side to diff against; open them instead, so a
    // multi-select of mixed kinds still does something sensible for every row.
    if (file.entry.kind === 'untracked') {
      await file.context.repo.openFile(file.entry.filePath);
    } else {
      await file.context.repo.openDiff(file.entry.filePath);
    }
  }
}

/** "Discard Changes" — destructive; always confirmed via a modal, matching the built-in
 *  Source Control view's own discard confirmation. Reverts to HEAD (modified/deleted)
 *  or deletes from disk via Trash (untracked/added) — see gitService.discardChanges. */
export async function discardChangesCommand(
  node?: ChangelistTreeNode,
  selection?: ChangelistTreeNode[]
): Promise<void> {
  const files = fileNodes(node, selection);
  if (files.length === 0) {
    return;
  }
  const context = files[0].context;
  if (files.some((f) => f.context !== context)) {
    void vscode.window.showWarningMessage('Changelists: discard files from one repository at a time.');
    return;
  }

  const removes = files.every((f) => f.entry.kind === 'untracked' || f.entry.kind === 'added');
  const subject = files.length === 1 ? `"${files[0].entry.filePath}"` : `${files.length} files`;

  // Discarding reverts whole paths — git has no way to revert one changelist's share of a
  // file. When a file is split, that destroys work belonging to changelists the user isn't
  // looking at, so name them. Shelving refuses this outright; discard is destructive by
  // intent, so it asks instead of refusing.
  const otherOwners = describeOtherOwners(files);
  const consequence = otherOwners
    ? ` Hunks belonging to ${otherOwners} will be discarded too — reverting cannot be limited to one changelist's share.`
    : '';

  const choice = await vscode.window.showWarningMessage(
    `${removes ? 'Delete' : 'Discard changes to'} ${subject}?${consequence} This cannot be undone from within Changelists.`,
    { modal: true },
    removes ? 'Delete' : 'Discard Changes'
  );
  if (choice === undefined) {
    return;
  }

  const failures: string[] = [];
  for (const file of files) {
    try {
      await context.repo.discardChanges(file.entry);
    } catch (err) {
      failures.push(`${file.entry.filePath} (${errorMessage(err)})`);
    }
  }
  await context.refreshLiveChanges(autoAssignSetting());

  if (failures.length > 0) {
    void vscode.window.showErrorMessage(
      `Discarded ${files.length - failures.length} of ${files.length}. Could not discard: ${failures.join(', ')}`
    );
  }
}

/** Names the changelists — other than the ones being discarded from — holding hunks of the
 *  selected files, or undefined when nothing in the selection is split. */
function describeOtherOwners(files: readonly FileNode[]): string | undefined {
  const selected = new Set(files.map((f) => `${f.changelist.id} ${f.entry.filePath}`));
  const names = new Set<string>();

  for (const file of files) {
    const { entry, context } = file;
    if (!entry.split || entry.split.ownedHunks >= entry.split.totalHunks) {
      continue;
    }
    for (const [changelistId, entries] of context.grouped) {
      if (!entries.some((e) => e.filePath === entry.filePath)) {
        continue;
      }
      if (selected.has(`${changelistId} ${entry.filePath}`)) {
        continue;
      }
      const name = context.manager.getChangelist(changelistId)?.name;
      if (name) {
        names.add(`"${name}"`);
      }
    }
  }

  const list = [...names];
  if (list.length === 0) {
    return undefined;
  }
  return list.length === 1 ? list[0] : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}
