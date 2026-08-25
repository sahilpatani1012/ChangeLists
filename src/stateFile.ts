/** Serialization and repair of a persisted ChangelistState.
 *
 *  Deliberately free of `vscode` imports, like changelistManager and hunks: these are pure
 *  functions over the domain model, and they encode rules (deterministic ordering for
 *  team sharing; the invariants the manager is allowed to assume) that are worth proving
 *  under plain Node rather than only in an extension host. persistence.ts keeps the I/O. */

import { ChangelistState, createEmptyState } from './types';

/** Serializes with sorted keys and one entry per line.
 *
 *  The ordering is the entire point: assignments are a set, but JSON.stringify preserves
 *  insertion order, so two teammates whose files differ only in *when* they touched a
 *  path would produce diffs — and merge conflicts — over semantically identical content.
 *  Sorting makes the file a deterministic function of its content, so git only ever sees
 *  a conflict where the two sides genuinely disagree. */
export function serialize(state: ChangelistState): string {
  const ordered: ChangelistState = {
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
  if (state.changelists.length === 0) {
    return createEmptyState('Default');
  }

  // Exactly one default. A hand-edited file can have none, or several.
  let seenDefault = false;
  let changelists = state.changelists.map((c) => {
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

  const ids = new Set(changelists.map((c) => c.id));
  return {
    changelists,
    assignments: (state.assignments ?? []).filter((a) => ids.has(a.changelistId)),
    hunkAssignments: (state.hunkAssignments ?? []).filter((h) => ids.has(h.changelistId)),
  };
}

export function isChangelistState(value: unknown): value is ChangelistState {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return Array.isArray(v.changelists) && Array.isArray(v.assignments);
}
