// The Worker Loader shim (`nimbus wrangler dev`'s worker_loaders binding)
// caches a worker loaded with LOADER.get(id, …) for the whole isolate. An
// entry is its owner's: two loaders minted for different owners never share
// a keyed worker, even under the same id and network (audit FAB-1).
import assert from 'node:assert/strict';
import { importWorkerBundle } from './lib/worker-bundle.mjs';

const { NimbusLoaderRPC, NimbusLoadedWorker, NimbusLoadedEntrypoint } = await importWorkerBundle({
  'packages/fabric/src/bindings.ts': ['NimbusLoaderRPC', 'NimbusLoadedWorker', 'NimbusLoadedEntrypoint'],
});

const native = { gets: [] };
const stub = { getEntrypoint: () => ({ fetch: async () => new Response('ok') }) };
const env = { LOADER: {
  load() { return stub; },
  get(key, callback) { native.gets.push({ key, code: Promise.resolve(callback()) }); return stub; },
} };
const exports = {
  NimbusLoadedWorker({ props }) { return Object.assign(Object.create(NimbusLoadedWorker.prototype), { ctx: { props, exports }, env }); },
  NimbusLoadedEntrypoint({ props }) { return Object.assign(Object.create(NimbusLoadedEntrypoint.prototype), { ctx: { props, exports }, env }); },
};
const loaderFor = (props) => Object.assign(Object.create(NimbusLoaderRPC.prototype), { ctx: { props, exports }, env });
const worker = (body) => ({ compatibilityDate: '2026-09-26', mainModule: 'w.js', modules: { 'w.js': `export default { fetch() { return new Response(${JSON.stringify(body)}); } };` } });
const resolvedCode = async (loaded) => { await loaded.getEntrypoint()._resolveEntrypoint(); return native.gets.at(-1).code; };

const network = { networkId: 'default-network' };
const first = loaderFor({ depth: 1, namespace: 'owner-a', ...network });
const second = loaderFor({ depth: 1, namespace: 'owner-b', ...network });
let calls = 0;
const a = await first.get('api', () => { calls++; return worker('a'); });
const b = await second.get('api', () => { calls++; return worker('b'); });
assert.equal(calls, 2, "a second owner's callback runs: it has no worker under that id yet");
assert.ok((await resolvedCode(b)).modules['w.js'].includes('"b"'), 'the second owner runs its own code');
assert.ok((await resolvedCode(a)).modules['w.js'].includes('"a"'), 'and the first, its own');
// Within one owner, the id is reused, as the platform's LOADER.get does.
const again = await first.get('api', () => { calls++; return worker('a2'); });
assert.equal(calls, 2, 'the same owner reuses its keyed worker');
assert.ok((await resolvedCode(again)).modules['w.js'].includes('"a"'));
// A loader without an owner has no keyed cache to use.
await assert.rejects(loaderFor({ depth: 1 }).get('api', () => worker('c')), /owner namespace/);
console.log('loader-shim-owner-keys: ok');
