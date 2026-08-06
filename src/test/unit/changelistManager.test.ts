import test from 'node:test';
import assert from 'node:assert/strict';
import { ChangelistManager } from '../../changelistManager';
import { createEmptyState, GitFileChange, ShelfInfo, ShelvedFile } from '../../types';

function change(filePath: string, kind: GitFileChange['kind'], extra: Partial<GitFileChange> = {}): GitFileChange {
  return { filePath, kind, staged: false, ...extra };
}

function freshManager(): ChangelistManager {
  return new ChangelistManager(createEmptyState('Default'));
}

// ---- reconcile(): new files auto-assign ----------------------------------------------

test('reconcile assigns a newly modified file to the active changelist', () => {
  const manager = freshManager();
  const feature = manager.createChangelist('Feature');
  manager.setActiveChangelist(feature.id);

  const result = manager.reconcile([change('src/a.ts', 'modified')], { autoAssignToActive: true });

  assert.equal(result.newlyAssigned.length, 1);
  assert.equal(result.newlyAssigned[0].changelistId, feature.id);
  assert.equal(manager.getChangelistIdForFile('src/a.ts'), feature.id);
});

test('reconcile assigns a newly modified file to Default when autoAssignToActive is off', () => {
  const manager = freshManager();
  const feature = manager.createChangelist('Feature');
  manager.setActiveChangelist(feature.id);

  manager.reconcile([change('src/a.ts', 'modified')], { autoAssignToActive: false });

  assert.equal(manager.getChangelistIdForFile('src/a.ts'), manager.getDefaultChangelist().id);
});

test('reconcile does not reassign a file that already has an assignment', () => {
  const manager = freshManager();
  const feature = manager.createChangelist('Feature');
  manager.assignFile('src/a.ts', feature.id);

  manager.reconcile([change('src/a.ts', 'modified')], { autoAssignToActive: true });

  assert.equal(manager.getChangelistIdForFile('src/a.ts'), feature.id);
});

// ---- reconcile(): files no longer modified drop out -----------------------------------

test('reconcile drops the assignment for a file that is no longer modified', () => {
  const manager = freshManager();
  const feature = manager.createChangelist('Feature');
  manager.assignFile('src/a.ts', feature.id);

  const result = manager.reconcile([], { autoAssignToActive: true });

  assert.equal(result.droppedAssignments.length, 1);
  assert.equal(result.droppedAssignments[0].filePath, 'src/a.ts');
  assert.equal(manager.getChangelistIdForFile('src/a.ts'), undefined);
});

// ---- reconcile(): renames carry the changelist over ------------------------------------

test('reconcile carries an assignment over when git reports a rename', () => {
  const manager = freshManager();
  const feature = manager.createChangelist('Feature');
  manager.assignFile('src/old.ts', feature.id);

  const result = manager.reconcile([change('src/new.ts', 'renamed', { renamedFrom: 'src/old.ts' })], {
    autoAssignToActive: true,
  });

  assert.equal(result.carriedOverRenames.length, 1);
  assert.deepEqual(result.carriedOverRenames[0], { from: 'src/old.ts', to: 'src/new.ts', changelistId: feature.id });
  assert.equal(manager.getChangelistIdForFile('src/old.ts'), undefined);
  assert.equal(manager.getChangelistIdForFile('src/new.ts'), feature.id);
});

test('reconcile does not double-consume a rename target across two stale assignments', () => {
  // Defensive case: two old assignments both point at paths that no longer exist, and
  // only one rename entry is live. Only the matching one should be carried over; the
  // other must be dropped, not accidentally paired with the same rename target.
  const manager = freshManager();
  const feature = manager.createChangelist('Feature');
  manager.assignFiles(['src/old.ts', 'src/unrelated-gone.ts'], feature.id);

  const result = manager.reconcile([change('src/new.ts', 'renamed', { renamedFrom: 'src/old.ts' })], {
    autoAssignToActive: true,
  });

  assert.equal(result.carriedOverRenames.length, 1);
  assert.equal(result.droppedAssignments.length, 1);
  assert.equal(result.droppedAssignments[0].filePath, 'src/unrelated-gone.ts');
});

// ---- changelist CRUD --------------------------------------------------------------------

test('createChangelist rejects a case-insensitive duplicate name', () => {
  const manager = freshManager();
  manager.createChangelist('Auth refactor');
  assert.throws(() => manager.createChangelist('  auth REFACTOR  '), /already exists/);
});

test('renameChangelist allows renaming the Default list but not colliding names', () => {
  const manager = freshManager();
  const other = manager.createChangelist('Other');
  const defaultList = manager.getDefaultChangelist();

  manager.renameChangelist(defaultList.id, 'Main');
  assert.equal(manager.getDefaultChangelist().name, 'Main');

  assert.throws(() => manager.renameChangelist(other.id, 'Main'), /already exists/);
});

test('deleteChangelist moves its files to Default and rejects deleting Default itself', () => {
  const manager = freshManager();
  const feature = manager.createChangelist('Feature');
  manager.assignFiles(['src/a.ts', 'src/b.ts'], feature.id);

  const { movedFilePaths } = manager.deleteChangelist(feature.id);

  assert.deepEqual(movedFilePaths.sort(), ['src/a.ts', 'src/b.ts']);
  assert.equal(manager.getChangelistIdForFile('src/a.ts'), manager.getDefaultChangelist().id);
  assert.equal(manager.getChangelist(feature.id), undefined);
  assert.throws(() => manager.deleteChangelist(manager.getDefaultChangelist().id), /cannot be deleted/);
});

test('deleting the active changelist makes Default active', () => {
  const manager = freshManager();
  const feature = manager.createChangelist('Feature');
  manager.setActiveChangelist(feature.id);

  manager.deleteChangelist(feature.id);

  assert.equal(manager.getActiveChangelist().id, manager.getDefaultChangelist().id);
});

test('setActiveChangelist keeps exactly one changelist active', () => {
  const manager = freshManager();
  const a = manager.createChangelist('A');
  const b = manager.createChangelist('B');

  manager.setActiveChangelist(a.id);
  manager.setActiveChangelist(b.id);

  const activeCount = manager.getChangelists().filter((c) => c.isActive).length;
  assert.equal(activeCount, 1);
  assert.equal(manager.getActiveChangelist().id, b.id);
});

// ---- assignment + grouped view -----------------------------------------------------------

test('assignFiles moves files atomically, replacing any prior assignment', () => {
  const manager = freshManager();
  const a = manager.createChangelist('A');
  const b = manager.createChangelist('B');
  manager.assignFiles(['x.ts', 'y.ts'], a.id);

  manager.assignFiles(['y.ts'], b.id);

  assert.equal(manager.getChangelistIdForFile('x.ts'), a.id);
  assert.equal(manager.getChangelistIdForFile('y.ts'), b.id);
});

test('getFilesGroupedByChangelist groups by changelist and skips stale assignments', () => {
  const manager = freshManager();
  const feature = manager.createChangelist('Feature');
  manager.assignFile('src/a.ts', feature.id);
  manager.assignFile('src/stale.ts', feature.id); // no longer in liveChanges below

  const grouped = manager.getFilesGroupedByChangelist([change('src/a.ts', 'modified')]);

  assert.equal(grouped.get(feature.id)?.length, 1);
  assert.equal(grouped.get(feature.id)?.[0].filePath, 'src/a.ts');
});

// ---- shelve / unshelve (v2) ---------------------------------------------------------

function shelfFor(files: Array<[string, GitFileChange['kind']]>): ShelfInfo {
  return {
    shelvedAt: new Date('2026-01-01T00:00:00Z').toISOString(),
    files: files.map(([filePath, kind]): ShelvedFile =>
      kind === 'modified' || kind === 'deleted'
        ? { filePath, kind, storage: 'patch', patch: `--- fake patch for ${filePath} ---` }
        : { filePath, kind, storage: 'content', content: Buffer.from(filePath).toString('base64') }
    ),
  };
}

test('shelving removes assignments and surfaces the shelf snapshot instead', () => {
  const manager = freshManager();
  const feature = manager.createChangelist('Feature');
  manager.assignFiles(['src/a.ts', 'src/b.ts'], feature.id);

  manager.shelveChangelist(feature.id, shelfFor([['src/a.ts', 'modified'], ['src/b.ts', 'added']]));

  assert.equal(manager.isShelved(feature.id), true);
  assert.equal(manager.getChangelistIdForFile('src/a.ts'), undefined);
  // ...but the tree still shows them, sourced from the shelf rather than git status.
  const grouped = manager.getFilesGroupedByChangelist([]);
  assert.equal(grouped.get(feature.id)?.length, 2);
  assert.equal(grouped.get(feature.id)?.[1].kind, 'added');
});

test('shelving the active changelist hands Active back to Default', () => {
  const manager = freshManager();
  const feature = manager.createChangelist('Feature');
  manager.assignFile('src/a.ts', feature.id);
  manager.setActiveChangelist(feature.id);

  manager.shelveChangelist(feature.id, shelfFor([['src/a.ts', 'modified']]));

  assert.equal(manager.getActiveChangelist().id, manager.getDefaultChangelist().id);
});

test('Default cannot be shelved, so reconcile always has a live auto-assign target', () => {
  const manager = freshManager();
  assert.throws(() => manager.shelveChangelist(manager.getDefaultChangelist().id, shelfFor([])), /cannot be shelved/);
});

test('reconcile does not resurrect shelved files or double-shelve', () => {
  const manager = freshManager();
  const feature = manager.createChangelist('Feature');
  manager.assignFile('src/a.ts', feature.id);
  manager.shelveChangelist(feature.id, shelfFor([['src/a.ts', 'modified']]));

  // Files are stashed, so git reports nothing — reconcile must be a no-op here.
  const result = manager.reconcile([], { autoAssignToActive: true });

  assert.equal(result.droppedAssignments.length, 0);
  assert.equal(result.newlyAssigned.length, 0);
  assert.throws(() => manager.shelveChangelist(feature.id, shelfFor([])), /already shelved/);
});

test('unshelving restores the original assignments, not the active list', () => {
  const manager = freshManager();
  const feature = manager.createChangelist('Feature');
  const other = manager.createChangelist('Other');
  manager.assignFile('src/a.ts', feature.id);
  manager.shelveChangelist(feature.id, shelfFor([['src/a.ts', 'modified']]));
  manager.setActiveChangelist(other.id);

  manager.unshelveChangelist(feature.id);

  assert.equal(manager.isShelved(feature.id), false);
  assert.equal(manager.getChangelistIdForFile('src/a.ts'), feature.id);
});

test('unshelving wins over an assignment made for the same path while shelved', () => {
  const manager = freshManager();
  const feature = manager.createChangelist('Feature');
  manager.assignFile('src/a.ts', feature.id);
  manager.shelveChangelist(feature.id, shelfFor([['src/a.ts', 'modified']]));
  // User edited the same file again; it landed in Default.
  manager.reconcile([change('src/a.ts', 'modified')], { autoAssignToActive: true });
  assert.equal(manager.getChangelistIdForFile('src/a.ts'), manager.getDefaultChangelist().id);

  manager.unshelveChangelist(feature.id);

  assert.equal(manager.getChangelistIdForFile('src/a.ts'), feature.id);
  assert.equal(manager.state.assignments.filter((a) => a.filePath === 'src/a.ts').length, 1);
});

test('a shelved changelist refuses deletion and refuses incoming files', () => {
  const manager = freshManager();
  const feature = manager.createChangelist('Feature');
  manager.assignFile('src/a.ts', feature.id);
  manager.shelveChangelist(feature.id, shelfFor([['src/a.ts', 'modified']]));

  assert.throws(() => manager.deleteChangelist(feature.id), /Unshelve it before deleting/);
  assert.throws(() => manager.assignFile('src/new.ts', feature.id), /unshelve it before moving/i);
});

test('onDidChangeState fires on mutation and stops firing after dispose', () => {
  const manager = freshManager();
  let calls = 0;
  const sub = manager.onDidChangeState(() => calls++);

  manager.createChangelist('Feature');
  assert.equal(calls, 1);

  sub.dispose();
  manager.createChangelist('Another');
  assert.equal(calls, 1);
});
