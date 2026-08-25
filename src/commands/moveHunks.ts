import * as vscode from 'vscode';
import { createChangelistCommand } from './createChangelist';
import { errorMessage, refreshAfterHunkChange } from './shared';
import { describeHunk, parseUnifiedDiff, summarizeHunkCounts } from '../hunks';
import { ChangelistsTreeDataProvider, ChangelistTreeNode, FileNode } from '../treeDataProvider';

const NEW_LIST = Symbol('new-list');

/** "Split Hunks to Changelist…" (PRD §10 v2) — the hunk-level counterpart to "Move to
 *  Changelist…". Presents the file's hunks in a multi-select QuickPick pre-checked with
 *  the ones this changelist already owns, then moves the checked set to a destination.
 *
 *  Only `modified` files are offered: added/untracked files have no HEAD blob to diff
 *  against, and deleted/renamed files have no coherent "half applied" state, so
 *  splitting them isn't meaningful rather than merely unimplemented. */
export async function splitHunksCommand(
  provider: ChangelistsTreeDataProvider,
  node?: ChangelistTreeNode
): Promise<void> {
  if (node?.kind !== 'file') {
    void vscode.window.showWarningMessage('Changelists: select a file to split.');
    return;
  }
  const fileNode: FileNode = node;
  const { context, entry } = fileNode;

  if (entry.kind !== 'modified') {
    void vscode.window.showInformationMessage(
      `Only modified files can be split by hunk — "${entry.filePath}" is ${entry.kind}.`
    );
    return;
  }

  let parsed;
  try {
    parsed = parseUnifiedDiff(await context.repo.getFileDiff(entry.filePath));
  } catch (err) {
    void vscode.window.showErrorMessage(`Could not read the diff: ${errorMessage(err)}`);
    return;
  }
  if (!parsed || parsed.hunks.length === 0) {
    void vscode.window.showInformationMessage(`"${entry.filePath}" has no hunks to split.`);
    return;
  }
  if (parsed.hunks.length === 1) {
    void vscode.window.showInformationMessage(
      `"${entry.filePath}" has only one hunk — move the whole file instead.`
    );
    return;
  }

  const overrides = context.manager.getHunkOverrides(entry.filePath);
  const fileOwner = context.manager.getChangelistIdForFile(entry.filePath);
  const ownerName = (id: string | undefined): string =>
    (id ? context.manager.getChangelist(id)?.name : undefined) ?? 'no changelist';

  // Nothing is pre-checked. The prompt asks which hunks to move, so arriving with this
  // changelist's hunks already ticked meant accepting the default moved everything — a
  // whole-file move wearing a split's clothing — and the user had to *un*tick what they
  // wanted to keep. Current ownership is shown per row instead, which is the information
  // the pre-checking was really carrying.
  type HunkItem = vscode.QuickPickItem & { hunkId: string };
  const items: HunkItem[] = parsed.hunks.map((hunk, i) => ({
    label: `$(diff) Hunk ${i + 1}: ${describeHunk(hunk)}`,
    description: `${summarizeHunkCounts(hunk)}  ·  in ${ownerName(overrides.get(hunk.id) ?? fileOwner)}`,
    detail: `line ${hunk.newStart}`,
    hunkId: hunk.id,
  }));

  const chosen = await vscode.window.showQuickPick(items, {
    title: `Split ${entry.filePath}`,
    placeHolder: 'Select the hunks to move, then choose a destination changelist',
    canPickMany: true,
  });
  if (!chosen || chosen.length === 0) {
    return;
  }

  type ListItem = vscode.QuickPickItem & { changelistId: string | typeof NEW_LIST };
  const listItems: ListItem[] = context.manager
    .getChangelists()
    .filter((c) => !c.shelf)
    .map((c) => ({
      label: c.name,
      description: c.id === fileNode.changelist.id ? 'current' : c.isActive ? 'active' : undefined,
      changelistId: c.id,
    }));
  listItems.push({ label: '$(add) New Changelist…', changelistId: NEW_LIST });

  const hunkWord = chosen.length === 1 ? 'hunk' : 'hunks';
  const destination = await vscode.window.showQuickPick(listItems, {
    title: `Move ${chosen.length} ${hunkWord} from ${entry.filePath}`,
    placeHolder: 'Select a destination changelist',
  });
  if (!destination) {
    return;
  }

  let targetId: string;
  if (destination.changelistId === NEW_LIST) {
    const created = await createChangelistCommand(provider, node);
    if (!created) {
      return;
    }
    targetId = created.changelistId;
  } else {
    targetId = destination.changelistId;
  }

  try {
    // totalHunks lets the manager recognise "every hunk selected" as a whole-file move,
    // rather than leaving the file assigned to one changelist while all of its hunks
    // override to another.
    context.manager.assignHunks(
      entry.filePath,
      chosen.map((c) => c.hunkId),
      targetId,
      { totalHunks: parsed.hunks.length }
    );
  } catch (err) {
    void vscode.window.showErrorMessage(errorMessage(err));
    return;
  }
  // The hunk index is only built once some file has overrides, so without this the very
  // first split of a session renders as a whole file until an unrelated git event lands.
  await refreshAfterHunkChange(context);
  const targetName = context.manager.getChangelist(targetId)?.name ?? 'the changelist';
  void vscode.window.showInformationMessage(
    chosen.length === parsed.hunks.length
      ? `Moved all of "${entry.filePath}" to "${targetName}".`
      : `Moved ${chosen.length} ${hunkWord} to "${targetName}".`
  );
}

/** "Reunite Hunks" — drops every per-hunk override for a file so it belongs wholly to
 *  its own changelist again. The escape hatch for a split that's become more trouble
 *  than it's worth. */
export async function reuniteHunksCommand(node?: ChangelistTreeNode): Promise<void> {
  if (node?.kind !== 'file') {
    return;
  }
  const { context, entry } = node;
  if (!context.manager.isSplit(entry.filePath)) {
    void vscode.window.showInformationMessage(`"${entry.filePath}" is not split.`);
    return;
  }
  context.manager.clearHunkAssignments(entry.filePath);
  await refreshAfterHunkChange(context);
  const owner = context.manager.getChangelistIdForFile(entry.filePath);
  const ownerName = owner ? context.manager.getChangelist(owner)?.name : undefined;
  void vscode.window.showInformationMessage(
    ownerName ? `All hunks of "${entry.filePath}" are back in "${ownerName}".` : 'Hunks reunited.'
  );
}
