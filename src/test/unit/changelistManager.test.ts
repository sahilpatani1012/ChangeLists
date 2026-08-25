import test from 'node:test';
import assert from 'node:assert/strict';
import { ChangelistManager } from '../../changelistManager';
import { Changelist, createEmptyState, GitFileChange, ShelfInfo, ShelvedFileMeta } from '../../types';

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
  // Metadata only: the payloads live in the shelf store, outside ChangelistState, so they
  // never reach a shared .vscode/changelists.json.
  return {
    shelvedAt: new Date('2026-01-01T00:00:00Z').toISOString(),
    files: files.map(([filePath, kind]): ShelvedFileMeta => ({ filePath, kind })),
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

// ---- hunk-level splitting (v2) ------------------------------------------------------

const HUNKS = ['h1', 'h2', 'h3'];
const hunkIndex = (filePath = 'src/a.ts', ids: string[] = HUNKS) => new Map([[filePath, ids]]);

test('a file with no hunk overrides renders whole, even when a hunk index is supplied', () => {
  const manager = freshManager();
  const feature = manager.createChangelist('Feature');
  manager.assignFile('src/a.ts', feature.id);

  const grouped = manager.getFilesGroupedByChangelist([change('src/a.ts', 'modified')], hunkIndex());

  assert.equal(grouped.get(feature.id)?.length, 1);
  assert.equal(grouped.get(feature.id)?.[0].split, undefined);
  assert.equal(manager.isSplit('src/a.ts'), false);
});

test('splitting a file makes it appear under both changelists with its own hunk share', () => {
  const manager = freshManager();
  const feature = manager.createChangelist('Feature');
  const bugfix = manager.createChangelist('Bugfix');
  manager.assignFile('src/a.ts', feature.id);

  manager.assignHunks('src/a.ts', ['h2'], bugfix.id);

  const grouped = manager.getFilesGroupedByChangelist([change('src/a.ts', 'modified')], hunkIndex());
  const featureRow = grouped.get(feature.id)?.[0];
  const bugfixRow = grouped.get(bugfix.id)?.[0];

  assert.equal(manager.isSplit('src/a.ts'), true);
  assert.deepEqual(featureRow?.split, { hunkIds: ['h1', 'h3'], ownedHunks: 2, totalHunks: 3 });
  assert.deepEqual(bugfixRow?.split, { hunkIds: ['h2'], ownedHunks: 1, totalHunks: 3 });
});

test('moving hunks back to the file\'s own changelist drops the override entirely', () => {
  const manager = freshManager();
  const feature = manager.createChangelist('Feature');
  const bugfix = manager.createChangelist('Bugfix');
  manager.assignFile('src/a.ts', feature.id);
  manager.assignHunks('src/a.ts', ['h2'], bugfix.id);

  manager.assignHunks('src/a.ts', ['h2'], feature.id);

  assert.equal(manager.isSplit('src/a.ts'), false);
  assert.equal(manager.state.hunkAssignments?.length, 0);
  // ...and the file is back to rendering as one whole row.
  const grouped = manager.getFilesGroupedByChangelist([change('src/a.ts', 'modified')], hunkIndex());
  assert.equal(grouped.get(feature.id)?.[0].split, undefined);
});

test('clearHunkAssignments reunites a split file', () => {
  const manager = freshManager();
  const feature = manager.createChangelist('Feature');
  const bugfix = manager.createChangelist('Bugfix');
  manager.assignFile('src/a.ts', feature.id);
  manager.assignHunks('src/a.ts', ['h1', 'h2'], bugfix.id);
  assert.equal(manager.isSplit('src/a.ts'), true);

  manager.clearHunkAssignments('src/a.ts');

  assert.equal(manager.isSplit('src/a.ts'), false);
});

test('reconcileHunks drops overrides whose hunk no longer exists', () => {
  const manager = freshManager();
  const feature = manager.createChangelist('Feature');
  const bugfix = manager.createChangelist('Bugfix');
  manager.assignFile('src/a.ts', feature.id);
  manager.assignHunks('src/a.ts', ['h2', 'h3'], bugfix.id);

  // The user edited the region h3 covered, so its content hash — and thus its id —
  // changed. h2 is untouched and must survive.
  const { droppedHunkAssignments } = manager.reconcileHunks(hunkIndex('src/a.ts', ['h1', 'h2', 'h9-new']));

  assert.equal(droppedHunkAssignments.length, 1);
  assert.equal(droppedHunkAssignments[0].hunkId, 'h3');
  assert.equal(manager.getHunkOverrides('src/a.ts').get('h2'), bugfix.id);
  // The edited hunk falls back to the file's own changelist rather than vanishing.
  const grouped = manager.getFilesGroupedByChangelist(
    [change('src/a.ts', 'modified')],
    hunkIndex('src/a.ts', ['h1', 'h2', 'h9-new'])
  );
  assert.deepEqual(grouped.get(feature.id)?.[0].split?.hunkIds, ['h1', 'h9-new']);
});

test('deleting a changelist moves its hunk overrides to Default rather than orphaning them', () => {
  // Mirrors the file-level rule (deletion moves work to Default, never discards it):
  // the hunk keeps its separate identity, now grouped under Default.
  const manager = freshManager();
  const feature = manager.createChangelist('Feature');
  const bugfix = manager.createChangelist('Bugfix');
  manager.assignFile('src/a.ts', feature.id);
  manager.assignHunks('src/a.ts', ['h2'], bugfix.id);

  manager.deleteChangelist(bugfix.id);

  const defaultId = manager.getDefaultChangelist().id;
  assert.equal(manager.getHunkOverrides('src/a.ts').get('h2'), defaultId);
  assert.equal(manager.isSplit('src/a.ts'), true);
  // It survives reconciliation too — the changelist it now points at is live.
  assert.equal(manager.reconcileHunks(hunkIndex()).droppedHunkAssignments.length, 0);

  const grouped = manager.getFilesGroupedByChangelist([change('src/a.ts', 'modified')], hunkIndex());
  assert.deepEqual(grouped.get(defaultId)?.[0].split?.hunkIds, ['h2']);
  assert.deepEqual(grouped.get(feature.id)?.[0].split?.hunkIds, ['h1', 'h3']);
});

test('mutating one changelist never discards unrelated hunk overrides', () => {
  // Regression guard: state is rebuilt as a fresh object on every mutation, and an
  // object literal that forgets to carry hunkAssignments over wipes every split in the
  // repo — silently, since nothing else reads it until the next render.
  const manager = freshManager();
  const feature = manager.createChangelist('Feature');
  const bugfix = manager.createChangelist('Bugfix');
  const doomed = manager.createChangelist('Doomed');
  manager.assignFile('src/a.ts', feature.id);
  manager.assignHunks('src/a.ts', ['h2'], bugfix.id);

  manager.deleteChangelist(doomed.id);
  assert.equal(manager.getHunkOverrides('src/a.ts').get('h2'), bugfix.id);

  manager.renameChangelist(feature.id, 'Renamed');
  manager.setActiveChangelist(bugfix.id);
  manager.assignFile('src/other.ts', feature.id);
  assert.equal(manager.getHunkOverrides('src/a.ts').get('h2'), bugfix.id);
});

test('hunks cannot be moved into a shelved changelist', () => {
  const manager = freshManager();
  const feature = manager.createChangelist('Feature');
  const bugfix = manager.createChangelist('Bugfix');
  manager.assignFile('src/a.ts', feature.id);
  manager.assignFile('src/b.ts', bugfix.id);
  manager.shelveChangelist(bugfix.id, shelfFor([['src/b.ts', 'modified']]));

  assert.throws(() => manager.assignHunks('src/a.ts', ['h1'], bugfix.id), /shelved/);
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

// ---- the shelved-active invariant (pass 3) -------------------------------------------

test('a shelved changelist cannot be made active', () => {
  const manager = freshManager();
  const feature = manager.createChangelist('Feature');
  manager.assignFile('src/a.ts', feature.id);
  manager.shelveChangelist(feature.id, shelfFor([['src/a.ts', 'modified']]));

  assert.throws(() => manager.setActiveChangelist(feature.id), /shelved/i);
  assert.equal(manager.getActiveChangelist().id, manager.getDefaultChangelist().id);
});

test('reconcile never auto-assigns into a shelved changelist', () => {
  // The failure this guards is invisible rather than loud: a shelved list renders its
  // snapshot instead of live git status, so a file assigned into one vanishes from the
  // tree entirely until the list is unshelved.
  const manager = freshManager();
  const feature = manager.createChangelist('Feature');
  manager.assignFile('src/a.ts', feature.id);
  manager.setActiveChangelist(feature.id);
  manager.shelveChangelist(feature.id, shelfFor([['src/a.ts', 'modified']]));

  manager.reconcile([change('src/new.ts', 'modified')], { autoAssignToActive: true });

  assert.equal(manager.getChangelistIdForFile('src/new.ts'), manager.getDefaultChangelist().id);
});

test('getActiveChangelist ignores a shelved list that is somehow flagged active', () => {
  // Third line of defence, for state that reached us from a hand-edited file rather than
  // through setActiveChangelist().
  const feature: Changelist = {
    id: 'f',
    name: 'Feature',
    isDefault: false,
    isActive: true,
    shelf: { shelvedAt: '2026-01-01T00:00:00.000Z', files: [] },
  };
  const state = createEmptyState('Default');
  const manager = new ChangelistManager({
    ...state,
    changelists: [...state.changelists.map((c) => ({ ...c, isActive: false })), feature],
  });

  assert.equal(manager.getActiveChangelist().id, manager.getDefaultChangelist().id);
});

// ---- resumable unshelve (pass 5) -------------------------------------------------------

test('a partial unshelve keeps only what did not land shelved', () => {
  // git apply cannot apply the same patch twice, so a shelf that kept everything after a
  // partial failure would make the suggested retry impossible.
  const manager = freshManager();
  const feature = manager.createChangelist('Feature');
  manager.assignFiles(['ok.ts', 'conflicted.ts'], feature.id);
  manager.shelveChangelist(feature.id, shelfFor([['ok.ts', 'modified'], ['conflicted.ts', 'modified']]));

  const { remaining } = manager.applyUnshelved(feature.id, ['ok.ts']);

  assert.equal(remaining, 1);
  assert.equal(manager.isShelved(feature.id), true, 'still shelved, because something is still in it');
  assert.deepEqual(manager.getChangelist(feature.id)?.shelf?.files.map((f) => f.filePath), ['conflicted.ts']);
  assert.equal(manager.getChangelistIdForFile('ok.ts'), feature.id, 'what landed is back in the changelist');
  assert.equal(manager.getChangelistIdForFile('conflicted.ts'), undefined);
});

test('finishing a partial unshelve clears the shelf', () => {
  const manager = freshManager();
  const feature = manager.createChangelist('Feature');
  manager.assignFiles(['ok.ts', 'conflicted.ts'], feature.id);
  manager.shelveChangelist(feature.id, shelfFor([['ok.ts', 'modified'], ['conflicted.ts', 'modified']]));
  manager.applyUnshelved(feature.id, ['ok.ts']);

  const { remaining } = manager.applyUnshelved(feature.id, ['conflicted.ts']);

  assert.equal(remaining, 0);
  assert.equal(manager.isShelved(feature.id), false);
  assert.equal(manager.getChangelistIdForFile('conflicted.ts'), feature.id);
});

test('an unshelve that restored nothing leaves the shelf exactly as it was', () => {
  const manager = freshManager();
  const feature = manager.createChangelist('Feature');
  manager.assignFile('a.ts', feature.id);
  manager.shelveChangelist(feature.id, shelfFor([['a.ts', 'modified']]));

  const { remaining } = manager.applyUnshelved(feature.id, []);

  assert.equal(remaining, 1);
  assert.equal(manager.isShelved(feature.id), true);
  assert.equal(manager.getChangelistIdForFile('a.ts'), undefined);
});

// ---- case drift on case-insensitive filesystems (pass 6) -------------------------------

test('reconcile re-keys an assignment whose file came back with different casing', () => {
  // On Windows and macOS the same file can be reported under different casing than the
  // assignment was stored with. Dropping it would silently move the user's file to
  // Default, which reads as the extension losing their grouping for no reason.
  const manager = freshManager();
  const feature = manager.createChangelist('Feature');
  manager.assignFile('src/Foo.ts', feature.id);

  const result = manager.reconcile([change('src/foo.ts', 'modified')], { autoAssignToActive: true });

  assert.equal(result.droppedAssignments.length, 0);
  assert.equal(manager.getChangelistIdForFile('src/foo.ts'), feature.id);
  assert.equal(manager.getChangelistIdForFile('src/Foo.ts'), undefined, 're-keyed, not duplicated');
});

test('a case-insensitive match never steals a path that already has its own assignment', () => {
  const manager = freshManager();
  const feature = manager.createChangelist('Feature');
  const other = manager.createChangelist('Other');
  manager.assignFile('src/Foo.ts', feature.id);
  manager.assignFile('src/foo.ts', other.id);

  // Only the lowercase one is still modified; it belongs to Other and must stay there.
  manager.reconcile([change('src/foo.ts', 'modified')], { autoAssignToActive: true });

  assert.equal(manager.getChangelistIdForFile('src/foo.ts'), other.id);
});

test('an exact match is preferred over a case-insensitive one', () => {
  const manager = freshManager();
  const feature = manager.createChangelist('Feature');
  manager.assignFile('src/foo.ts', feature.id);

  manager.reconcile([change('src/foo.ts', 'modified'), change('src/FOO.ts', 'modified')], {
    autoAssignToActive: true,
  });

  assert.equal(manager.getChangelistIdForFile('src/foo.ts'), feature.id);
});
