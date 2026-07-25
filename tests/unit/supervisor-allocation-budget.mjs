#!/usr/bin/env bun

import assert from 'node:assert/strict';
import {
  acquireSupervisorAllocation,
  registerAllocObserver,
  SupervisorAllocationBudget,
} from '../../packages/worker/src/observability/heavy-alloc-coord.ts';
import { readDiagCounters } from '../../packages/worker/src/observability/diag-counters.ts';
import { estimateSupervisorHeap } from '../../packages/worker/src/observability/heap-estimate.ts';

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

console.log('supervisor allocation budget: ok');
