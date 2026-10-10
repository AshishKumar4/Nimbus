import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nimbusAppConfigs } from '../../scripts/generate-wrangler-configs.mjs';
import { buildNimbusWranglerConfig } from '../../packages/config/src/index.ts';
import { checkAll, loadConfig } from '../../scripts/deploy-isolation.mjs';

const spec = JSON.parse(readFileSync(new URL('../../apps/nimbus-deployments.json', import.meta.url), 'utf8'));
const [hosted, probe] = nimbusAppConfigs(spec);
assert.deepEqual(hosted, loadConfig('apps/hosted-demo/wrangler.jsonc'));
assert.deepEqual(probe, loadConfig('apps/probe/wrangler.jsonc'));
const tiers = [hosted, hosted.env.staging, hosted.env.production];
assert.deepEqual(tiers.map((tier) => [tier.name, tier.d1_databases[0].database_id, tier.ratelimits[0].namespace_id]), [
  ['nimbus-dev', '72d98818-359a-4c30-ba59-e3f4418bfa74', '1002'],
  ['nimbus-staging', '5589ddb3-96bc-4a73-b939-5431553b63d7', '1003'],
  ['nimbus', '8e2ecc37-d975-49d8-96b7-885d45734a53', '1001'],
]);
assert.equal(hosted.assets.run_worker_first, true);
assert.deepEqual(probe.assets.run_worker_first, ['/api/*', '/s/*', '/new']);
assert.deepEqual(hosted.migrations.map(({ tag }) => tag), ['v1', 'v2']);
assert.equal(probe.placement, undefined);
assert.deepEqual(probe.previews.r2_buckets, probe.r2_buckets);
assert.deepEqual(checkAll().flatMap((result) => result.violations), []);
const changed = nimbusAppConfigs({ ...spec, runtimeCatalogSha256: 'a'.repeat(64) });
for (const tier of [changed[0], ...Object.values(changed[0].env), changed[1], changed[1].previews]) {
  assert.equal(tier.vars.NIMBUS_RUNTIME_CATALOG_SHA256, 'a'.repeat(64));
}
assert.deepEqual(probe.limits, buildNimbusWranglerConfig({ name: 'fixture' }).limits, 'hosting limits come from the canonical builder');
console.log('deployment-config-projection: ok');
