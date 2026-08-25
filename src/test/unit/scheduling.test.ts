import test from 'node:test';
import assert from 'node:assert/strict';
import { CoalescingRunner, Debouncer } from '../../scheduling';

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A controllable async operation: records how many times it ran and lets each run be
 *  released on demand, so overlap is observable rather than timing-dependent. */
function gatedOperation() {
  let releases: Array<() => void> = [];
  let runs = 0;
  let concurrent = 0;
  let maxConcurrent = 0;
  const run = async (): Promise<void> => {
    runs++;
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise<void>((resolve) => releases.push(resolve));
    concurrent--;
  };
  return {
    run,
    get runs() {
      return runs;
    },
    get maxConcurrent() {
      return maxConcurrent;
    },
    get waiting() {
      return releases.length;
    },
    releaseAll(): void {
      const pending = releases;
      releases = [];
      for (const r of pending) {
        r();
      }
    },
  };
}

// ---- CoalescingRunner ------------------------------------------------------------------

test('CoalescingRunner never runs two passes at once', async () => {
  const op = gatedOperation();
  const runner = new CoalescingRunner(op.run);

  const a = runner.trigger();
  const b = runner.trigger();
  const c = runner.trigger();
  await tick();

  assert.equal(op.runs, 1, 'only the first trigger starts a pass');
  assert.equal(op.maxConcurrent, 1);

  op.releaseAll(); // first pass completes; the queued re-run starts
  await tick();
  assert.equal(op.runs, 2, 'the triggers that arrived mid-flight collapse into one re-run');

  op.releaseAll();
  await Promise.all([a, b, c]);
  assert.equal(op.runs, 2);
  assert.equal(op.maxConcurrent, 1);
});

test('CoalescingRunner resolves callers only once a pass that started after them is done', async () => {
  const op = gatedOperation();
  const runner = new CoalescingRunner(op.run);
  let lateResolved = false;

  runner.trigger();
  await tick();
  // Arrives while pass 1 is in flight, so it must NOT be satisfied by pass 1's result —
  // that pass read state from before this caller asked.
  const late = runner.trigger().then(() => {
    lateResolved = true;
  });

  op.releaseAll(); // pass 1 ends, pass 2 begins
  await tick();
  assert.equal(lateResolved, false, 'still waiting on the re-run it requested');
  assert.equal(op.runs, 2);

  op.releaseAll();
  await late;
  assert.equal(lateResolved, true);
});

test('CoalescingRunner goes idle between bursts', async () => {
  const op = gatedOperation();
  const runner = new CoalescingRunner(op.run);

  const first = runner.trigger();
  assert.equal(runner.isRunning, true);
  op.releaseAll();
  await first;
  assert.equal(runner.isRunning, false);

  const second = runner.trigger();
  op.releaseAll();
  await second;
  assert.equal(op.runs, 2, 'a later trigger starts a fresh pass rather than being swallowed');
});

test('CoalescingRunner surfaces a failing pass and stays usable afterwards', async () => {
  let attempt = 0;
  const runner = new CoalescingRunner(async () => {
    attempt++;
    if (attempt === 1) {
      throw new Error('status read failed');
    }
  });

  await assert.rejects(() => runner.trigger(), /status read failed/);
  assert.equal(runner.isRunning, false, 'a rejected pass must not leave the runner wedged');
  await runner.trigger();
  assert.equal(attempt, 2);
});

// ---- Debouncer -------------------------------------------------------------------------

test('Debouncer collapses a burst into one trailing run', async () => {
  let runs = 0;
  const debouncer = new Debouncer(20, () => {
    runs++;
  });

  for (let i = 0; i < 10; i++) {
    debouncer.schedule();
  }
  assert.equal(runs, 0, 'nothing runs while the burst is still arriving');
  assert.equal(debouncer.pending, true);

  await tick(60);
  assert.equal(runs, 1);
  assert.equal(debouncer.pending, false);
});

test('Debouncer restarts its clock on every schedule', async () => {
  let runs = 0;
  const debouncer = new Debouncer(40, () => {
    runs++;
  });

  debouncer.schedule();
  await tick(25);
  debouncer.schedule(); // still inside the window: the first run must never happen
  await tick(25);
  assert.equal(runs, 0, 'the second schedule pushed the deadline out');

  await tick(40);
  assert.equal(runs, 1);
});

test('Debouncer.cancel reports whether work was dropped', async () => {
  let runs = 0;
  const debouncer = new Debouncer(20, () => {
    runs++;
  });

  assert.equal(debouncer.cancel(), false, 'nothing pending');
  debouncer.schedule();
  assert.equal(debouncer.cancel(), true, 'a pending run was dropped — callers may need to flush it');
  assert.equal(debouncer.cancel(), false);

  await tick(50);
  assert.equal(runs, 0, 'a cancelled run must not fire later');
});

// ---- composed, as repositoryContext uses them -------------------------------------------

test('a debounced trigger feeding a coalescing runner never overlaps or drops work', async () => {
  const op = gatedOperation();
  const runner = new CoalescingRunner(op.run);
  const debouncer = new Debouncer(10, () => void runner.trigger());

  // A burst of git events...
  for (let i = 0; i < 5; i++) {
    debouncer.schedule();
  }
  await tick(30);
  assert.equal(op.runs, 1, 'five events, one pass');

  // ...and an explicit refresh arriving mid-pass supersedes the debounce and still waits
  // for a pass that began after it.
  debouncer.schedule();
  assert.equal(debouncer.cancel(), true);
  const explicit = runner.trigger();

  op.releaseAll();
  await tick();
  assert.equal(op.runs, 2);
  op.releaseAll();
  await explicit;
  assert.equal(op.maxConcurrent, 1, 'no interleaving at any point');
});

test('CoalescingRunner.whenIdle waits without starting a run', async () => {
  const op = gatedOperation();
  const runner = new CoalescingRunner(op.run);

  // Idle: returns immediately and starts nothing. This is the case that matters — a
  // reload must not rewrite a state file just to confirm it was already written.
  await runner.whenIdle();
  assert.equal(op.runs, 0);

  const running = runner.trigger();
  await tick();
  assert.equal(op.runs, 1);

  let idle = false;
  const waiter = runner.whenIdle().then(() => {
    idle = true;
  });
  await tick();
  assert.equal(idle, false, 'still waiting on the in-flight run');
  assert.equal(op.runs, 1, 'whenIdle did not queue a re-run');

  op.releaseAll();
  await Promise.all([running, waiter]);
  assert.equal(idle, true);
  assert.equal(op.runs, 1, 'and never did');
});

test('CoalescingRunner.whenIdle resolves even if the in-flight run fails', async () => {
  const runner = new CoalescingRunner(async () => {
    throw new Error('write failed');
  });
  const failing = runner.trigger();
  await assert.rejects(() => failing, /write failed/);
  await runner.whenIdle();
});
