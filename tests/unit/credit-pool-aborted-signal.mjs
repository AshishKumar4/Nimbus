#!/usr/bin/env bun
// A credit request whose signal is already aborted is refused (AbortError),
// takes no credit, and marks nothing active, whatever its size and whichever
// lane would have granted it: the small-request lane's shared-capacity grant
// included, through the pool and through the supervisor's allocation budget
// (acquire and acquireWithoutLifecycle alike). A request whose signal is live is
// granted as before.
//
// Red before: a small request was granted from free shared capacity before
// its signal was looked at, so it resolved and held credit, where a larger
// one, or the same one with the shared lane full, was refused.

import assert from 'node:assert/strict';
import { WeightedCreditPool } from '../../packages/platform/src/weighted-credit-pool.ts';
import { SupervisorAllocationBudget } from '../../packages/platform/src/heavy-alloc-coord.ts';

const aborted = () => {
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  return controller.signal;
};
const refused = (error) => error instanceof DOMException && error.name === 'AbortError' && error.message === 'cancelled';
const options = { smallRequestBytes: 2, reserve: 2 };

// The pool: small (shared lane free), small (shared lane full), large.
{
  const pool = new WeightedCreditPool(10, options);
  await assert.rejects(pool.acquire(1, aborted()), refused, 'a small request, the shared lane free');
  assert.equal(pool.stats.current, 0, 'it took no credit');
  const held = await pool.acquire(10);
  await assert.rejects(pool.acquire(1, aborted()), refused, 'a small request, the shared lane full');
  held.release();
  await assert.rejects(pool.acquire(3, aborted()), refused, 'a large request');
  assert.deepEqual(pool.stats, { current: 0, peak: 10, queued: 0 }, 'nothing held or queued');
  const live = await pool.acquire(1, new AbortController().signal);
  assert.equal(pool.stats.current, 1, 'a live small request is granted from shared capacity');
  live.release();
}

// The supervisor's allocation budget: nothing held, and its lifecycle never made active.
{
  let active = 0;
  const budget = new SupervisorAllocationBudget(10, { onActive: () => { active++; } }, options);
  await assert.rejects(budget.acquire(1, aborted()), refused, 'acquire, small');
  await assert.rejects(budget.acquireWithoutLifecycle(1, aborted()), refused, 'acquireWithoutLifecycle, small');
  await assert.rejects(budget.acquire(5, aborted()), refused, 'acquire, large');
  assert.equal(budget.stats.current, 0, 'it took no credit');
  assert.equal(active, 0, 'an aborted request marked nothing active');
}

console.log('credit-pool-aborted-signal: ok');
