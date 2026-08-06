/** Real (non-ambient) mirror of the numeric ordinals vscode.git's internal `Status` enum
 *  assigns to `Change.status`. Deliberately NOT declared inside git.d.ts: that file is a
 *  pure ambient declaration (no JS emitted for it at all), and a `const enum` imported as
 *  a *value* from a module with no runtime output can't be bundled by esbuild — esbuild
 *  compiles each file in isolation (the same restriction TypeScript's `isolatedModules`
 *  flag warns about) and refuses to inline a const enum across a file boundary, so
 *  `import { Status } from './git'` failed to resolve at bundle time even though `tsc`
 *  itself compiled it fine by inlining the values whole-program.
 *
 *  A real, local, plain `enum` sidesteps that entirely: it's actual runtime code we own,
 *  bundles like any other module, and its ordinals are set here to match vscode.git's own
 *  (stable, long-unchanged — see microsoft/vscode extensions/git/src/api/git.d.ts) Status
 *  enum, which is the standard way third-party extensions consume it. */
export enum Status {
  INDEX_MODIFIED,
  INDEX_ADDED,
  INDEX_DELETED,
  INDEX_RENAMED,
  INDEX_COPIED,
  MODIFIED,
  DELETED,
  UNTRACKED,
  IGNORED,
  INTENT_TO_ADD,
  INTENT_TO_RENAME,
  TYPE_CHANGED,
  ADDED_BY_US,
  ADDED_BY_THEM,
  DELETED_BY_US,
  DELETED_BY_THEM,
  BOTH_ADDED,
  BOTH_DELETED,
  BOTH_MODIFIED,
}
