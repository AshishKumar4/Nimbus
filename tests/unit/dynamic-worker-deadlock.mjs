#!/usr/bin/env bun
// A wait for a Dynamic Worker that no release can ever satisfy is refused,
// and one that can still be satisfied keeps waiting. Told from explicit
// state, never by a timeout or by ancestry alone. A process reports that
// its only remaining work is waiting on its own children, and which
// (setProcessBlocked); a report is current only while no news of those
// children has been produced for it since, and only if it had seen every
// news reply made for it (noteProcessNews, processNewsReply). A holder is
// stuck when its current report waits only on children that are queued for
// a worker or stuck themselves: a fixpoint over the wait-for graph. What has
// to hold:
//
//   (1) at the limit, with every worker held by a stuck process (nine
//       children of a parent, each doing nothing but wait on a grandchild of
//       its own), the newest queued process a stuck holder waits on is
//       refused with DynamicWorkerDeadlockError (EAGAIN, errno -11), holding
//       nothing; the others keep waiting, and are let in, in order, as
//       holders end;
//   (2) a holder that is not blocked will end on its own, so nothing is
//       refused, though every holder has a waiting descendant (children that
//       also have a process.exit(0) scheduled); a holder that unblocks
//       withdraws the refusal's ground;
//   (3) nothing is refused while a hold no process owns (a pool's call) is
//       in flight, nor while a fan-out's claim is held;
//   (4) a one-shot run is such a waiter: refused, it rejects with the error
//       and assembles nothing;
//   (5) a holder's report ends with its last hold;
//   (6) a holder blocked on a child that is neither queued nor stuck (a
//       `sleep 5` builtin, which runs without a worker) is not stuck, and
//       neither is a parent waiting on it: nothing is refused until that
//       child's exit has been heard and the holder reports again;
//   (7) news of a child produced for a holder after its report withdraws the
//       report, and a report that had not seen every news reply made for the
//       holder is not taken.
//
// Before, every such wait waited for good; then (3160c492f..312210f89) a
// wait was refused from ancestry alone, which refused (2); then
// (34f5b1e0e) from blocked state alone, which refused (6) and (7).

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
  noteProcessNews,
  processNewsReply,
  setProcessBlocked,
} from '../../packages/fabric/src/budgets.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { createCtxExports, createFacetCtx, createFacetWorld } from './facet-host-harness.mjs';

assert.equal(DO_DYNAMIC_WORKER_LIMIT, 10, 'the scenarios below fill a limit of 10');
let ctxCount = 0;
const freshCtx = () => ({ id: { toString: () => `deadlock-${++ctxCount}` } });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Process `pid` reports it waits only on `waitsOn`, having seen `seen` news replies. */
const block = (ctx, pid, waitsOn, seen = 0) => setProcessBlocked(ctx, pid, { blocked: true, seen, waitsOn });
const unblock = (ctx, pid) => setProcessBlocked(ctx, pid, { blocked: false, seen: 0, waitsOn: [] });
const children = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

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
  block(ctx, 1, children(2, 10)); // the parent waits on its children
  for (let k = 2; k <= 10; k++) {
    waits.push(grandchild(ctx, k, log));
    await tick();
    if (k < 10) assert.deepEqual(log, [], `with child ${k + 1} not yet blocked, every wait waits`);
    block(ctx, k, [100 + k]); // child k now waits on its grandchild only
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
  block(ctx, 1, children(2, 10));
  // Every child waits on a grandchild of its own, but has a process.exit(0)
  // scheduled too: not blocked.
  const waits = [];
  for (let k = 2; k <= 10; k++) waits.push(grandchild(ctx, k, log));
  await tick();
  assert.deepEqual(log, [], 'children with work of their own will end: every wait keeps waiting');
  // Eight of them have only their grandchild left; one still has its timer.
  for (let k = 2; k <= 9; k++) block(ctx, k, [100 + k]);
  await tick();
  assert.deepEqual(log, [], 'one holder not blocked is enough to keep waiting');
  // A blocked holder sets a timer: it unblocks, and blocking the last one is not a deadlock.
  unblock(ctx, 4);
  block(ctx, 10, [110]);
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
  block(ctx, 1, children(2, 10));
  for (let k = 2; k <= 9; k++) block(ctx, k, [100 + k]);
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
  block(ctx, 1, children(2, 10));
  for (let k = 2; k <= 9; k++) block(ctx, k, [100 + k]);
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
  const log = [];
  const waits = [];
  for (let k = 2; k <= 9; k++) waits.push(grandchild(ctx, k, log));
  block(ctx, 1, children(2, 10));
  for (let k = 2; k <= 10; k++) block(ctx, k, [100 + k]);
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
  assert.deepEqual(log, [], 'the other grandchildren wait on');
  await release(holds, waits);
}

// ── (5) a holder's report ends with its last hold ──────────────────────────
{
  const ctx = freshCtx();
  const first = beginLoaderFetch(ctx, 'run-7', undefined, 7);
  const second = beginLoaderFetch(ctx, 'run-7-b', undefined, 7);
  block(ctx, 7, [300]);
  first();
  assert.deepEqual(loaderLedgerStats(ctx).blockedOn, { 7: [300] }, 'process 7, still holding a worker, still reports');
  second();
  assert.deepEqual(loaderLedgerStats(ctx).blockedOn, {}, 'its last hold ended: its report with it');
  const again = beginLoaderFetch(ctx, 'run-7-c', undefined, 7);
  assert.deepEqual(loaderLedgerStats(ctx).blockedOn, {}, 'a new hold of process 7 is not taken to be blocked');
  again();
  block(ctx, 8, [1]);
  assert.deepEqual(loaderLedgerStats(ctx).blockedOn, {}, 'nor is a report from a process that holds no worker taken');
}

// ── (6) a child that runs without a worker: not stuck ──────────────────────
{
  const ctx = freshCtx();
  const holds = fullOfAFamily(ctx);
  const log = [];
  const waits = [];
  block(ctx, 1, children(2, 10));
  for (let k = 2; k <= 10; k++) waits.push(grandchild(ctx, k, log));
  for (let k = 2; k <= 9; k++) block(ctx, k, [100 + k]);
  // Child 10 also waits on 500, `sleep 5`: a builtin, running in the session.
  block(ctx, 10, [110, 500]);
  await tick();
  assert.deepEqual(log, [], 'child 10 waits on a child that will end: nothing is refused');
  assert.deepEqual(loaderLedgerStats(ctx).blockedOn[10], [110, 500]);
  // sleep exits: its exit is news for child 10, delivered in reply 1; child 10 reports again.
  noteProcessNews(ctx, 10);
  assert.equal(processNewsReply(ctx, 10), 1);
  block(ctx, 10, [110], 1);
  await tick();
  assert.deepEqual(log, ['refused 110'], 'once it waits on its queued grandchild only, it is stuck: the refusal comes');
  await release(holds, waits);
}

// ── (7) news withdraws a report; a stale report is not taken ───────────────
{
  const ctx = freshCtx();
  const holds = fullOfAFamily(ctx);
  const log = [];
  const waits = [];
  block(ctx, 1, children(2, 10));
  for (let k = 2; k <= 10; k++) waits.push(grandchild(ctx, k, log));
  for (let k = 2; k <= 9; k++) block(ctx, k, [100 + k]);
  // Child 3's grandchild-to-be... child 3 hears output of another child of its own after reporting.
  noteProcessNews(ctx, 3);
  block(ctx, 10, [110]);
  await tick();
  assert.deepEqual(log, [], "news produced for child 3 withdrew its report: it may be runnable, so nothing is refused");
  // The news is delivered in a reply numbered 1; a report that has not seen it is not taken.
  assert.equal(processNewsReply(ctx, 3), 1);
  block(ctx, 3, [103], 0);
  await tick();
  assert.deepEqual(log, [], 'a report that had not seen reply 1 is stale');
  assert.equal(loaderLedgerStats(ctx).blockedOn[3], undefined);
  block(ctx, 3, [103], 1);
  await tick();
  assert.deepEqual(log, ['refused 110'], 'the current one is taken, and the deadlock refused');
  await release(holds, waits);
}

// ── (8) a parent waiting on a child no one can account for: not stuck ──────
{
  const ctx = freshCtx();
  const holds = fullOfAFamily(ctx);
  const log = [];
  const waits = [];
  // The parent also waits on 11, a child that exited and whose exit it has not heard yet.
  block(ctx, 1, [...children(2, 10), 11]);
  for (let k = 2; k <= 10; k++) waits.push(grandchild(ctx, k, log));
  for (let k = 2; k <= 10; k++) block(ctx, k, [100 + k]);
  await tick();
  assert.deepEqual(log, [], 'the parent is not stuck, so its worker is not held for good: nothing is refused');
  await release(holds, waits);
}

console.log('ok - dynamic-worker-deadlock (refused only when every holder is stuck on queued or stuck children, from current reports; a builtin child, news or a stale report keeps them waiting)');
