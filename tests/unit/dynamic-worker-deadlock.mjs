#!/usr/bin/env bun
// A wait for a Dynamic Worker that no release can ever satisfy is refused,
// and one that can still be satisfied keeps waiting. Told from the session's
// own account of its processes (bindProcessWaitGraph: the table's children,
// and what a shell line awaits) and from what each guest holding a worker
// has said of itself: blocked, at a frontier of news applied. The session
// numbers each piece of news as it is produced (issueProcessNews); a report
// counts only while its frontier is everything issued, and a report older
// than the last taken is dropped. What has to hold:
//
//   (1) at the limit, with every worker held by a stuck process (nine
//       children of a parent, each doing nothing but wait on a grandchild of
//       its own), the newest queued process a stuck process waits on is
//       refused with DynamicWorkerDeadlockError (EAGAIN, errno -11), holding
//       nothing; no second refusal follows; the others are let in, in order,
//       as holders end;
//   (2) a holder that is not blocked will end on its own: nothing is
//       refused; one that becomes blocked last lets the refusal come, and
//       one that unblocks first withdraws its ground;
//   (3) nothing is refused while a hold no process owns (a pool's call) is
//       in flight, nor while a fan-out's claim is held, nor without a graph;
//   (4) a one-shot run is such a waiter: refused, it rejects with the error
//       and assembles nothing;
//   (5) a holder's report and news end with its last hold, and a report is
//       taken only from a process holding a worker;
//   (6) a child running without a worker (a `sleep` builtin) keeps its
//       parent from being stuck, until it is gone from the table;
//   (7) news issued after a report makes it stale; a report at a frontier
//       short of what was issued is not taken; a report older than the last
//       taken is dropped, never reinstalled;
//   (8) a shell line awaiting a program (`sh -c 'node x'`, the program under
//       a pid its parent never names) is stuck exactly when that program is:
//       its parent's grandchild is refused; a shell with work of its own
//       (a builtin running) is not stuck;
//   (9) a change to the graph (a shell's work ending) lets the ledger tell a
//       deadlock it could not before;
//  (10) never on the synchronous path of that change: the refusal is decided
//       on a later turn, on the ledger as it is then. A shell whose command
//       ended and whose next began in the same turn (wait-only for an
//       instant) is not refused; one still wait-only on the later turn is.
//       Before, the refusal was committed inside the change, in that instant.
//
// Before: every such wait waited for good; then a refusal was told from
// ancestry, then from guest-named pids and a news count a late report
// could satisfy (dynamic-worker-protocol-model holds the interleavings).

import assert from 'node:assert/strict';
import {
  beginLoaderFetch,
  beginLoaderFetchWhenFree,
  bindProcessWaitGraph,
  claimDynamicWorkers,
  DO_DYNAMIC_WORKER_LIMIT,
  DynamicWorkerDeadlockError,
  dynamicWorkerHeadroom,
  isDynamicWorkerDeadlock,
  issueProcessNews,
  loaderLedgerStats,
  processWaitGraphChanged,
  setProcessBlocked,
} from '../../packages/fabric/src/budgets.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { createCtxExports, createFacetCtx, createFacetWorld } from './facet-host-harness.mjs';

assert.equal(DO_DYNAMIC_WORKER_LIMIT, 10, 'the scenarios below fill a limit of 10');
let ctxCount = 0;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A fake process table: parent → children, the running set, and what shells await. */
function table(ctx) {
  const parentOf = new Map();
  const ended = new Set();
  const awaits = new Map();
  bindProcessWaitGraph(ctx, {
    children: (pid) => [...parentOf].filter(([c, p]) => p === pid && !ended.has(c)).map(([c]) => c),
    awaits: (pid) => awaits.get(pid) ?? null,
  });
  return {
    spawn(pid, parent) { parentOf.set(pid, parent); },
    end(pid) { ended.add(pid); processWaitGraphChanged(ctx); },
    awaits(pid, children) { if (children) awaits.set(pid, children); else awaits.delete(pid); processWaitGraphChanged(ctx); },
  };
}

function freshCtx() {
  const ctx = { id: { toString: () => `deadlock-${++ctxCount}` } };
  return { ctx, procs: table(ctx) };
}

/** Process `pid` says it is blocked at frontier `frontier` (all news issued to it so far, by default). */
const seqs = new Map();
const report = (ctx, pid, blocked = true, frontier = loaderLedgerStats(ctx).news[pid]?.issued ?? 0, seq) =>
  setProcessBlocked(ctx, pid, { blocked, frontier, seq: seq ?? (seqs.set(pid, (seqs.get(pid) ?? 0) + 1), seqs.get(pid)) });

/** Parent 1 holds a worker, and so does each of its nine children, 2..10. */
function family(ctx, procs) {
  procs.spawn(1, 0);
  for (let k = 2; k <= 10; k++) procs.spawn(k, 1);
  return new Map(Array.from({ length: 10 }, (_, i) => [i + 1, beginLoaderFetch(ctx, `run-${i + 1}`, undefined, i + 1)]));
}

/** A wait for grandchild 100+k of child k, recorded as it settles. */
function grandchild(ctx, procs, k, log) {
  const entry = { pid: 100 + k, end: null, error: null };
  procs.spawn(entry.pid, k);
  entry.promise = beginLoaderFetchWhenFree(ctx, `run-${100 + k}`, { process: { pid: 100 + k } }).then(
    (end) => { entry.end = end; log.push(`in ${entry.pid}`); },
    (error) => { entry.error = error; log.push(`refused ${entry.pid}`); },
  );
  return entry;
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

// ── (1) every holder stuck on its children: the newest is refused, once ───
{
  const { ctx, procs } = freshCtx();
  const holds = family(ctx, procs);
  const log = [];
  const waits = [];
  report(ctx, 1);
  for (let k = 2; k <= 10; k++) {
    waits.push(grandchild(ctx, procs, k, log));
    await tick();
    if (k < 10) assert.deepEqual(log, [], `with child ${k + 1} not yet blocked, every wait waits`);
    report(ctx, k);
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
  // Another report, before 110's end is news to 10: 110 is not queued, so 10 is not stuck.
  report(ctx, 1);
  await tick();
  assert.deepEqual(log, ['refused 110'], 'no second refusal while the first is still news on its way');
  // Child 10 hears its grandchild cannot start, and ends: 102, first to ask, is let in.
  issueProcessNews(ctx, 10);
  procs.end(110);
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
  const { ctx, procs } = freshCtx();
  const holds = family(ctx, procs);
  const log = [];
  report(ctx, 1);
  const waits = [];
  for (let k = 2; k <= 10; k++) waits.push(grandchild(ctx, procs, k, log));
  for (let k = 2; k <= 9; k++) report(ctx, k);
  await tick();
  assert.deepEqual(log, [], 'child 10 has work of its own: every wait keeps waiting');
  report(ctx, 4, false);
  report(ctx, 10);
  await tick();
  assert.deepEqual(log, [], 'child 4 unblocked before child 10 blocked: still no deadlock');
  report(ctx, 4);
  await tick();
  assert.deepEqual(log, ['refused 110'], 'all blocked: the refusal comes');
  await release(holds, waits);
}

// ── (3) a hold no process owns, a fan-out's claim, no graph: nothing refused ─
{
  const { ctx, procs } = freshCtx();
  const holds = family(ctx, procs);
  holds.get(10)();
  const pool = beginLoaderFetch(ctx, 'nfp:a-pool-call');
  const log = [];
  const waits = Array.from({ length: 8 }, (_, i) => grandchild(ctx, procs, i + 2, log));
  for (let k = 1; k <= 9; k++) report(ctx, k);
  await tick();
  assert.deepEqual(log, [], "a pool's call ends on its own: nobody is refused");
  pool();
  await tick();
  assert.deepEqual(log, ['in 102']);
  await release(holds, waits);
}
{
  const { ctx, procs } = freshCtx();
  procs.spawn(1, 0);
  for (let k = 2; k <= 9; k++) procs.spawn(k, 1);
  const holds = new Map(Array.from({ length: 9 }, (_, i) => [i + 1, beginLoaderFetch(ctx, `run-${i + 1}`, undefined, i + 1)]));
  const claim = claimDynamicWorkers(ctx, 1);
  assert.ok(claim);
  const log = [];
  const waits = Array.from({ length: 8 }, (_, i) => grandchild(ctx, procs, i + 2, log));
  for (let k = 1; k <= 9; k++) report(ctx, k);
  await tick();
  assert.deepEqual(log, [], "a fan-out's claim is released when its batch ends: nobody is refused");
  claim.release();
  await tick();
  assert.deepEqual(log, ['in 102']);
  await release(holds, waits);
}
{
  const ctx = { id: { toString: () => `deadlock-${++ctxCount}` } };
  const holds = new Map(Array.from({ length: 10 }, (_, i) => [i + 1, beginLoaderFetch(ctx, `run-${i + 1}`, undefined, i + 1)]));
  const waited = beginLoaderFetchWhenFree(ctx, 'run-102', { process: { pid: 102 } });
  for (let k = 1; k <= 10; k++) report(ctx, k);
  await tick();
  assert.equal(loaderLedgerStats(ctx).waiting, 1, 'with no graph bound, nothing is refused');
  for (const [, end] of holds) end();
  (await waited)();
}

// ── (4) a one-shot run refused: rejects with the error, assembles nothing ──
adoptCtxExports(createCtxExports(() => { throw new Error('no disk'); }));
{
  const world = createFacetWorld(() => ({}));
  const ctx = createFacetCtx(world, 'deadlock-one-shot');
  const procs = table(ctx);
  let loaded = 0;
  const env = { LOADER: { get: world.loader.get, load() { loaded++; throw new Error('not reached'); } } };
  const host = processHostFor(ctx, env, () => ({ readFile() { throw new Error('no disk'); } }));
  const holds = family(ctx, procs);
  const log = [];
  const waits = [];
  for (let k = 2; k <= 9; k++) waits.push(grandchild(ctx, procs, k, log));
  procs.spawn(110, 10);
  for (let k = 1; k <= 10; k++) report(ctx, k);
  let assembled = 0;
  const run = host.runOnce({
    pid: 110,
    writerId: crypto.randomUUID(),
    code: async () => { assembled++; throw new Error('not reached'); },
    request: new Request('https://run/', { method: 'POST', body: '{}' }),
    onWriterActivated() {},
  }, (response) => response.text());
  await assert.rejects(run, (error) => isDynamicWorkerDeadlock(error) && error.pid === 110 && error.code === 'EAGAIN');
  assert.equal(assembled, 0, 'the refused run assembled no module map');
  assert.equal(loaded, 0, 'and loaded no worker');
  assert.deepEqual(log, [], 'the other grandchildren wait on');
  await release(holds, waits);
}

// ── (5) a holder's report and news end with its last hold ──────────────────
{
  const { ctx } = freshCtx();
  const first = beginLoaderFetch(ctx, 'run-7', undefined, 7);
  const second = beginLoaderFetch(ctx, 'run-7-b', undefined, 7);
  assert.equal(issueProcessNews(ctx, 7), 1);
  report(ctx, 7, true, 1);
  first();
  assert.deepEqual(loaderLedgerStats(ctx).news[7], { issued: 1, reportSeq: seqs.get(7), blockedAt: 1 }, 'process 7, still holding a worker, still reports');
  second();
  assert.equal(loaderLedgerStats(ctx).news[7], undefined, 'its last hold ended: its report and news with it');
  assert.equal(issueProcessNews(ctx, 8), 0, 'news is not numbered for a process holding no worker');
  report(ctx, 8, true, 0, 1);
  assert.equal(loaderLedgerStats(ctx).news[8], undefined, 'nor is its report taken');
}

// ── (6) a child that runs without a worker keeps its parent from being stuck ─
{
  const { ctx, procs } = freshCtx();
  const holds = family(ctx, procs);
  const log = [];
  const waits = [];
  for (let k = 2; k <= 10; k++) waits.push(grandchild(ctx, procs, k, log));
  procs.spawn(500, 10); // `sleep 5`, running in the session
  for (let k = 1; k <= 10; k++) report(ctx, k);
  await tick();
  assert.deepEqual(log, [], 'child 10 waits on a builtin that will end: nothing is refused');
  // sleep exits: its end is news for child 10, which applies it and reports again.
  const n = issueProcessNews(ctx, 10);
  procs.end(500);
  await tick();
  assert.deepEqual(log, [], "10's report predates the news: still nothing");
  report(ctx, 10, true, n);
  await tick();
  assert.deepEqual(log, ['refused 110'], 'once it has applied the news and waits on its grandchild alone, the refusal comes');
  await release(holds, waits);
}

// ── (7) stale and late reports ─────────────────────────────────────────────
{
  const { ctx, procs } = freshCtx();
  const holds = family(ctx, procs);
  const log = [];
  const waits = [];
  for (let k = 2; k <= 10; k++) waits.push(grandchild(ctx, procs, k, log));
  for (let k = 1; k <= 9; k++) report(ctx, k);
  // Child 3 is issued news (a child's output) after its report: the report is stale.
  const n = issueProcessNews(ctx, 3);
  report(ctx, 10);
  await tick();
  assert.deepEqual(log, [], "news issued after child 3's report: it may be running, nothing is refused");
  assert.equal(loaderLedgerStats(ctx).news[3].blockedAt, 0, 'its report stands, at a frontier now short');
  report(ctx, 3, true, n - 1);
  await tick();
  assert.equal(loaderLedgerStats(ctx).news[3].blockedAt, null, 'a report at a frontier short of what was issued is not taken');
  const lateSeq = seqs.get(3) + 1;
  report(ctx, 3, true, n, lateSeq + 1);
  await tick();
  assert.deepEqual(log, ['refused 110'], 'a current one is, and the deadlock is refused');
  report(ctx, 3, false, n, lateSeq);
  assert.equal(loaderLedgerStats(ctx).news[3].blockedAt, n, 'a report older than the last taken is dropped, not reinstalled');
  await release(holds, waits);
}

// ── (8) a shell line awaiting its program is stuck when the program is ─────
{
  const { ctx, procs } = freshCtx();
  // Parent 1 and nine programs 2..10, each run by its own shell line 20+k under 1.
  procs.spawn(1, 0);
  const holds = new Map([[1, beginLoaderFetch(ctx, 'run-1', undefined, 1)]]);
  for (let k = 2; k <= 10; k++) {
    procs.spawn(20 + k, 1);
    procs.spawn(k, 20 + k);
    procs.awaits(20 + k, [k]);
    holds.set(k, beginLoaderFetch(ctx, `run-${k}`, undefined, k));
  }
  const log = [];
  const waits = [];
  for (let k = 2; k <= 10; k++) waits.push(grandchild(ctx, procs, k, log));
  procs.awaits(30, null); // shell 30 is running a builtin too: work of its own
  for (let k = 1; k <= 10; k++) report(ctx, k);
  await tick();
  assert.deepEqual(log, [], 'shell 30 has work of its own: its parent is not stuck, nothing is refused');
  // ── (9) its builtin ends: the graph changed, and the deadlock is told
  procs.awaits(30, [10]);
  await tick();
  assert.deepEqual(log, ['refused 110'], "every shell awaits only its program, and every program is stuck: one's grandchild is refused");
  await release(holds, waits);
}

// ── (10) decided on a later turn, on the state then ──────────────────────────
{
  const { ctx, procs } = freshCtx();
  procs.spawn(1, 0);
  const holds = new Map([[1, beginLoaderFetch(ctx, 'run-1', undefined, 1)]]);
  for (let k = 2; k <= 10; k++) {
    procs.spawn(20 + k, 1);
    procs.spawn(k, 20 + k);
    procs.awaits(20 + k, [k]);
    holds.set(k, beginLoaderFetch(ctx, `run-${k}`, undefined, k));
  }
  const log = [];
  const waits = [];
  for (let k = 2; k <= 10; k++) waits.push(grandchild(ctx, procs, k, log));
  procs.awaits(30, null); // shell 30 runs `sleep`
  for (let k = 1; k <= 10; k++) report(ctx, k);
  await tick();
  // `sleep` ends, and `kill` begins in the same turn.
  procs.awaits(30, [10]);
  assert.equal(loaderLedgerStats(ctx).waiting, 9, 'nothing is refused on the synchronous path of the change');
  procs.awaits(30, null);
  await tick();
  assert.deepEqual(log, [], 'on the later turn shell 30 has work again: nothing is refused');
  // `kill` ends, and nothing follows it: still wait-only on the later turn.
  procs.awaits(30, [10]);
  assert.equal(loaderLedgerStats(ctx).waiting, 9, 'not on the synchronous path');
  await tick();
  assert.deepEqual(log, ['refused 110'], 'still stuck on the later turn: refused then');
  await release(holds, waits);
}

console.log('ok - dynamic-worker-deadlock (refused from the session\'s process graph and current reports; a builtin, a busy shell, news, or a stale or late report keeps them waiting)');
