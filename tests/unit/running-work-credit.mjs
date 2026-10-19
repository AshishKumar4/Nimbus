#!/usr/bin/env bun
// Running work comes first (the lock order's one exception, acquireSupervisorLoad):
// what a running process needs to go on, its write waves and the session
// RPCs it makes, is never held up by a launch that is not running.
//   - It overtakes every queued ask, however large.
//   - Where only parked launches' retained maps hold the credit, it reclaims
//     them, the oldest parked first, and no more than it needs.
//   - A launch that parks while a running ask waits is reclaimed for it.
//   - A small running ask may take the read reserve, but never waits on it,
//     so it never reclaims for credit no reclaim frees.
//   - An ordinary ask reclaims nothing.
//   - A load holding its credit while it waits for a worker (a refused call's
//     readmission) is reclaimed for running work, and loads once let in.
//   - So is credit a load took for a worker the loader then answers warm,
//     which never calls back for it.
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
import { IsolatePool } from '../../packages/fabric/src/isolate-pool.ts';
import { facetTaskSource } from '../../packages/core/src/runtime/facet-task.ts';
import { ISOLATE_NETWORK } from '../../packages/core/src/_shared/workspace-network.ts';

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

// ── two running asks at once reclaim only what they need together ─────────
// The first is woken to its turn with the credit one reclaim freed; the
// second fits beside it, so nothing more is reclaimed for it.
{
  const budget = new SupervisorAllocationBudget(100);
  const older = await park(budget, 40);
  const newer = await park(budget, 40);
  const [first, second] = await Promise.all([budget.acquireRunning(30), budget.acquireRunning(30)]);
  assert.equal(older.reclaimed, true, 'the oldest parked map is reclaimed');
  assert.equal(newer.reclaimed, false, 'and not the next: both asks fit beside it');
  first.release();
  second.release();
  newer.unregister();
  newer.lease.release();
  assert.equal(budget.stats.current, 0);
  console.log('  ✓ two running asks at once reclaim only what they need together');
}

// ── a launch that parks while a running ask waits is reclaimed for it ───────
{
  const budget = new SupervisorAllocationBudget(100);
  // A launch generating its map holds the credit, not yet reclaimable.
  const generating = await budget.acquire(100);
  let granted = false;
  const running = budget.acquireRunning(100).then((lease) => { granted = true; return lease; });
  await settled();
  assert.equal(granted, false, 'nothing is reclaimable yet');
  // Its map made, it parks: its credit becomes reclaimable.
  let reclaimed = false;
  budget.reclaimable(() => { reclaimed = true; generating.release(); });
  const lease = await Promise.race([
    running,
    new Promise((_, reject) => setTimeout(() => reject(new Error('running work was not woken by a map becoming reclaimable')), 5_000)),
  ]);
  assert.equal(reclaimed, true, 'the parked map is reclaimed for the running ask');
  lease.release();
  assert.equal(budget.stats.current, 0);
  console.log('  ✓ a launch that parks while a running ask waits is reclaimed for it');
}

// ── a small running ask takes the reserve, and reclaims nothing for it ──────
{
  const budget = new SupervisorAllocationBudget(100, {}, { smallRequestBytes: 10, reserve: 20 });
  const parked = await park(budget, 100);
  const first = await budget.acquireRunning(10);
  const second = await budget.acquireRunning(10);
  assert.equal(parked.reclaimed, false, 'the reserve grants them; no map is reclaimed');
  // The reserve full too, it waits on the shared capacity: the parked map is reclaimed for it.
  const third = await Promise.race([
    budget.acquireRunning(10),
    new Promise((_, reject) => setTimeout(() => reject(new Error('a small running ask waited on the reserve')), 5_000)),
  ]);
  assert.equal(parked.reclaimed, true, 'past the reserve, a parked map is reclaimed');
  for (const lease of [first, second, third]) lease.release();
  assert.equal(budget.stats.current, 0);
  console.log('  ✓ a small running ask takes the reserve, and waits only on what a reclaim frees');
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
  // Each facet's next write needs credit only the parked maps hold: all of it, between them.
  const write = Math.floor(capacity / DO_DYNAMIC_WORKER_LIMIT);
  const writes = facets.map(() => acquireSupervisorRunningAllocation(write));
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

// ── a load waiting for a worker holding its credit is reclaimed for running work ─
{
  const MiB = 1024 * 1024;
  const ctx = { id: { toString: () => 'running-work-readmit' }, waitUntil() {} };
  const capacity = readSupervisorAllocationBudget().capacity;
  const CAP_MESSAGE = 'Dynamic worker concurrency limit exceeded: each request may have up to 10 concurrent dynamic worker invocations. Wait for one to finish before starting another.';
  // The platform counts each worker running, and refuses past the limit.
  const counted = new Set();
  let refused = 0;
  const env = {
    LOADER: {
      get(id, load) {
        return {
          getEntrypoint: () => ({
            async execute(value) {
              if (!counted.has(id) && counted.size >= DO_DYNAMIC_WORKER_LIMIT) { refused++; throw new Error(CAP_MESSAGE); }
              counted.add(id);
              try { await load(); return value; } finally { counted.delete(id); }
            },
          }),
        };
      },
    },
  };
  // Every worker held by a running facet.
  const facets = Array.from({ length: DO_DYNAMIC_WORKER_LIMIT }, (_, i) => {
    counted.add(`running-${i}`);
    return beginLoaderFetch(ctx, `running-${i}`);
  });
  // A load as large as the budget, refused, waits to be let in again holding its credit.
  const image = { path: '/whole.wasm', identity: 'whole', size: 8 * MiB, peak: capacity, async read() { return new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]); } };
  const pool = new IsolatePool(env, ctx, { tag: 'whole', network: ISOLATE_NETWORK, omitSupervisor: true, timeoutMs: 0, wasmModules: { 'primary.wasm': image } });
  const loading = pool.map(facetTaskSource('(value) => value'), [1]);
  for (let i = 0; i < 100 && !(refused > 0 && readSupervisorAllocationBudget().current === capacity); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(readSupervisorAllocationBudget().current, capacity, 'refused, the load waits for a worker holding the whole budget');
  // A running facet's next write needs credit only that load holds.
  const write = await Promise.race([
    acquireSupervisorRunningAllocation(4 * MiB),
    new Promise((_, reject) => setTimeout(() => reject(new Error('a running facet waited on a load waiting for its worker')), 5_000)),
  ]);
  write.release();
  // The facet ends; the load is let in and takes its credit then.
  counted.delete('running-0');
  facets[0]();
  assert.deepEqual(await loading, [1]);
  for (const end of facets.slice(1)) end();
  assert.equal(readSupervisorAllocationBudget().current, 0, 'nothing stays held');
  console.log('  ✓ a load waiting for a worker holding its credit is reclaimed for running work');
}

// ── credit a warm worker never used is reclaimed for its own running work ───
{
  const MiB = 1024 * 1024;
  const capacity = readSupervisorAllocationBudget().capacity;
  // The loader keeps its workers; a Durable Object's pools know only those they made.
  const cache = new Map();
  let builds = 0;
  const env = {
    LOADER: {
      get(id, load) {
        return {
          getEntrypoint: () => ({
            async execute(value) {
              if (!cache.has(id)) { cache.set(id, await load()); builds++; }
              // The running program's next write.
              const write = await Promise.race([
                acquireSupervisorRunningAllocation(4 * MiB),
                new Promise((_, reject) => setTimeout(() => reject(new Error('a warm worker\'s write waited on credit its own load took')), 5_000)),
              ]);
              write.release();
              return value;
            },
          }),
        };
      },
    },
  };
  const image = { path: '/warm.wasm', identity: 'warm', size: 8 * MiB, peak: capacity, async read() { return new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]); } };
  const run = (ctx) => new IsolatePool(env, ctx, { tag: 'warm', network: ISOLATE_NETWORK, omitSupervisor: true, timeoutMs: 0, wasmModules: { 'primary.wasm': image } })
    .map(facetTaskSource('(value) => value'), [1]);
  assert.deepEqual(await run({ id: { toString: () => 'running-work-warm' }, waitUntil() {} }), [1]);
  // The same Durable Object again, its pools new: they take credit for a worker the loader has warm.
  assert.deepEqual(await run({ id: { toString: () => 'running-work-warm' }, waitUntil() {} }), [1]);
  assert.equal(builds, 1, 'answered warm, it read nothing');
  assert.equal(readSupervisorAllocationBudget().current, 0, 'nothing stays held');
  console.log('  ✓ credit a warm worker never used is reclaimed for its own running work');
}

console.log('running-work-credit: ok');
