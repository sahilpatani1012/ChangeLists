import * as vscode from 'vscode';
import { ChangelistTreeNode } from './treeDataProvider';
import { MovableRow } from './types';

// VS Code derives a tree's own drag type from its view id, lower-cased — for
// `changelists.view` that is this string. A custom type would also work, but matching
// the convention keeps this view consistent with how every built-in tree advertises
// itself, rather than depending on custom types staying permitted.
const MIME_TYPE = 'application/vnd.code.tree.changelists.view';

/** Carries the *rows* being dragged, not just their paths.
 *
 *  A split file renders one row per owning changelist, each showing only that
 *  changelist's share. Sending paths alone loses which share was grabbed, so dropping the
 *  row under "Bugfix" onto "Feature" relocated the file instead — moving the hunks the
 *  user wasn't touching and leaving Bugfix's behind. */
interface DragPayload {
  repoRoot: string;
  rows: MovableRow[];
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
    // A multi-root workspace renders a node per repository and a selection can span them,
    // so the drag is restricted to the repo the first row belongs to; handleDrop() rejects
    // anything from elsewhere. Changelists are per-repository (PRD §4 non-goals), so there
    // is nothing coherent a cross-repo drag could mean.
    const payload: DragPayload = {
      repoRoot: fileNodes[0].context.repo.rootUri.toString(),
      rows: fileNodes
        .filter((n) => n.context === fileNodes[0].context)
        .map((n) => ({
        filePath: n.entry.filePath,
        changelistId: n.changelist.id,
        hunkIds: n.entry.split?.hunkIds,
        totalHunks: n.entry.split?.totalHunks,
      })),
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
    try {
      target.context.manager.moveRows(payload.rows ?? [], targetChangelistId);
    } catch (err) {
      // moveRows() refuses a shelved destination. Without this the rejection vanished
      // into VS Code's drop handler: the files simply didn't move and nothing said why.
      void vscode.window.showErrorMessage(
        `Changelists: ${err instanceof Error ? err.message : String(err)}`
      );
    }
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
