#!/usr/bin/env bun
// A wait for a Dynamic Worker that no release can ever satisfy is refused,
// and one that can still be satisfied keeps waiting. Told from explicit
// state, never by a timeout or by ancestry alone: a worker is given back
// when its holder ends, and a holder ends on its own unless it has said it
// is blocked (setProcessBlocked: its only remaining work is waiting on its
// own children, as its event loop knows). What has to hold:
//
//   (1) at the limit, with every worker held by a blocked process (nine
//       children of a parent, each doing nothing but wait on a grandchild of
//       its own), the newest waiter that descends from a holder is refused
//       with DynamicWorkerDeadlockError (EAGAIN, errno -11), holding nothing;
//       the others keep waiting, and are let in, in order, as holders end;
//   (2) a holder that is not blocked will end on its own, so nothing is
//       refused, though every holder has a waiting descendant: children
//       that each wait on a grandchild AND have a process.exit(0) scheduled
//       (the reviewer's counterexample) wait, and are let in when one ends;
//       a holder that unblocks (a timer set) withdraws the refusal's ground;
//   (3) nothing is refused while a hold no process owns (a pool's call) is
//       in flight, nor while a fan-out's claim is held;
//   (4) a one-shot run is such a waiter: refused, it rejects with the error
//       and assembles nothing;
//   (5) a holder's blocked state ends with its last hold.
//
// Before, every such wait waited for good; then (3160c492f..312210f89) a
// wait was refused from ancestry alone, which refused (2).

import assert from 'node:assert/strict';
import {
  beginLoaderFetch,
  beginLoaderFetchWhenFree,
  claimDynamicWorkers,
  DO_DYNAMIC_WORKER_LIMIT,
  DynamicWorkerDeadlockError,
  dynamicWorkerHeadroom,
  isDynamicWorkerDeadlock,
  loaderLedgerStats,
  setProcessBlocked,
} from '../../packages/fabric/src/budgets.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { createCtxExports, createFacetCtx, createFacetWorld } from './facet-host-harness.mjs';

assert.equal(DO_DYNAMIC_WORKER_LIMIT, 10, 'the scenarios below fill a limit of 10');
let ctxCount = 0;
const freshCtx = () => ({ id: { toString: () => `deadlock-${++ctxCount}` } });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Parent 1 holds a worker, and so does each of its nine children, 2..10. */
function fullOfAFamily(ctx) {
  return new Map(Array.from({ length: 10 }, (_, i) => [i + 1, beginLoaderFetch(ctx, `run-${i + 1}`, undefined, i + 1)]));
}

/** End every hold, and every wait as it is let in, until the ledger is empty. */
async function release(holds, waits) {
  for (const [, end] of holds) end();
  while (waits.some((w) => w.end === null && w.error === null)) {
    for (const w of waits) w.end?.();
    await tick();
  }
  for (const w of waits) w.end?.();
}

/** A wait for grandchild 100+k of child k, recorded as it settles. */
function grandchild(ctx, k, log) {
  const entry = { pid: 100 + k, end: null, error: null };
  entry.promise = beginLoaderFetchWhenFree(ctx, `run-${100 + k}`, { process: { pid: 100 + k, ancestors: [k, 1] } }).then(
    (end) => { entry.end = end; log.push(`in ${entry.pid}`); },
    (error) => { entry.error = error; log.push(`refused ${entry.pid}`); },
  );
  return entry;
}

// ── (1) every holder blocked on its children: the newest is refused ────────
{
  const ctx = freshCtx();
  const holds = fullOfAFamily(ctx);
  const log = [];
  const waits = [];
  setProcessBlocked(ctx, 1, true); // the parent waits on its children
  for (let k = 2; k <= 10; k++) {
    waits.push(grandchild(ctx, k, log));
    await tick();
    if (k < 10) assert.deepEqual(log, [], `with child ${k + 1} not yet blocked, every wait waits`);
    setProcessBlocked(ctx, k, true); // child k now waits on its grandchild only
    await tick();
  }
  assert.deepEqual(log, ['refused 110'], 'the last holder blocking makes it a deadlock: the newest waiter is refused');
  const refused = waits.at(-1).error;
  assert.ok(isDynamicWorkerDeadlock(refused) && refused instanceof DynamicWorkerDeadlockError);
  assert.equal(refused.code, 'EAGAIN');
  assert.equal(refused.errno, -11);
  assert.equal(refused.pid, 110);
  assert.deepEqual([...refused.holders].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'naming the holders');
  assert.equal(loaderLedgerStats(ctx).waiting, 8, 'the other eight keep waiting');
  assert.equal(loaderLedgerStats(ctx).inFlightWorkers.length, 10, 'and the refusal took no hold');
  // Child 10, told its grandchild cannot start, ends: grandchild 102, first to ask, is let in.
  holds.get(10)();
  await tick();
  assert.deepEqual(log, ['refused 110', 'in 102'], 'room made by a holder goes to the oldest waiter');
  holds.get(2)();
  await tick();
  assert.deepEqual(log.slice(2), ['in 103'], 'and so on, in order, with no other refusal');
  await release(holds, waits);
  assert.equal(dynamicWorkerHeadroom(ctx), DO_DYNAMIC_WORKER_LIMIT);
}

// ── (2) a holder that is not blocked will end: nothing refused ──────────────
{
  const ctx = freshCtx();
  const holds = fullOfAFamily(ctx);
  const log = [];
  setProcessBlocked(ctx, 1, true);
  // Every child waits on a grandchild of its own, but has a process.exit(0)
  // scheduled too: not blocked.
  const waits = [];
  for (let k = 2; k <= 10; k++) waits.push(grandchild(ctx, k, log));
  await tick();
  assert.deepEqual(log, [], 'children with work of their own will end: every wait keeps waiting');
  // Eight of them have only their grandchild left; one still has its timer.
  for (let k = 2; k <= 9; k++) setProcessBlocked(ctx, k, true);
  await tick();
  assert.deepEqual(log, [], 'one holder not blocked is enough to keep waiting');
  // A blocked holder sets a timer: it unblocks, and blocking the last one is not a deadlock.
  setProcessBlocked(ctx, 4, false);
  setProcessBlocked(ctx, 10, true);
  await tick();
  assert.deepEqual(log, [], 'a holder that unblocked withdraws the ground for a refusal');
  // Child 4's timer fires: it exits and gives its worker back.
  holds.get(4)();
  await tick();
  assert.deepEqual(log, ['in 102'], 'and the oldest waiter is let in');
  await release(holds, waits);
}

// ── (3) a hold no process owns, or a fan-out's claim: nothing refused ──────
{
  const ctx = freshCtx();
  const holds = fullOfAFamily(ctx);
  holds.get(10)();
  for (let k = 1; k <= 9; k++) setProcessBlocked(ctx, k, true);
  const pool = beginLoaderFetch(ctx, 'nfp:a-pool-call');
  const log = [];
  const waits = Array.from({ length: 8 }, (_, i) => grandchild(ctx, i + 2, log));
  await tick();
  assert.deepEqual(log, [], "a pool's call ends on its own: nobody is refused");
  pool();
  await tick();
  assert.deepEqual(log, ['in 102']);
  await release(holds, waits);
}
{
  const ctx = freshCtx();
  const holds = new Map(Array.from({ length: 9 }, (_, i) => [i + 1, beginLoaderFetch(ctx, `run-${i + 1}`, undefined, i + 1)]));
  for (let k = 1; k <= 9; k++) setProcessBlocked(ctx, k, true);
  const claim = claimDynamicWorkers(ctx, 1);
  assert.ok(claim);
  const log = [];
  const waits = Array.from({ length: 8 }, (_, i) => grandchild(ctx, i + 2, log));
  await tick();
  assert.deepEqual(log, [], "a fan-out's claim is released when its batch ends: nobody is refused");
  claim.release();
  await tick();
  assert.deepEqual(log, ['in 102']);
  await release(holds, waits);
}

// ── (4) a one-shot run refused: rejects with the error, assembles nothing ──
adoptCtxExports(createCtxExports(() => { throw new Error('no disk'); }));
{
  const world = createFacetWorld(() => ({}));
  const ctx = createFacetCtx(world, 'deadlock-one-shot');
  let loaded = 0;
  const env = { LOADER: { get: world.loader.get, load() { loaded++; throw new Error('not reached'); } } };
  const host = processHostFor(ctx, env, () => ({ readFile() { throw new Error('no disk'); } }));
  const holds = fullOfAFamily(ctx);
  for (let k = 1; k <= 10; k++) setProcessBlocked(ctx, k, true);
  let assembled = 0;
  const run = (pid, ancestors) => host.runOnce({
    pid,
    writerId: crypto.randomUUID(),
    ancestors,
    code: async () => { assembled++; throw new Error('not reached'); },
    request: new Request('https://run/', { method: 'POST', body: '{}' }),
    onWriterActivated() {},
  }, (response) => response.text());
  await assert.rejects(run(110, [10, 1]), (error) => isDynamicWorkerDeadlock(error) && error.pid === 110 && error.code === 'EAGAIN');
  assert.equal(assembled, 0, 'the refused run assembled no module map');
  assert.equal(loaded, 0, 'and loaded no worker');
  for (const [, end] of holds) end();
}

// ── (5) a holder's blocked state ends with its last hold ────────────────────
{
  const ctx = freshCtx();
  const first = beginLoaderFetch(ctx, 'run-7', undefined, 7);
  const second = beginLoaderFetch(ctx, 'run-7-b', undefined, 7);
  setProcessBlocked(ctx, 7, true);
  first();
  const holds = Array.from({ length: 9 }, (_, i) => beginLoaderFetch(ctx, `other-${i}`, undefined, 20 + i));
  for (let i = 0; i < 9; i++) setProcessBlocked(ctx, 20 + i, true);
  const log = [];
  const waiting = beginLoaderFetchWhenFree(ctx, 'late', { process: { pid: 300, ancestors: [7] } }).then(
    () => log.push('in'), (error) => log.push(error.code));
  await tick();
  assert.deepEqual(log, ['EAGAIN'], 'process 7, still holding one worker, is still blocked');
  second();
  const again = beginLoaderFetch(ctx, 'run-7-c', undefined, 7);
  const log2 = [];
  beginLoaderFetchWhenFree(ctx, 'later', { process: { pid: 301, ancestors: [7] } }).then(
    (end) => { log2.push('in'); end(); }, (error) => log2.push(error.code));
  await tick();
  assert.deepEqual(log2, [], 'once its last hold ended, a new hold of process 7 is not taken to be blocked');
  again();
  await tick();
  assert.deepEqual(log2, ['in']);
  await waiting;
  for (const end of holds) end();
}

console.log('ok - dynamic-worker-deadlock (refused only when every holder is blocked on its children, newest descendant first; a holder with work of its own keeps them waiting)');
