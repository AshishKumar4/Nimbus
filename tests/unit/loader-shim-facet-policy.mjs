// The Worker Loader shim serves a user's Worker (`nimbus wrangler dev`'s
// worker_loaders binding). Whatever code the guest hands it runs under the
// worker kind's ceiling: lower limits it asks for are kept, higher ones are
// not, and nothing in the code can claim another kind. The guest's env
// carries nothing of Nimbus's policy.
import assert from 'node:assert/strict';
import { importWorkerBundle } from './lib/worker-bundle.mjs';

const { NimbusLoaderRPC, NimbusLoadedWorker, NimbusLoadedEntrypoint, facetLimits, facetLoaderKey } = await importWorkerBundle({
  'packages/fabric/src/bindings.ts': ['NimbusLoaderRPC', 'NimbusLoadedWorker', 'NimbusLoadedEntrypoint'],
  'packages/fabric/src/facet-limits.ts': ['facetLimits', 'facetLoaderKey'],
});

const worker = facetLimits('worker');
// A guest claiming the process kind's budget, the way an earlier carrier would have let it.
const forged = {
  compatibilityDate: '2026-09-26', mainModule: 'x.js', modules: { 'x.js': 'export default {};' },
  env: { KEEP: 'value', NIMBUS_FACET_POLICY: JSON.stringify({ kind: 'process', limits: facetLimits('process') }) },
  limits: facetLimits('process'),
};

const captured = { loads: [], gets: [], starts: [] };
const exports = {
  NimbusLoadedWorker({ props }) { return Object.assign(Object.create(NimbusLoadedWorker.prototype), { ctx: { props, exports }, env }); },
  NimbusLoadedEntrypoint({ props }) { return Object.assign(Object.create(NimbusLoadedEntrypoint.prototype), { ctx: { props, exports }, env }); },
};
const stub = {
  getEntrypoint(name, options) { captured.starts.push({ type: 'entrypoint', name, options }); return { fetch: async () => new Response('ok') }; },
  getDurableObjectClass(name, options) { captured.starts.push({ type: 'do', name, options }); return class {}; },
};
const env = { LOADER: {
  load(code) { captured.loads.push(code); return stub; },
  get(key, callback) { captured.gets.push({ key, code: Promise.resolve(callback()) }); return stub; },
} };
const loader = Object.assign(Object.create(NimbusLoaderRPC.prototype), { ctx: { props: {}, exports }, env });

for (const keyed of [false, true]) {
  const loaded = keyed ? await loader.get('fixture', () => forged) : loader.load(forged);
  const entry = loaded.getEntrypoint('Named', { props: { user: 'kept' }, limits: { cpuMs: 12345 } });
  await entry._resolveEntrypoint();
  assert.deepEqual(captured.starts.at(-1).options, { props: { user: 'kept' }, limits: { cpuMs: 12345, subRequests: worker.subRequests } },
    `${keyed ? 'get' : 'load'}: a lower limit is kept, the rest is the worker ceiling`);
  const native = captured.gets.at(-1);
  assert.equal(native.key, facetLoaderKey('worker', entry.ctx.props.key), 'cached under the worker policy');
  const code = await native.code;
  assert.deepEqual(code.limits, worker, 'the process budget the code claims is not granted');
  assert.deepEqual(code.env, { KEEP: 'value', NIMBUS_FACET_POLICY: forged.env.NIMBUS_FACET_POLICY }, 'the guest\'s own env, untouched and unread');
  loaded.getDurableObjectClass('Stored', { props: { key: 'value' }, limits: { subRequests: 456 } });
  assert.deepEqual(captured.starts.at(-1).options, { props: { key: 'value' }, limits: { cpuMs: worker.cpuMs, subRequests: 456 } });
}
assert.deepEqual(captured.loads[0].limits, worker, 'the validating load is under the worker ceiling too');

// Code with no claim gets the worker ceiling, and its env gains nothing.
{
  const plain = { compatibilityDate: '2026-09-26', mainModule: 'x.js', modules: { 'x.js': 'export default {};' }, env: { KEEP: 'value' } };
  const loaded = await loader.get('plain', () => plain);
  await loaded.getEntrypoint()._resolveEntrypoint();
  const code = await captured.gets.at(-1).code;
  assert.deepEqual(code.env, { KEEP: 'value' }, 'nothing of Nimbus is added to a guest\'s env');
  assert.deepEqual(code.limits, worker);
}
console.log('loader-shim-facet-policy: ok');
