#!/usr/bin/env bun
// launch-learning-store — what a command's runs learned for its next launch,
// kept in the session's storage, because the session is evicted whenever it
// sits idle between two commands. What must hold across a fresh isolate over
// the same storage: every part of a profile survives, the parts stay apart
// (a data read never comes back as a module to execute), a code entry larger
// than one storage value comes back whole, and every bound drops the least
// recently recorded from storage too.

import assert from 'node:assert/strict';
import { LaunchLearningStore } from '../../packages/worker/src/facets/launch-learning-store.ts';
import { RUNTIME_CODE_MAX_BYTES, RUNTIME_CODE_MAX_ENTRIES, runtimeCodeKey } from '../../packages/core/src/_shared/commonjs-cell.ts';

/** Durable Object storage over a Map, as a session's outlives its isolate. */
function storageOver(rows, reads = { count: 0 }) {
  return {
    async get(key) { reads.count++; return rows.has(key) ? structuredClone(rows.get(key)) : undefined; },
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
const VITE = 'runtime\x001000:1000:1000\x00/home/user/app\x00/home/user/app/nimbus-vite.mjs\x00abc';
const MS = 'home/user/app/node_modules/ms/index.js';
const CONTENT = 'home/user/app/src/App.tsx';

// Learned in one isolate, known in the next, each part as it was reported.
{
  const rows = new Map();
  const evicted = new LaunchLearningStore(storageOver(rows));
  assert.equal(await evicted.record(VITE, { executedModules: [MS], dataReads: [CONTENT] }), true, 'new paths are learned');
  assert.equal(await evicted.record(VITE, { executedModules: [MS], dataReads: [CONTENT] }), false, 'the same paths twice are nothing new');
  const next = await new LaunchLearningStore(storageOver(rows)).forLaunch(VITE);
  assert.deepEqual(next.executedModules, [MS], 'the next isolate roots what the evicted one executed');
  assert.deepEqual(next.dataReads, [CONTENT], 'and stages what it read as data, not as a module');
  const other = await new LaunchLearningStore(storageOver(rows)).forLaunch('other-build');
  assert.deepEqual([other.executedModules, other.dataReads, other.code.size], [[], [], 0], 'a profile only seeds its own build');
  console.log('  [1] executed modules and data reads survive an eviction, apart');
}

// A relaunch at once reads what the exit just reported; junk is not a path.
{
  const store = new LaunchLearningStore(storageOver(new Map()));
  const recorded = store.record(VITE, { dataReads: [MS, '', 42] });
  assert.deepEqual((await store.forLaunch(VITE)).dataReads, [MS], 'queued behind the record; junk entries are dropped');
  assert.equal(await recorded, true);
  console.log('  [2] a launch after a report is built with it');
}

// Asking about commands that never reported holds nothing and writes nothing.
{
  const rows = new Map();
  const store = new LaunchLearningStore(storageOver(rows));
  for (let i = 0; i < 100; i++) await store.forLaunch(`node -e ${i}`);
  assert.deepEqual(store.cached(), [], 'no profile is held for an unindexed key');
  assert.equal(rows.size, 0);
  console.log('  [3] unindexed keys cost nothing that stays');
}

// One LRU index of bundle keys; paths per part capped.
{
  const rows = new Map();
  const store = new LaunchLearningStore(storageOver(rows), 2, 2);
  await store.record('a', { dataReads: ['a1'] });
  await store.record('b', { executedModules: ['b1'], code: [fn('b')] });
  await store.record('a', { dataReads: ['a2'] });
  await store.record('c', { dataReads: ['c1'] });
  const next = new LaunchLearningStore(storageOver(rows), 2, 2);
  const b = await next.forLaunch('b');
  assert.deepEqual([b.executedModules, b.code.size], [[], 0], 'the least recently recorded key is dropped whole');
  assert.deepEqual((await next.forLaunch('a')).dataReads, ['a1', 'a2']);
  assert.deepEqual((await next.forLaunch('c')).dataReads, ['c1']);
  assert.equal(await store.record('a', { dataReads: ['a3'] }), false, 'a full part stops growing');
  assert.deepEqual((await new LaunchLearningStore(storageOver(rows), 2, 2).forLaunch('a')).dataReads, ['a1', 'a2']);
  assert.equal([...rows.keys()].filter((k) => k.startsWith('launch-profile:')).length, 2, 'storage holds only the kept keys');
  console.log('  [4] one bounded index of bundle keys; capped parts');
}

// A code entry larger than one storage value, in two-byte text, comes back whole.
{
  const rows = new Map();
  const body = 'é'.repeat(1_500_000);
  assert.equal(await new LaunchLearningStore(storageOver(rows)).record('cmd', { code: [fn(body)] }), true, 'a new key is learned');
  const staged = (await new LaunchLearningStore(storageOver(rows)).forLaunch('cmd')).code;
  assert.equal(staged.get(runtimeCodeKey(fn(body)))?.body, body, 'the entry survives a new isolate whole');
  assert.equal((await new LaunchLearningStore(storageOver(rows)).forLaunch('other')).code.size, 0, 'and only for its own command');
  console.log('  [5] a chunked entry round-trips through storage');
}

// At most RUNTIME_CODE_MAX_BYTES of code, least recently recorded out — a
// re-report counts as recent — and what leaves is deleted.
{
  const rows = new Map();
  const store = new LaunchLearningStore(storageOver(rows));
  const [a, b, c] = [big('a'), big('b'), big('c')];
  await store.record('cmd', { code: [a] });
  await store.record('cmd', { code: [b] });
  assert.equal(await store.record('cmd', { code: [a] }), false, 'a key already known is not news');
  await store.record('cmd', { code: [c] });
  await store.record('cmd', { code: [fn('x'.repeat(64))] });
  const staged = (await new LaunchLearningStore(storageOver(rows)).forLaunch('cmd')).code;
  assert.deepEqual(
    [a, b, c].map((entry) => staged.has(runtimeCodeKey(entry))), [true, false, true],
    'the least recently recorded left; the re-reported one stayed',
  );
  assert.ok(![...rows.keys()].some((key) => key.startsWith(`runtime-code:${runtimeCodeKey(b)}:`)), 'its rows are deleted');
  console.log('  [6] code bounded by bytes, least recently recorded out');
}

// A data: URL module pays for its URL as well as its text, so two of them at
// a third of the bound each (by text) do not both fit.
{
  const rows = new Map();
  const store = new LaunchLearningStore(storageOver(rows));
  const inline = (fill) => {
    const text = 'export default "' + fill.repeat(Math.floor(RUNTIME_CODE_MAX_BYTES / 3)) + '";';
    return { kind: 'module', path: 'data:text/javascript,' + text, text };
  };
  const [x, y] = [inline('x'), inline('y')];
  await store.record('cmd', { code: [x] });
  await store.record('cmd', { code: [y] });
  const staged = (await store.forLaunch('cmd')).code;
  assert.deepEqual([x, y].map((entry) => staged.has(runtimeCodeKey(entry))), [false, true], 'the older inline module left');
  console.log('  [7] a data: module is charged for its URL');
}

// Garbage in a report is dropped, not stored.
{
  const store = new LaunchLearningStore(storageOver(new Map()));
  assert.equal(await store.record('cmd', { code: [{ kind: 'eval', body: 'x' }, { kind: 'module', path: 1 }, null] }), false);
  assert.equal((await store.forLaunch('cmd')).code.size, 0);
  console.log('  [8] malformed reports are dropped');
}

// A flood of tiny pieces is bounded by count, not only by text, and a key the
// store dropped leaves every profile, the other commands' included.
{
  const rows = new Map();
  const store = new LaunchLearningStore(storageOver(rows));
  const flood = Array.from({ length: RUNTIME_CODE_MAX_ENTRIES * 3 }, (_, i) => fn(String(i)));
  await store.record('first', { code: flood.slice(0, 10) });
  await store.record('second', { code: flood.slice(10) });
  const entryRows = [...rows.keys()].filter((key) => /^runtime-code:[0-9a-f]{64}:/.test(key));
  assert.ok(entryRows.length <= RUNTIME_CODE_MAX_ENTRIES, `at most ${RUNTIME_CODE_MAX_ENTRIES} entries are kept: ${entryRows.length}`);
  const fresh = new LaunchLearningStore(storageOver(rows));
  assert.ok((await fresh.forLaunch('second')).code.size <= RUNTIME_CODE_MAX_ENTRIES);
  assert.equal((await fresh.forLaunch('first')).code.size, 0, 'the first command\'s ten pieces were the least recent, and left');
  assert.deepEqual(rows.get('launch-profile:first').codeKeys, [], 'and its profile row names none of them');
  console.log('  [9] bounded by count as well as bytes; dropped keys leave every profile');
}

console.log('launch-learning-store OK');
