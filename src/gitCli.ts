import { execFile } from 'child_process';

/** Config forced onto every git invocation, via `-c`.
 *
 *  `diff.noprefix` and `diff.mnemonicPrefix` are the load-bearing pair. Both change the
 *  `a/`…`b/` prefixes in a diff header, and `git apply` defaults to `-p1` — so a user who
 *  sets either one turns every patch this extension generates into one git itself refuses
 *  to read ("git diff header lacks filename information when removing 1 leading pathname
 *  component"). That breaks unshelve and hunk-scoped commits: the two paths where a
 *  generated patch is the only copy of the user's work.
 *
 *  `color.ui` is belt-and-braces alongside the explicit `--no-color` at the call sites:
 *  `color.ui = always` puts ANSI escapes into piped output, which nothing recovers from.
 *
 *  Pinned in one place so a diff and the `apply` that reverses it can never disagree. */
const PINNED_CONFIG = ['-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false', '-c', 'color.ui=false'];

/** A whole-file diff of a large source file can run to megabytes, and Node's default
 *  1 MB cap turns that into a truncation error rather than a diff. */
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export class GitCommandError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly stderr: string,
    message: string
  ) {
    super(message);
    this.name = 'GitCommandError';
  }
}

/** Thin wrapper over the `git` binary — the only place in the extension that spawns a
 *  process.
 *
 *  Replaced `simple-git`, which accounted for most of the bundle while being used for
 *  little more than argument passing. Two things are better for having written it out:
 *  patches go to `git apply` over **stdin** instead of via a world-readable temp file in
 *  `os.tmpdir()`, and the failure message is git's own stderr rather than a wrapper's
 *  paraphrase of it. */
export class GitCli {
  constructor(private readonly cwd: string) {}

  /** Runs git and resolves with stdout. `stdin` is written and closed when supplied,
   *  which is how patches reach `git apply` without touching the filesystem. */
  run(args: readonly string[], options: { stdin?: string } = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        'git',
        [...PINNED_CONFIG, ...args],
        { cwd: this.cwd, maxBuffer: MAX_BUFFER_BYTES, windowsHide: true, encoding: 'utf8' },
        (err, stdout, stderr) => {
          if (!err) {
            resolve(stdout);
            return;
          }
          // git's own stderr is the part worth showing; Node's "Command failed: …" prefix
          // repeats the arguments the user cannot act on. ENOENT is worth naming outright,
          // because "git is not installed" reads nothing like a changelists problem.
          const detail = stderr.trim();
          const message =
            (err as NodeJS.ErrnoException).code === 'ENOENT'
              ? 'git was not found on your PATH. Changelists needs the git CLI for staging, commit, diff and patch application.'
              : detail || err.message;
          reject(new GitCommandError(args, detail, message));
        }
      );

      if (options.stdin !== undefined) {
        // A broken pipe here surfaces through the callback above; swallowing it keeps an
        // unhandled 'error' event from taking the extension host down with it.
        child.stdin?.on('error', () => undefined);
        child.stdin?.end(options.stdin, 'utf8');
      }
    });
  }
}
