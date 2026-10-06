#!/usr/bin/env bun
// The pack layer's byte-bounded LRU charges each entry a fixed overhead
// besides its bytes, so many tiny entries (a status reading small trees)
// stay within the budget too. Red before: 10,000 one-byte entries all stayed
// in a 160,000-byte cache.

import assert from 'node:assert/strict';

import { BYTE_LRU_ENTRY_OVERHEAD, ByteLru } from '../../packages/worker/src/git/pack/byte-lru.ts';

const cache = new ByteLru(160_000);
for (let i = 0; i < 10_000; i++) cache.set(i, new Uint8Array(1));
assert.ok(cache.size <= Math.floor(160_000 / (1 + BYTE_LRU_ENTRY_OVERHEAD)), 'entries bounded by overhead: ' + cache.size);
assert.ok(cache.byteLength <= 160_000);
assert.equal(cache.get(9_999)?.byteLength, 1, 'the newest stays');
assert.equal(cache.get(0), undefined, 'the oldest went');

// Replacing a key keeps the account exact.
const exact = new ByteLru(10_000);
exact.set('a', new Uint8Array(100));
exact.set('a', new Uint8Array(300));
assert.equal(exact.byteLength, 300 + BYTE_LRU_ENTRY_OVERHEAD);
exact.clear();
assert.equal(exact.byteLength, 0);
console.log('git-pack-byte-lru: ok');
