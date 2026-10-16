#!/usr/bin/env bun
// What the Worker Loader shim (`nimbus wrangler dev`'s worker_loaders binding,
// and nested Nimbus's LOADER) holds in its isolate is bounded (FAB-2, the
// audit's case: seven 20 MiB Workers loaded through it were all kept, 140 MiB
// in an isolate of 128 MiB):
//
//   - a loaded Worker's modules are a cache, its env and metadata an entry
//     charged in full; neither keeps more than its bound;
//   - a load's argument has already arrived: past the code credit, it is
//     refused at once, by name, never queued while it holds its bytes;
//   - an entry over its bound (a graph of small objects, a holey array), a
//     compiled WebAssembly.Module and an over-long LOADER.get id are each
//     refused by name, the id before its key is built;
//   - a LOADER.get's key is held under its own allowance while it waits, and
//     one past that allowance is refused at once; a cold get on an idle pool
//     is admitted;
//   - a Worker whose modules the cache let go fails its native miss by name,
//     and one it kept is re-created as it was loaded.
//
// The shim runs here against a native loader that keeps nothing.
import assert from 'node:assert/strict';
import { importWorkerBundle } from './lib/worker-bundle.mjs';

const { NimbusLoaderRPC, NimbusLoadedWorker, NimbusLoadedEntrypoint, resolveLoadedEntrypoint } = await importWorkerBundle({
  'packages/fabric/src/bindings.ts': ['NimbusLoaderRPC', 'NimbusLoadedWorker', 'NimbusLoadedEntrypoint', 'resolveLoadedEntrypoint'],
});

const MiB = 1024 * 1024;
const native = { gets: [], held: null };
const stub = { getEntrypoint: () => ({ fetch: async () => new Response('ok') }) };
const env = { LOADER: {
  // Validates and keeps nothing; a test may hold its answer (`held`), as a nested shim's admission takes time.
  load() { return native.held ? native.held.then(() => stub) : stub; },
  get(key, callback) { native.gets.push({ key, code: Promise.resolve().then(callback) }); return stub; },
} };
const exports = {
  NimbusLoadedWorker({ props }) { return Object.assign(Object.create(NimbusLoadedWorker.prototype), { ctx: { props, exports }, env }); },
  NimbusLoadedEntrypoint({ props }) { return Object.assign(Object.create(NimbusLoadedEntrypoint.prototype), { ctx: { props, exports }, env }); },
};
const loader = Object.assign(Object.create(NimbusLoaderRPC.prototype), { ctx: { props: { depth: 1, namespace: 'heap-owner', networkId: 'n' }, exports }, env });
const worker = (modules, extra = {}) => ({ compatibilityDate: '2026-09-26', mainModule: Object.keys(modules)[0], modules, ...extra });
/** The code a native miss re-creates for `loaded`'s Worker, or its refusal. */
const missed = async (loaded) => {
  await resolveLoadedEntrypoint(await loaded.getEntrypoint());
  return native.gets.at(-1).code;
};
const gate = () => { let open; const promise = new Promise((resolve) => { open = resolve; }); return { promise, open }; };

// ── The audit's case: seven 20 MiB Workers, none kept past the bounds ──
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
}

// ── A load past the code credit is refused at once, never queued holding its bytes ──
{
  const held = gate();
  native.held = held.promise;
  const load = () => loader.load(worker({ 'w.js': 'export default {};', 'blob.bin': { data: new ArrayBuffer(20 * MiB) } }));
  const admitted = [load(), load(), load()];
  await assert.rejects(Promise.resolve().then(load), /holding .* of other Workers' code .*retry/, 'a fourth 20 MiB load, past the 64 MiB credit, is refused at once');
  native.held = null;
  held.open();
  await Promise.all(admitted);
  await load();
}

// ── Entries over their bound, compiled Wasm and over-long ids are refused by name ──
await assert.rejects(Promise.resolve().then(() => loader.load(worker({ 'w.js': '' }, { env: { many: Array.from({ length: 100_000 }, () => ({})) } }))),
  /env and metadata charge .* over the shim's 4,194,304 bytes entry bound/, 'a graph of 100,000 small objects is over the entry bound');
await assert.rejects(Promise.resolve().then(() => loader.load(worker({ 'w.js': '' }, { env: { holes: new Array(1_000_000) } }))),
  /entry bound/, 'a holey array of length 1,000,000 is charged by its length');
const wasm = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
await assert.rejects(Promise.resolve().then(() => loader.load(worker({ 'w.js': '', 'm.wasm': { wasm } }))),
  /compiled WebAssembly\.Module.*pass its bytes/, 'a compiled module is refused, naming what to pass');
await assert.rejects(loader.get('\u0000'.repeat(300_000), () => worker({ 'w.js': '' })),
  /LOADER\.get id of 300,000 UTF-16 units is over the shim's 262,144/, 'an over-long id is refused before its key is built');

// ── A cold get on an idle pool is admitted; keys past their allowance are refused at once ──
{
  const cold = await loader.get('cold', () => worker({ 'w.js': 'export default {};' }));
  assert.ok(cold, 'a cold get on an idle pool is admitted');
  const held = gate();
  const holding = loader.get('holding', async () => { await held.promise; return worker({ 'w.js': '' }); });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const waiting = Array.from({ length: 40 }, (_, i) => loader.get(`${'k'.repeat(200_000)}${i}`, () => worker({ 'w.js': '' })).then(() => 'admitted', (error) => String(error.message)));
  held.open();
  const outcomes = await Promise.all(waiting);
  await holding;
  assert.ok(outcomes.some((outcome) => /other LOADER\.get keys/.test(outcome)), 'gets past the key allowance are refused at once');
  assert.ok(outcomes.includes('admitted'), 'and those within it are admitted in turn');
}

// ── A native miss re-creates a kept Worker; one whose modules the cache let go fails by name ──
{
  const small = await loader.load(worker({ 'w.js': 'export default { fetch() { return new Response("small"); } };' }));
  assert.equal((await missed(small)).modules['w.js'], 'export default { fetch() { return new Response("small"); } };', 'a kept Worker is re-created as it was loaded');
  const first = await loader.load(worker({ 'w.js': '', 'a.bin': { data: new ArrayBuffer(5 * MiB) } }));
  await loader.load(worker({ 'w.js': '', 'b.bin': { data: new ArrayBuffer(5 * MiB) } }));
  await assert.rejects(missed(first), /no longer loaded: the shim's cache evicted it/, 'a Worker whose module was evicted fails its miss by name');
}

// ── A code map whose only module is empty is admitted ──
assert.ok(await loader.load(worker({ 'w.js': '' })), 'an empty module is charged, and admitted');

console.log('loader-shim-heap: ok');
