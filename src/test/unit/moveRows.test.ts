import test from 'node:test';
import assert from 'node:assert/strict';
import { ChangelistManager } from '../../changelistManager';
import { createEmptyState, GitFileChange, ShelfInfo } from '../../types';

/** Row-level moves and hunk reconciliation: the two places where "a file" and "one
 *  changelist's share of a file" have to stay distinct. */

const HUNKS = ['h1', 'h2', 'h3'];

function freshManager(): ChangelistManager {
  return new ChangelistManager(createEmptyState('Default'));
}

function change(filePath: string, kind: GitFileChange['kind'] = 'modified'): GitFileChange {
  return { filePath, kind, staged: false };
}

function hunkIndex(filePath = 'src/a.ts', ids: string[] = HUNKS): Map<string, string[]> {
  return new Map([[filePath, ids]]);
}

const emptyShelf: ShelfInfo = { shelvedAt: '2026-01-01T00:00:00.000Z', files: [] };

// ---- moving rows vs moving files --------------------------------------------------------

test('moving a split row moves that share, not the whole file', () => {
  // The row under Bugfix reads "1/3 hunks". Dragging it to Other must move h2 — not
  // relocate the file, which would send h1/h3 instead and leave Bugfix holding h2.
  const manager = freshManager();
  const feature = manager.createChangelist('Feature');
  const bugfix = manager.createChangelist('Bugfix');
  const other = manager.createChangelist('Other');
  manager.assignFile('src/a.ts', feature.id);
  manager.assignHunks('src/a.ts', ['h2'], bugfix.id);

  manager.moveRows([{ filePath: 'src/a.ts', changelistId: bugfix.id, hunkIds: ['h2'], totalHunks: 3 }], other.id);

  assert.equal(manager.getChangelistIdForFile('src/a.ts'), feature.id, 'the file stayed put');
  assert.equal(manager.getHunkOverrides('src/a.ts').get('h2'), other.id, 'only the dragged hunk moved');

  const grouped = manager.getFilesGroupedByChangelist([change('src/a.ts')], hunkIndex());
  assert.deepEqual(grouped.get(feature.id)?.[0].split?.hunkIds, ['h1', 'h3']);
  assert.deepEqual(grouped.get(other.id)?.[0].split?.hunkIds, ['h2']);
  assert.equal(grouped.get(bugfix.id)?.length, 0);
});

test('moving a whole-file row takes its hunks with it', () => {
  const manager = freshManager();
  const feature = manager.createChangelist('Feature');
  const bugfix = manager.createChangelist('Bugfix');
  const other = manager.createChangelist('Other');
  manager.assignFile('src/a.ts', feature.id);
  manager.assignHunks('src/a.ts', ['h2'], bugfix.id);

  // No hunkIds on the row: this is "move the file".
  manager.moveRows([{ filePath: 'src/a.ts', changelistId: feature.id }], other.id);

  assert.equal(manager.getChangelistIdForFile('src/a.ts'), other.id);
  assert.equal(manager.isSplit('src/a.ts'), false, 'a whole-file move leaves no fragments behind');
  assert.equal(manager.state.hunkAssignments?.length, 0);
});

test('selecting every hunk is treated as a whole-file move', () => {
  // Otherwise the file stays assigned to Feature while every one of its hunks overrides to
  // Other: Feature lists a file it owns nothing of, and deleting Other would hand the
  // hunks to Default while the file stayed behind.
  const manager = freshManager();
  const feature = manager.createChangelist('Feature');
  const other = manager.createChangelist('Other');
  manager.assignFile('src/a.ts', feature.id);

  manager.assignHunks('src/a.ts', HUNKS, other.id, { totalHunks: HUNKS.length });

  assert.equal(manager.getChangelistIdForFile('src/a.ts'), other.id);
  assert.equal(manager.isSplit('src/a.ts'), false);
  assert.equal(manager.state.hunkAssignments?.length, 0);
});

test('without totalHunks the same selection stays a split, as before', () => {
  // Guards the opt-in: callers that genuinely do not know the total (nothing in the
  // codebase today) must not have their behaviour changed underneath them.
  const manager = freshManager();
  const feature = manager.createChangelist('Feature');
  const other = manager.createChangelist('Other');
  manager.assignFile('src/a.ts', feature.id);

  manager.assignHunks('src/a.ts', HUNKS, other.id);

  assert.equal(manager.getChangelistIdForFile('src/a.ts'), feature.id);
  assert.equal(manager.isSplit('src/a.ts'), true);
});

test('selecting every row of a split file moves the file as a unit', () => {
  const manager = freshManager();
  const feature = manager.createChangelist('Feature');
  const bugfix = manager.createChangelist('Bugfix');
  const other = manager.createChangelist('Other');
  manager.assignFile('src/a.ts', feature.id);
  manager.assignHunks('src/a.ts', ['h2'], bugfix.id);

  manager.moveRows(
    [
      { filePath: 'src/a.ts', changelistId: feature.id, hunkIds: ['h1', 'h3'], totalHunks: 3 },
      { filePath: 'src/a.ts', changelistId: bugfix.id, hunkIds: ['h2'], totalHunks: 3 },
    ],
    other.id
  );

  assert.equal(manager.getChangelistIdForFile('src/a.ts'), other.id);
  assert.equal(manager.isSplit('src/a.ts'), false);
});

test('a multi-row move is one mutation, not one per row', () => {
  const manager = freshManager();
  const feature = manager.createChangelist('Feature');
  const other = manager.createChangelist('Other');
  manager.assignFiles(['a.ts', 'b.ts', 'c.ts'], feature.id);

  let notifications = 0;
  const sub = manager.onDidChangeState(() => notifications++);
  manager.moveRows(
    ['a.ts', 'b.ts', 'c.ts'].map((filePath) => ({ filePath, changelistId: feature.id })),
    other.id
  );
  sub.dispose();

  assert.equal(notifications, 1, 'one persist, one tree refresh');
  assert.equal(manager.getChangelistIdForFile('b.ts'), other.id);
});

test('moveRows refuses a shelved destination', () => {
  const manager = freshManager();
  const feature = manager.createChangelist('Feature');
  manager.assignFile('src/a.ts', feature.id);
  manager.shelveChangelist(feature.id, emptyShelf);

  assert.throws(() => manager.moveRows([{ filePath: 'other.ts', changelistId: 'x' }], feature.id), /shelved/i);
});

test('moveRows skips a hunk row for a file in no changelist rather than aborting the batch', () => {
  const manager = freshManager();
  const feature = manager.createChangelist('Feature');
  const other = manager.createChangelist('Other');
  manager.assignFile('known.ts', feature.id);

  manager.moveRows(
    [
      { filePath: 'known.ts', changelistId: feature.id },
      { filePath: 'unassigned.ts', changelistId: feature.id, hunkIds: ['h1'], totalHunks: 3 },
    ],
    other.id
  );

  assert.equal(manager.getChangelistIdForFile('known.ts'), other.id, 'the valid row still moved');
  assert.equal(manager.getHunkOverrides('unassigned.ts').size, 0);
});

// ---- "couldn't diff" is not "hunk gone" --------------------------------------------------

test('reconcileHunks keeps overrides for a file whose diff could not be read', () => {
  // A held file or a momentary index lock must not permanently delete a split the user set
  // up by hand: the absence of an answer is not the answer "it's gone".
  const manager = freshManager();
  const feature = manager.createChangelist('Feature');
  const bugfix = manager.createChangelist('Bugfix');
  manager.assignFile('src/a.ts', feature.id);
  manager.assignHunks('src/a.ts', ['h2'], bugfix.id);

  const { droppedHunkAssignments } = manager.reconcileHunks(new Map(), { undiffable: new Set(['src/a.ts']) });

  assert.equal(droppedHunkAssignments.length, 0);
  assert.equal(manager.getHunkOverrides('src/a.ts').get('h2'), bugfix.id);
});

test('reconcileHunks still drops a hunk a successful diff no longer reports', () => {
  const manager = freshManager();
  const feature = manager.createChangelist('Feature');
  const bugfix = manager.createChangelist('Bugfix');
  manager.assignFile('src/a.ts', feature.id);
  manager.assignHunks('src/a.ts', ['h2'], bugfix.id);

  // Diffed cleanly; h2's content changed, so its content-derived id changed with it.
  const { droppedHunkAssignments } = manager.reconcileHunks(hunkIndex('src/a.ts', ['h1', 'h9', 'h3']));

  assert.equal(droppedHunkAssignments.length, 1);
  assert.equal(droppedHunkAssignments[0].reason, 'hunk-changed');
});

test('a file that diffed cleanly with no hunks still drops its overrides', () => {
  // "Diffed, has no hunks" is a real answer — unlike undiffable — so it must act on it.
  const manager = freshManager();
  const feature = manager.createChangelist('Feature');
  const bugfix = manager.createChangelist('Bugfix');
  manager.assignFile('src/a.ts', feature.id);
  manager.assignHunks('src/a.ts', ['h2'], bugfix.id);

  const { droppedHunkAssignments } = manager.reconcileHunks(new Map([['src/a.ts', []]]));

  assert.equal(droppedHunkAssignments.length, 1);
  assert.equal(droppedHunkAssignments[0].reason, 'hunk-changed');
});

test('reconcileHunks reports why each override lapsed', () => {
  // Only 'hunk-changed' is worth a notification; the others follow from something the user
  // just did, so the reason has to reach the caller for it to stay quiet about those.
  const manager = freshManager();
  const feature = manager.createChangelist('Feature');
  const bugfix = manager.createChangelist('Bugfix');
  manager.assignFiles(['edited.ts', 'reverted.ts'], feature.id);
  manager.assignHunks('edited.ts', ['h1'], bugfix.id);
  manager.assignHunks('reverted.ts', ['h1'], bugfix.id);

  // reverted.ts is no longer modified, so reconcile drops its file-level assignment.
  manager.reconcile([change('edited.ts')], { autoAssignToActive: true });
  const { droppedHunkAssignments } = manager.reconcileHunks(hunkIndex('edited.ts', ['h2']));

  const byFile = new Map(droppedHunkAssignments.map((d) => [d.filePath, d.reason]));
  assert.equal(byFile.get('edited.ts'), 'hunk-changed');
  assert.equal(byFile.get('reverted.ts'), 'file-gone');
});

// ---- undo ------------------------------------------------------------------------------

test('undo reverses the last deliberate change', () => {
  const manager = freshManager();
  const feature = manager.createChangelist('Feature');
  const other = manager.createChangelist('Other');
  manager.assignFile('src/a.ts', feature.id);

  manager.moveRows([{ filePath: 'src/a.ts', changelistId: feature.id }], other.id);
  assert.equal(manager.getChangelistIdForFile('src/a.ts'), other.id);

  assert.match(manager.undoableAction ?? '', /moving/);
  manager.undo();

  assert.equal(manager.getChangelistIdForFile('src/a.ts'), feature.id);
  assert.equal(manager.undoableAction, undefined, 'undo does not stack into a toggle');
});

test('undo restores a deleted changelist along with its files', () => {
  const manager = freshManager();
  const feature = manager.createChangelist('Feature');
  manager.assignFiles(['a.ts', 'b.ts'], feature.id);

  manager.deleteChangelist(feature.id);
  assert.equal(manager.getChangelist(feature.id), undefined);

  manager.undo();

  assert.equal(manager.getChangelist(feature.id)?.name, 'Feature');
  assert.equal(manager.getChangelistIdForFile('a.ts'), feature.id);
});

test('reconcile does not become the undo point', () => {
  // Reconciliation reacts to git, not to the user. If it set the checkpoint, the change
  // the user actually wanted back would be buried by their very next save.
  const manager = freshManager();
  const feature = manager.createChangelist('Feature');
  const other = manager.createChangelist('Other');
  manager.assignFile('src/a.ts', feature.id);
  manager.moveRows([{ filePath: 'src/a.ts', changelistId: feature.id }], other.id);

  manager.reconcile([change('src/a.ts'), change('src/new.ts')], { autoAssignToActive: true });
  manager.undo();

  assert.equal(manager.getChangelistIdForFile('src/a.ts'), feature.id, 'the move is still what got undone');
});

test('undo is a no-op when nothing has been changed', () => {
  const manager = freshManager();
  assert.equal(manager.undoableAction, undefined);
  assert.equal(manager.undo(), undefined);
});

test('undo fires a change notification so the tree and store follow', () => {
  const manager = freshManager();
  const feature = manager.createChangelist('Feature');
  let notifications = 0;
  const sub = manager.onDidChangeState(() => notifications++);
  manager.renameChangelist(feature.id, 'Renamed');
  manager.undo();
  sub.dispose();

  assert.equal(notifications, 2);
  assert.equal(manager.getChangelist(feature.id)?.name, 'Feature');
});
