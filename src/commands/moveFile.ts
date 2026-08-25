import * as vscode from 'vscode';
import { createChangelistCommand } from './createChangelist';
import { errorMessage } from './shared';
import { ChangelistsTreeDataProvider, ChangelistTreeNode, FileNode } from '../treeDataProvider';

const NEW_LIST = Symbol('new-list');

/** "Move to Changelist…" — file context menu (mockup D4/L4: submenu of the other
 *  changelists plus "New Changelist…"). VS Code invokes a `view/item/context` command
 *  with `(clickedNode, allSelectedNodes)`, so this single command handles both a lone
 *  right-click and a multi-select drag of the context menu — mirrors how drag-and-drop
 *  handles multi-select (PRD §7.2: "Multi-select support"). Hidden from the Command
 *  Palette (package.json) since it fundamentally needs a file selection to act on. */
export async function moveSelectionToChangelistCommand(
  provider: ChangelistsTreeDataProvider,
  node?: ChangelistTreeNode,
  selection?: ChangelistTreeNode[]
): Promise<void> {
  const candidates = selection && selection.length > 0 ? selection : node ? [node] : [];
  const fileNodes = candidates.filter((n): n is FileNode => n.kind === 'file');
  if (fileNodes.length === 0) {
    void vscode.window.showWarningMessage('Changelists: select one or more files to move.');
    return;
  }
  const context = fileNodes[0].context;

  // Where the selection currently lives, so the picker can say so rather than offering a
  // move that would be a no-op. With a mixed selection nothing is marked.
  const sourceIds = new Set(fileNodes.map((n) => n.changelist.id));
  const currentId = sourceIds.size === 1 ? [...sourceIds][0] : undefined;

  type Item = vscode.QuickPickItem & { changelistId: string | typeof NEW_LIST };
  const items: Item[] = context.manager
    // A shelved list has no working tree behind it; assignFiles() would reject the move.
    .getChangelists()
    .filter((c) => !c.shelf)
    .map((c) => ({
      label: c.name,
      description: c.id === currentId ? 'current' : c.isActive ? 'active' : undefined,
      changelistId: c.id,
    }));
  items.push({ label: '$(add) New Changelist…', changelistId: NEW_LIST });

  const fileWord = fileNodes.length === 1 ? 'file' : 'files';
  const picked = await vscode.window.showQuickPick<Item>(items, {
    title: `Move ${fileNodes.length} ${fileWord} to Changelist`,
    placeHolder: 'Select a destination changelist',
  });
  if (!picked) {
    return;
  }

  let targetId: string;
  if (picked.changelistId === NEW_LIST) {
    const created = await createChangelistCommand(provider, node);
    if (!created) {
      return;
    }
    targetId = created.changelistId;
  } else {
    targetId = picked.changelistId;
  }

  try {
    context.manager.assignFiles(
      fileNodes.map((n) => n.entry.filePath),
      targetId
    );
  } catch (err) {
    void vscode.window.showErrorMessage(errorMessage(err));
  }
}
