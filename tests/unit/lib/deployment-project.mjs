import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeNimbusAppConfigs } from '../../../scripts/generate-wrangler-configs.mjs';

/** A temporary publisher project with the same deployment authority as the repository. */
export function stageDeploymentProject(root, pin) {
  const repo = new URL('../../../', import.meta.url).pathname;
  for (const path of ['apps/hosted-demo', 'apps/probe', 'scripts', 'packages/config']) mkdirSync(join(root, path), { recursive: true });
  cpSync(join(repo, 'packages/config/dist'), join(root, 'packages/config/dist'), { recursive: true });
  cpSync(join(repo, 'packages/config/package.json'), join(root, 'packages/config/package.json'));
  cpSync(join(repo, 'scripts/generate-wrangler-configs.mjs'), join(root, 'scripts/generate-wrangler-configs.mjs'));
  const spec = JSON.parse(readFileSync(join(repo, 'apps/nimbus-deployments.json'), 'utf8'));
  spec.runtimeCatalogSha256 = pin;
  writeFileSync(join(root, 'apps/nimbus-deployments.json'), JSON.stringify(spec, null, 2) + '\n');
  writeNimbusAppConfigs({ root });
  return spec;
}
