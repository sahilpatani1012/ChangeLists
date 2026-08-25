import * as vscode from 'vscode';
import { RepositoryContext } from '../repositoryContext';
import { ChangelistsTreeDataProvider, ChangelistTreeNode } from '../treeDataProvider';
import { Changelist } from '../types';

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Candidate filters for the pickers below.
 *
 *  A shelved changelist holds a snapshot, not files in the working tree, so most commands
 *  cannot act on one: committing it would stage paths that aren't there, reviewing it has
 *  no diff to open, shelving it again is a contradiction. Offering it and then failing is
 *  worse than not offering it, and the tree menus already hide these actions — this is how
 *  the Command Palette, which has no `contextValue` to gate on, reaches the same rule. */
export const isActionable = (c: Changelist): boolean => c.shelf === undefined;
export const isShelved = (c: Changelist): boolean => c.shelf !== undefined;
export const isDeletable = (c: Changelist): boolean => !c.isDefault && c.shelf === undefined;
export const isShelvable = (c: Changelist): boolean => !c.isDefault && c.shelf === undefined;

export interface ChangelistTargetOptions {
  /** Restricts the candidates offered, and validates a changelist supplied directly by a
   *  tree node — so both entry points enforce the same rule rather than the menus being
   *  the only thing standing between the user and an error. */
  readonly filter?: (c: Changelist) => boolean;
  /** Shown when `filter` rejects the changelist a tree node supplied. */
  readonly reject?: (c: Changelist) => string;
  /** Shown when `filter` leaves nothing to pick from. */
  readonly empty?: string;
}

/** Prompts for a changelist within `context` via QuickPick. Used whenever a command is
 *  invoked from the Command Palette (no tree node argument) — PRD §7.4: "no action
 *  should be mouse-only" — so every changelist-scoped command still works without a
 *  prior tree selection. */
export async function pickChangelist(
  context: RepositoryContext,
  options: { title: string; excludeId?: string } & ChangelistTargetOptions = { title: 'Select a changelist' }
): Promise<Changelist | undefined> {
  const candidates = context.manager
    .getChangelists()
    .filter((c) => c.id !== options.excludeId && (options.filter?.(c) ?? true));
  if (candidates.length === 0) {
    void vscode.window.showWarningMessage(options.empty ?? 'Changelists: no changelists available.');
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
  pickerTitle: string,
  options: ChangelistTargetOptions = {}
): Promise<{ context: RepositoryContext; changelist: Changelist } | undefined> {
  if (node && node.kind !== 'repo') {
    const { changelist } = node;
    if (options.filter && !options.filter(changelist)) {
      void vscode.window.showInformationMessage(
        options.reject?.(changelist) ?? `"${changelist.name}" can't be used for this action.`
      );
      return undefined;
    }
    return { context: node.context, changelist };
  }
  // node is either absent (Command Palette) or a RepoNode (no single changelist implied
  // by it) — either way, resolveContext still handles it fine (a RepoNode carries
  // `.context` too), we just still need to ask which changelist within that repo.
  const context = await provider.resolveContext(node);
  if (!context) {
    return undefined;
  }
  const changelist = await pickChangelist(context, { ...options, title: pickerTitle });
  return changelist ? { context, changelist } : undefined;
}
