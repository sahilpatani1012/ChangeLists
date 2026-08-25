import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GitCli, GitCommandError } from '../../gitCli';

/** GitCli has no `vscode` import, so unlike the rest of gitService it can be driven
 *  against real repositories under plain Node. These cover the parts that replaced
 *  simple-git: stdin patching, config pinning, and error reporting. */

function tempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'changelists-gitcli-'));
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  };
  git('init', '-q', '.');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 'test');
  git('config', 'core.autocrlf', 'false');
  return dir;
}

function write(dir: string, name: string, content: string): void {
  fs.writeFileSync(path.join(dir, name), content, 'utf8');
}

function read(dir: string, name: string): string {
  return fs.readFileSync(path.join(dir, name), 'utf8');
}

test('run() returns stdout untrimmed, so a patch keeps its trailing newline', async () => {
  const dir = tempRepo();
  write(dir, 'a.txt', 'one\ntwo\n');
  const git = new GitCli(dir);
  await git.run(['add', '-A']);
  await git.run(['commit', '-qm', 'base']);

  write(dir, 'a.txt', 'one\nTWO\n');
  const diff = await git.run(['diff', '--no-color', '--no-ext-diff', '-U3', 'HEAD', '--', 'a.txt']);

  assert.ok(diff.startsWith('diff --git a/a.txt b/a.txt'));
  assert.ok(diff.endsWith('\n'), 'git apply rejects a patch with no trailing newline');
});

test('a patch reaches git apply over stdin, with no temp file involved', async () => {
  const dir = tempRepo();
  write(dir, 'a.txt', 'one\ntwo\n');
  const git = new GitCli(dir);
  await git.run(['add', '-A']);
  await git.run(['commit', '-qm', 'base']);

  write(dir, 'a.txt', 'one\nTWO\n');
  const patch = await git.run(['diff', '--no-color', '--no-ext-diff', '-U3', '--binary', 'HEAD', '--', 'a.txt']);
  await git.run(['checkout', 'HEAD', '--', 'a.txt']);
  assert.equal(read(dir, 'a.txt'), 'one\ntwo\n', 'reverted, so the patch is the only copy');

  await git.run(['apply', '--whitespace=nowarn', '-'], { stdin: patch });

  assert.equal(read(dir, 'a.txt'), 'one\nTWO\n');
});

test('a binary patch round-trips over stdin', async () => {
  const dir = tempRepo();
  fs.writeFileSync(path.join(dir, 'img.bin'), Buffer.from([0, 1, 2, 3, 255, 0, 9]));
  const git = new GitCli(dir);
  await git.run(['add', '-A']);
  await git.run(['commit', '-qm', 'base']);

  const edited = Buffer.from([0, 1, 2, 3, 255, 0, 9, 42, 0, 7]);
  fs.writeFileSync(path.join(dir, 'img.bin'), edited);
  const patch = await git.run(['diff', '--no-color', '--no-ext-diff', '-U3', '--binary', 'HEAD', '--', 'img.bin']);
  await git.run(['checkout', 'HEAD', '--', 'img.bin']);

  await git.run(['apply', '--whitespace=nowarn', '-'], { stdin: patch });

  assert.deepEqual([...fs.readFileSync(path.join(dir, 'img.bin'))], [...edited]);
});

test('pinned config defeats diff.noprefix, so generated patches stay appliable', async () => {
  const dir = tempRepo();
  write(dir, 'a.txt', 'one\ntwo\n');
  const git = new GitCli(dir);
  await git.run(['add', '-A']);
  await git.run(['commit', '-qm', 'base']);
  // The setting that used to break every patch this extension produced.
  await git.run(['config', 'diff.noprefix', 'true']);
  await git.run(['config', 'diff.mnemonicPrefix', 'true']);

  write(dir, 'a.txt', 'one\nTWO\n');
  const patch = await git.run(['diff', '--no-color', '--no-ext-diff', '-U3', '--binary', 'HEAD', '--', 'a.txt']);
  assert.ok(patch.includes('a/a.txt'), 'prefixes survive the user config');

  await git.run(['checkout', 'HEAD', '--', 'a.txt']);
  await git.run(['apply', '--whitespace=nowarn', '-'], { stdin: patch });
  assert.equal(read(dir, 'a.txt'), 'one\nTWO\n');
});

test('pinned config strips colour even when color.ui is always', async () => {
  const dir = tempRepo();
  write(dir, 'a.txt', 'one\n');
  const git = new GitCli(dir);
  await git.run(['add', '-A']);
  await git.run(['commit', '-qm', 'base']);
  await git.run(['config', 'color.ui', 'always']);

  write(dir, 'a.txt', 'two\n');
  const diff = await git.run(['diff', '--no-color', '--no-ext-diff', '-U3', 'HEAD', '--', 'a.txt']);

  assert.ok(!diff.includes('['), 'no ANSI escapes reach the parser');
});

test("a failing command rejects with git's own stderr, not a wrapper paraphrase", async () => {
  const dir = tempRepo();
  write(dir, 'a.txt', 'one\n');
  const git = new GitCli(dir);
  await git.run(['add', '-A']);
  await git.run(['commit', '-qm', 'base']);

  await assert.rejects(
    // The exact failure discardChanges used to hit on a renamed or staged-added file.
    () => git.run(['checkout', 'HEAD', '--', 'does-not-exist.txt']),
    (err: unknown) => {
      assert.ok(err instanceof GitCommandError);
      assert.match(err.message, /did not match/i, "git's own wording reaches the user");
      assert.ok(
        !err.message.startsWith('Command failed'),
        "Node's prefix, which just repeats arguments the user cannot act on, is stripped"
      );
      assert.deepEqual(err.args.slice(0, 2), ['checkout', 'HEAD']);
      return true;
    }
  );
});

test('an unappliable patch fails rather than silently doing nothing', async () => {
  const dir = tempRepo();
  write(dir, 'a.txt', 'one\n');
  const git = new GitCli(dir);
  await git.run(['add', '-A']);
  await git.run(['commit', '-qm', 'base']);

  await assert.rejects(
    () => git.run(['apply', '--whitespace=nowarn', '-'], { stdin: 'this is not a patch\n' }),
    /patch|unrecognized|corrupt/i
  );
});

test('run() survives output larger than Node default 1 MB buffer', async () => {
  const dir = tempRepo();
  const big = Array.from({ length: 60000 }, (_, i) => `line ${i}`).join('\n') + '\n';
  write(dir, 'big.txt', big);
  const git = new GitCli(dir);
  await git.run(['add', '-A']);
  await git.run(['commit', '-qm', 'base']);
  write(dir, 'big.txt', big.replace('line 0', 'LINE ZERO'));

  const diff = await git.run(['diff', '--no-color', '--no-ext-diff', '-U3', 'HEAD', '--', 'big.txt']);
  assert.ok(diff.includes('LINE ZERO'));
});
