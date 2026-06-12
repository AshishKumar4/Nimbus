#!/usr/bin/env bun
// on-demand-bundle-gate — the byte-budget admission gate for on-demand
// /@modules/ bundling must (1) never let total resident slice bytes
// exceed the budget, (2) overlap many small slices, and (3) still admit
// a single slice larger than the budget (no deadlock).

import assert from 'node:assert/strict';
import { OnDemandBundleGate } from '../../packages/worker/src/facets/on-demand-bundle-gate.ts';

const tick = () => new Promise((r) => setTimeout(r, 0));

// ── 1. Peak resident bytes never exceeds the budget ──────────────────
{
  const BUDGET = 28 * 1024 * 1024;
  const gate = new OnDemandBundleGate(BUDGET);

  let live = 0;      // currently-admitted bytes (build done, submit running)
  let peak = 0;
  let maxConcurrentSubmits = 0;
  let concurrentSubmits = 0;

  // 20 jobs of mixed sizes; several near the cap, many small.
  const sizes = [];
  for (let i = 0; i < 20; i++) {
    sizes.push(i % 5 === 0 ? 26 * 1024 * 1024 : 200 * 1024);
  }

  const jobs = sizes.map((bytes) =>
    gate.run(async (admit) => {
      // Simulate the synchronous slice build (not yet admitted).
      await tick();
      await admit(bytes);
      // Admitted — bytes are now resident until this job returns.
      live += bytes;
      peak = Math.max(peak, live);
      concurrentSubmits++;
      maxConcurrentSubmits = Math.max(maxConcurrentSubmits, concurrentSubmits);
      // Simulate the facet RPC round-trip.
      await tick();
      await tick();
      live -= bytes;
      concurrentSubmits--;
      return bytes;
    }),
  );

  const results = await Promise.all(jobs);
  assert.equal(results.length, 20);
  assert.equal(live, 0, 'all bytes released');
  assert.ok(peak <= BUDGET, `peak ${peak} must not exceed budget ${BUDGET}`);
  assert.equal(gate.inFlightBytes, 0, 'gate fully drained');
  // The small slices (200 KiB) must overlap — a single-slot semaphore
  // would force maxConcurrentSubmits === 1. With ~27.6 MiB of headroom
  // after one small slice admits, many run at once.
  assert.ok(maxConcurrentSubmits >= 2, `expected overlap, got ${maxConcurrentSubmits}`);
}

// ── 2. A single oversized slice still makes progress (no deadlock) ────
{
  const gate = new OnDemandBundleGate(1024); // tiny budget
  const out = await gate.run(async (admit) => {
    await admit(5 * 1024 * 1024); // far larger than budget
    return 'ok';
  });
  assert.equal(out, 'ok');
  assert.equal(gate.inFlightBytes, 0);
}

// ── 3. Two oversized slices serialize (peak == one slice) ─────────────
{
  const BUDGET = 1024;
  const gate = new OnDemandBundleGate(BUDGET);
  let live = 0;
  let peak = 0;
  const big = 10 * 1024 * 1024;
  await Promise.all([0, 1, 2].map(() =>
    gate.run(async (admit) => {
      await admit(big);
      live += big;
      peak = Math.max(peak, live);
      await tick();
      live -= big;
    }),
  ));
  // Oversized slices can't share the budget, so they run one at a time:
  // peak resident is exactly one slice, never two.
  assert.equal(peak, big, `oversized slices must serialize; peak=${peak}`);
  assert.equal(gate.inFlightBytes, 0);
}

// ── 4. Jobs that bail before admitting don't wedge the build lock ─────
{
  const gate = new OnDemandBundleGate(1024);
  const a = await gate.run(async () => 'no-admit'); // never calls admit
  assert.equal(a, 'no-admit');
  // A subsequent job must still acquire the build lock and run.
  const b = await gate.run(async (admit) => { await admit(100); return 'after'; });
  assert.equal(b, 'after');
  assert.equal(gate.inFlightBytes, 0);
}

// ── 5. A throwing job releases its reservation ───────────────────────
{
  const gate = new OnDemandBundleGate(1024);
  await assert.rejects(
    gate.run(async (admit) => { await admit(500); throw new Error('boom'); }),
    /boom/,
  );
  assert.equal(gate.inFlightBytes, 0, 'reservation released on throw');
  const ok = await gate.run(async (admit) => { await admit(500); return 'ok'; });
  assert.equal(ok, 'ok');
}

console.log('on-demand-bundle-gate: ok');
