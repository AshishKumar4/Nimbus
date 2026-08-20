#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { WeightedCreditPool } from '../../packages/platform/src/weighted-credit-pool.ts';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// Exact capacity is usable, an additional waiter parks, and release drains it.
{
  const pool = new WeightedCreditPool(8 * 1024 * 1024);
  const leases = Array.from({ length: 128 }, () => pool.tryAcquire(64 * 1024));
  assert.ok(leases.every(Boolean));
  assert.equal(pool.stats.current, pool.capacity);
  assert.equal(pool.stats.peak, pool.capacity);
  assert.equal(pool.tryAcquire(1), null);

  let acquired = false;
  const pending = pool.acquire(64 * 1024).then((lease) => {
    acquired = true;
    return lease;
  });
  await tick();
  assert.equal(acquired, false);
  assert.equal(pool.stats.queued, 1);
  leases[0].release();
  const replacement = await pending;
  assert.equal(pool.stats.current, pool.capacity);
  replacement.release();
  for (const lease of leases.slice(1)) lease.release();
  assert.equal(pool.stats.current, 0);
  assert.equal(pool.stats.queued, 0);
}

// Strict FIFO fairness: a small later request cannot bypass the weighted head.
{
  const pool = new WeightedCreditPool(10);
  const held = pool.tryAcquire(8);
  const order = [];
  const first = pool.acquire(6).then((lease) => {
    order.push('first');
    return lease;
  });
  const second = pool.acquire(2).then((lease) => {
    order.push('second');
    return lease;
  });
  await tick();
  assert.deepEqual(order, []);
  held.release();
  const firstLease = await first;
  assert.deepEqual(order, ['first', 'second']);
  const secondLease = await second;
  firstLease.release();
  secondLease.release();
  assert.equal(pool.stats.current, 0);
}

// Abort removes a queued head and immediately gives the next waiter a chance.
{
  const pool = new WeightedCreditPool(10);
  const held = pool.tryAcquire(8);
  const controller = new AbortController();
  const aborted = pool.acquire(6, controller.signal);
  const next = pool.acquire(2);
  controller.abort('cancelled');
  await assert.rejects(aborted, (error) => error?.name === 'AbortError');
  const nextLease = await next;
  assert.equal(pool.stats.queued, 0);
  nextLease.release();
  held.release();
  assert.equal(pool.stats.current, 0);
}

// A full-capacity setup reservation can hand back unused credit while keeping
// its retained payload covered for the rest of its lifetime.
{
  const pool = new WeightedCreditPool(10);
  const setup = await pool.acquire(10);
  const queued = pool.acquire(4);
  setup.shrinkTo(6);
  const admitted = await queued;
  assert.equal(setup.bytes, 6);
  assert.equal(pool.stats.current, 10);
  admitted.release();
  setup.release();
  assert.equal(pool.stats.current, 0);
}

// N partial streams commit/release before waiting, so none can deadlock while
// collectively owning all credit.
{
  const pool = new WeightedCreditPool(8);
  const start = deferred();
  const completionOrder = [];
  const streams = Array.from({ length: 4 }, (_, index) => (async () => {
    let bucket = pool.tryAcquire(2);
    assert.ok(bucket);
    await start.promise;
    if (pool.tryAcquire(2) === null) {
      bucket.release();
      bucket = null;
    }
    const next = bucket ?? await pool.acquire(2);
    completionOrder.push(index);
    await tick();
    next.release();
  })());
  start.resolve();
  await Promise.race([
    Promise.all(streams),
    new Promise((_, reject) => setTimeout(() => reject(new Error('credit deadlock')), 1_000)),
  ]);
  assert.equal(completionOrder.length, 4);
  assert.ok(pool.stats.peak <= pool.capacity);
  assert.equal(pool.stats.current, 0);
  assert.equal(pool.stats.queued, 0);
}

// Success, error, and cancellation-style finally blocks all return credit.
for (const outcome of ['success', 'error', 'cancel']) {
  const pool = new WeightedCreditPool(4);
  try {
    const lease = await pool.acquire(4);
    try {
      if (outcome === 'error') throw new Error('injected');
      if (outcome === 'cancel') throw new DOMException('cancelled', 'AbortError');
    } finally {
      lease.release();
      lease.release(); // release is deliberately idempotent for nested finally paths.
    }
  } catch (error) {
    assert.ok(outcome !== 'success');
    assert.match(error.message, /injected|cancelled/);
  }
  assert.equal(pool.stats.current, 0, `${outcome} leaked credit`);
}

for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 11]) {
  const pool = new WeightedCreditPool(10);
  assert.throws(() => pool.tryAcquire(invalid), /credit/i);
  await assert.rejects(pool.acquire(invalid), /credit/i);
}

console.log('weighted write-stream credit pool: ok');
