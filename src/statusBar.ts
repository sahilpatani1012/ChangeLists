import * as vscode from 'vscode';
import { ChangelistsTreeDataProvider } from './treeDataProvider';

/** Status bar item showing the active changelist (PRD §7.4, mockup D8/L8): sits after
 *  the branch/sync items, click opens the QuickPick switcher (`switchActiveChangelist`
 *  command). With multiple repos open, shows the first repo's active list — matching
 *  the "treat each repo independently" stance, a single status bar slot can't represent
 *  N repos at once, so v1 doesn't try. */
export class ChangelistsStatusBarItem implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor(private readonly provider: ChangelistsTreeDataProvider) {
    this.item = vscode.window.createStatusBarItem('changelists.activeList', vscode.StatusBarAlignment.Left, 9);
    this.item.name = 'Changelists: Active List';
    this.item.command = 'changelists.switchActiveChangelist';
  }

  refresh(): void {
    const contexts = this.provider.getContexts();
    if (contexts.length === 0) {
      this.item.hide();
      return;
    }
    const active = contexts[0].manager.getActiveChangelist();
    this.item.text = `$(list-flat) ${active.name}`;
    this.item.tooltip = new vscode.MarkdownString(
      `Changelists: active list is **${active.name}**.\n\nClick to switch.`
    );
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
