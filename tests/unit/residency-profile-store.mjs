#!/usr/bin/env bun
// A session learns what a resident process could not read, and the next run
// of the same build stages it. The session Durable Object is evicted whenever
// it sits idle between two commands, so the profile has to live in the
// session's storage: a fresh isolate over the same storage (what the next
// command after a pause runs in) must know every path the evicted one learned.
// Measured before this store existed: an in-memory profile, and Vite's
// node_modules/ms/index.js missed on every launch that followed a pause.

import assert from 'node:assert/strict';
import { ResidencyProfileStore } from '../../packages/worker/src/facets/residency-profile-store.ts';

function durable() {
  const rows = new Map();
  return {
    rows,
    async get(key) { return rows.has(key) ? structuredClone(rows.get(key)) : undefined; },
    async put(key, value) { rows.set(key, structuredClone(value)); },
    async delete(key) { return rows.delete(key); },
  };
}

const VITE = 'runtime\x001000:1000:1000\x00/home/user/app\x00/home/user/app/nimbus-vite.mjs\x00abc';
const MS = 'home/user/app/node_modules/ms/index.js';

// ── learned in one isolate, known in the next ───────────────────────────
{
  const storage = durable();
  const evicted = new ResidencyProfileStore(storage, 16, 4096);
  assert.equal(await evicted.record(VITE, [MS]), true, 'a new path is learned');
  assert.equal(await evicted.record(VITE, [MS]), false, 'the same path twice is nothing new');
  const next = new ResidencyProfileStore(storage, 16, 4096);
  assert.deepEqual(await next.paths(VITE), [MS], 'the next isolate stages what the evicted one learned');
  assert.deepEqual(await next.paths('other-build'), [], 'a profile only seeds the build it was measured against');
}

// ── a relaunch at once reads what the exit just reported ────────────────
{
  const store = new ResidencyProfileStore(durable(), 16, 4096);
  const recorded = store.record(VITE, [MS, '', 42]);
  assert.deepEqual(await store.paths(VITE), [MS], 'queued behind the record; junk entries are not paths');
  assert.equal(await recorded, true);
}

// ── bounded: keys least recently recorded go first, paths per key capped ─
{
  const storage = durable();
  const store = new ResidencyProfileStore(storage, 2, 2);
  await store.record('a', ['a1']);
  await store.record('b', ['b1']);
  await store.record('a', ['a2']);
  await store.record('c', ['c1']);
  const next = new ResidencyProfileStore(storage, 2, 2);
  assert.deepEqual(await next.paths('b'), [], 'the least recently recorded key is dropped, from storage too');
  assert.deepEqual(await next.paths('a'), ['a1', 'a2']);
  assert.deepEqual(await next.paths('c'), ['c1']);
  assert.equal(await store.record('a', ['a3']), false, 'a full profile stops growing');
  assert.deepEqual(await new ResidencyProfileStore(storage, 2, 2).paths('a'), ['a1', 'a2']);
  assert.equal([...storage.rows.keys()].filter((k) => k.startsWith('residency-profile:')).length, 2, 'storage holds only the kept keys');
}

console.log('residency-profile-store: ok');
