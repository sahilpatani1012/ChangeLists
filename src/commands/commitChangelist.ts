import * as vscode from 'vscode';
import { errorMessage, resolveChangelistTarget } from './shared';
import { ChangelistsTreeDataProvider, ChangelistTreeNode } from '../treeDataProvider';

/** "Commit Changelist…" — stages and commits exactly this changelist's files (PRD §7.3,
 *  appendix). Scope is stated three times, mirroring the mockup (D7/L7): the prompt
 *  titles name the list, the message prompt states the file count, and after commit the
 *  confirmation repeats both. If other files are staged outside this changelist, the
 *  user is warned and must opt in before proceeding — PRD §12: "warn and ask, don't
 *  silently override."
 *
 *  Note: commit message entry is a single-line QuickInput (no multi-paragraph body) —
 *  a full commit-message editor would need either a custom SourceControlInputBox (which
 *  means registering a second SCM provider, out of scope for a panel that's meant to
 *  stay additive to vscode.git's own SCM entry) or a webview. Tracked as a natural v2
 *  upgrade once the webview-based commit view from the design spec is built. */
export async function commitChangelistCommand(
  provider: ChangelistsTreeDataProvider,
  node?: ChangelistTreeNode
): Promise<void> {
  const target = await resolveChangelistTarget(provider, node, 'Select a changelist to commit');
  if (!target) {
    return;
  }
  const { context, changelist } = target;

  const grouped = context.manager.getFilesGroupedByChangelist(context.liveChanges);
  const entries = grouped.get(changelist.id) ?? [];
  if (entries.length === 0) {
    void vscode.window.showInformationMessage(`"${changelist.name}" has no files to commit.`);
    return;
  }

  const paths = new Set<string>();
  for (const entry of entries) {
    paths.add(entry.filePath);
    if (entry.renamedFrom) {
      paths.add(entry.renamedFrom);
    }
  }

  const otherStaged = context.repo.getOtherStagedPaths(paths);
  if (otherStaged.length > 0) {
    const choice = await vscode.window.showWarningMessage(
      `${otherStaged.length} other staged file${otherStaged.length === 1 ? ' is' : 's are'} outside "${changelist.name}" and will be left staged, not committed. Continue?`,
      { modal: true },
      'Continue'
    );
    if (choice !== 'Continue') {
      return;
    }
  }

  const fileWord = entries.length === 1 ? 'file' : 'files';
  const message = await vscode.window.showInputBox({
    title: `Commit: ${changelist.name}`,
    prompt: `Commit message for ${entries.length} ${fileWord}`,
    placeHolder: 'Summary of changes',
    validateInput: (v) => (v.trim().length === 0 ? 'Commit message cannot be empty.' : undefined),
  });
  if (!message) {
    return;
  }

  let amend = false;
  const headMessage = await context.repo.getHeadCommitMessage();
  if (headMessage !== undefined) {
    const amendChoice = await vscode.window.showQuickPick(
      [
        { label: 'Create new commit', amend: false },
        { label: `Amend last commit ("${headMessage.split('\n')[0].slice(0, 50)}")`, amend: true },
      ],
      { title: 'Commit mode', placeHolder: 'Commit mode' }
    );
    if (!amendChoice) {
      return;
    }
    amend = amendChoice.amend;
  }

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Committing "${changelist.name}"…` },
      () => context.repo.commitScoped([...paths], message, { amend })
    );
    void vscode.window.showInformationMessage(`Committed ${entries.length} ${fileWord} to "${changelist.name}".`);
    const autoAssignToActive = vscode.workspace
      .getConfiguration('changelists')
      .get<boolean>('autoAssignNewFilesToActive', true);
    await context.refreshLiveChanges(autoAssignToActive);
  } catch (err) {
    void vscode.window.showErrorMessage(`Commit failed: ${errorMessage(err)}`);
  }
}
