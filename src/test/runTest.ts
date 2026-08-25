import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

/** Builds the fixture repository the integration suite runs against.
 *
 *  A real repo is the point: the assumptions worth testing in an extension host are the
 *  ones about what `vscode.git` reports — above all which side of a rename lands in
 *  `Change.uri` versus `Change.originalUri`, which the whole rename carry-over depends on
 *  and which no unit test can reach. */
function createFixtureRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'changelists-fixture-'));
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  };
  git('init', '-q', '.');
  git('config', 'user.email', 'fixture@test');
  git('config', 'user.name', 'Fixture');
  git('config', 'core.autocrlf', 'false');
  git('config', 'commit.gpgsign', 'false');

  fs.writeFileSync(path.join(dir, 'committed.txt'), 'one\ntwo\nthree\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'renamed-source.txt'), 'stays the same\n', 'utf8');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'app.ts'), 'export const a = 1;\n', 'utf8');
  git('add', '-A');
  git('commit', '-qm', 'fixture base');

  // The working-tree states the suite asserts against.
  fs.appendFileSync(path.join(dir, 'committed.txt'), 'four\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'untracked.txt'), 'brand new\n', 'utf8');
  git('mv', 'renamed-source.txt', 'renamed-target.txt');

  return dir;
}

async function main(): Promise<void> {
  let fixture: string | undefined;
  try {
    fixture = createFixtureRepo();
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');
    const extensionTestsPath = path.resolve(__dirname, './suite/index');
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      // --disable-extensions would take vscode.git with it, which is the one extension
      // this suite cannot do without.
      launchArgs: [fixture, '--disable-workspace-trust'],
      extensionTestsEnv: {
        CHANGELISTS_FIXTURE: fixture,
        // Cleared deliberately. Running this from VS Code's own integrated terminal
        // inherits ELECTRON_RUN_AS_NODE=1 from the parent, which makes the VS Code we
        // spawn behave like plain Node and try to `require` the fixture path as a script —
        // failing with a MODULE_NOT_FOUND that says nothing about the real cause.
        ELECTRON_RUN_AS_NODE: undefined,
      },
    });
  } catch (err) {
    console.error('Failed to run integration tests:', err);
    process.exitCode = 1;
  } finally {
    if (fixture) {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  }
}

void main();
