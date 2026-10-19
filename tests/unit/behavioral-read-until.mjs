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

// A deadline that falls during a quick read: the wait ends with that read's value.
for (let i = 0; i < 30; i++) {
  let reads = 0;
  // Each read takes 20 ms, so the 300 ms deadline falls mid-read on some runs and between reads on others.
  const value = await readUntil(async () => { await sleep(20); return ++reads; }, () => false, 300 + i * 7);
  assert.equal(typeof value, 'number', `run ${i}: the wait ends with a value`);
  assert.ok(value >= 1, `run ${i}: at least one read`);
}
console.log('  ✓ a condition that never holds ends with the last value, wherever the deadline falls');

// A read that never answers stalls the wait, and it says so.
{
  const started = performance.now();
  await assert.rejects(readUntil(() => new Promise(() => {}), () => false, 200), /still pending/);
  assert.ok(performance.now() - started < 5000, 'within a bounded time past the deadline');
  console.log('  ✓ a read that never answers is reported as stalled');
}

// The condition met: the wait ends at once with the value that met it.
{
  let reads = 0;
  assert.equal(await readUntil(async () => ++reads, (v) => v === 3, 5000), 3);
  console.log('  ✓ a met condition ends the wait');
}
console.log('behavioral-read-until: ok');
