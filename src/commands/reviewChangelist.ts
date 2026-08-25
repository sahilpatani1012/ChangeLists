import * as vscode from 'vscode';
import { errorMessage, isActionable, resolveChangelistTarget } from './shared';
import { ChangelistsTreeDataProvider, ChangelistTreeNode } from '../treeDataProvider';

/** Rough cap on how many diff editors we'll open in one go. Past this, opening them all
 *  buries every other editor tab and takes long enough to feel like a hang, so we ask. */
const CONFIRM_ABOVE = 10;

/** "Review Changelist" (PRD §10 v3, changelist-scoped review mode) — opens a diff editor
 *  for every file in the changelist, in path order, so one changelist's work can be read
 *  end to end without hunting for its files in the flat SCM list.
 *
 *  Diffs are opened sequentially rather than with Promise.all: `git.openChange` resolves
 *  once the editor is *requested*, not once it's rendered, and firing dozens
 *  concurrently makes VS Code interleave the tabs unpredictably. Sequential opening
 *  keeps the tab order matching the order the user sees in the tree. */
export async function reviewChangelistCommand(
  provider: ChangelistsTreeDataProvider,
  node?: ChangelistTreeNode
): Promise<void> {
  const target = await resolveChangelistTarget(provider, node, 'Select a changelist to review', {
    filter: isActionable,
    reject: (c) => `"${c.name}" is shelved — unshelve it to review its changes.`,
    empty: 'Changelists: every changelist is shelved. Unshelve one to review it.',
  });
  if (!target) {
    return;
  }
  const { context, changelist } = target;

  const entries = (context.grouped.get(changelist.id) ?? [])
    .slice()
    .sort((a, b) => a.filePath.localeCompare(b.filePath));

  if (entries.length === 0) {
    void vscode.window.showInformationMessage(`"${changelist.name}" has no files to review.`);
    return;
  }

  if (entries.length > CONFIRM_ABOVE) {
    const choice = await vscode.window.showWarningMessage(
      `Open ${entries.length} diff editors for "${changelist.name}"?`,
      { modal: true },
      'Open All'
    );
    if (choice !== 'Open All') {
      return;
    }
  }

  const failures: string[] = [];
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Opening diffs for "${changelist.name}"…` },
    async (progress) => {
      for (const [i, entry] of entries.entries()) {
        progress.report({ message: `${i + 1} of ${entries.length}`, increment: 100 / entries.length });
        try {
          if (entry.kind === 'untracked') {
            // No HEAD side to diff against; open the file itself so review still covers it.
            await context.repo.openFile(entry.filePath);
          } else {
            await context.repo.openDiff(entry.filePath);
          }
        } catch (err) {
          failures.push(`${entry.filePath} (${errorMessage(err)})`);
        }
      }
    }
  );

  if (failures.length > 0) {
    void vscode.window.showWarningMessage(
      `Opened ${entries.length - failures.length} of ${entries.length} diffs. Could not open: ${failures.join(', ')}`
    );
  }
}
