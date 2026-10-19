#!/usr/bin/env bun
// A Durable Object's thread held while work is in flight is a stall,
// recorded with that work: the facets a session loads share its thread, and
// a long slice of theirs is what ages the session's queue until the platform
// refuses it. Held synchronously here, as a facet's slice holds it there.

import assert from 'node:assert/strict';
import { holdThreadWatch, recentThreadStalls, STALL_RECORDED_MS } from '../../packages/fabric/src/thread-stalls.ts';

const hold = (ms) => { const until = Date.now() + ms; while (Date.now() < until) { /* the thread is held */ } };
const turn = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

{
  const ctx = {};
  const release = holdThreadWatch(ctx, 'facet git-batch');
  hold(STALL_RECORDED_MS + 150);
  await turn();
  const [stall, ...more] = recentThreadStalls(ctx);
  assert.equal(more.length, 0, JSON.stringify(recentThreadStalls(ctx)));
  assert.ok(stall.ms >= STALL_RECORDED_MS, `the stall's length: ${stall.ms} ms`);
  assert.deepEqual(stall.inFlight, ['facet git-batch']);
  release();
  console.log(`  ✓ a held thread is a stall, named by the work in flight (${stall.ms} ms)`);
}

{
  const ctx = {};
  const first = holdThreadWatch(ctx, 'facet a');
  const second = holdThreadWatch(ctx, 'writeBatchStream pid 1000001');
  hold(STALL_RECORDED_MS + 150);
  second();
  await turn();
  assert.deepEqual(recentThreadStalls(ctx).map((stall) => stall.inFlight.sort()), [['facet a', 'writeBatchStream pid 1000001']],
    'work that ended during the stall is named with it');
  first();
  console.log('  ✓ work that ended during a stall is named with it');
}

{
  const ctx = {};
  const release = holdThreadWatch(ctx, 'facet a');
  await turn(STALL_RECORDED_MS);
  release();
  release();
  hold(STALL_RECORDED_MS + 150);
  await turn();
  assert.deepEqual(recentThreadStalls(ctx), [], 'a thread held with nothing in flight, or kept busy only by its own turns, is no stall');
  console.log('  ✓ nothing in flight, nothing watched; turns that run on time are no stall');
}

{
  const ctx = {};
  for (let i = 0; i < 20; i++) {
    const release = holdThreadWatch(ctx, `facet ${i}`);
    hold(STALL_RECORDED_MS + 100);
    await turn(60);
    release();
  }
  const stalls = recentThreadStalls(ctx);
  assert.equal(stalls.length, 16, 'the last sixteen are kept');
  assert.deepEqual(stalls.at(-1).inFlight, ['facet 19'], 'oldest first, the newest last');
  console.log('  ✓ the last sixteen stalls are kept, oldest first');
}
console.log('thread-stalls: ok');
