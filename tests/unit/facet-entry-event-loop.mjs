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

// These cases never time the loop. A loop that must not wait is given a
// deadline no test outlives (NEVER) and must return at all (a wait shows as
// the guard's failure, a minute on, not as a slow run); a wait that must
// happen is checked by what had happened when the loop returned.
const NEVER = 3_600_000;
function returns(promise, what) {
  let guard;
  return Promise.race([
    promise,
    new Promise((_, reject) => { guard = setTimeout(() => reject(new Error(`${what}: the loop never returned`)), 60_000); }),
  ]).finally(() => clearTimeout(guard));
}

// ── 1. An unsettled promise is not a handle ─────────────────────────────────
// The npm-bin fixture verbatim: a floating chain that adopts a promise nothing
// will ever settle. Node prints and exits 0; so must the facet, promptly.
{
  const l = freshLoop();
  let printed = false;
  Promise.resolve().then(() => new Promise(() => {}));
  printed = true;

  const r = await returns(l.runEntrypointToExit(undefined, NEVER), 'an unsettled promise');

  assert.equal(printed, true);
  assert.equal(r.pending, 0, 'an unsettled promise was counted as unfinished work');
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
// The deadline is honored, not cut short: an untracked timer due before it
// has fired by the time the loop gives up (timers fire in due order).
{
  const l = freshLoop();
  globalThis.__nimbusPendingTimers = 1;    // a live setInterval
  let dueEarlier = false;
  setTimeout(() => { dueEarlier = true; }, 100);

  const r = await l.runEntrypointToExit(undefined, 300);
  assert.ok(r.pending > 0, 'a live timer must be reported as work still in flight');
  assert.equal(dueEarlier, true, 'the loop gave up before its deadline');
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

  const r = await l.runEntrypointToExit(undefined, NEVER);
  assert.equal(r.pending, 0, 'the program ended once its server closed');
  assert.equal(globalThis.__portRegistry.has(3000), false, 'the loop exited while a server was still listening');
}

// A RESIDENT facet only settles its startup — it keeps serving afterwards, and
// its boot response is awaited by the shell, so its own listening port must
// not hold the prompt.
{
  const l = freshLoop();
  globalThis.__portRegistry.set(3000, {});
  assert.equal(l.pendingStartupWork(), 0, 'a listening server is not startup work');

  await returns(l.settleEntrypointStartup(undefined, NEVER), 'a resident boot waited on its own server');
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

  const r = await returns(l.runEntrypointToExit(new Promise(() => {}), NEVER), 'process.exit did not exit');
  assert.equal(r.pending, 0, 'an explicit process exit is not a truncation');
}

// ── 6. An entry's own evaluation promise IS awaited ─────────────────────────
// Top-level await in an ESM entry: the module has not finished loading until
// its evaluation promise settles, so that one promise is a handle.
{
  const l = freshLoop();
  let evaluated = false;
  const entry = new Promise((r) => setTimeout(() => { evaluated = true; r(); }, 400));

  await l.runEntrypointToExit(entry, NEVER);
  assert.equal(evaluated, true, 'the entry module evaluation was abandoned');
}

globalThis.__nimbusPendingTimers = 0;
globalThis.__nimbusPendingOps = 0;
globalThis.__portRegistry = new Map();
console.log('ok - facet-entry-event-loop');
