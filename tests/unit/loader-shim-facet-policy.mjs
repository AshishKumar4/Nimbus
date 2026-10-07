import assert from 'node:assert/strict';
import { importWorkerBundle } from './lib/worker-bundle.mjs';

const { NimbusLoaderRPC, NimbusLoadedWorker, NimbusLoadedEntrypoint, applyFacetLimits, facetLimits, facetLoaderKey } = await importWorkerBundle({
  'packages/fabric/src/bindings.ts': ['NimbusLoaderRPC', 'NimbusLoadedWorker', 'NimbusLoadedEntrypoint'],
  'packages/fabric/src/facet-limits.ts': ['applyFacetLimits', 'facetLimits', 'facetLoaderKey'],
});

for (const kind of ['git', 'process']) {
  const captured = { loads: [], gets: [], starts: [] };
  const exports = {
    NimbusLoadedWorker({ props }) { return Object.assign(Object.create(NimbusLoadedWorker.prototype), { ctx: { props, exports }, env }); },
    NimbusLoadedEntrypoint({ props }) { return Object.assign(Object.create(NimbusLoadedEntrypoint.prototype), { ctx: { props, exports }, env }); },
  };
  const stub = {
    getEntrypoint(name, options) { captured.starts.push({ type:'entrypoint', name, options }); return { fetch: async () => new Response('ok') }; },
    getDurableObjectClass(name, options) { captured.starts.push({ type:'do', name, options }); return class {}; },
  };
  const env = { LOADER: {
    load(code) { captured.loads.push(code); return stub; },
    get(key, callback) { captured.gets.push({ key, code: Promise.resolve(callback()) }); return stub; },
  } };
  const loader = Object.assign(Object.create(NimbusLoaderRPC.prototype), { ctx: { props: {}, exports }, env });
  const code = applyFacetLimits(kind, { compatibilityDate:'2026-09-26', mainModule:'x.js', modules:{ 'x.js':'export default {};' }, env:{ KEEP:'value' } });
  for (const keyed of [false, true]) {
    const worker = keyed ? await loader.get('fixture-'+kind, () => code) : loader.load(code);
    const entry = worker.getEntrypoint('Named', { props:{ user:'kept' }, limits:{ cpuMs:12345 } });
    await entry._resolveEntrypoint();
    const start = captured.starts.at(-1);
    assert.deepEqual(start.options, { props:{ user:'kept' }, limits:{ cpuMs:12345, subRequests:facetLimits(kind).subRequests } });
    const native = captured.gets.at(-1);
    assert.equal(native.key, facetLoaderKey(kind, entry.ctx.props.key));
    const loaded = await native.code;
    assert.deepEqual(loaded.limits, facetLimits(kind));
    assert.equal(loaded.env.KEEP, 'value');
    worker.getDurableObjectClass('Stored', { props:{ key:'value' }, limits:{ subRequests:456 } });
    assert.deepEqual(captured.starts.at(-1).options, { props:{ key:'value' }, limits:{ cpuMs:facetLimits(kind).cpuMs, subRequests:456 } });
  }
  assert.equal(captured.loads[0].limits.subRequests, facetLimits(kind).subRequests);
}
