#!/usr/bin/env bun
// The crashable facet storage's transaction is a serialized read/write unit.
// This proves two bodies never run at once, a commit only applies the keys its
// own body touched (an unrelated pending write and another body's copy are
// left alone), and a rejected body frees the queue without committing.

import assert from 'node:assert/strict';
import { createFacetWorld, createFacetCtx } from './facet-host-harness.mjs';

const world = createFacetWorld(() => ({}));
const rows = new Map();
const ctx = createFacetCtx(world, 'do-txn', rows, { crashable: true });

// ── 1. bodies are serialized; a commit never clears an unrelated write ──────
{
  let release;
  const held = new Promise((r) => { release = r; });
  let enter;
  const entered = new Promise((r) => { enter = r; });
  const order = [];
  const first = ctx.storage.transaction(async (txn) => {
    order.push('first-enter');
    enter();
    await held;                      // park inside the transaction
    await txn.put('a', 1);
    order.push('first-exit');
  });
  const second = ctx.storage.transaction(async (txn) => {
    order.push('second-enter');
    await txn.put('b', 2);
    order.push('second-exit');
  });
  await entered;                     // first is parked inside its body
  assert.deepEqual(order, ['first-enter'],
    'the second transaction cannot enter while the first is held');
  // An unrelated pending write mid-transaction must survive the commit.
  await ctx.storage.put('unrelated', 'u');
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-enter', 'first-exit', 'second-enter', 'second-exit'],
    'bodies run one at a time, in order');
  await ctx.storage.sync();
  assert.equal(rows.get('a'), 1);
  assert.equal(rows.get('b'), 2);
  assert.equal(rows.get('unrelated'), 'u',
    "a pending write outside the transaction is not cleared by another's commit");
}

// ── 2. a rejected body commits nothing and frees the queue ──────────────────
{
  await ctx.storage.put('keep', 'pre'); // pending when the transaction runs
  await assert.rejects(
    ctx.storage.transaction(async (txn) => {
      await txn.put('doomed', 'x');
      throw new Error('commit never runs');
    }),
    /commit never runs/,
  );
  assert.equal(await ctx.storage.get('doomed'), undefined,
    'a rejected transaction commits nothing');
  assert.equal(await ctx.storage.get('keep'), 'pre',
    'a rejected transaction leaves unrelated pending writes alone');
  const after = await ctx.storage.transaction(async (txn) => {
    await txn.put('c', 3);
    return 'ran';
  });
  assert.equal(after, 'ran', 'a rejected body frees the queue for the next transaction');
  await ctx.storage.sync();
  assert.equal(rows.get('c'), 3);
  assert.equal(rows.get('keep'), 'pre');
  assert.equal(rows.has('doomed'), false);
}

console.log('facet-host-storage-transaction: ok');
