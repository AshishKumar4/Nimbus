#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { acquireSupervisorAllocation, SupervisorAllocationBudget, SupervisorLoadWaitError } from '../../packages/platform/src/heavy-alloc-coord.ts';
import { attributeAllocation, readDiagCounters } from '../../packages/platform/src/diag-counters.ts';

const budget = new SupervisorAllocationBudget(100);
const first = await budget.acquire(30, undefined, { owner: 'first slice', pid: 7, session: 'one' });
const second = await budget.acquire(50, undefined, { owner: 'second map', pid: 8, session: 'two' });
const abort = new AbortController();
const waiting = budget.acquire(90, abort.signal, { owner: 'queued build', pid: 9, session: 'three' });
waiting.catch(() => {});
try {
  const stats = budget.stats;
  assert.ok(Array.isArray(stats.holders), 'the allocation budget names its live owners');
  assert.deepEqual(stats.holders.map(({ owner, bytes, pid, session }) => ({ owner, bytes, pid, session })), [
    { owner: 'second map', bytes: 50, pid: 8, session: 'two' },
    { owner: 'first slice', bytes: 30, pid: 7, session: 'one' },
  ]);
  assert.deepEqual(stats.waiting.map(({ owner, bytes }) => ({ owner, bytes })), [{ owner: 'queued build', bytes: 90 }]);
  second.shrinkTo(20);
  assert.equal(budget.stats.holders.find(({ owner }) => owner === 'second map').bytes, 20, 'holder bytes follow the real lease on shrink');
  await assert.rejects(budget.acquireLoad('runtime load', 100, { waitMs: 20 }), (error) =>
    error instanceof SupervisorLoadWaitError && error.message.includes('first slice') && error.message.includes('queued build'),
  'a refused load names the holders and FIFO waiters');
} finally {
  abort.abort(new Error('test complete'));
  await assert.rejects(waiting);
  first.release();
  second.release();
}
assert.deepEqual(budget.stats.holders, []);
assert.deepEqual(budget.stats.waiting, []);
const baseline = readDiagCounters().prefetchBundleBytes;
const owned = await acquireSupervisorAllocation(100, undefined, { owner: 'canonical owner' });
attributeAllocation('prefetchBundleBytes', owned);
assert.equal(readDiagCounters().prefetchBundleBytes, baseline + 100);
owned.shrinkTo(40);
assert.equal(readDiagCounters().prefetchBundleBytes, baseline + 40, 'shrinking through the real lease updates derived attribution without a wrapper ledger');
owned.release();
assert.equal(readDiagCounters().prefetchBundleBytes, baseline);
console.log('supervisor-allocation-owners: holders and waiters name the real leases');
