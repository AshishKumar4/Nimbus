#!/usr/bin/env bun
// A call the platform refused at the Dynamic Worker limit, let in again on
// the ledger (readmitRefused): one protocol for every caller, a pooled call
// and a one-shot's run alike. The platform refuses a call before it starts
// and still counts workers the ledger gave back (an RPC-invoked one until its
// session closes), so the refused call's hold, ended with the refusal, paused
// admission. What has to hold:
//
//   (1) the call is let in again on the same key, and only after the pause,
//       even while that key is still in flight (a launch keeps its own held);
//   (2) after the pause it still waits for room;
//   (3) a launch's run is let in again as that launch's run (claimed), or,
//       when another run claimed the launch meanwhile, as a worker of its own;
//   (4) it gives up, holding nothing, once its first refusal is
//       REFUSED_CALL_WAIT_MS old or its signal aborts;
//   (5) only a hold the ledger gave can be readmitted;
//   (6) every wording the platform has refused a start with is a refusal:
//       it pauses admission and the call is let in again.

import assert from 'node:assert/strict';
import { jest } from 'bun:test';
import {
  beginLoaderFetch,
  claimAdmission,
  DO_DYNAMIC_WORKER_LIMIT,
  loaderLedgerStats,
  readmitRefused,
  REFUSED_CALL_WAIT_MS,
  withLaunchAdmission,
} from '../../packages/fabric/src/budgets.ts';

const CAP_MESSAGE = 'Dynamic worker concurrency limit exceeded: each request may have up to 10 concurrent dynamic worker invocations. Wait for one to finish before starting another.';
// Each as the platform said it (probe verdicts: the first through 2026-10-13,
// the others from 2026-10-23), the last two as a peer Durable Object relays them.
const REFUSALS = [
  CAP_MESSAGE,
  'Too many dynamic workers.',
  'Too many dynamic workers. (remote) (peer-do)',
  'Too many dynamic workers are starting concurrently. (remote) (peer-do)',
];

let ctxCount = 0;
const freshCtx = () => ({ id: { toString: () => `readmit-${++ctxCount}` } });

// A stopwatch started after refusal measures only the pause left after the
// process regained the CPU. Drive the pause and deadline timers instead.
jest.useFakeTimers({ now: 0 });
try {
  // ── (1) the pause is waited out even for a key still in flight ──────────────
  {
    const ctx = freshCtx();
    const launch = beginLoaderFetch(ctx, 'launch:7', undefined, 7);
    const run = beginLoaderFetch(ctx, 'launch:7', undefined, 7);
    run(new Error(CAP_MESSAGE));
    assert.equal(loaderLedgerStats(ctx).pauseMs, 50, 'the refusal paused admission');
    let readmitted;
    const waiting = readmitRefused(run, { since: Date.now() }).then((end) => { readmitted = end; });
    jest.advanceTimersByTime(49);
    assert.equal(readmitted, undefined, 'a key in flight is not joined while the pause lasts');
    assert.deepEqual(loaderLedgerStats(ctx).waiters, [{ key: 'launch:7', pid: 7 }], 'it waits on its own key, for its own process');
    assert.deepEqual(loaderLedgerStats(ctx).holders, { 'launch:7': [7] }, 'the refused run holds nothing before the pause ends');
    assert.equal(loaderLedgerStats(ctx).readmitted, 0, 'no readmission before the pause timer fires');
    jest.advanceTimersByTime(1);
    await waiting;
    assert.equal(loaderLedgerStats(ctx).pauseMs, 0, 'the pause timer ended the pause');
    assert.equal(typeof readmitted, 'function');
    assert.deepEqual(loaderLedgerStats(ctx).holders, { 'launch:7': [7, 7] }, 'on the same key, counted once');
    assert.equal(loaderLedgerStats(ctx).readmitted, 1, 'and counted as let in again');
    assert.equal(jest.getTimerCount(), 0, 'admission cancels the refusal deadline');
    readmitted();
    launch();
    assert.deepEqual(loaderLedgerStats(ctx).inFlightWorkers, []);
  }

  // ── (2) after the pause, it still waits for room ────────────────────────────
  {
    const ctx = freshCtx();
    const others = Array.from({ length: DO_DYNAMIC_WORKER_LIMIT - 1 }, (_, i) => beginLoaderFetch(ctx, `other-${i}`));
    const run = beginLoaderFetch(ctx, 'one-shot:a');
    run(new Error(CAP_MESSAGE));
    const filler = beginLoaderFetch(ctx, 'filler');
    let readmitted;
    const waiting = readmitRefused(run, { since: Date.now() }).then((end) => { readmitted = end; });
    jest.advanceTimersByTime(50);
    assert.equal(loaderLedgerStats(ctx).pauseMs, 0, 'the pause timer fired');
    assert.equal(readmitted, undefined, 'the pause is over, but the ledger is full');
    assert.equal(loaderLedgerStats(ctx).waiting, 1, 'the refused run still waits for room');
    filler();
    await waiting;
    assert.ok(loaderLedgerStats(ctx).inFlightWorkers.includes('one-shot:a'), 'let in by the release');
    readmitted();
    for (const end of others) end();
  }

  // ── (3) a launch's run is let in again as that launch's run ─────────────────
  {
    const ctx = freshCtx();
    await withLaunchAdmission(ctx, { pid: 9 }, undefined, async () => {
      const run = claimAdmission(ctx, 9);
      assert.equal(claimAdmission(ctx, 9), undefined, 'one run holds the launch at a time');
      run(new Error(CAP_MESSAGE));
      const waiting = readmitRefused(run, { since: Date.now() });
      jest.advanceTimersByTime(50);
      const again = await waiting;
      assert.equal(claimAdmission(ctx, 9), undefined, 'the run let in again holds the launch');
      again();
      const next = claimAdmission(ctx, 9);
      assert.equal(typeof next, 'function', 'and gives it back as it ends');
      next();
    });
    assert.deepEqual(loaderLedgerStats(ctx).inFlightWorkers, []);
  }

  {
    // Another run of the launch claims its worker while the refused one waits:
    // the refused run, let in, is a worker of its own, never counted with it.
    const ctx = freshCtx();
    await withLaunchAdmission(ctx, { pid: 11 }, undefined, async () => {
      const first = claimAdmission(ctx, 11);
      first(new Error(CAP_MESSAGE));
      const waiting = readmitRefused(first, { since: Date.now() });
      const second = claimAdmission(ctx, 11);
      assert.equal(typeof second, 'function', 'the launch\'s worker was free to claim');
      jest.advanceTimersByTime(50);
      const again = await waiting;
      assert.equal(typeof again, 'function');
      assert.equal(loaderLedgerStats(ctx).inFlightWorkers.length, 2, 'two workers run, and two are counted');
      again();
      second();
    });
    assert.deepEqual(loaderLedgerStats(ctx).inFlightWorkers, []);
  }

  // ── (4) it gives up, holding nothing ────────────────────────────────────────
  {
    const ctx = freshCtx();
    const run = beginLoaderFetch(ctx, 'one-shot:old');
    run(new Error(CAP_MESSAGE));
    assert.equal(await readmitRefused(run, { since: Date.now() - REFUSED_CALL_WAIT_MS }), undefined, 'refused too long ago');
    const kill = new AbortController();
    const waiting = readmitRefused(run, { since: Date.now(), signal: kill.signal });
    kill.abort(new Error('killed'));
    assert.equal(await waiting, undefined, 'its run was killed while it waited');
    assert.equal(jest.getTimerCount(), 1, 'abort cancels the deadline, leaving only the pause');
    jest.advanceTimersByTime(50);
    assert.deepEqual(loaderLedgerStats(ctx).inFlightWorkers, [], 'it holds nothing');
    assert.equal(loaderLedgerStats(ctx).waiting, 0, 'and waits for nothing');
    assert.equal(loaderLedgerStats(ctx).readmitted, 0);
  }

  {
    const ctx = freshCtx();
    const others = Array.from({ length: DO_DYNAMIC_WORKER_LIMIT - 1 }, (_, i) => beginLoaderFetch(ctx, `deadline-other-${i}`));
    const run = beginLoaderFetch(ctx, 'one-shot:deadline');
    run(new Error(CAP_MESSAGE));
    const filler = beginLoaderFetch(ctx, 'deadline-filler');
    const waiting = readmitRefused(run, { since: Date.now() });
    jest.advanceTimersByTime(REFUSED_CALL_WAIT_MS - 1);
    assert.equal(loaderLedgerStats(ctx).pauseMs, 0, 'the pause ended without making room');
    assert.equal(loaderLedgerStats(ctx).waiting, 1, 'the refused run waits until its deadline');
    assert.equal(jest.getTimerCount(), 1, 'only the refusal deadline remains');
    jest.advanceTimersByTime(1);
    assert.equal(await waiting, undefined, 'the first refusal deadline ends the wait');
    assert.equal(loaderLedgerStats(ctx).waiting, 0, 'the expired wait leaves the queue');
    assert.equal(loaderLedgerStats(ctx).readmitted, 0, 'the expired run was never let in');
    filler();
    for (const end of others) end();
    assert.deepEqual(loaderLedgerStats(ctx).inFlightWorkers, [], 'the expired run holds nothing');
  }

  // ── (5) only the ledger's own holds ─────────────────────────────────────────
  await assert.rejects(readmitRefused(() => {}, { since: Date.now() }), /only a hold the Dynamic Worker ledger gave/);

  // ── (6) every wording of a refused start ────────────────────────────────────
  for (const message of REFUSALS) {
    const ctx = freshCtx();
    const run = beginLoaderFetch(ctx, 'one-shot:worded');
    run(new Error(message));
    assert.equal(loaderLedgerStats(ctx).pauseMs, 50, `"${message}" paused admission`);
    let readmitted;
    const waiting = readmitRefused(run, { since: Date.now() }).then((end) => { readmitted = end; });
    jest.advanceTimersByTime(50);
    await waiting;
    assert.equal(typeof readmitted, 'function', `"${message}": the call is let in again`);
    readmitted();
    assert.deepEqual(loaderLedgerStats(ctx).inFlightWorkers, []);
  }

  assert.equal(jest.getTimerCount(), 0, 'settled waits leave no pause or deadline timers');
} finally {
  jest.useRealTimers();
}

console.log('dynamic-worker-readmit: ok');
