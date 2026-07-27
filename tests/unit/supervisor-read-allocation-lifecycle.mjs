#!/usr/bin/env bun
// A filesystem read must not shrink the cache it is filling.
//
// The supervisor byte budget drives a disposable-cache lifecycle: acquiring it
// when idle shrinks the SqliteVFS chunk cache so a heavy owner has heap
// headroom, and the last release restores it. Reads take byte credit too, and
// sequentially the budget empties between every single read — so an
// occupancy-edged observer fired once per read, pinning the cache at its
// shrunk floor for the whole workload. It could never warm. Concurrently it
// fired once, which is why the same work was orders of magnitude cheaper in a
// batch than in a loop.
//
// Reads now take credit without driving the lifecycle. Back-pressure is
// unchanged: the credit still serialises a large read against a large write.

import assert from 'node:assert/strict';
import { SupervisorAllocationBudget } from '../../packages/worker/src/observability/heavy-alloc-coord.ts';

const MiB = 1024 * 1024;
const CHUNK = 65536; // READ_STREAM_CHUNK_BYTES — one ranged read

function makeBudget() {
  const seen = { shrink: 0, restore: 0 };
  const budget = new SupervisorAllocationBudget(40 * MiB, {
    onActive: () => { seen.shrink++; },
    onIdle: () => { seen.restore++; },
  });
  return { budget, seen };
}

// ── a sequential read loop must not touch the cache at all ──────────────
{
  const { budget, seen } = makeBudget();
  for (let i = 0; i < 1000; i++) {
    const lease = await budget.acquireWithoutLifecycle(CHUNK);
    lease.release();
  }
  assert.equal(seen.shrink, 0,
    `1000 sequential reads shrank the VFS cache ${seen.shrink} time(s); a read must not sacrifice the cache it fills`);
  assert.equal(seen.restore, 0, 'reads drove a cache restore');
}

// ── heavy owners keep the protection they were built for ────────────────
{
  const { budget, seen } = makeBudget();
  const install = await budget.acquire(28 * MiB);
  assert.equal(seen.shrink, 1, 'a heavy owner no longer shrinks the cache');
  install.release();
  assert.equal(seen.restore, 1, 'a heavy owner no longer restores the cache');
}

// ── a read inside a heavy window must not restore the cache early ───────
// The heavy owner still needs its headroom; a read finishing first must not
// hand the cache back underneath it.
{
  const { budget, seen } = makeBudget();
  const install = await budget.acquire(28 * MiB);
  const read = await budget.acquireWithoutLifecycle(CHUNK);
  read.release();
  assert.equal(seen.restore, 0,
    'a read released the heavy owner\'s cache headroom while it was still working');
  install.release();
  assert.equal(seen.restore, 1, 'the heavy owner never got its restore');
}

// ── nested heavy owners still restore exactly once, at the end ──────────
{
  const { budget, seen } = makeBudget();
  const a = await budget.acquire(8 * MiB);
  const b = await budget.acquire(8 * MiB);
  assert.equal(seen.shrink, 1, 'the second heavy owner re-fired a shrink');
  a.release();
  assert.equal(seen.restore, 0, 'restored while a heavy owner was still holding');
  b.release();
  assert.equal(seen.restore, 1, 'the last heavy owner did not restore');
}

// ── back-pressure is preserved: reads still take real credit ────────────
{
  const { budget } = makeBudget();
  const big = await budget.acquireWithoutLifecycle(40 * MiB);
  let granted = false;
  const queued = budget.acquireWithoutLifecycle(CHUNK).then((l) => { granted = true; return l; });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(granted, false, 'a read took no byte credit — back-pressure was dropped, not decoupled');
  big.release();
  (await queued).release();
}

console.log('supervisor-read-allocation-lifecycle OK: reads take credit without shrinking the cache they fill');
