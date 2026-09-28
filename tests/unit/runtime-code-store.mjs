#!/usr/bin/env bun
// runtime-code-store — the code node processes produced at runtime, kept in
// the session's storage for the next launch of their command. What must hold
// across a fresh isolate over the same storage: an entry larger than one
// storage value comes back whole, the store keeps at most
// RUNTIME_CODE_MAX_BYTES with the least recently recorded leaving first, and
// what left is gone from storage too.

import assert from 'node:assert/strict';
import { RuntimeCodeStore } from '../../packages/worker/src/facets/runtime-code-store.ts';
import { RUNTIME_CODE_MAX_BYTES, runtimeCodeKey } from '../../packages/core/src/_shared/commonjs-cell.ts';

/** Durable Object storage over a Map, as a session's outlives its isolate. */
function storageOver(rows) {
  return {
    async get(key) { return rows.get(key); },
    async put(key, value) {
      // A key and value may not exceed 2 MB together; a two-byte string
      // serializes at two bytes per unit.
      assert.ok(typeof value !== 'string' || value.length * 2 <= 2 * 1024 * 1024, `value for ${key} fits one storage row`);
      rows.set(key, structuredClone(value));
    },
    async delete(key) { return rows.delete(key); },
  };
}

const fn = (body) => ({ kind: 'async', params: ['a'], body });
const third = Math.floor(RUNTIME_CODE_MAX_BYTES / 3) - 16;
const big = (fill) => fn(fill.repeat(third));

// An entry larger than one storage value, in two-byte text, comes back whole.
{
  const rows = new Map();
  const body = 'é'.repeat(1_500_000);
  assert.equal(await new RuntimeCodeStore(storageOver(rows)).record('cmd', [fn(body)]), true, 'a new key is learned');
  const staged = await new RuntimeCodeStore(storageOver(rows)).forLaunch('cmd');
  assert.equal(staged.get(runtimeCodeKey(fn(body)))?.body, body, 'the entry survives a new isolate whole');
  assert.equal((await new RuntimeCodeStore(storageOver(rows)).forLaunch('other')).size, 0, 'and only for its own command');
  console.log('  [1] a chunked entry round-trips through storage');
}

// At most RUNTIME_CODE_MAX_BYTES, least recently recorded out — a re-report
// counts as recent — and what leaves is deleted.
{
  const rows = new Map();
  const store = new RuntimeCodeStore(storageOver(rows));
  const [a, b, c] = [big('a'), big('b'), big('c')];
  await store.record('cmd', [a]);
  await store.record('cmd', [b]);
  assert.equal(await store.record('cmd', [a]), false, 'a key already known is not news');
  await store.record('cmd', [c]);
  await store.record('cmd', [fn('x'.repeat(64))]);
  const staged = await new RuntimeCodeStore(storageOver(rows)).forLaunch('cmd');
  assert.deepEqual(
    [a, b, c].map((entry) => staged.has(runtimeCodeKey(entry))), [true, false, true],
    'the least recently recorded left; the re-reported one stayed',
  );
  assert.ok(![...rows.keys()].some((key) => key.startsWith(`runtime-code:${runtimeCodeKey(b)}:`)), 'its rows are deleted');
  console.log('  [2] bounded, least recently recorded out');
}

// Garbage in a report is dropped, not stored.
{
  const rows = new Map();
  const store = new RuntimeCodeStore(storageOver(rows));
  assert.equal(await store.record('cmd', [{ kind: 'eval', body: 'x' }, { kind: 'module', path: 1 }, null]), false);
  assert.equal((await store.forLaunch('cmd')).size, 0);
  console.log('  [3] malformed reports are dropped');
}

console.log('runtime-code-store OK');
