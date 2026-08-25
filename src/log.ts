import * as vscode from 'vscode';
import { DroppedHunkAssignment, ReconciliationResult } from './types';

/** The extension's output channel.
 *
 *  Reconciliation moves files between changelists on its own — a commit lands, a branch
 *  switches, a rebase rewrites twenty paths — and until now it did so with no record at
 *  all: `ReconciliationResult` was fully populated and every production caller discarded
 *  it. A notification per reconcile would be intolerable (it fires on ordinary saves), so
 *  the log is the right surface: silent unless you go looking, and complete when you do.
 *
 *  Also where refresh failures land, which previously went to `console.error` where no
 *  user would ever find them. */
let channel: vscode.LogOutputChannel | undefined;

export function initializeLog(): vscode.Disposable {
  channel = vscode.window.createOutputChannel('Changelists', { log: true });
  return channel;
}

export function logReconciliation(repoLabel: string, result: ReconciliationResult): void {
  const { newlyAssigned, droppedAssignments, carriedOverRenames } = result;
  if (newlyAssigned.length === 0 && droppedAssignments.length === 0 && carriedOverRenames.length === 0) {
    return;
  }
  const parts = [
    newlyAssigned.length ? `${newlyAssigned.length} newly assigned` : undefined,
    droppedAssignments.length ? `${droppedAssignments.length} no longer modified` : undefined,
    carriedOverRenames.length ? `${carriedOverRenames.length} carried across a rename` : undefined,
  ].filter(Boolean);
  channel?.info(`[${repoLabel}] reconciled: ${parts.join(', ')}`);
  for (const rename of carriedOverRenames) {
    channel?.debug(`[${repoLabel}]   ${rename.from} → ${rename.to}`);
  }
  for (const dropped of droppedAssignments) {
    channel?.debug(`[${repoLabel}]   dropped ${dropped.filePath}`);
  }
}

export function logDroppedHunks(repoLabel: string, dropped: readonly DroppedHunkAssignment[]): void {
  for (const entry of dropped) {
    channel?.debug(`[${repoLabel}] hunk override dropped (${entry.reason}): ${entry.filePath} ${entry.hunkId}`);
  }
}

export function logError(message: string, err: unknown): void {
  channel?.error(`${message}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
}
