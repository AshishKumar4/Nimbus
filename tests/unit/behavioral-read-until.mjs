#!/usr/bin/env bun
// readUntil, the bounded wait probes read a page through: a condition that
// never holds ends the wait with the last value read, for the probe's own
// check to report, however its deadline falls against a quick read. Only a
// read that does not answer stalls the wait, and says so. A read in flight
// when the deadline fell was reported as stalled though it answered in
// milliseconds (resize-survives-frame-focus on main, where the page answered
// every read in 4-8 ms): a condition that never held looked like a page hang.

import assert from 'node:assert/strict';
import { readUntil } from '../behavioral/_driver.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A deadline that falls during a read: the read still answers the wait.
{
  let reads = 0;
  const value = await readUntil((signal) => {
    reads++;
    if (reads === 1) return Promise.resolve('before');
    // In flight at the deadline, it answers 50 ms after it.
    return new Promise((resolve) => signal.addEventListener('abort', () => setTimeout(() => resolve('in flight'), 50), { once: true }));
  }, () => false, 300);
  assert.equal(value, 'in flight');
  console.log('  ✓ a read in flight at the deadline answers the wait');
}

// A read that never answers stalls the wait, and it says so.
{
  const started = performance.now();
  await assert.rejects(readUntil(() => new Promise(() => {}), () => false, 200), /still pending/);
  assert.ok(performance.now() - started < 5000, 'within a bounded time past the deadline');
  console.log('  ✓ a read that never answers is reported as stalled');
}

// A read the deadline aborts ends the wait with the value read before it.
{
  let reads = 0;
  const value = await readUntil((signal) => new Promise((resolve, reject) => {
    reads++;
    if (reads === 1) { resolve('first'); return; }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }), () => false, 300);
  assert.equal(value, 'first');
  console.log('  ✓ a read the deadline aborts ends the wait with the value before it');
}

// A read that fails for its own reason after the deadline fails the wait.
{
  let reads = 0;
  await assert.rejects(readUntil((signal) => {
    reads++;
    if (reads === 1) return Promise.resolve('before');
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('the page went away')), { once: true }));
  }, () => false, 300), /the page went away/);
  console.log('  ✓ a read failing for its own reason fails the wait');
}

// A read rejected with no reason before the deadline fails the wait, as any read failing does.
{
  let reads = 0;
  await assert.rejects(readUntil(() => (++reads === 1 ? Promise.resolve('before') : Promise.reject()), () => false, 5000), (error) => error === undefined);
  console.log('  ✓ a read rejected with no reason fails the wait');
}

// The condition met: the wait ends at once with the value that met it.
{
  let reads = 0;
  assert.equal(await readUntil(async () => ++reads, (v) => v === 3, 5000), 3);
  console.log('  ✓ a met condition ends the wait');
}
console.log('behavioral-read-until: ok');
