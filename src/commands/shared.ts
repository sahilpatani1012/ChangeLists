import * as vscode from 'vscode';
import { RepositoryContext } from '../repositoryContext';
import { ChangelistsTreeDataProvider, ChangelistTreeNode } from '../treeDataProvider';
import { Changelist } from '../types';

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Prompts for a changelist within `context` via QuickPick. Used whenever a command is
 *  invoked from the Command Palette (no tree node argument) — PRD §7.4: "no action
 *  should be mouse-only" — so every changelist-scoped command still works without a
 *  prior tree selection. */
export async function pickChangelist(
  context: RepositoryContext,
  options: { title: string; excludeId?: string } = { title: 'Select a changelist' }
): Promise<Changelist | undefined> {
  const candidates = context.manager.getChangelists().filter((c) => c.id !== options.excludeId);
  if (candidates.length === 0) {
    void vscode.window.showWarningMessage('Changelists: no changelists available.');
    return undefined;
  }
  if (candidates.length === 1) {
    return candidates[0];
  }
  const picked = await vscode.window.showQuickPick(
    candidates.map((c) => ({
      label: c.name,
      description: c.isActive ? 'active' : undefined,
      detail: c.description,
      changelist: c,
    })),
    { title: options.title, placeHolder: options.title }
  );
  return picked?.changelist;
}

/** Resolves a {context, changelist} pair for any command bound to a changelist- or
 *  file-scoped tree node, falling back to context + QuickPick resolution when invoked
 *  without a node (Command Palette). */
export async function resolveChangelistTarget(
  provider: ChangelistsTreeDataProvider,
  node: ChangelistTreeNode | undefined,
  pickerTitle: string
): Promise<{ context: RepositoryContext; changelist: Changelist } | undefined> {
  if (node && node.kind !== 'repo') {
    return { context: node.context, changelist: node.changelist };
  }
  // node is either absent (Command Palette) or a RepoNode (no single changelist implied
  // by it) — either way, resolveContext still handles it fine (a RepoNode carries
  // `.context` too), we just still need to ask which changelist within that repo.
  const context = await provider.resolveContext(node);
  if (!context) {
    return undefined;
  }
  const changelist = await pickChangelist(context, { title: pickerTitle });
  return changelist ? { context, changelist } : undefined;
}
