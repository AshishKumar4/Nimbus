import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { digestInputs } from '../artifact-inputs.mjs';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
export const OPENCODE_SOURCE = { version: '1.16.2', commit: '76c631d198f9ff620e15468e45f3457d50481b57', url: 'https://github.com/sst/opencode' };

export async function opencodeInputs(root = REPO) {
  const recipe = 'packages/worker/scripts/opencode';
  const patches = (await fs.readdir(path.join(root, recipe))).filter(name => name.endsWith('.patch'));
  return digestInputs(root, [
    `${recipe}/build-node.ts`, `${recipe}/bundle-patches.ts`, `${recipe}/inputs.mjs`, `${recipe}/stubs`,
    ...patches.map(name => `${recipe}/${name}`),
    'packages/worker/scripts/artifact-inputs.mjs',
    'packages/worker/scripts/stage-asset.mjs',
    'scripts/ci/rebuild-opencode.mjs',
  ]);
}
