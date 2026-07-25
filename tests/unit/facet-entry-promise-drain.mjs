#!/usr/bin/env bun
// Regression test for the foreground/attached facet entrypoint promise
// drain. A floating async entrypoint (e.g. `vt().catch(...)` in create-vite's
// clack-driven scaffold) settles across MANY event-loop ticks before its
// synchronous file writes run. The drain must keep ticking until the tracked
// promises actually settle — bounded by a wall-clock deadline, not a fixed
// tiny pass count. The pre-fix `maxPasses = 12` cap abandoned such
// entrypoints mid-flight, so `npm create vite` scaffolded zero files.
//
// The drain also decides a one-shot facet's LIFETIME, so it has to see work
// that promise tracking structurally cannot: `await` resolves through
// PerformPromiseThen and never calls the patched Promise.prototype.then, so a
// floating `(async () => { await fetch(u); ... })()` leaves `__tracked`
// empty. In-flight async operations are counted separately
// (`globalThis.__nimbusPendingOps`, incremented at the shim's fetch and
// supervisor-RPC seams) and the drain must honour that counter — and must
// report what was still pending when it gives up, so the caller can fail
// instead of claiming a truncated program exited cleanly.

import assert from 'node:assert/strict';
import { ENTRYPOINT_PROMISE_TRACKER } from '../../packages/worker/src/facets/manager.ts';

// Instantiate the generated tracker exactly as a facet would.
const makeTracker = new Function(
  ENTRYPOINT_PROMISE_TRACKER + '\nreturn __makeEntrypointPromiseTracker;',
)();

// A floating promise that only settles after `ticks` macrotask turns, then
// performs a side effect — the analogue of create-vite finishing its scaffold
// writes well past tick 12.
function floatingWork(ticks, onDone) {
  let p = Promise.resolve();
  for (let i = 0; i < ticks; i++) {
    p = p.then(() => new Promise((r) => setTimeout(r, 0)));
  }
  return p.then(() => { onDone(); });
}

// 1. A 40-tick floating promise (well past the old 12-pass cap) must be fully
//    drained: the deadline is generous, so drain waits until it settles.
{
  const tracker = makeTracker();
  let done = false;
  tracker.start();
  const floating = floatingWork(40, () => { done = true; });
  tracker.track(floating);
  tracker.stop();

  await tracker.drain(null, 5000, 0);
  assert.equal(done, true, 'drain abandoned a 40-tick floating promise before it settled');
}

// 2. The drain returns early as soon as tracked promises settle — it must NOT
//    burn the full deadline for fast entrypoints.
{
  const tracker = makeTracker();
  tracker.start();
  tracker.track(floatingWork(2, () => {}));
  tracker.stop();

  const t0 = Date.now();
  await tracker.drain(null, 5000, 0);
  assert.ok(Date.now() - t0 < 1000, 'drain did not return promptly after promises settled');
}

// 3. A never-settling floating promise (server / interval) must be bounded by
//    the wall-clock deadline — drain returns, it does not hang forever.
{
  const tracker = makeTracker();
  tracker.start();
  // Pending forever; never tracked-as-settled.
  tracker.track(new Promise(() => {}));
  tracker.stop();

  const t0 = Date.now();
  await tracker.drain(null, 300, 0);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 250 && elapsed < 2000, `drain deadline not honored (elapsed=${elapsed}ms)`);
}

// 4. The process-exit signal short-circuits the drain immediately.
{
  const tracker = makeTracker();
  tracker.start();
  tracker.track(new Promise(() => {})); // never settles on its own
  tracker.stop();

  const exitPromise = Promise.resolve();
  const t0 = Date.now();
  await tracker.drain(exitPromise, 5000, 0);
  assert.ok(Date.now() - t0 < 500, 'drain did not short-circuit on process exit');
}

// 5. An in-flight async operation keeps the drain alive even though NOTHING
//    is tracked and no timer is pending — the floating-`await` case. The
//    pre-fix drain saw an empty __tracked, ran its minPasses and exited,
//    which is how a program that awaited a fetch was cut off after its first
//    flushed line and still reported exit 0.
{
  globalThis.__nimbusPendingOps = 0;
  const tracker = makeTracker();
  tracker.start();
  tracker.stop();

  let finished = false;
  // What the shim's __nimbusTrackOp does around a fetch: count it in flight,
  // count it out when it settles, with the continuation running after.
  globalThis.__nimbusPendingOps++;
  const op = new Promise((r) => setTimeout(r, 250));
  op.then(() => { globalThis.__nimbusPendingOps--; finished = true; });

  const result = await tracker.drain(null, 5000, 0);
  assert.equal(finished, true, 'drain abandoned an in-flight async operation');
  assert.equal(result.pending, 0, 'drain reports no pending work once the operation settled');
  assert.equal(globalThis.__nimbusPendingOps, 0);
}

// 6. Giving up is reported, never silently swallowed: the caller needs to know
//    the program did not finish so it can exit non-zero with a reason.
{
  globalThis.__nimbusPendingOps = 1;   // an operation that never settles
  const tracker = makeTracker();
  tracker.start();
  tracker.stop();

  const t0 = Date.now();
  const result = await tracker.drain(null, 300, 0);
  const elapsed = Date.now() - t0;
  assert.ok(result.pending > 0, 'drain must report the work still in flight when it gives up');
  assert.ok(elapsed >= 250 && elapsed < 2000, `drain deadline not honored (elapsed=${elapsed}ms)`);
  globalThis.__nimbusPendingOps = 0;
}

// 7. A pending TIMER is reported the same way — a one-shot program left with a
//    live interval did not finish either.
{
  globalThis.__nimbusPendingTimers = 1;
  const tracker = makeTracker();
  tracker.start();
  tracker.stop();

  const result = await tracker.drain(null, 200, 0);
  assert.ok(result.pending > 0, 'a live timer counts as unfinished work');
  globalThis.__nimbusPendingTimers = 0;
}

// 8. A process that exits explicitly is finished by definition — nothing is
//    reported as abandoned even with work in flight.
{
  globalThis.__nimbusPendingOps = 1;
  const tracker = makeTracker();
  tracker.start();
  tracker.stop();

  const result = await tracker.drain(Promise.resolve(), 5000, 0);
  assert.equal(result.pending, 0, 'an explicit process exit is not a truncation');
  globalThis.__nimbusPendingOps = 0;
}

console.log('ok - facet-entry-promise-drain');
