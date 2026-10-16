#!/usr/bin/env bun
// What the Worker Loader shim (`nimbus wrangler dev`'s worker_loaders binding,
// and nested Nimbus's LOADER) holds in its isolate is bounded (FAB-2, the
// audit's case: seven 20 MiB Workers loaded through it were all kept, 140 MiB
// in an isolate of 128 MiB). The shim runs here against a native loader that
// keeps nothing, and no store (loader-code-store.mjs has one):
//
//   - its module cache keeps at most its 8 MiB; a load's argument, past the
//     32 MiB code credit, is refused at once, by name, never queued while it
//     holds its bytes; a Worker over the shim's 32 MiB per-Worker bound is
//     refused, naming it the shim's (native allows 64);
//   - a value's charge is everything it holds: every own property of every
//     object (a built-in's beside its storage, a class instance's, a
//     non-enumerable one's), a holey array at its length, a buffer once
//     under many views; an accessor (in the env, an array, the module map) is
//     refused, never run; objects shared across modules are charged once;
//   - an entry right under its bound is kept, and its handle re-created;
//   - LOADER.get: its parts are validated and bounded before its key is
//     built; a miss holds its key and arguments (two-byte ids at their size)
//     under the key allowance; a hit holds nothing, whatever the allowance;
//     two gets of one key run its callback once;
//   - every lease is given back when a callback or the outer load rejects;
//   - a module named `__proto__` is re-created as its own module.
import assert from 'node:assert/strict';
import { importWorkerBundle } from './lib/worker-bundle.mjs';

const { NimbusLoaderRPC, NimbusLoadedWorker, NimbusLoadedEntrypoint, resolveLoadedEntrypoint, loaderHeapStats, priceCode, getKey } = await importWorkerBundle({
  'packages/fabric/src/bindings.ts': ['NimbusLoaderRPC', 'NimbusLoadedWorker', 'NimbusLoadedEntrypoint', 'resolveLoadedEntrypoint'],
  'packages/fabric/src/loader-heap.ts': ['loaderHeapStats', 'priceCode', 'getKey'],
});

const MiB = 1024 * 1024;
const native = { gets: [], held: null, failLoad: false };
const stub = { getEntrypoint: () => ({ fetch: async () => new Response('ok') }) };
const env = { LOADER: {
  // Validates and keeps nothing; a test may hold its answer (`held`), as a nested shim's admission takes time, or fail it.
  load() {
    if (native.failLoad) return Promise.reject(new Error('outer load refused'));
    return native.held ? native.held.then(() => stub) : stub;
  },
  get(key, callback) { native.gets.push(Promise.resolve().then(callback)); return stub; },
} };
const exports = {
  NimbusLoadedWorker({ props }) { return Object.assign(Object.create(NimbusLoadedWorker.prototype), { ctx: { props, exports }, env }); },
  NimbusLoadedEntrypoint({ props }) { return Object.assign(Object.create(NimbusLoadedEntrypoint.prototype), { ctx: { props, exports }, env }); },
};
const props = { depth: 1, namespace: 'heap-owner', networkId: 'n' };
const loader = Object.assign(Object.create(NimbusLoaderRPC.prototype), { ctx: { props, exports }, env });
const worker = (modules, extra = {}) => ({ compatibilityDate: '2026-09-26', mainModule: Object.keys(modules)[0], modules, ...extra });
/** The code a native miss re-creates for `loaded`'s Worker, or its refusal. */
const missed = async (loaded) => {
  await resolveLoadedEntrypoint(await loaded.getEntrypoint());
  return native.gets.at(-1);
};
const gate = () => { let open; const promise = new Promise((resolve) => { open = resolve; }); return { promise, open }; };
const idle = () => { const stats = loaderHeapStats(); assert.deepEqual([stats.codeReserved, stats.codeWaiting, stats.keyReserved], [0, 0, 0], 'every lease is given back'); };
const refused = (promise, pattern, what) => assert.rejects(Promise.resolve().then(() => promise), pattern, what);

// ── The audit's case: seven 20 MiB Workers, none kept past the module cache ──
{
  const refs = [];
  for (let i = 0; i < 7; i++) {
    await (async () => {
      const data = new ArrayBuffer(20 * MiB);
      refs.push(new WeakRef(data));
      await loader.load(worker({ 'w.js': 'export default {};', 'blob.bin': { data } }));
    })();
  }
  for (let i = 0; i < 5; i++) Bun.gc(true);
  const kept = refs.filter((ref) => ref.deref() !== undefined).length;
  assert.ok(kept <= 1, `seven 20 MiB Workers loaded; the shim keeps ${kept} of their 20 MiB modules (its module cache holds 8 MiB)`);
  assert.ok(loaderHeapStats().moduleCacheBytes <= 8 * MiB);
  idle();
}

// ── Past the code credit, a load is refused at once; past the per-Worker bound, by the shim's name ──
{
  const held = gate();
  native.held = held.promise;
  const load = () => loader.load(worker({ 'w.js': 'export default {};', 'blob.bin': { data: new ArrayBuffer(20 * MiB) } }));
  const admitted = load();
  await refused(load(), /holding .* of other Workers' code .*retry/, 'a second 20 MiB load, past the 32 MiB credit, is refused at once');
  native.held = null;
  held.open();
  await admitted;
  await refused(loader.load(worker({ 'w.js': '', 'blob.bin': { data: new ArrayBuffer(40 * MiB) } })),
    /Nimbus Worker Loader shim's per-Worker bound of 33,554,432 bytes .*native workerd allows 67,108,864/, 'a 40 MiB Worker is over the shim\'s bound, named as the shim\'s');
  idle();
}

// ── A value's charge is everything it holds ──
{
  const big = () => new ArrayBuffer(40 * MiB);
  class Payload { constructor() { this.held = big(); } }
  const hidden = {};
  Object.defineProperty(hidden, 'held', { value: big(), enumerable: false });
  const cases = [
    ['a boxed number holding a buffer', { json: Object.assign(new Number(1), { payload: big() }) }],
    ['a Map holding a buffer as an own property', { json: Object.assign(new Map(), { payload: big() }) }],
    ['a non-enumerable own property', { json: hidden }],
    ['a holey array of length 5,000,000', { json: new Array(5_000_000) }],
    ['a non-enumerable array index', { json: Object.defineProperty([], 0, { value: big(), enumerable: false }) }],
    ['a small view over a large buffer', { json: new Uint8Array(big(), 0, 4) }],
    ['a RegExp holding a buffer in lastIndex', { json: Object.assign(/x/g, { lastIndex: big() }) }],
  ];
  for (const [what, module] of cases) {
    await refused(loader.load(worker({ 'w.js': '', 'm.json': module })), /per-Worker bound/, `${what} is charged for it`);
  }
  class Secret { #held = big(); }
  for (const [what, module] of [['a class instance holding a buffer', { json: new Payload() }], ['a class instance with a private field', { json: new Secret() }]]) {
    await refused(loader.load(worker({ 'w.js': '', 'm.json': module })), /instance of a class .* whose state the shim cannot account for/, `${what} is refused`);
  }
  const sourceGetter = /x/; Object.defineProperty(sourceGetter, 'source', { get() { throw new Error('ran'); } });
  await refused(loader.load(worker({ 'w.js': '', 'r.json': { json: { r: sourceGetter } } })), /accessor/, 'a RegExp with an own source getter is refused, the getter never run');
  await refused(loader.load(worker({ 'w.js': '', 't.json': { json: { toJSON() { return 'x'.repeat(100); } } } })), /toJSON/, 'a {json} module holding a toJSON is refused');
  // Cycles, Errors, BigInt, Dates and an own __proto__ env field are charged and admitted.
  const cyclic = new Map(); cyclic.set('self', cyclic); const ring = new Set(); ring.add(ring);
  const error = new Error('outer', { cause: new Error('inner') }); error.cause.cause = error;
  const env = { cyclic, ring, error, big: 2n ** 4096n, when: new Date(0) };
  Object.defineProperty(env, '__proto__', { value: 'own', enumerable: true, writable: true, configurable: true });
  assert.ok(await loader.load(worker({ 'w.js': '', 'd.json': { json: { when: new Date(0) } } }, { env })), 'cyclic Map, Set and Error cause, a BigInt, a Date and an own __proto__ field are admitted');
  await refused(loader.load(worker({ 'w.js': '' }, { env: { get big() { return 'x'; } } })), /accessor/, 'an accessor in the env is refused, never run');
  const sparse = []; Object.defineProperty(sparse, 0, { get() { return 'x'; }, enumerable: true });
  await refused(loader.load(worker({ 'w.js': '', 'a.json': { json: sparse } })), /accessor/, 'an accessor array element is refused');
  const moduleMap = { 'w.js': '' }; Object.defineProperty(moduleMap, 'late.js', { get() { return 'x'; }, enumerable: true });
  await refused(loader.load(worker(moduleMap)), /accessor/, 'an accessor module is refused');
  await refused(loader.load(worker({ 'w.js': '' }, { env: { many: Array.from({ length: 100_000 }, () => ({})) } })),
    /env and metadata charge .* over the shim's 4,194,304 bytes entry bound/, 'a graph of 100,000 small objects is over the entry bound');
  const wasm = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  await refused(loader.load(worker({ 'w.js': '', 'm.wasm': { wasm } })), /compiled WebAssembly\.Module.*pass its bytes/, 'a compiled module is refused, naming what to pass');
  // One buffer under many views, and one object shared by three modules, are charged once.
  const shared = new ArrayBuffer(1.5 * MiB);
  assert.ok(await loader.load(worker({ 'w.js': '' }, { env: { views: [new Uint8Array(shared), new Uint8Array(shared, 1), new DataView(shared)] } })),
    'three views of a 1.5 MiB buffer are charged once (4.5 MiB, over the entry bound, if not)');
  const common = new Map([['s', 'x'.repeat(6 * MiB)]]);
  assert.ok(await loader.load(worker({ 'w.js': '', 'a.json': { json: common }, 'b.json': { json: common }, 'c.json': { json: common } })),
    'a 12 MiB string shared by three modules is charged once (36 MiB, over the bound, if not)');
  idle();
}

// ── An entry right under its bound is kept, and its handle re-created ──
{
  const { key } = getKey('heap-owner', 'n', 'exact');
  const sized = (n) => worker({ 'w.js': 'export default {};' }, { env: { s: 'x'.repeat(n) } });
  const base = priceCode(sized(0), key, false).entry.byteLength;
  const n = Math.floor((4 * MiB - 160 - base) / 2);
  const handle = await loader.get('exact', () => sized(n));
  assert.equal((await missed(handle)).modules['w.js'], 'export default {};', 'an entry 160 bytes under its bound (ByteLru adds that) is kept');
  idle();
}

// ── LOADER.get: parts validated and bounded before the key; a miss's key and arguments held; a hit holds nothing ──
{
  await refused(loader.get('\u0000'.repeat(300_000), () => worker({ 'w.js': '' })), /id of 300,000 UTF-16 units is over the shim's 262,144/, 'an over-long id is refused before its key is built');
  const odd = Object.assign(Object.create(NimbusLoaderRPC.prototype), { ctx: { props: { ...props, networkId: 42n }, exports }, env });
  await refused(odd.get('x', () => worker({ 'w.js': '' })), /network id must be a string/, 'a network id that is not a string is refused before its key is built');
  idle();

  const cached = await loader.get('cached', () => worker({ 'w.js': 'export default "cached";' }));
  assert.ok(cached);
  const held = gate();
  const holder = loader.get('holder', async () => { await held.promise; return worker({ 'w.js': '' }); });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const id = '\u0100'.repeat(200_000);
  const waiting = loader.get(id, () => worker({ 'w.js': '' }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(loaderHeapStats().keyReserved >= 2 * 2 * id.length, `a waiting get holds its two-byte id and its key: ${loaderHeapStats().keyReserved}`);
  const flood = Array.from({ length: 30 }, (_, i) => loader.get(`${'k'.repeat(200_000)}${i}`, () => worker({ 'w.js': '' })).then(() => 'admitted', (error) => String(error.message)));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(await loader.get('cached', () => { throw new Error('a hit runs no callback'); }), 'a hit is answered while the key allowance is spent');
  held.open();
  await holder;
  await waiting;
  const outcomes = await Promise.all(flood);
  assert.ok(outcomes.some((outcome) => /other LOADER\.get keys/.test(outcome)), 'gets past the key allowance are refused at once');

  let calls = 0;
  const slow = gate();
  const first = loader.get('twice', async () => { calls++; await slow.promise; return worker({ 'w.js': '' }); });
  const second = loader.get('twice', async () => { calls++; return worker({ 'w.js': '' }); });
  slow.open();
  await Promise.all([first, second]);
  assert.equal(calls, 1, 'two gets of one key run its callback once');
  idle();
}

// ── Leases are given back when a callback or the outer load rejects ──
await refused(loader.get('rejecting', () => Promise.reject(new Error('callback failed'))), /callback failed/);
idle();
native.failLoad = true;
await refused(loader.load(worker({ 'w.js': '' })), /outer load refused/);
await refused(loader.get('outer-fails', () => worker({ 'w.js': '' })), /outer load refused/);
native.failLoad = false;
idle();

// ── A native miss re-creates a kept Worker, `__proto__` module and all; an evicted one fails by name ──
{
  const modules = { 'w.js': 'export default {};' };
  Object.defineProperty(modules, '__proto__', { value: 'export const proto = 1;', enumerable: true, writable: true, configurable: true });
  const loaded = await loader.load(worker(modules));
  const code = await missed(loaded);
  assert.ok(Object.hasOwn(code.modules, '__proto__') && code.modules.__proto__ === 'export const proto = 1;', 'a module named __proto__ is its own module');
  const first = await loader.load(worker({ 'w.js': '', 'a.bin': { data: new ArrayBuffer(5 * MiB) } }));
  await loader.load(worker({ 'w.js': '', 'b.bin': { data: new ArrayBuffer(5 * MiB) } }));
  await refused(missed(first), /no longer loaded: the shim's cache evicted it/, 'a Worker whose module was evicted, with no store, fails its miss by name');
  assert.ok(await loader.load(worker({ 'w.js': '' })), 'an empty module is charged, and admitted');
  idle();
}

console.log('loader-shim-heap: ok');
