#!/usr/bin/env bun
// runtime-code-store — the code node processes produced at runtime, kept in
// the session's storage for the next launch of their command. What must hold
// across a fresh isolate over the same storage: an entry larger than one
// storage value comes back whole, the store keeps at most
// RUNTIME_CODE_MAX_BYTES with the least recently recorded leaving first, and
// what left is gone from storage too.

import assert from 'node:assert/strict';
import { RuntimeCodeStore } from '../../packages/worker/src/facets/runtime-code-store.ts';
import { RUNTIME_CODE_MAX_BYTES, RUNTIME_CODE_MAX_ENTRIES, runtimeCodeKey } from '../../packages/core/src/_shared/commonjs-cell.ts';

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

// A flood of tiny pieces is bounded by count, not only by text: a report is
// read up to RUNTIME_CODE_MAX_ENTRIES, the store keeps as many, and a key the
// store dropped leaves every profile, the other commands' included.
{
  const rows = new Map();
  const store = new RuntimeCodeStore(storageOver(rows));
  const flood = Array.from({ length: RUNTIME_CODE_MAX_ENTRIES * 3 }, (_, i) => fn(String(i)));
  await store.record('first', flood.slice(0, 10));
  await store.record('second', flood.slice(10));
  const entryRows = [...rows.keys()].filter((key) => /^runtime-code:[0-9a-f]{64}:/.test(key));
  assert.ok(entryRows.length <= RUNTIME_CODE_MAX_ENTRIES, `at most ${RUNTIME_CODE_MAX_ENTRIES} entries are kept: ${entryRows.length}`);
  const fresh = new RuntimeCodeStore(storageOver(rows));
  assert.ok((await fresh.forLaunch('second')).size <= RUNTIME_CODE_MAX_ENTRIES);
  const first = await fresh.forLaunch('first');
  assert.equal(first.size, 0, 'the first command\'s ten pieces were the least recent, and left');
  assert.deepEqual(rows.get('runtime-code-profile:first'), [], 'and its profile row names none of them');
  console.log('  [4] bounded by count as well as bytes; dropped keys leave every profile');
}

console.log('runtime-code-store OK');
