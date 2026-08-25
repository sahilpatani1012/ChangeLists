import test from 'node:test';
import assert from 'node:assert/strict';
import { isChangelistState, normalize, serialize } from '../../stateFile';
import { Changelist, ChangelistState, ShelfInfo } from '../../types';

const shelf: ShelfInfo = { shelvedAt: '2026-01-01T00:00:00.000Z', files: [] };

function list(over: Partial<Changelist> & { id: string }): Changelist {
  return { name: over.id, isDefault: false, isActive: false, ...over };
}

function stateOf(changelists: Changelist[], rest: Partial<ChangelistState> = {}): ChangelistState {
  return { changelists, assignments: [], hunkAssignments: [], ...rest };
}

// ---- the shelved-active invariant ------------------------------------------------------

test('normalize never leaves a shelved changelist active', () => {
  // The ordering is the bug: the shelved list sorts *before* Default, so a repair that
  // only sets Default active and then de-duplicates would keep this one and switch
  // Default back off — handing Active to a list with nothing in the working tree.
  const repaired = normalize(
    stateOf([
      list({ id: 'shelved', isActive: true, shelf }),
      list({ id: 'default', isDefault: true, isActive: false }),
    ])
  );

  const active = repaired.changelists.filter((c) => c.isActive);
  assert.equal(active.length, 1);
  assert.equal(active[0].id, 'default');
  assert.equal(repaired.changelists.find((c) => c.id === 'shelved')?.isActive, false);
  // ...and the shelf itself is untouched.
  assert.ok(repaired.changelists.find((c) => c.id === 'shelved')?.shelf);
});

test('normalize prefers Default when no list is active', () => {
  const repaired = normalize(
    stateOf([list({ id: 'a' }), list({ id: 'default', isDefault: true }), list({ id: 'b' })])
  );
  assert.equal(repaired.changelists.filter((c) => c.isActive).length, 1);
  assert.equal(repaired.changelists.find((c) => c.isActive)?.id, 'default');
});

test('normalize falls back to a live list when Default itself is shelved', () => {
  // Only reachable by hand-editing the file, but the alternative is handing Active to a
  // shelved list, which is exactly what this pass exists to prevent.
  const repaired = normalize(
    stateOf([list({ id: 'default', isDefault: true, shelf }), list({ id: 'live' })])
  );
  assert.equal(repaired.changelists.find((c) => c.isActive)?.id, 'live');
});

// ---- the other invariants the manager is allowed to assume ------------------------------

test('normalize keeps exactly one default', () => {
  const none = normalize(stateOf([list({ id: 'a' }), list({ id: 'b' })]));
  assert.equal(none.changelists.filter((c) => c.isDefault).length, 1);
  assert.equal(none.changelists[0].isDefault, true, 'the first entry is promoted');

  const several = normalize(
    stateOf([list({ id: 'a', isDefault: true }), list({ id: 'b', isDefault: true })])
  );
  assert.equal(several.changelists.filter((c) => c.isDefault).length, 1);
  assert.equal(several.changelists.find((c) => c.isDefault)?.id, 'a');
});

test('normalize keeps exactly one active', () => {
  const repaired = normalize(
    stateOf([
      list({ id: 'default', isDefault: true, isActive: true }),
      list({ id: 'a', isActive: true }),
      list({ id: 'b', isActive: true }),
    ])
  );
  assert.equal(repaired.changelists.filter((c) => c.isActive).length, 1);
});

test('normalize drops assignments pointing at changelists that no longer exist', () => {
  const repaired = normalize(
    stateOf([list({ id: 'default', isDefault: true, isActive: true })], {
      assignments: [
        { filePath: 'kept.ts', changelistId: 'default' },
        { filePath: 'orphan.ts', changelistId: 'deleted-elsewhere' },
      ],
      hunkAssignments: [
        { filePath: 'kept.ts', hunkId: 'h1', changelistId: 'default' },
        { filePath: 'orphan.ts', hunkId: 'h2', changelistId: 'deleted-elsewhere' },
      ],
    })
  );
  assert.deepEqual(repaired.assignments.map((a) => a.filePath), ['kept.ts']);
  assert.deepEqual(repaired.hunkAssignments?.map((h) => h.filePath), ['kept.ts']);
});

test('normalize replaces a changelist-less state rather than trusting it', () => {
  const repaired = normalize(stateOf([]));
  assert.equal(repaired.changelists.length, 1);
  assert.equal(repaired.changelists[0].isDefault, true);
  assert.equal(repaired.changelists[0].isActive, true);
});

test('normalize does not mutate the state it was given', () => {
  const original = stateOf([list({ id: 'shelved', isActive: true, shelf }), list({ id: 'd', isDefault: true })]);
  normalize(original);
  assert.equal(original.changelists[0].isActive, true, 'input left alone');
});

// ---- serialization determinism (the team-sharing story) ---------------------------------

test('serialize is a deterministic function of content, not of insertion order', () => {
  const a = stateOf([list({ id: 'z', isDefault: true, isActive: true }), list({ id: 'a' })], {
    assignments: [
      { filePath: 'src/b.ts', changelistId: 'a' },
      { filePath: 'src/a.ts', changelistId: 'z' },
    ],
  });
  const b = stateOf([list({ id: 'a' }), list({ id: 'z', isDefault: true, isActive: true })], {
    assignments: [
      { filePath: 'src/a.ts', changelistId: 'z' },
      { filePath: 'src/b.ts', changelistId: 'a' },
    ],
  });
  assert.equal(serialize(a), serialize(b), 'two teammates with the same content produce the same file');
});

test('serialize puts Default first and ends with a newline', () => {
  const text = serialize(stateOf([list({ id: 'zzz' }), list({ id: 'aaa', isDefault: true })]));
  const parsed = JSON.parse(text) as ChangelistState;
  assert.equal(parsed.changelists[0].id, 'aaa');
  assert.ok(text.endsWith('\n'));
});

// ---- shape guard ------------------------------------------------------------------------

test('isChangelistState rejects anything without the two required arrays', () => {
  assert.equal(isChangelistState({ changelists: [], assignments: [] }), true);
  assert.equal(isChangelistState({ changelists: [] }), false);
  assert.equal(isChangelistState(null), false);
  assert.equal(isChangelistState('nope'), false);
  assert.equal(isChangelistState([]), false);
});
