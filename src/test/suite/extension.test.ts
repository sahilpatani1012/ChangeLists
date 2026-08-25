import * as assert from 'assert';
import * as vscode from 'vscode';
import { discoverRepositories, GitRepository } from '../../gitService';

/** Integration coverage: the assumptions that can only be checked against a real
 *  `vscode.git` inside a real extension host.
 *
 *  The unit suite covers everything that can be reasoned about from strings and state.
 *  What it cannot reach is what the git extension actually *reports* — and one of those
 *  assumptions, which side of a rename lands in `Change.uri`, carries PRD §11's acceptance
 *  criterion on its back. It held up against upstream's source; this is where it stops
 *  being taken on trust. */

async function waitFor<T>(what: string, probe: () => T | undefined, timeoutMs = 20000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

let cachedRepo: GitRepository | undefined;

function fixtureRepository(): GitRepository {
  assert.ok(cachedRepo, 'the fixture repository was never discovered');
  return cachedRepo;
}

suite('Changelists extension', () => {
  suiteSetup(async function () {
    // Generous: the first run in CI also pays for the git extension's own startup.
    this.timeout(60000);
    const ext = vscode.extensions.getExtension('changelists-dev.changelists');
    assert.ok(ext, 'Extension not found — check the publisher.name id in package.json.');
    await ext.activate();

    // vscode.git discovers repositories asynchronously after its own activation, so this
    // polls rather than assuming the first call finds anything.
    for (let attempt = 0; attempt < 80 && !cachedRepo; attempt++) {
      cachedRepo = (await discoverRepositories()).repositories[0];
      if (!cachedRepo) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    assert.ok(cachedRepo, 'vscode.git never reported the fixture repository');
  });

  test('activates and registers its commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    const contributed: Array<{ command: string }> =
      vscode.extensions.getExtension('changelists-dev.changelists')?.packageJSON.contributes.commands ?? [];
    assert.ok(contributed.length > 0, 'no commands are contributed');
    for (const { command } of contributed) {
      assert.ok(commands.includes(command), `Expected command "${command}" to be registered.`);
    }
  });

  test('a rename reports the NEW path, with renamedFrom as the old one', async () => {
    // The assumption the whole rename carry-over rests on. If vscode.git ever swapped
    // these, reconcile() would carry the assignment the wrong way and a scoped commit
    // would stage the wrong side — silently, in both cases.
    const repo = fixtureRepository();
    const rename = await waitFor('the fixture rename to appear in git status', () =>
      repo.getFileChanges().find((c) => c.kind === 'renamed')
    );

    assert.equal(rename.filePath, 'renamed-target.txt', 'filePath is the path the file has now');
    assert.equal(rename.renamedFrom, 'renamed-source.txt', 'renamedFrom is the path it had before');
  });

  test('status reporting covers modified, untracked and renamed files', async () => {
    const repo = fixtureRepository();
    const byPath = await waitFor('the fixture working tree to settle', () => {
      const changes = new Map(repo.getFileChanges().map((c) => [c.filePath, c]));
      return changes.has('committed.txt') && changes.has('untracked.txt') ? changes : undefined;
    });

    assert.equal(byPath.get('committed.txt')?.kind, 'modified');
    assert.equal(byPath.get('untracked.txt')?.kind, 'untracked');
    assert.equal(byPath.get('renamed-target.txt')?.kind, 'renamed');
    assert.ok(!byPath.has('renamed-source.txt'), 'the pre-rename path is not reported separately');
  });

  test('a modified file yields parseable hunks against the real repository', async () => {
    const repo = fixtureRepository();
    const diff = await repo.getFileDiff('committed.txt');
    assert.ok(diff.startsWith('diff --git a/committed.txt b/committed.txt'), diff.slice(0, 80));

    const scan = await repo.buildHunkIndex(repo.getFileChanges());
    assert.ok((scan.index.get('committed.txt') ?? []).length > 0, 'the modified file has at least one hunk');
    assert.equal(scan.undiffable.size, 0);
  });

  test('the tree view is registered and can be revealed', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.changelists');
    // Nothing to assert beyond "this did not throw": the command only resolves if the
    // view container contributed successfully.
    assert.ok(true);
  });
});
