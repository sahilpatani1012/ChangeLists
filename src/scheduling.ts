/** Two small scheduling primitives, kept free of `vscode` and `git` imports so the
 *  concurrency rules they encode can be unit-tested under plain Node — the surfaces that
 *  use them (repositoryContext, treeDataProvider) cannot be.
 *
 *  Both exist for the same reason: this extension reacts to events it does not control
 *  the rate of. `Repository.state.onDidChange` fires on every save, every index touch and
 *  every focus change; the changelists file watcher fires on every `git pull`. Reacting
 *  once per event means overlapping async passes that race each other's results, and
 *  redundant work nobody asked for. */

/** Runs an async operation at most once at a time.
 *
 *  A trigger arriving while a run is in flight does not start a second, overlapping run —
 *  it asks the current one to go round again once it finishes, and resolves with it. That
 *  matters wherever a pass ends by *assigning* to shared state: two interleaved passes
 *  can finish out of order and publish the older snapshot, which is the kind of bug that
 *  shows up as "the tree is occasionally one save stale" and is near-impossible to pin
 *  down after the fact.
 *
 *  The re-run is what keeps that safe rather than merely serialized: a trigger is never
 *  dropped, so the final run always observes state at least as fresh as the last request. */
export class CoalescingRunner {
  private inFlight: Promise<void> | undefined;
  private queued = false;

  constructor(private readonly run: () => Promise<void>) {}

  get isRunning(): boolean {
    return this.inFlight !== undefined;
  }

  /** Resolves once nothing is in flight, *without* requesting a run. The difference from
   *  trigger() matters for callers that only need the operation to have settled — asking
   *  for a fresh run there would mean, for instance, rewriting a state file on every
   *  reload just to confirm it was already written. */
  async whenIdle(): Promise<void> {
    while (this.inFlight) {
      // Swallowed deliberately: a failed run is the trigger caller's to handle, and this
      // caller only asked to wait for quiet.
      await this.inFlight.catch(() => undefined);
    }
  }

  /** Resolves when a run that started at or after this call has completed. */
  trigger(): Promise<void> {
    if (this.inFlight) {
      this.queued = true;
      return this.inFlight;
    }
    this.inFlight = this.loop().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async loop(): Promise<void> {
    do {
      // Cleared *before* the run, so a trigger arriving during it is seen on the way out
      // rather than being swallowed by this iteration's own reset.
      this.queued = false;
      await this.run();
    } while (this.queued);
  }
}

/** Trailing-edge debounce: `schedule()` restarts the clock, so a burst of calls costs one
 *  run once the burst stops. Separate from CoalescingRunner because they answer different
 *  questions — this one is "how often should we start", that one is "what if one is
 *  already running" — and the call sites need both, composed. */
export class Debouncer {
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly delayMs: number,
    private readonly action: () => void
  ) {}

  get pending(): boolean {
    return this.timer !== undefined;
  }

  schedule(): void {
    this.cancel();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.action();
    }, this.delayMs);
  }

  /** Cancels a pending run. Returns whether there was one, so callers can decide whether
   *  the cancelled work still needs doing (flush) or is genuinely obsolete (discard). */
  cancel(): boolean {
    if (this.timer === undefined) {
      return false;
    }
    clearTimeout(this.timer);
    this.timer = undefined;
    return true;
  }
}
