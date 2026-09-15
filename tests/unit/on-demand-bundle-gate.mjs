#!/usr/bin/env bun
// on-demand-bundle-gate — admission is decided BEFORE a job body runs.
//
// A cold /@modules/ build allocates its slice as the first thing its body
// does, before it can know the size. A gate that accounts bytes only after
// the build (the previous byte-budget design) admits memory that already
// exists. The regression property is therefore about bytes the job body
// actually allocates: while one job holds its allocation, no later job's
// body has started at all, so peak retained bytes never exceed one job.

import assert from 'node:assert/strict';
import { OnDemandBundleGate } from '../../packages/worker/src/facets/on-demand-bundle-gate.ts';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// ── 1. Lead red repro: allocation before any await never overlaps ────
// Adapted from /tmp/nimbus-gate/on-demand-allocation-repro.mjs to the
// no-admit signature: with the old gate this printed retainedBytes 120
// under a 100-byte budget; here the second body must not have started.
{
  const gate = new OnDemandBundleGate();
  const firstStarted = Promise.withResolvers();
  const releaseFirst = Promise.withResolvers();
  let retained = 0;
  let peak = 0;
  let secondBodyStarted = false;

  const first = gate.run(async () => {
    const payload = new Uint8Array(60);
    retained += payload.byteLength;
    peak = Math.max(peak, retained);
    firstStarted.resolve();
    try {
      await releaseFirst.promise;
    } finally {
      retained -= payload.byteLength;
    }
    return 'first';
  });
  await firstStarted.promise;

  const second = gate.run(async () => {
    secondBodyStarted = true;
    const payload = new Uint8Array(60);
    retained += payload.byteLength;
    peak = Math.max(peak, retained);
    try {
      await settle();
    } finally {
      retained -= payload.byteLength;
    }
    return 'second';
  });

  await settle();
  await settle();
  assert.equal(secondBodyStarted, false, 'second body must not start while the first job is held');
  assert.equal(retained, 60, 'only the first job\'s bytes are resident');

  releaseFirst.resolve();
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
  assert.equal(secondBodyStarted, true);
  assert.equal(peak, 60, `peak retained bytes must equal one job, got ${peak}`);
  assert.equal(retained, 0, 'all bytes released');
  console.log('  [1] allocation at body start never overlaps a held job');
}

// ── 2. FIFO drain order, each job's result preserved ─────────────────
{
  const gate = new OnDemandBundleGate();
  const order = [];
  const holds = [0, 1, 2, 3].map(() => Promise.withResolvers());
  let running = 0;
  let maxRunning = 0;

  const jobs = holds.map((hold, i) =>
    gate.run(async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      order.push(`start:${i}`);
      await hold.promise;
      order.push(`end:${i}`);
      running--;
      return i * 10;
    }),
  );

  // Release out of order — the gate must still start bodies in FIFO order.
  for (const i of [2, 0, 3, 1]) {
    await settle();
    holds[i].resolve();
  }
  assert.deepEqual(await Promise.all(jobs), [0, 10, 20, 30], 'results map to their own jobs');
  assert.equal(maxRunning, 1, 'never more than one body in flight');
  assert.deepEqual(order, [
    'start:0', 'end:0',
    'start:1', 'end:1',
    'start:2', 'end:2',
    'start:3', 'end:3',
  ]);
  console.log('  [2] queue drains FIFO with one body in flight');
}

// ── 3. A rejected job does not poison the next ───────────────────────
{
  const gate = new OnDemandBundleGate();
  const failing = gate.run(async () => { throw new Error('boom'); });
  const next = gate.run(async () => 'after-failure');
  await assert.rejects(failing, /boom/);
  assert.equal(await next, 'after-failure');
  // A synchronous throw from the job factory is a rejection too, not a hang.
  const syncThrow = gate.run(() => { throw new Error('sync-boom'); });
  await assert.rejects(syncThrow, /sync-boom/);
  assert.equal(await gate.run(async () => 'still-alive'), 'still-alive');
  console.log('  [3] rejected jobs settle their own promise and the queue keeps moving');
}

// ── 4. Zero queued work: a single job completes immediately ──────────
{
  const gate = new OnDemandBundleGate();
  assert.equal(await gate.run(async () => 'solo'), 'solo');
  assert.equal(await gate.run(async () => 'solo-again'), 'solo-again');
  console.log('  [4] an idle gate runs a lone job to completion');
}

console.log('on-demand-bundle-gate: ok');
