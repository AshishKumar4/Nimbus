#!/usr/bin/env bun
// A chunk-sized read must not be parked behind a multi-megabyte owner.
//
// The credit pool is strict FIFO — tryAcquire refuses outright while anyone is
// queued — so one large owner used to park every later request for as long as
// it held, however small. A 64 KiB filesystem read then waited on something
// with nothing to do with its own cost.
//
// Small requests now take shared capacity when it can be granted outright and
// fall back to a reserve otherwise, so they never join the shared queue.

import assert from 'node:assert/strict';
import { WeightedCreditPool } from '../../packages/worker/src/_shared/weighted-credit-pool.ts';
import {
  CHUNK_SIZE,
  SUPERVISOR_IN_FLIGHT_ALLOCATION_BUDGET_BYTES as CAPACITY,
} from '../../packages/worker/src/constants.ts';
import {
  acquireSupervisorAllocation,
  acquireSupervisorReadAllocation,
} from '../../packages/worker/src/observability/heavy-alloc-coord.ts';

const MiB = 1024 * 1024;
// Held as literals rather than imported so this asserts the behaviour, not
// the presence of a constant. Production wiring is asserted at the end
// against the real supervisor singleton.
const RESERVE = 1024 * 1024;
const opts = { smallRequestBytes: CHUNK_SIZE, reserve: RESERVE };
const settled = () => new Promise((r) => setTimeout(r, 0));

// ── the pathology: small behind large ───────────────────────────────────
{
  const pool = new WeightedCreditPool(CAPACITY, opts);
  const heavy = await pool.acquire(20 * MiB);
  const queuedBig = pool.acquire(28 * MiB); // does not fit — queues
  await settled();

  let granted = false;
  const read = pool.acquire(CHUNK_SIZE).then((l) => { granted = true; return l; });
  await settled();
  assert.equal(granted, true,
    'a 64 KiB read was parked behind a 28 MiB request that could not run anyway');

  (await read).release();
  heavy.release();
  (await queuedBig).release();
}

// ── a full-capacity owner still leaves reads servable ───────────────────
{
  const pool = new WeightedCreditPool(CAPACITY, opts);
  const install = await pool.acquire(CAPACITY); // acquireHeavyAlloc's shape
  let granted = false;
  const read = pool.acquire(CHUNK_SIZE).then((l) => { granted = true; return l; });
  await settled();
  assert.equal(granted, true, 'a read stopped dead for the whole duration of a full-budget owner');
  (await read).release();
  install.release();
}

// ── a large waiter is never overtaken by small ones ─────────────────────
// Shared capacity stops admitting small requests the moment anything queues
// for it, so small traffic cannot starve a large owner.
{
  const pool = new WeightedCreditPool(CAPACITY, opts);
  const held = await pool.acquire(CAPACITY);
  const big = pool.acquire(30 * MiB);
  await settled();

  // Exhaust the reserve so every further read must wait.
  const reads = [];
  for (let i = 0; i < RESERVE / CHUNK_SIZE; i++) reads.push(await pool.acquire(CHUNK_SIZE));
  let overtook = false;
  const extra = pool.acquire(CHUNK_SIZE).then((l) => { overtook = true; return l; });
  await settled();
  assert.equal(overtook, false, 'small requests kept being granted past the reserve');

  held.release();
  await settled();
  const bigLease = await big;
  assert.ok(bigLease, 'the large waiter never got its credit');
  for (const r of reads) r.release();
  bigLease.release();
  (await extra).release();
}

// ── reads get full concurrency when nothing is contending ───────────────
// The reserve must not become a cap: with the shared budget free, concurrent
// reads draw on it exactly as before.
{
  const pool = new WeightedCreditPool(CAPACITY, opts);
  const inFlight = [];
  const wanted = (RESERVE / CHUNK_SIZE) + 32; // more than the reserve alone allows
  for (let i = 0; i < wanted; i++) {
    let granted = false;
    const lease = pool.acquire(CHUNK_SIZE).then((l) => { granted = true; return l; });
    await settled();
    assert.equal(granted, true, `read ${i} queued although the shared budget was free`);
    inFlight.push(await lease);
  }
  for (const l of inFlight) l.release();
}

// ── the single-lane pool is untouched ───────────────────────────────────
// sqlite-vfs's write-stream credits construct the pool with no options and
// must keep strict FIFO.
{
  const pool = new WeightedCreditPool(4 * MiB);
  const held = await pool.acquire(3 * MiB);
  const queued = pool.acquire(2 * MiB);
  await settled();
  let jumped = false;
  const small = pool.acquire(1024).then((l) => { jumped = true; return l; });
  await settled();
  assert.equal(jumped, false, 'a pool built without a reserve stopped being strict FIFO');
  held.release();
  (await queued).release();
  (await small).release();
}

// ── a reserve that cannot hold one small request is a construction error ─
assert.throws(
  () => new WeightedCreditPool(4 * MiB, { smallRequestBytes: CHUNK_SIZE, reserve: 1024 }),
  /could never be granted/,
);

// ── the production supervisor budget is wired this way ──────────────────
// The real singleton, driven exactly as a heavy owner and a ranged read do.
{
  const install = await acquireSupervisorAllocation(CAPACITY);
  let granted = false;
  const read = acquireSupervisorReadAllocation(CHUNK_SIZE).then((l) => { granted = true; return l; });
  await settled();
  assert.equal(granted, true,
    'the supervisor budget still parks a ranged read for the whole duration of a full-budget owner');
  (await read).release();
  install.release();
}

console.log('credit-pool-small-request-lane OK: a chunk read is never parked behind a heavy owner');
