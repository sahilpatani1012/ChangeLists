import * as assert from 'assert';
import * as vscode from 'vscode';

/** Smoke-level integration test: confirms the packaged extension activates inside a
 *  real VS Code instance and contributes its commands. This is a starting point, not
 *  full coverage — the PRD's NFR calls for integration tests of "the tree view and
 *  commit flow," which needs a fixture workspace with an actual git repo (opened via
 *  `runTests({ launchArgs: [fixtureRepoPath] })` in runTest.ts) plus assertions against
 *  `vscode.window.createTreeView`'s visible items. That fixture-repo setup is the next
 *  piece to add here once this scaffold is exercised in an environment with VS Code
 *  binary + network access (see README.md "Testing"). */
suite('Changelists extension', () => {
  test('activates and registers its commands', async () => {
    const ext = vscode.extensions.getExtension('changelists-dev.changelists');
    assert.ok(ext, 'Extension not found — check the publisher.name id in package.json.');
    await ext?.activate();

    const commands = await vscode.commands.getCommands(true);
    const expected = [
      'changelists.createChangelist',
      'changelists.renameChangelist',
      'changelists.deleteChangelist',
      'changelists.setActiveChangelist',
      'changelists.switchActiveChangelist',
      'changelists.commitChangelist',
      'changelists.moveSelectionToChangelist',
      'changelists.openFile',
      'changelists.openDiff',
      'changelists.discardChanges',
      'changelists.refresh',
      'changelists.collapseAll',
    ];
    for (const id of expected) {
      assert.ok(commands.includes(id), `Expected command "${id}" to be registered.`);
    }
  });
});
