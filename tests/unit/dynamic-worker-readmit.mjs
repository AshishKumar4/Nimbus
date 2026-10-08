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
//   (3) a launch's run is let in again as that launch's run (claimed);
//   (4) it gives up, holding nothing, once its first refusal is
//       REFUSED_CALL_WAIT_MS old or its signal aborts;
//   (5) only a hold the ledger gave can be readmitted.

import assert from 'node:assert/strict';
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

let ctxCount = 0;
const freshCtx = () => ({ id: { toString: () => `readmit-${++ctxCount}` } });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// ── (1) the pause is waited out even for a key still in flight ──────────────
{
  const ctx = freshCtx();
  const launch = beginLoaderFetch(ctx, 'launch:7', undefined, 7);
  const run = beginLoaderFetch(ctx, 'launch:7', undefined, 7);
  run(new Error(CAP_MESSAGE));
  assert.equal(loaderLedgerStats(ctx).pauseMs, 50, 'the refusal paused admission');
  const started = Date.now();
  let readmitted;
  const waiting = readmitRefused(run, { since: Date.now() }).then((end) => { readmitted = end; });
  await tick();
  assert.equal(readmitted, undefined, 'a key in flight is not joined while the pause lasts');
  assert.deepEqual(loaderLedgerStats(ctx).waiters, [{ key: 'launch:7', pid: 7 }], 'it waits on its own key, for its own process');
  await waiting;
  assert.ok(Date.now() - started >= 40, `let in only after the pause (${Date.now() - started} ms)`);
  assert.equal(typeof readmitted, 'function');
  assert.deepEqual(loaderLedgerStats(ctx).holders, { 'launch:7': [7, 7] }, 'on the same key, counted once');
  assert.equal(loaderLedgerStats(ctx).readmitted, 1, 'and counted as let in again');
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
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(readmitted, undefined, 'the pause is over, but the ledger is full');
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
    const again = await readmitRefused(run, { since: Date.now() });
    assert.equal(claimAdmission(ctx, 9), undefined, 'the run let in again holds the launch');
    again();
    const next = claimAdmission(ctx, 9);
    assert.equal(typeof next, 'function', 'and gives it back as it ends');
    next();
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
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(loaderLedgerStats(ctx).inFlightWorkers, [], 'it holds nothing');
  assert.equal(loaderLedgerStats(ctx).waiting, 0, 'and waits for nothing');
  assert.equal(loaderLedgerStats(ctx).readmitted, 0);
}

// ── (5) only the ledger's own holds ─────────────────────────────────────────
await assert.rejects(readmitRefused(() => {}, { since: Date.now() }), /only a hold the Dynamic Worker ledger gave/);

console.log('dynamic-worker-readmit: ok');
