#!/usr/bin/env bun
// Verified immutable tarballs stay local across fresh supervisor cache clients.
import assert from 'node:assert/strict';
import { R2CacheClient } from '../../packages/worker/src/npm/r2-cache.ts';
import { packageTarball, sriOf } from './lib/tarball-fixture.mjs';
import { withColoCache } from './lib/colo-cache.mjs';

function bucket() {
  const entries = new Map();
  return {
    async put(key, bytes) { entries.set(key, new Uint8Array(bytes)); },
    async get(key) {
      const bytes = entries.get(key);
      return bytes ? { arrayBuffer: async () => bytes.slice().buffer } : null;
    },
  };
}

await withColoCache(async colo => {
  let externalReads = 0;
  const match = colo.match.bind(colo);
  colo.match = request => { externalReads++; return match(request); };
  const shared = bucket();
  const original = packageTarball({ 'package/index.js': 'module.exports = "immutable";' });
  const integrity = await sriOf(original);
  const input = original.slice();
  assert.equal(await new R2CacheClient(shared, null).putTarball(integrity, input), true);
  input[0] ^= 0xff; // The writer still owns its input after the write.
  for (let run = 0; run < 5; run++) {
    const bytes = await new R2CacheClient(shared, null).getTarball(integrity);
    assert.deepEqual(bytes, original, 'a fresh supervisor sees the verified immutable bytes');
    bytes[0] ^= 0xff; // Returned views cannot mutate another caller's cached bytes.
  }
  assert.equal(externalReads, 0, 'verified uploads and warm reads need no repeated colo-cache I/O');
});

await withColoCache(async colo => {
  let externalReads = 0;
  const match = colo.match.bind(colo);
  colo.match = request => { externalReads++; return match(request); };
  const shared = bucket();
  // Oversize values stay in the external tiers, not in the bounded local heap.
  const large = new Uint8Array(3 * 1024 * 1024);
  const integrity = await sriOf(large);
  assert.equal(await new R2CacheClient(shared, null).putTarball(integrity, large), true);
  for (let run = 0; run < 2; run++) assert.deepEqual(await new R2CacheClient(shared, null).getTarball(integrity), large);
  assert.equal(externalReads, 2, 'large tarballs bypass local retention');

  // Nine 1 MiB values cannot all remain in an 8 MiB cache. The oldest
  // remains fetchable after eviction; the most recent still needs no I/O.
  const addresses = [];
  for (let run = 0; run < 9; run++) {
    const bytes = new Uint8Array(1024 * 1024);
    bytes[0] = run;
    addresses.push(await sriOf(bytes));
    assert.equal(await new R2CacheClient(shared, null).putTarball(addresses[run], bytes), true);
  }
  const before = externalReads;
  assert.ok(await new R2CacheClient(shared, null).getTarball(addresses[0]));
  assert.equal(externalReads, before + 1, 'evicted content falls through to the existing verified store');
  const newest = await new R2CacheClient(shared, null).getTarball(addresses.at(-1));
  assert.equal(newest[0], 8);
  assert.equal(externalReads, before + 1, 'a retained immutable tarball remains local');
});

await withColoCache(async () => {
  const shared = bucket();
  const honest = packageTarball({ 'package/index.js': 'module.exports = "honest";' });
  const wrong = packageTarball({ 'package/index.js': 'module.exports = "wrong";' });
  const integrity = await sriOf(honest);
  assert.equal(await new R2CacheClient(shared, null).putTarball(integrity, wrong), false);
  assert.equal(await new R2CacheClient(shared, null).getTarball(integrity), null, 'rejected bytes never enter the local tier');
});

await withColoCache(async () => {
  const shared = bucket();
  const original = packageTarball({ 'package/index.js': 'module.exports = "snapshot";' });
  const integrity = await sriOf(original);
  const input = original.slice();
  const stored = new R2CacheClient(shared, null).putTarball(integrity, input);
  input[0] ^= 0xff; // A pending write must not admit a later caller mutation.
  assert.equal(await stored, true);
  assert.deepEqual(await new R2CacheClient(shared, null).getTarball(integrity), original);
});

console.log('npm-tarball-local-cache: ok');
