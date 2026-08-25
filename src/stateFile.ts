/** Serialization and repair of a persisted ChangelistState.
 *
 *  Deliberately free of `vscode` imports, like changelistManager and hunks: these are pure
 *  functions over the domain model, and they encode rules (deterministic ordering for
 *  team sharing; the invariants the manager is allowed to assume) that are worth proving
 *  under plain Node rather than only in an extension host. persistence.ts keeps the I/O. */

import { Changelist, ChangelistState, createEmptyState, SCHEMA_VERSION } from './types';

/** Serializes with sorted keys and one entry per line.
 *
 *  The ordering is the entire point: assignments are a set, but JSON.stringify preserves
 *  insertion order, so two teammates whose files differ only in *when* they touched a
 *  path would produce diffs — and merge conflicts — over semantically identical content.
 *  Sorting makes the file a deterministic function of its content, so git only ever sees
 *  a conflict where the two sides genuinely disagree. */
export function serialize(state: ChangelistState): string {
  const ordered: ChangelistState = {
    version: SCHEMA_VERSION,
    changelists: [...state.changelists].sort(compareById),
    assignments: [...state.assignments].sort(
      (a, b) => a.filePath.localeCompare(b.filePath) || a.changelistId.localeCompare(b.changelistId)
    ),
    hunkAssignments: [...(state.hunkAssignments ?? [])].sort(
      (a, b) => a.filePath.localeCompare(b.filePath) || a.hunkId.localeCompare(b.hunkId)
    ),
  };
  return JSON.stringify(ordered, null, 2) + '\n';
}

function compareById(a: { id: string; isDefault: boolean }, b: { id: string; isDefault: boolean }): number {
  // Default first, so the file reads naturally; everything else by stable id.
  if (a.isDefault !== b.isDefault) {
    return a.isDefault ? -1 : 1;
  }
  return a.id.localeCompare(b.id);
}

/** Repairs states persisted by older versions or hand-edited files, so the rest of the
 *  codebase can rely on ChangelistManager's invariants (exactly one default, at most one
 *  active, no assignments pointing at changelists that don't exist). */
export function normalize(state: ChangelistState): ChangelistState {
  // Entries that survive this are known to have the fields every consumer dereferences.
  // isChangelistState() only checks that the two arrays exist, so a hand-edited file (or a
  // half-resolved merge) can carry entries with no id at all — which then render as a row
  // keyed `undefined` and silently swallow every assignment pointing near them.
  const seenIds = new Set<string>();
  const valid = (state.changelists ?? []).filter((c): c is Changelist => {
    if (!isUsableChangelist(c) || seenIds.has(c.id)) {
      return false;
    }
    seenIds.add(c.id);
    return true;
  });
  if (valid.length === 0) {
    return createEmptyState('Default');
  }

  // Exactly one default. A hand-edited file can have none, or several.
  let seenDefault = false;
  let changelists = valid.map((c) => {
    if (!c.isDefault) {
      return c;
    }
    if (seenDefault) {
      return { ...c, isDefault: false };
    }
    seenDefault = true;
    return c;
  });
  if (!seenDefault) {
    changelists[0] = { ...changelists[0], isDefault: true };
  }

  // A shelved list can never be the active one — see getActiveChangelist(). Cleared here
  // *before* the dedup below rather than relying on the fallback afterwards: the dedup
  // keeps the first active entry it meets, so a shelved list that happens to sort earlier
  // than Default would otherwise win and switch Default back off.
  changelists = changelists.map((c) => (c.isActive && c.shelf ? { ...c, isActive: false } : c));

  // Exactly one active, preferring the first survivor.
  let seenActive = false;
  changelists = changelists.map((c) => {
    if (!c.isActive) {
      return c;
    }
    if (seenActive) {
      return { ...c, isActive: false };
    }
    seenActive = true;
    return c;
  });
  if (!seenActive) {
    // Prefer Default, but never hand Active to something shelved. Default itself can only
    // be shelved by hand-editing this file (shelveChangelist() refuses it), which is also
    // the only way the second lookup can come up empty — and getActiveChangelist() falls
    // back to Default regardless, so that degrades to a visible "unshelve me" rather than
    // to files silently vanishing.
    const preferred = changelists.findIndex((c) => c.isDefault && !c.shelf);
    const target = preferred >= 0 ? preferred : changelists.findIndex((c) => !c.shelf);
    if (target >= 0) {
      changelists[target] = { ...changelists[target], isActive: true };
    }
  }

  // One assignment per path. Two entries for the same file (a merge that kept both sides,
  // a hand edit) would otherwise render the file under two changelists at once and make
  // every "which list owns this?" lookup depend on array order.
  const ids = new Set(changelists.map((c) => c.id));
  const claimed = new Set<string>();
  const assignments = (state.assignments ?? []).filter((a) => {
    if (!ids.has(a.changelistId) || typeof a.filePath !== 'string' || claimed.has(a.filePath)) {
      return false;
    }
    claimed.add(a.filePath);
    return true;
  });

  const seenHunks = new Set<string>();
  const hunkAssignments = (state.hunkAssignments ?? []).filter((h) => {
    const key = `${h.filePath}\u0000${h.hunkId}`;
    if (!ids.has(h.changelistId) || !claimed.has(h.filePath) || seenHunks.has(key)) {
      return false;
    }
    seenHunks.add(key);
    return true;
  });

  return { version: SCHEMA_VERSION, changelists, assignments, hunkAssignments };
}

/** Minimum a changelist entry must carry for the rest of the codebase to be able to use
 *  it at all. */
function isUsableChangelist(value: unknown): value is Changelist {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const c = value as Record<string, unknown>;
  return typeof c.id === 'string' && c.id.length > 0 && typeof c.name === 'string';
}

export function isChangelistState(value: unknown): value is ChangelistState {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return Array.isArray(v.changelists) && Array.isArray(v.assignments);
}
