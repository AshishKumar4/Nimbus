#!/usr/bin/env bun
// Regression test for the event loop a node facet entrypoint runs on.
//
// A one-shot facet's lifetime IS this loop, so it has to answer exactly the
// question Node's loop answers: are there live HANDLES left? Node exits when
// there are none — timers, sockets, servers, requests in flight. An unsettled
// promise is NOT a handle, and this is where that used to go wrong: the loop
// tracked promises through a patched Promise.prototype.then, so a program
// ending with `Promise.resolve().then(() => new Promise(() => {}))` — a shape
// npm CLIs produce routinely — burned the whole 30s facet lifetime and was
// then reported as unfinished. Node prints its output and exits 0.
//
// The handles that DO count are each owned by the shim that creates them:
// `__nimbusPendingTimers` (the timer tracker), `__nimbusPendingOps` (fetch,
// response-body reads, supervisor RPC — `await` resolves through
// PerformPromiseThen and surfaces nowhere else, so this counter is how awaited
// work is seen at all), and `__portRegistry` (listening servers).

import assert from 'node:assert/strict';
import { ENTRYPOINT_EVENT_LOOP } from '../../packages/worker/src/facets/manager.ts';

// Instantiate the generated loop exactly as a facet would, over the globals a
// facet's shims maintain.
const loop = new Function(
  '__nimbusProcessExitPromise',
  ENTRYPOINT_EVENT_LOOP + `
  return {
    runEventLoop: __nimbusRunEventLoop,
    liveHandles: __nimbusLiveHandles,
    pendingStartupWork: __nimbusPendingStartupWork,
    runEntrypointToExit: __nimbusRunEntrypointToExit,
    settleEntrypointStartup: __nimbusSettleEntrypointStartup,
  };`,
);

/** A fresh loop over a fresh, quiescent handle table. */
function freshLoop({ exitPromise = new Promise(() => {}) } = {}) {
  globalThis.__nimbusPendingTimers = 0;
  globalThis.__nimbusPendingOps = 0;
  globalThis.__portRegistry = new Map();
  return loop(exitPromise);
}

// ── 1. An unsettled promise is not a handle ─────────────────────────────────
// The npm-bin fixture verbatim: a floating chain that adopts a promise nothing
// will ever settle. Node prints and exits 0; so must the facet, promptly.
{
  const l = freshLoop();
  let printed = false;
  Promise.resolve().then(() => new Promise(() => {}));
  printed = true;

  const t0 = Date.now();
  const r = await l.runEntrypointToExit(undefined, 5000);
  const elapsed = Date.now() - t0;

  assert.equal(printed, true);
  assert.equal(r.pending, 0, 'an unsettled promise was counted as unfinished work');
  assert.ok(elapsed < 500, `the loop waited on an unsettleable promise (elapsed=${elapsed}ms)`);
}

// A whole microtask chain, however long, still resolves inside the loop's
// warm-up passes — nothing about dropping promise tracking cuts it short.
{
  const l = freshLoop();
  let steps = 0;
  let chain = Promise.resolve();
  for (let i = 0; i < 5000; i++) chain = chain.then(() => { steps++; });

  const r = await l.runEntrypointToExit(undefined, 5000);
  assert.equal(steps, 5000, 'a microtask chain was cut off');
  assert.equal(r.pending, 0);
}

// ── 2. A pending timer keeps the program alive until it fires ───────────────
{
  const l = freshLoop();
  let fired = false;
  globalThis.__nimbusPendingTimers++;
  setTimeout(() => { globalThis.__nimbusPendingTimers--; fired = true; }, 400);

  const r = await l.runEntrypointToExit(undefined, 5000);
  assert.equal(fired, true, 'the loop abandoned a pending timer');
  assert.equal(r.pending, 0);
}

// A timer that never fires is not a clean exit: the program did not finish and
// the caller has to be able to say so.
{
  const l = freshLoop();
  globalThis.__nimbusPendingTimers = 1;    // a live setInterval

  const t0 = Date.now();
  const r = await l.runEntrypointToExit(undefined, 300);
  const elapsed = Date.now() - t0;
  assert.ok(r.pending > 0, 'a live timer must be reported as work still in flight');
  assert.ok(elapsed >= 250 && elapsed < 2000, `deadline not honored (elapsed=${elapsed}ms)`);
}

// ── 3. An open server keeps the program alive ───────────────────────────────
// `http.createServer().listen(p)` puts the server in __portRegistry and takes
// it out again on close(). A bound port keeps a Node process alive; it keeps
// the facet alive too, and closing it lets the program end.
{
  const l = freshLoop();
  globalThis.__portRegistry.set(3000, {});
  assert.equal(l.liveHandles(), 1, 'a listening server is a live handle');

  setTimeout(() => globalThis.__portRegistry.delete(3000), 400);

  const t0 = Date.now();
  const r = await l.runEntrypointToExit(undefined, 5000);
  const elapsed = Date.now() - t0;
  assert.equal(r.pending, 0, 'the program ended once its server closed');
  assert.ok(elapsed >= 350, `the loop exited while a server was still listening (elapsed=${elapsed}ms)`);
}

// A RESIDENT facet only settles its startup — it keeps serving afterwards, and
// its boot response is awaited by the shell, so its own listening port must
// not hold the prompt.
{
  const l = freshLoop();
  globalThis.__portRegistry.set(3000, {});
  assert.equal(l.pendingStartupWork(), 0, 'a listening server is not startup work');

  const t0 = Date.now();
  await l.settleEntrypointStartup(undefined, 5000);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 500, `a resident boot waited on its own server (elapsed=${elapsed}ms)`);
}

// ── 4. In-flight async operations are awaited ───────────────────────────────
// The floating-`await` case: nothing is tracked and no timer is pending, yet
// the program is mid-fetch. Pre-fix this exited after its first flushed line
// and still reported success.
{
  const l = freshLoop();
  let finished = false;
  globalThis.__nimbusPendingOps++;
  const op = new Promise((r) => setTimeout(r, 250));
  op.then(() => { globalThis.__nimbusPendingOps--; finished = true; });

  const r = await l.runEntrypointToExit(undefined, 5000);
  assert.equal(finished, true, 'the loop abandoned an in-flight async operation');
  assert.equal(r.pending, 0);
  assert.equal(globalThis.__nimbusPendingOps, 0);
}

// An operation that never settles is reported, never silently swallowed.
{
  const l = freshLoop();
  globalThis.__nimbusPendingOps = 1;

  const r = await l.runEventLoop(l.liveHandles, null, 300, 0);
  assert.ok(r.pending > 0, 'abandoned work must be reported so the caller can fail');
}

// ── 5. process.exit() wins over everything outstanding ──────────────────────
{
  const l = freshLoop({ exitPromise: Promise.resolve(3) });
  globalThis.__nimbusPendingOps = 1;
  globalThis.__nimbusPendingTimers = 1;
  globalThis.__portRegistry.set(8080, {});

  const t0 = Date.now();
  const r = await l.runEntrypointToExit(new Promise(() => {}), 5000);
  const elapsed = Date.now() - t0;
  assert.equal(r.pending, 0, 'an explicit process exit is not a truncation');
  assert.ok(elapsed < 500, `process.exit did not exit immediately (elapsed=${elapsed}ms)`);
}

// ── 6. An entry's own evaluation promise IS awaited ─────────────────────────
// Top-level await in an ESM entry: the module has not finished loading until
// its evaluation promise settles, so that one promise is a handle.
{
  const l = freshLoop();
  let evaluated = false;
  const entry = new Promise((r) => setTimeout(() => { evaluated = true; r(); }, 400));

  const t0 = Date.now();
  await l.runEntrypointToExit(entry, 5000);
  assert.equal(evaluated, true, 'the entry module evaluation was abandoned');
  assert.ok(Date.now() - t0 >= 350);
}

globalThis.__nimbusPendingTimers = 0;
globalThis.__nimbusPendingOps = 0;
globalThis.__portRegistry = new Map();
console.log('ok - facet-entry-event-loop');
