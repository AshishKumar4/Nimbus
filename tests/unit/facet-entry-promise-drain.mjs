#!/usr/bin/env bun
// Regression test for the foreground/attached facet entrypoint promise
// drain. A floating async entrypoint (e.g. `vt().catch(...)` in create-vite's
// clack-driven scaffold) settles across MANY event-loop ticks before its
// synchronous file writes run. The drain must keep ticking until the tracked
// promises actually settle — bounded by a wall-clock deadline, not a fixed
// tiny pass count. The pre-fix `maxPasses = 12` cap abandoned such
// entrypoints mid-flight, so `npm create vite` scaffolded zero files.

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

console.log('ok - facet-entry-promise-drain');
