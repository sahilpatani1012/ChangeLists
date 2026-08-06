import * as path from 'path';
import { runTests } from '@vscode/test-electron';

/** Entry point for `npm run test:integration`. Downloads/launches a real VS Code
 *  instance and runs suite/index.ts inside its extension host — this actually loads
 *  the packaged extension (dist/extension.js), unlike the unit tests. Requires network
 *  access to fetch the VS Code binary the first time it runs, so it is NOT exercised as
 *  part of this scaffold's own verification; see README.md "Testing". */
async function main(): Promise<void> {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');
    const extensionTestsPath = path.resolve(__dirname, './suite/index');
    await runTests({ extensionDevelopmentPath, extensionTestsPath });
  } catch (err) {
    console.error('Failed to run integration tests:', err);
    process.exitCode = 1;
  }
}

void main();
