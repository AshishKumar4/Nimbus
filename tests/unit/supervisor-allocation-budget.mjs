#!/usr/bin/env bun

import assert from 'node:assert/strict';
import {
  acquireSupervisorAllocation,
  registerAllocObserver,
  SupervisorAllocationBudget,
} from '../../packages/platform/src/heavy-alloc-coord.ts';
import { readDiagCounters } from '../../packages/platform/src/diag-counters.ts';
import { estimateSupervisorHeap } from '../../packages/platform/src/heap-estimate.ts';

const deferred = () => {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// Concurrent allocators cannot collectively exceed the byte budget.
{
  const budget = new SupervisorAllocationBudget(32);
  const releaseAll = deferred();
  let admitted = 0;
  const allocators = Array.from({ length: 12 }, async () => {
    const lease = await budget.acquire(8);
    admitted++;
    await releaseAll.promise;
    lease.release();
  });

  await tick();
  assert.equal(admitted, 4);
  assert.deepEqual(budget.stats, {
    capacity: 32,
    current: 32,
    peak: 32,
    queued: 8,
    resident: 0,
  });

  releaseAll.resolve();
  await Promise.all(allocators);
  assert.equal(budget.stats.current, 0);
  assert.equal(budget.stats.queued, 0);
}

// A full-budget owner is exclusive, and FIFO ordering prevents later small
// allocations from bypassing it.
{
  const budget = new SupervisorAllocationBudget(32);
  const held = await budget.acquire(8);
  let exclusiveAdmitted = false;
  let laterAdmitted = false;
  const exclusive = budget.acquire(32).then((lease) => {
    exclusiveAdmitted = true;
    return lease;
  });
  const later = budget.acquire(4).then((lease) => {
    laterAdmitted = true;
    return lease;
  });

  held.release();
  const exclusiveLease = await exclusive;
  assert.equal(exclusiveAdmitted, true);
  assert.equal(laterAdmitted, false);
  assert.equal(budget.stats.current, 32);

  exclusiveLease.release();
  const laterLease = await later;
  assert.equal(laterAdmitted, true);
  laterLease.release();
  laterLease.release();
  assert.equal(budget.stats.current, 0);
}

// An observer registered during an active phase receives the current edge, so
// a newly constructed VFS cannot miss the signal to shed its disposable LRU.
{
  const held = await acquireSupervisorAllocation(1);
  let acquireCount = 0;
  let releaseCount = 0;
  const unregister = registerAllocObserver({
    onAcquire: () => acquireCount++,
    onRelease: () => releaseCount++,
  });

  assert.equal(acquireCount, 1);
  held.release();
  assert.equal(releaseCount, 1);
  unregister();
}

// An admitted owner without a named payload counter still contributes to the
// heap estimate instead of disappearing into supplemental diagnostics.
{
  const held = await acquireSupervisorAllocation(8);
  const heap = estimateSupervisorHeap(readDiagCounters(), {
    cacheHotBytes: 0,
    inFlightWriteBytes: 0,
  });
  assert.equal(heap.breakdown.unattributedReservationBytes, 8);
  assert.equal(
    heap.estimatedBytes,
    heap.breakdown.supervisorBaselineBytes + 8,
  );
  held.release();
}

// ── resident owners, and the claim that can never fit ─────────────────────
//
// A resident owner holds its credit for its whole lifetime: the esbuild
// pool's wasm image, retained until the pool is disposed. A later claim
// larger than what remains around it can never be satisfied by waiting, and
// parking it is worse than failing — the FIFO refuses everyone behind a
// waiter, so one unsatisfiable claim stops the whole isolate with no error
// and no CPU. Measured on a deployed worker before this: capacity
// 41,943,040, resident 11,907,565, queued 1 for 222 s.
{
  const budget = new SupervisorAllocationBudget(1000);
  assert.equal(budget.stats.resident, 0);

  const pool = await budget.acquireResidentBytes(400);
  assert.equal(budget.stats.resident, 400);
  assert.equal(budget.stats.current, 400);

  // A weighted claim that FITS around the resident owner proceeds.
  const fits = await budget.acquire(600);
  assert.equal(budget.stats.current, 1000);
  assert.equal(budget.stats.queued, 0, 'a claim that fits is granted, not queued');
  fits.release();

  // One byte too large: refused, with both numbers, and NOT queued.
  await assert.rejects(
    budget.acquire(601),
    (error) => {
      assert.ok(error instanceof RangeError, `expected RangeError, got ${error}`);
      assert.match(error.message, /can never be granted/);
      assert.match(error.message, /capacity is 1000/);
      assert.match(error.message, /400 bytes are held by resident owners/);
      assert.match(error.message, /leaving 600/);
      return true;
    },
  );
  assert.equal(budget.stats.queued, 0, 'a refused claim must not sit in the queue');

  // A claim that merely has to WAIT still waits: this must not turn ordinary
  // back-pressure into an error.
  const holder = await budget.acquire(600);
  let granted = false;
  const waiting = budget.acquire(100).then((lease) => { granted = true; return lease; });
  await tick();
  assert.equal(granted, false, 'a claim that fits but has no room yet queues');
  assert.equal(budget.stats.queued, 1);
  holder.release();
  (await waiting).release();
  assert.equal(granted, true, 'and is granted once room appears');

  // Releasing the resident owner lifts the ceiling again.
  pool.release();
  assert.equal(budget.stats.resident, 0);
  const full = await budget.acquire(1000);
  full.release();
}

// Shrinking a resident lease lowers the floor by what it gave back — how the
// esbuild pool goes from its setup bound to the bytes it actually keeps.
{
  const budget = new SupervisorAllocationBudget(1000);
  const pool = await budget.acquireResidentBytes(900);
  await assert.rejects(budget.acquire(200), /can never be granted/);
  pool.shrinkTo(100);
  assert.equal(budget.stats.resident, 100);
  const after = await budget.acquire(900);
  after.release();
  pool.release();
}

console.log('supervisor allocation budget: ok');
