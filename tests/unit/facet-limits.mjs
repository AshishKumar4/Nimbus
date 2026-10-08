import assert from 'node:assert/strict';
import { FACET_LIMITS, MAX_FACET_CPU_MS, applyFacetLimits, facetCallDeadlineMs, facetLimits, facetLoaderKey, facetPolicyKey, codeFacetPolicy } from '../../packages/fabric/src/facet-limits.ts';
import { facetCpuViolations } from '../../scripts/deploy-isolation.mjs';
import { IsolatePool } from '../../packages/fabric/src/isolate-pool.ts';
import { ISOLATE_NETWORK } from '../../packages/core/src/_shared/workspace-network.ts';
import { buildNimbusWranglerConfig } from '../../packages/config/src/index.ts';

const seen = new Set();
for (const [kind, configured] of Object.entries(FACET_LIMITS)) {
  const code = { mainModule: 'fixture.js', modules: { 'fixture.js': 'export default {};' }, env: { PRESERVED: 'value' }, limits: { cpuMs: 1, subRequests: 1 } };
  const applied = applyFacetLimits(kind, code);
  assert.deepEqual(applied.limits, facetLimits(kind), `${kind}: native limits come from the table`);
  assert.deepEqual(applied.limits, { cpuMs: configured.cpuMs, subRequests: configured.subRequests }, `${kind}: native limits are the table's, nothing else`);
  // A process has no wall deadline; a direct compute call has one, and it is not the old 30 s.
  if (kind === 'process' || kind === 'isolate' || kind === 'worker') assert.equal(facetCallDeadlineMs(kind), undefined, `${kind}: runs processes, no wall deadline`);
  else assert.ok(facetCallDeadlineMs(kind) > 30_000, `${kind}: a compute call's deadline`);
  assert.deepEqual(codeFacetPolicy(applied), { kind, limits: applied.limits }, `${kind}: inner Loader preserves the code policy`);
  assert.equal(applied.env.NIMBUS_FACET_LIMITS, undefined, 'no unconsumed budget envelope');
  assert.equal(applied.env.PRESERVED, 'value');
  assert.deepEqual(code.limits, { cpuMs: 1, subRequests: 1 }, `${kind}: caller config is not mutated`);
  assert.ok(configured.subRequests > 12000 + 64);
  assert.ok(configured.subRequests <= 10_000_000, `${kind}: never claims more than the provider maximum`);
  assert.ok(facetLoaderKey(kind, 'fixture').endsWith(`:${configured.cpuMs}:${configured.subRequests}`));
  assert.equal(facetPolicyKey(kind), `${kind}:${configured.cpuMs}:${configured.subRequests}`);
  seen.add(kind);
}
for (const kind of ['process', 'build', 'esbuild', 'transform', 'git']) assert.ok(seen.has(kind));
const loaderIds = new Set();
const ctx = { id: { toString: () => 'facet-policy-unit' }, waitUntil() {} };
for (const kind of seen) {
  let loaded;
  let startLimits;
  const env = { LOADER: { get(id, callback) {
    loaderIds.add(id);
    const code = Promise.resolve(callback());
    return { getEntrypoint(name, options) {
      startLimits = options.limits;
      return { async fetch() {
        loaded = await code;
        return Response.json({ kind });
      } };
    } };
  } } };
  const pool = new IsolatePool(env, ctx, { facetKind: kind, omitSupervisor: true, network: ISOLATE_NETWORK });
  try {
    const response = await pool.submitRequest(() => new Response('fixture'), new Request('https://unit.example/'));
    assert.equal((await response.json()).kind, kind);
    assert.deepEqual(loaded.limits, facetLimits(kind), `${kind}: actual Loader factory receives the policy`);
    assert.deepEqual(startLimits, facetLimits(kind), `${kind}: actual entrypoint start receives the same policy`);
    assert.deepEqual(codeFacetPolicy(loaded), { kind, limits: startLimits });
    assert.equal(pool.defaultTimeoutMs, facetCallDeadlineMs(kind) ?? 0, `${kind}: the pool's deadline is the kind's, or none`);
  } finally {
    await pool.dispose();
  }
}
assert.equal(loaderIds.size, seen.size, 'distinct kinds cannot reuse a cached worker with another policy');
assert.equal(MAX_FACET_CPU_MS, Math.max(...Object.values(FACET_LIMITS).map(limits => limits.cpuMs)));
assert.deepEqual(facetCpuViolations({ limits: { cpu_ms: MAX_FACET_CPU_MS } }), []);
const refused = facetCpuViolations({ limits: { cpu_ms: MAX_FACET_CPU_MS - 1 } });
assert.equal(refused.length, 1);
assert.ok(refused[0].includes(String(MAX_FACET_CPU_MS - 1)) && refused[0].includes(String(MAX_FACET_CPU_MS)));
assert.equal(facetCpuViolations({}).length, 1);
assert.equal(buildNimbusWranglerConfig({ name: 'facet-policy-unit' }).limits.cpu_ms, MAX_FACET_CPU_MS);
assert.equal(buildNimbusWranglerConfig({ name: 'facet-policy-unit', cpuMs: MAX_FACET_CPU_MS }).limits.cpu_ms, MAX_FACET_CPU_MS);
assert.throws(() => buildNimbusWranglerConfig({ name: 'facet-policy-unit', cpuMs: MAX_FACET_CPU_MS - 1 }), error => {
  return error.message.includes(String(MAX_FACET_CPU_MS - 1)) && error.message.includes(String(MAX_FACET_CPU_MS));
});
console.log(`${seen.size} facet kinds receive explicit native and reportable limits`);
