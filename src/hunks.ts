import { createHash } from 'crypto';
import { RepoRelativePath } from './types';

/** Unified-diff parsing and subset-patch generation for hunk-level changelists
 *  (PRD §10 v2). Pure functions over strings — no `vscode`, no `git`, no I/O — so the
 *  whole of the fiddly line-number arithmetic is unit-testable under plain Node. */

export interface Hunk {
  /** Content-derived identity, stable across line-number shifts elsewhere in the file.
   *  See computeHunkId() for why this isn't just the `@@` header. */
  readonly id: string;
  /** 1-based line number in the *original* (HEAD) file. */
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  /** The `@@ … @@` line's trailing section heading, if git emitted one. */
  readonly heading: string;
  /** Body lines including their leading ' ', '+', '-' or '\' marker. */
  readonly lines: readonly string[];
  readonly additions: number;
  readonly deletions: number;
}

export interface ParsedDiff {
  /** Everything before the first `@@` — `diff --git`, `index`, `---`/`+++`, mode lines.
   *  Replayed verbatim at the top of every generated subset patch. */
  readonly header: string;
  readonly hunks: readonly Hunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** Identity for a hunk, used to keep hunk→changelist assignments attached across
 *  refreshes. Hashes only the body lines: the `@@` header's line numbers shift whenever
 *  an *earlier* hunk in the same file grows or shrinks, so including them would
 *  invalidate assignments on every unrelated edit above. `occurrence` disambiguates
 *  byte-identical hunks within one file (repeated boilerplate edits), which content
 *  hashing alone cannot. */
function computeHunkId(lines: readonly string[], occurrence: number): string {
  const digest = createHash('sha1').update(lines.join('\n')).digest('hex').slice(0, 12);
  return `${digest}:${occurrence}`;
}

/** Parses `git diff` output for a *single* file. Returns undefined for input with no
 *  hunks at all (binary files, pure mode changes, empty diffs) — callers treat that as
 *  "this file cannot be split" rather than as an error. */
export function parseUnifiedDiff(diff: string): ParsedDiff | undefined {
  if (!diff.trim()) {
    return undefined;
  }
  const lines = diff.split('\n');
  const firstHunk = lines.findIndex((l) => HUNK_HEADER.test(l));
  if (firstHunk === -1) {
    return undefined;
  }

  const header = lines.slice(0, firstHunk).join('\n');
  const hunks: Hunk[] = [];
  const seen = new Map<string, number>();

  let i = firstHunk;
  while (i < lines.length) {
    const match = HUNK_HEADER.exec(lines[i]);
    if (!match) {
      i++;
      continue;
    }
    const oldStart = Number(match[1]);
    const oldCount = match[2] === undefined ? 1 : Number(match[2]);
    const newStart = Number(match[3]);
    const newCount = match[4] === undefined ? 1 : Number(match[4]);
    const heading = match[5] ?? '';

    const body: string[] = [];
    i++;
    while (i < lines.length && !HUNK_HEADER.test(lines[i])) {
      const line = lines[i];
      // A trailing empty string from the final "\n" split isn't part of the hunk.
      if (line === '' && i === lines.length - 1) {
        i++;
        continue;
      }
      body.push(line);
      i++;
    }

    const additions = body.filter((l) => l.startsWith('+')).length;
    const deletions = body.filter((l) => l.startsWith('-')).length;
    const digestKey = body.join('\n');
    const occurrence = seen.get(digestKey) ?? 0;
    seen.set(digestKey, occurrence + 1);

    hunks.push({
      id: computeHunkId(body, occurrence),
      oldStart,
      oldCount,
      newStart,
      newCount,
      heading,
      lines: body,
      additions,
      deletions,
    });
  }

  return hunks.length > 0 ? { header, hunks } : undefined;
}

/** Builds an applicable patch containing only `selectedIds`, in file order.
 *
 *  The line-number rewrite is the whole point of this function. Each hunk's `@@` header
 *  as git emitted it assumes *every* preceding hunk is also applied. Dropping a hunk
 *  invalidates the `+` side of every header after it, and `git apply` validates those
 *  counts, so a naive concatenation of the selected `@@` blocks is rejected (or worse,
 *  silently misapplied). We keep the `-` side verbatim — it describes the original file,
 *  which is unchanged by our selection — and recompute the `+` side by accumulating the
 *  size delta of only the hunks we actually kept.
 *
 *  Returns undefined if nothing was selected. */
export function buildSubsetPatch(parsed: ParsedDiff, selectedIds: ReadonlySet<string>): string | undefined {
  const selected = parsed.hunks.filter((h) => selectedIds.has(h.id));
  if (selected.length === 0) {
    return undefined;
  }

  const out: string[] = [parsed.header];
  let delta = 0;
  for (const hunk of selected) {
    const newStart = hunk.oldStart + delta;
    const newCount = hunk.oldCount + (hunk.additions - hunk.deletions);
    out.push(formatHunkHeader(hunk.oldStart, hunk.oldCount, newStart, newCount, hunk.heading));
    out.push(...hunk.lines);
    delta += hunk.additions - hunk.deletions;
  }
  // git apply requires the patch to end with a newline.
  return out.join('\n') + '\n';
}

function formatHunkHeader(
  oldStart: number,
  oldCount: number,
  newStart: number,
  newCount: number,
  heading: string
): string {
  // git omits ",1" counts; match that so round-tripped patches stay byte-comparable
  // with what git itself would emit.
  const oldPart = oldCount === 1 ? `${oldStart}` : `${oldStart},${oldCount}`;
  const newPart = newCount === 1 ? `${newStart}` : `${newStart},${newCount}`;
  return `@@ -${oldPart} +${newPart} @@${heading}`;
}

/** One-line human summary for a hunk, used as the QuickPick label when choosing which
 *  hunks to move. Prefers git's own section heading (the function/class name it detects)
 *  and falls back to the first changed line. */
export function describeHunk(hunk: Hunk): string {
  const heading = hunk.heading.trim();
  if (heading) {
    return heading;
  }
  const firstChange = hunk.lines.find((l) => l.startsWith('+') || l.startsWith('-'));
  return firstChange ? firstChange.slice(1).trim().slice(0, 80) || '(whitespace change)' : '(no changes)';
}

export function summarizeHunkCounts(hunk: Hunk): string {
  return `+${hunk.additions} −${hunk.deletions}`;
}

/** A file whose hunks are split across more than one changelist. */
export interface SplitFileSummary {
  readonly filePath: RepoRelativePath;
  readonly ownedHunks: number;
  readonly totalHunks: number;
}
