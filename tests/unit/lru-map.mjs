#!/usr/bin/env bun
// lru-map — the bounded LRU map must evict the least-recently-used key
// at capacity, treat get/set as a use (move-to-MRU), and preserve the
// Map surface its callers use.

import assert from 'node:assert/strict';
import { LruMap } from '../../packages/core/src/_shared/lru-map.ts';

// Eviction at capacity, LRU first.
{
  const m = new LruMap(2);
  m.set('a', 1);
  m.set('b', 2);
  m.set('c', 3); // evicts 'a' (LRU)
  assert.equal(m.size, 2);
  assert.equal(m.get('a'), undefined);
  assert.equal(m.get('b'), 2);
  assert.equal(m.get('c'), 3);
}

// get() refreshes recency so the touched key survives the next eviction.
{
  const m = new LruMap(2);
  m.set('a', 1);
  m.set('b', 2);
  assert.equal(m.get('a'), 1); // 'a' now MRU, 'b' LRU
  m.set('c', 3);               // evicts 'b'
  assert.equal(m.get('b'), undefined);
  assert.equal(m.get('a'), 1);
  assert.equal(m.get('c'), 3);
}

// set() on an existing key updates the value without growing size and
// refreshes recency.
{
  const m = new LruMap(2);
  m.set('a', 1);
  m.set('b', 2);
  m.set('a', 11); // update + MRU
  assert.equal(m.size, 2);
  m.set('c', 3);  // evicts 'b'
  assert.equal(m.get('b'), undefined);
  assert.equal(m.get('a'), 11);
}

// delete / has / clear / keys surface.
{
  const m = new LruMap(4);
  m.set('x', 1);
  m.set('y', 2);
  assert.equal(m.has('x'), true);
  assert.equal(m.delete('x'), true);
  assert.equal(m.has('x'), false);
  assert.deepEqual([...m.keys()], ['y']);
  m.clear();
  assert.equal(m.size, 0);
}

// Rejects a non-positive capacity.
assert.throws(() => new LruMap(0), /maxEntries/);

console.log('lru-map: ok');
