import * as vscode from 'vscode';
import { errorMessage } from './shared';
import { RepositoryContext } from '../repositoryContext';
import { ChangelistsTreeDataProvider, ChangelistTreeNode } from '../treeDataProvider';

/** "New Changelist…" — QuickInput name + description prompt (mockup D6/L6: a bare
 *  drop-down QuickInput, no modal, no OK/Cancel buttons). Reachable from the view
 *  title bar (no node) or a changelist's context menu (node present, used only to
 *  resolve which repo — the new list is always created alongside its siblings, not
 *  nested under the invoking node). Returns the created changelist id, or undefined if
 *  the user cancelled — callers that want to immediately act on the new list (e.g.
 *  "Move to Changelist → New Changelist…") can await this. */
export async function createChangelistCommand(
  provider: ChangelistsTreeDataProvider,
  node?: ChangelistTreeNode
): Promise<{ context: RepositoryContext; changelistId: string } | undefined> {
  const context = await provider.resolveContext(node);
  if (!context) {
    return undefined;
  }

  const name = await vscode.window.showInputBox({
    title: 'New Changelist',
    prompt: "Press 'Enter' to create, 'Escape' to cancel",
    placeHolder: 'e.g. Auth refactor',
    validateInput: (value) => {
      if (value.trim().length === 0) {
        return 'Name cannot be empty.';
      }
      if (!context.manager.isNameAvailable(value)) {
        return `A changelist named "${value.trim()}" already exists.`;
      }
      return undefined;
    },
  });
  if (name === undefined) {
    return undefined;
  }

  const description = await vscode.window.showInputBox({
    title: 'New Changelist',
    prompt: 'Description (optional)',
    placeHolder: 'Description (optional)',
  });

  try {
    const changelist = context.manager.createChangelist(name, description);
    return { context, changelistId: changelist.id };
  } catch (err) {
    void vscode.window.showErrorMessage(errorMessage(err));
    return undefined;
  }
}
