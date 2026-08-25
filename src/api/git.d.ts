/**
 * Minimal type declarations for the built-in `vscode.git` extension's exported API.
 *
 * The `vscode.git` extension does not ship its own `.d.ts` on the marketplace; this is
 * a trimmed-down copy of the publicly documented surface (see microsoft/vscode source,
 * extensions/git/src/api/git.d.ts) restricted to what this extension consumes:
 * repository discovery, working-tree/index status, and HEAD/branch info. We deliberately
 * do NOT declare the repository's `add`/`commit` methods here even though upstream
 * exposes them — see gitService.ts for why staging/commit go through the git CLI instead.
 *
 * `Status` itself lives in ./gitStatus.ts, not here — see that file's doc comment for
 * why (this file has zero JS emission, and esbuild can't bundle a const-enum *value*
 * import from a module with no runtime output).
 */

import type { Event, Uri } from 'vscode';
import type { Status } from './gitStatus';

export interface Change {
  readonly uri: Uri;
  readonly originalUri: Uri;
  readonly status: Status;
}

export interface RepositoryState {
  readonly HEAD: Branch | undefined;
  readonly workingTreeChanges: Change[];
  readonly indexChanges: Change[];
  readonly mergeChanges: Change[];
  readonly untrackedChanges?: Change[];
  readonly onDidChange: Event<void>;
}

export interface Branch {
  readonly name?: string;
  readonly commit?: string;
}

export interface RepositoryUIState {
  readonly selected: boolean;
  readonly onDidChange: Event<void>;
}

export interface Repository {
  readonly rootUri: Uri;
  readonly state: RepositoryState;
  readonly ui: RepositoryUIState;
}

export interface API {
  readonly state: 'uninitialized' | 'initialized';
  readonly repositories: Repository[];
  readonly onDidOpenRepository: Event<Repository>;
  readonly onDidCloseRepository: Event<Repository>;
  readonly onDidChangeState: Event<'uninitialized' | 'initialized'>;
  getRepository(uri: Uri): Repository | null;
}

export interface GitExtension {
  readonly enabled: boolean;
  readonly onDidChangeEnablement: Event<boolean>;
  getAPI(version: 1): API;
}
