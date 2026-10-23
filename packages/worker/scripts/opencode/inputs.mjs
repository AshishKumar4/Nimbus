import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { digestInputs, lockfileInputs } from '../artifact-inputs.mjs';
import { sha256Hex } from '../stage-asset.mjs';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
export const OPENCODE_SOURCE = { version: '1.16.2', commit: '76c631d198f9ff620e15468e45f3457d50481b57', url: 'https://github.com/sst/opencode' };

export async function opencodeInputs(root = REPO) {
  const recipe = 'packages/worker/scripts/opencode';
  const patches = (await fs.readdir(path.join(root, recipe))).filter(name => name.endsWith('.patch'));
  const files = await digestInputs(root, [
    `${recipe}/build-node.ts`, `${recipe}/bundle-patches.ts`, `${recipe}/inputs.mjs`, `${recipe}/models-catalog.mjs`, `${recipe}/stubs`,
    ...patches.map(name => `${recipe}/${name}`),
    'packages/worker/scripts/artifact-inputs.mjs',
    'packages/worker/scripts/stage-asset.mjs',
    'scripts/ci/rebuild-opencode.mjs',
  ]);
  // The parser bundle-patches.ts runs (tsrs, its CI binary included).
  const parser = await lockfileInputs(root, 'bun.lock', ['tsrs', '@tsrs/linux-x64-gnu']);
  return { ...files, ...parser, 'toolchain#bun': sha256Hex(execFileSync('bun', ['--version'], { encoding: 'utf8' }).trim()) };
}
