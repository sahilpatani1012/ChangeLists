import * as path from 'path';
import { glob } from 'glob';
import Mocha from 'mocha';

/** Loaded by @vscode/test-electron inside the spawned VS Code's extension host (see
 *  runTest.ts). Discovers every compiled *.test.js under this directory and runs them
 *  with Mocha's TDD interface (suite/test), matching the vscode-extension-samples
 *  convention so this scaffold is a drop-in fit for VS Code's own tooling docs. */
export async function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 20000 });
  const testsRoot = path.resolve(__dirname, '.');
  const files = await glob('**/*.test.js', { cwd: testsRoot });
  for (const file of files) {
    mocha.addFile(path.resolve(testsRoot, file));
  }

  return new Promise((resolve, reject) => {
    try {
      mocha.run((failures) => {
        if (failures > 0) {
          reject(new Error(`${failures} integration test(s) failed.`));
        } else {
          resolve();
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}
