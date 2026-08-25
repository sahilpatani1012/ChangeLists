import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSubsetPatch, describeHunk, describePatchDefect, parseUnifiedDiff } from '../../hunks';

/** A three-hunk diff of a single file. Hunk sizes deliberately differ (+2/-0, +0/-1,
 *  +1/-1) so the subset-patch line arithmetic has something real to get wrong. */
const THREE_HUNK_DIFF = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,3 +1,5 @@ function head()',
  ' const a = 1;',
  '+const added1 = 1;',
  '+const added2 = 2;',
  ' const b = 2;',
  ' const c = 3;',
  '@@ -10,4 +12,3 @@ function middle()',
  ' keep1',
  '-removed',
  ' keep2',
  ' keep3',
  '@@ -30,3 +31,3 @@ function tail()',
  ' ctx',
  '-old',
  '+new',
  ' ctx2',
  '',
].join('\n');

test('parseUnifiedDiff splits the header from the hunks and counts changes', () => {
  const parsed = parseUnifiedDiff(THREE_HUNK_DIFF);
  assert.ok(parsed);
  assert.equal(parsed.hunks.length, 3);
  assert.match(parsed.header, /^diff --git a\/src\/app\.ts/);
  assert.ok(parsed.header.includes('+++ b/src/app.ts'));
  assert.ok(!parsed.header.includes('@@'));

  assert.deepEqual(
    parsed.hunks.map((h) => [h.oldStart, h.oldCount, h.additions, h.deletions]),
    [
      [1, 3, 2, 0],
      [10, 4, 0, 1],
      [30, 3, 1, 1],
    ]
  );
  assert.equal(parsed.hunks[0].heading, ' function head()');
});

test('parseUnifiedDiff returns undefined for input with no hunks', () => {
  assert.equal(parseUnifiedDiff(''), undefined);
  assert.equal(parseUnifiedDiff('   \n'), undefined);
  assert.equal(
    parseUnifiedDiff('diff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ\n'),
    undefined
  );
});

test('hunk ids are content-derived, so they survive line shifts elsewhere in the file', () => {
  const parsed = parseUnifiedDiff(THREE_HUNK_DIFF);
  // Same content, but every hunk sits 100 lines further down the file.
  const shifted = THREE_HUNK_DIFF.replace('@@ -10,4 +12,3 @@', '@@ -110,4 +112,3 @@').replace(
    '@@ -30,3 +31,3 @@',
    '@@ -130,3 +131,3 @@'
  );
  const parsedShifted = parseUnifiedDiff(shifted);

  assert.ok(parsed && parsedShifted);
  assert.deepEqual(
    parsed.hunks.map((h) => h.id),
    parsedShifted.hunks.map((h) => h.id)
  );
});

test('identical hunks within one file get distinct ids', () => {
  const dup = [
    'diff --git a/a.txt b/a.txt',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1,2 +1,3 @@',
    ' ctx',
    '+dupe',
    '@@ -20,2 +21,3 @@',
    ' ctx',
    '+dupe',
    '',
  ].join('\n');
  const parsed = parseUnifiedDiff(dup);
  assert.ok(parsed);
  assert.equal(parsed.hunks.length, 2);
  assert.notEqual(parsed.hunks[0].id, parsed.hunks[1].id);
});

test('buildSubsetPatch rewrites the + side so dropped hunks do not corrupt later offsets', () => {
  const parsed = parseUnifiedDiff(THREE_HUNK_DIFF);
  assert.ok(parsed);
  // Take hunks 2 and 3, dropping hunk 1 (which added two lines). Both survivors must be
  // renumbered as though those two added lines never existed.
  const subset = buildSubsetPatch(parsed, new Set([parsed.hunks[1].id, parsed.hunks[2].id]));
  assert.ok(subset);

  const headers = subset.split('\n').filter((l) => l.startsWith('@@'));
  assert.deepEqual(headers, [
    // hunk 2: -10,4 with one deletion => +10,3 (not the original +12,3)
    '@@ -10,4 +10,3 @@ function middle()',
    // hunk 3: -30,3, preceded by a net -1 => +29,3 (not the original +31,3)
    '@@ -30,3 +29,3 @@ function tail()',
  ]);
  assert.ok(subset.endsWith('\n'));
  assert.ok(subset.startsWith('diff --git a/src/app.ts b/src/app.ts'));
});

test('buildSubsetPatch keeps the whole diff intact when every hunk is selected', () => {
  const parsed = parseUnifiedDiff(THREE_HUNK_DIFF);
  assert.ok(parsed);
  const all = buildSubsetPatch(parsed, new Set(parsed.hunks.map((h) => h.id)));
  assert.ok(all);
  assert.deepEqual(
    all.split('\n').filter((l) => l.startsWith('@@')),
    ['@@ -1,3 +1,5 @@ function head()', '@@ -10,4 +12,3 @@ function middle()', '@@ -30,3 +31,3 @@ function tail()']
  );
});

test('buildSubsetPatch selecting only the first hunk leaves its header untouched', () => {
  const parsed = parseUnifiedDiff(THREE_HUNK_DIFF);
  assert.ok(parsed);
  const first = buildSubsetPatch(parsed, new Set([parsed.hunks[0].id]));
  assert.ok(first);
  assert.deepEqual(first.split('\n').filter((l) => l.startsWith('@@')), ['@@ -1,3 +1,5 @@ function head()']);
});

test('buildSubsetPatch returns undefined when nothing is selected or ids are unknown', () => {
  const parsed = parseUnifiedDiff(THREE_HUNK_DIFF);
  assert.ok(parsed);
  assert.equal(buildSubsetPatch(parsed, new Set()), undefined);
  assert.equal(buildSubsetPatch(parsed, new Set(['not-a-real-id'])), undefined);
});

test('single-line hunk counts round-trip in git\'s own abbreviated form', () => {
  // git writes "@@ -5 +5,2 @@" rather than "@@ -5,1 +5,2 @@"; the parser must accept
  // the omitted count and the builder must re-emit it the same way.
  const diff = [
    'diff --git a/a.txt b/a.txt',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -5 +5,2 @@',
    ' ctx',
    '+added',
    '',
  ].join('\n');
  const parsed = parseUnifiedDiff(diff);
  assert.ok(parsed);
  assert.equal(parsed.hunks[0].oldCount, 1);

  const rebuilt = buildSubsetPatch(parsed, new Set([parsed.hunks[0].id]));
  assert.ok(rebuilt?.includes('@@ -5 +5,2 @@'));
});

test('describeHunk prefers git\'s section heading and falls back to the first change', () => {
  const parsed = parseUnifiedDiff(THREE_HUNK_DIFF);
  assert.ok(parsed);
  assert.equal(describeHunk(parsed.hunks[0]), 'function head()');

  const headless = parseUnifiedDiff(
    ['diff --git a/a.txt b/a.txt', '--- a/a.txt', '+++ b/a.txt', '@@ -1,2 +1,3 @@', ' ctx', '+the new line', ''].join(
      '\n'
    )
  );
  assert.ok(headless);
  assert.equal(describeHunk(headless.hunks[0]), 'the new line');
});

// ---- shelve capture validation -------------------------------------------------------

test('describePatchDefect accepts a normal text patch and an empty diff', () => {
  assert.equal(describePatchDefect(THREE_HUNK_DIFF), undefined);
  // No difference from HEAD is not a defect — unshelvePaths() skips these.
  assert.equal(describePatchDefect(''), undefined);
  assert.equal(describePatchDefect('  \n'), undefined);
});

test('describePatchDefect rejects the content-free binary stub git emits without --binary', () => {
  const stub = [
    'diff --git a/img.bin b/img.bin',
    'index 8f3bbb1..602f867 100644',
    'Binary files a/img.bin and b/img.bin differ',
    '',
  ].join('\n');
  assert.match(describePatchDefect(stub) ?? '', /binary/i);
});

test('describePatchDefect accepts a real encoded binary patch', () => {
  // What `git diff --binary` produces for the same file: restorable, so not a defect.
  const encoded = [
    'diff --git a/img.bin b/img.bin',
    'index 8f3bbb19459ed6bdc6e2869e8f0020b46559c889..6d0d68ac0bd7da420dd4b45664c482bf6becc5fe 100644',
    'GIT binary patch',
    'literal 11',
    'ScmZQzWMX#qaP)I`bpZee<N@&j',
    '',
  ].join('\n');
  assert.equal(describePatchDefect(encoded), undefined);
});

test('describePatchDefect rejects colorized output from color.ui = always', () => {
  const colored = '\u001b[1mdiff --git a/t.txt b/t.txt\u001b[m\n\u001b[36m@@ -1 +1 @@\u001b[m\n';
  assert.match(describePatchDefect(colored) ?? '', /unified diff/);
});

test('describePatchDefect rejects output that is not a diff at all', () => {
  // What a configured diff.external driver prints instead.
  assert.match(describePatchDefect('1c1\n< text\n---\n> text2\n') ?? '', /unified diff/);
});
