#!/usr/bin/env bun
// A lease grows by what it lacks only as tryAcquire would grant that much:
// now, beside what is held, and never ahead of a queued ask. A launch whose
// module map needs more than its fitted share takes the rest this way, and
// otherwise gives its share back and asks again, so it never waits holding.

import assert from 'node:assert/strict';
import { WeightedCreditPool } from '../../packages/platform/src/weighted-credit-pool.ts';
import { SupervisorAllocationBudget } from '../../packages/platform/src/heavy-alloc-coord.ts';

const MiB = 1024 * 1024;
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

// ── it grows into free room, and its release gives all of it back ───────
{
  const pool = new WeightedCreditPool(40 * MiB);
  const lease = await pool.acquire(30 * MiB);
  assert.equal(lease.tryGrowTo(36 * MiB), true);
  assert.equal(lease.bytes, 36 * MiB);
  assert.equal(pool.stats.current, 36 * MiB);
  assert.equal(lease.tryGrowTo(36 * MiB), true, 'growing to what it holds is granted');
  lease.release();
  assert.equal(pool.stats.current, 0);
  console.log('  ✓ a lease grows into free room and gives it all back');
}

// ── room it would need beyond the capacity: refused, holding what it held ─
{
  const pool = new WeightedCreditPool(40 * MiB);
  const lease = await pool.acquire(30 * MiB);
  const other = await pool.acquire(8 * MiB);
  assert.equal(lease.tryGrowTo(36 * MiB), false);
  assert.equal(lease.bytes, 30 * MiB);
  assert.equal(pool.stats.current, 38 * MiB);
  other.release();
  lease.release();
  console.log('  ✓ growth that does not fit is refused and changes nothing');
}

// ── never ahead of a queued ask, ordinary or running ────────────────────
{
  const pool = new WeightedCreditPool(40 * MiB);
  const lease = await pool.acquire(30 * MiB);
  let queuedGranted = false;
  const queued = pool.acquire(12 * MiB).then((granted) => { queuedGranted = true; return granted; });
  await settled();
  assert.equal(lease.tryGrowTo(34 * MiB), false, 'an older ordinary ask is served first, though the growth fits');
  lease.release();
  (await queued).release();
  assert.equal(queuedGranted, true);

  const parked = await pool.acquire(30 * MiB);
  const running = pool.acquireAhead(12 * MiB);
  await settled();
  assert.equal(parked.tryGrowTo(34 * MiB), false, 'a waiting running ask is served first');
  parked.release();
  (await running).release();
  assert.equal(pool.stats.current, 0);
  console.log('  ✓ growth never overtakes a queued ask');
}

// ── through the supervisor budget: the lease it hands out grows the same ─
{
  const budget = new SupervisorAllocationBudget(40 * MiB);
  const lease = await budget.acquireWithoutLifecycle(30 * MiB);
  assert.equal(lease.tryGrowTo(34 * MiB), true);
  assert.equal(budget.stats.current, 34 * MiB);
  assert.throws(() => lease.tryGrowTo(20 * MiB), RangeError, 'shrinking is shrinkTo');
  lease.release();
  assert.throws(() => lease.tryGrowTo(34 * MiB), /released/);
  assert.equal(budget.stats.current, 0);
  console.log('  ✓ the supervisor budget\'s leases grow the same way');
}

console.log('credit-pool-grow: ok');
