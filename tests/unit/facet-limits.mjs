import assert from 'node:assert/strict';
import { FACET_LIMITS, MAX_FACET_CPU_MS, applyFacetLimits, facetLimits } from '../../packages/fabric/src/facet-limits.ts';
import { facetCpuViolations } from '../../scripts/deploy-isolation.mjs';

const seen = new Set();
for (const [kind, configured] of Object.entries(FACET_LIMITS)) {
  const code = { mainModule: 'fixture.js', modules: { 'fixture.js': 'export default {};' }, env: { PRESERVED: 'value' }, limits: { cpuMs: 1, subRequests: 1 } };
  const applied = applyFacetLimits(kind, code);
  assert.deepEqual(applied.limits, facetLimits(kind), `${kind}: native limits come from the table`);
  assert.deepEqual(applied.limits, configured, `${kind}: every registered kind gets its policy`);
  assert.deepEqual(JSON.parse(applied.env.NIMBUS_FACET_LIMITS), { ...configured, diagnosticReserve: 64 }, `${kind}: diagnostic counter and native policy agree`);
  assert.equal(applied.env.PRESERVED, 'value');
  assert.deepEqual(code.limits, { cpuMs: 1, subRequests: 1 }, `${kind}: caller config is not mutated`);
  assert.ok(configured.subRequests > 12000 + 64);
  seen.add(kind);
}
for (const kind of ['process', 'build', 'esbuild', 'transform', 'git']) assert.ok(seen.has(kind));
assert.equal(MAX_FACET_CPU_MS, Math.max(...Object.values(FACET_LIMITS).map(limits => limits.cpuMs)));
assert.deepEqual(facetCpuViolations({ limits: { cpu_ms: MAX_FACET_CPU_MS } }), []);
const refused = facetCpuViolations({ limits: { cpu_ms: MAX_FACET_CPU_MS - 1 } });
assert.equal(refused.length, 1);
assert.ok(refused[0].includes(String(MAX_FACET_CPU_MS - 1)) && refused[0].includes(String(MAX_FACET_CPU_MS)));
assert.equal(facetCpuViolations({}).length, 1);
console.log(`${seen.size} facet kinds receive explicit native and reportable limits`);
