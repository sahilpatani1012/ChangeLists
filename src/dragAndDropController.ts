import * as vscode from 'vscode';
import { ChangelistTreeNode } from './treeDataProvider';
import { RepoRelativePath } from './types';

const MIME_TYPE = 'application/vnd.code.tree.changelistsview';

interface DragPayload {
  repoRoot: string;
  filePaths: RepoRelativePath[];
}

/** Drag-and-drop between changelist groups (PRD §7.2/§7.4, mockup D3/L3: source rows
 *  dim to 40% opacity while dragging — that dimming is VS Code's own built-in drag
 *  affordance for `handleDrag`, not something this controller draws itself). Only
 *  internal file→changelist drags are handled; dropping arbitrary OS files onto the
 *  view is intentionally not supported in v1. */
export class ChangelistsDragAndDropController implements vscode.TreeDragAndDropController<ChangelistTreeNode> {
  readonly dropMimeTypes = [MIME_TYPE];
  readonly dragMimeTypes = [MIME_TYPE];

  handleDrag(source: readonly ChangelistTreeNode[], dataTransfer: vscode.DataTransfer): void {
    const fileNodes = source.filter((n): n is Extract<ChangelistTreeNode, { kind: 'file' }> => n.kind === 'file');
    if (fileNodes.length === 0) {
      return;
    }
    // All selected file nodes are necessarily from the same repo context — VS Code's
    // TreeView selection can't span multiple views, and our repo nodes are the only
    // level above changelists, so a multi-select drag is always single-repo.
    const payload: DragPayload = {
      repoRoot: fileNodes[0].context.repo.rootUri.toString(),
      filePaths: fileNodes.map((n) => n.entry.filePath),
    };
    dataTransfer.set(MIME_TYPE, new vscode.DataTransferItem(JSON.stringify(payload)));
  }

  async handleDrop(
    target: ChangelistTreeNode | undefined,
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken
  ): Promise<void> {
    if (!target) {
      return;
    }
    const item = dataTransfer.get(MIME_TYPE);
    if (!item) {
      return;
    }
    let payload: DragPayload;
    try {
      payload = JSON.parse(await item.asString());
    } catch {
      return;
    }
    if (payload.repoRoot !== target.context.repo.rootUri.toString()) {
      // Cross-repo drags aren't supported (PRD §4 non-goals: "no cross-repo changelist
      // merging") — silently ignore rather than erroring on what looks like a stray drop.
      return;
    }
    const targetChangelistId = resolveTargetChangelistId(target);
    if (!targetChangelistId) {
      return;
    }
    target.context.manager.assignFiles(payload.filePaths, targetChangelistId);
  }
}

function resolveTargetChangelistId(node: ChangelistTreeNode): string | undefined {
  switch (node.kind) {
    case 'changelist':
    case 'file':
    case 'empty':
      return node.changelist.id;
    case 'repo':
      return undefined;
  }
}
