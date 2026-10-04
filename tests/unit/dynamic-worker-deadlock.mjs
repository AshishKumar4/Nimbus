#!/usr/bin/env bun
// A wait for a Dynamic Worker that no release can ever satisfy is refused,
// and one that can still be satisfied keeps waiting. Told structurally, from
// who holds the Durable Object's workers and whom each waiter descends from,
// never by a timeout. What has to hold:
//
//   (1) at the limit, with every hold a process that has a descendant among
//       the waiters (nine children of a parent, each waiting on a grandchild
//       of its own), the newest such waiter is refused with
//       DynamicWorkerDeadlockError (EAGAIN, errno -11), holding nothing; the
//       others keep waiting, and are let in, in order, as holders end;
//   (2) if any holder has no descendant waiting, it can end on its own:
//       nothing is refused;
//   (3) neither is anything while a hold no process owns (a pool's call) is
//       in flight, nor while a fan-out's claim is held;
//   (4) a one-shot run is such a waiter: refused, it rejects with the error
//       and assembles nothing.
//
// Before, every such wait waited for good.

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

// ── (1) every holder waits on a waiting descendant: the newest is refused ───
{
  const ctx = freshCtx();
  const holds = fullOfAFamily(ctx);
  const log = [];
  const waits = [];
  for (let k = 2; k <= 9; k++) waits.push(grandchild(ctx, k, log));
  await tick();
  assert.deepEqual(log, [], 'with child 10 not yet waiting on anything, every wait waits');
  waits.push(grandchild(ctx, 10, log));
  await tick();
  assert.deepEqual(log, ['refused 110'], 'the last piece makes it a deadlock: the newest waiter is refused');
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

// ── (2) a holder with no waiting descendant can still end: nothing refused ──
{
  const ctx = freshCtx();
  const holds = fullOfAFamily(ctx);
  const log = [];
  // Child 5's grandchild never asks.
  const waits = [2, 3, 4, 6, 7, 8, 9, 10].map((k) => grandchild(ctx, k, log));
  await tick();
  assert.deepEqual(log, [], 'child 5 waits on nothing here, so it may end: every wait keeps waiting');
  holds.get(5)();
  await tick();
  assert.deepEqual(log, ['in 102'], 'and when it does, the oldest waiter is let in');
  await release(holds, waits);
}

// ── (3) a hold no process owns, or a fan-out's claim: nothing refused ──────
{
  const ctx = freshCtx();
  const holds = fullOfAFamily(ctx);
  holds.get(10)();
  const pool = beginLoaderFetch(ctx, 'nfp:a-pool-call');
  const log = [];
  const waits = Array.from({ length: 9 }, (_, i) => grandchild(ctx, i + 2, log));
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
  let assembled = 0;
  const run = (pid, ancestors) => host.runOnce({
    pid,
    writerId: crypto.randomUUID(),
    ancestors,
    code: async () => { assembled++; throw new Error('not reached'); },
    request: new Request('https://run/', { method: 'POST', body: '{}' }),
    onWriterActivated() {},
  }, (response) => response.text());
  const waiting = [];
  for (let k = 2; k <= 9; k++) waiting.push(run(100 + k, [k, 1]).catch((error) => error));
  const last = run(110, [10, 1]);
  await assert.rejects(last, (error) => isDynamicWorkerDeadlock(error) && error.pid === 110 && error.code === 'EAGAIN');
  assert.equal(assembled, 0, 'the refused run assembled no module map');
  assert.equal(loaded, 0, 'and loaded no worker');
  assert.equal(loaderLedgerStats(ctx).waiting, 8, 'the other runs wait on');
  for (const [, end] of holds) end();
  await Promise.all(waiting);
}

console.log('ok - dynamic-worker-deadlock (a wait no release can satisfy is refused EAGAIN, newest first; one that can still be satisfied waits)');
