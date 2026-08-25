import * as vscode from 'vscode';
import { createChangelistCommand } from './createChangelist';
import { errorMessage, isActionable, resolveChangelistTarget } from './shared';
import { ChangelistsTreeDataProvider, ChangelistTreeNode } from '../treeDataProvider';

/** "Set as Active" — from a tree node's context menu, or the Command Palette (prompts
 *  for repo + changelist when invoked without a node). */
export async function setActiveChangelistCommand(
  provider: ChangelistsTreeDataProvider,
  node?: ChangelistTreeNode
): Promise<void> {
  const target = await resolveChangelistTarget(provider, node, 'Select a changelist to activate', {
    filter: isActionable,
    reject: (c) => `"${c.name}" is shelved — unshelve it before making it active.`,
    empty: 'Changelists: every changelist is shelved. Unshelve one to activate it.',
  });
  if (!target) {
    return;
  }
  try {
    target.context.manager.setActiveChangelist(target.changelist.id);
  } catch (err) {
    void vscode.window.showErrorMessage(errorMessage(err));
  }
}

/** "Switch Active Changelist…" — the status bar item's click target (mockup D8/L8): a
 *  QuickPick listing every changelist with its file count, the current active one marked,
 *  and a trailing "New Changelist…" entry so switching and creating are one flow instead
 *  of two. */
export async function switchActiveChangelistCommand(provider: ChangelistsTreeDataProvider): Promise<void> {
  const context = await provider.resolveContext();
  if (!context) {
    return;
  }
  const grouped = context.grouped;
  const NEW_LIST = Symbol('new-list');
  type Item = vscode.QuickPickItem & { changelistId: string | typeof NEW_LIST };

  const items: Item[] = context.manager
    // Shelved lists are omitted: they cannot become active (newly modified files would
    // land somewhere that isn't in the working tree), so listing them here would only
    // offer a choice that is refused.
    .getChangelists()
    .filter((c) => !c.shelf)
    .map((c) => {
      const count = grouped.get(c.id)?.length ?? 0;
      // `picked` only does anything with canPickMany, so the active list was never
      // actually marked despite the doc comment above promising it.
      return {
        label: c.isActive ? `$(check) ${c.name}` : c.name,
        description: `${count} file${count === 1 ? '' : 's'}${c.isActive ? ' · active' : ''}`,
        changelistId: c.id,
      };
    });
  items.push({
    label: '$(add) New Changelist…',
    changelistId: NEW_LIST,
  });

  const picked = await vscode.window.showQuickPick<Item>(items, {
    title: 'Select a changelist to activate',
    placeHolder: 'Select a changelist to activate',
  });
  if (!picked) {
    return;
  }
  try {
    if (picked.changelistId === NEW_LIST) {
      const created = await createChangelistCommand(provider, undefined);
      if (created) {
        created.context.manager.setActiveChangelist(created.changelistId);
      }
      return;
    }
    context.manager.setActiveChangelist(picked.changelistId);
  } catch (err) {
    void vscode.window.showErrorMessage(errorMessage(err));
  }
}
