#!/usr/bin/env bun
// Running work comes first (the lock order's one exception, acquireSupervisorLoad):
// what a running process needs to go on, its write waves and the session
// RPCs it makes, is never held up by a launch that is not running.
//   - It overtakes every queued ask, however large.
//   - Where only parked launches' retained maps hold the credit, it reclaims
//     them, the oldest parked first, and no more than it needs.
//   - An ordinary ask reclaims nothing.
//   - The full cycle: every worker held by a running facet whose next write
//     needs credit, and the budget full of parked launches each waiting for
//     a worker. The writes get their credit, the facets end, and the parked
//     launches get their workers, sent back to prepare.

import assert from 'node:assert/strict';
import {
  SupervisorAllocationBudget,
  acquireSupervisorAllocation,
  acquireSupervisorRunningAllocation,
  readSupervisorAllocationBudget,
  reclaimableSupervisorAllocation,
} from '../../packages/platform/src/heavy-alloc-coord.ts';
import { beginLoaderFetch, beginLoaderFetchWhenFree, DO_DYNAMIC_WORKER_LIMIT } from '../../packages/fabric/src/budgets.ts';

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A parked launch: its retained map's credit, reclaimable, and whether it was reclaimed. */
function park(budget, bytes) {
  const launch = { reclaimed: false, lease: null, unregister: null };
  return budget.acquire(bytes).then((lease) => {
    launch.lease = lease;
    launch.unregister = budget.reclaimable(() => { launch.reclaimed = true; lease.release(); });
    return launch;
  });
}

// ── it overtakes a queued ask, and reclaims the oldest parked map, no more ──
{
  const budget = new SupervisorAllocationBudget(100);
  const older = await park(budget, 40);
  const newer = await park(budget, 40);
  let queuedGranted = false;
  const queued = budget.acquire(100).then((lease) => { queuedGranted = true; return lease; });
  await settled();
  const running = await budget.acquireRunning(30);
  assert.equal(older.reclaimed, true, 'the oldest parked map is reclaimed');
  assert.equal(newer.reclaimed, false, 'and no more than the running ask needs');
  assert.equal(queuedGranted, false, 'ahead of a queued ask');
  running.release();
  newer.unregister();
  newer.lease.release();
  (await queued).release();
  assert.equal(budget.stats.current, 0);
  console.log('  ✓ running work overtakes the queue and reclaims the oldest parked map');
}

// ── an ordinary ask reclaims nothing ─────────────────────────────────────────
{
  const budget = new SupervisorAllocationBudget(100);
  const parked = await park(budget, 80);
  let granted = false;
  const ordinary = budget.acquire(40).then((lease) => { granted = true; return lease; });
  await settled();
  assert.equal(granted, false, 'an ordinary ask waits');
  assert.equal(parked.reclaimed, false, 'and reclaims nothing');
  parked.unregister();
  parked.lease.release();
  (await ordinary).release();
  console.log('  ✓ an ordinary ask reclaims nothing');
}

// ── running work waits only on running work ─────────────────────────────────
{
  const budget = new SupervisorAllocationBudget(100);
  const first = await budget.acquireRunning(70);
  let secondGranted = false;
  const second = budget.acquireRunning(70).then((lease) => { secondGranted = true; return lease; });
  await settled();
  assert.equal(secondGranted, false, 'a running ask that does not fit beside running work waits');
  first.release();
  (await second).release();
  assert.equal(budget.stats.current, 0);
  console.log('  ✓ running work waits only for running work');
}

// ── the full cycle: workers held by running facets, the budget by parked maps ─
{
  const ctx = { id: { toString: () => 'running-work-cycle' } };
  const capacity = readSupervisorAllocationBudget().capacity;
  // Every worker this Durable Object may run, each a running facet.
  const facets = Array.from({ length: DO_DYNAMIC_WORKER_LIMIT }, (_, i) => beginLoaderFetch(ctx, `running-${i}`));
  // The budget full of parked launches, each waiting for a worker.
  const parked = [];
  const share = Math.floor(capacity / 4);
  for (let i = 0; i < 4; i++) {
    const launch = { reclaimed: false, admitted: null };
    const lease = await acquireSupervisorAllocation(share);
    launch.unregister = reclaimableSupervisorAllocation(() => { launch.reclaimed = true; lease.release(); });
    launch.lease = lease;
    launch.admitted = beginLoaderFetchWhenFree(ctx, `parked-${i}`);
    parked.push(launch);
  }
  await settled();
  // Each facet's next write needs credit only the parked maps hold.
  const writes = facets.map(() => acquireSupervisorRunningAllocation(share));
  const leases = await Promise.race([
    Promise.all(writes),
    new Promise((_, reject) => setTimeout(() => reject(new Error('a running facet waited on a launch that is not running')), 5_000)),
  ]);
  assert.ok(parked.every((launch) => launch.reclaimed), 'the parked maps were reclaimed');
  // The writes done, the facets end; the parked launches get their workers.
  for (const lease of leases) lease.release();
  for (const end of facets) end();
  const ends = await Promise.all(parked.map((launch) => launch.admitted));
  assert.equal(ends.length, 4, 'every parked launch is admitted, to prepare again');
  for (const end of ends) end();
  assert.equal(readSupervisorAllocationBudget().current, 0, 'nothing stays held');
  console.log('  ✓ the full cycle resolves: the running facets write, end, and the parked launches are admitted');
}

console.log('running-work-credit: ok');
