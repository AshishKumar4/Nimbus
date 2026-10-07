// What the local deploy path needs installed, checked before anything that
// needs it is imported: the upload (wrangler), the config parser
// deploy-isolation uses (packages/worker's jsonc-parser), and the workspace
// links the apps' assets are read through. All of it comes from
// `bun install --frozen-lockfile --ignore-scripts`: the root postinstall
// bundles, and this machine builds nothing (AGENTS.md, Tests § CI). This
// module imports nothing outside node, so it runs in a bare checkout.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const INSTALL = 'bun install --frozen-lockfile --ignore-scripts';

/** Exit 2, saying what is missing and the install that provides it, unless `root` has it. */
export function assertInstalled(root, who = 'this command') {
  const missing = [];
  if (!existsSync(join(root, 'node_modules', '.bin', 'wrangler'))) missing.push('node_modules/.bin/wrangler');
  try {
    Bun.resolveSync('jsonc-parser', join(root, 'packages', 'worker', 'src'));
  } catch {
    missing.push('packages/worker\'s jsonc-parser');
  }
  for (const app of ['apps/probe', 'apps/hosted-demo']) {
    if (!existsSync(join(root, app, 'node_modules', '@nimbus-sh', 'worker'))) missing.push(`${app}'s @nimbus-sh/worker link`);
  }
  if (missing.length === 0) return;
  console.error(`${who}: node_modules is missing or incomplete here (${missing.join(', ')}). Run, in ${root}:\n  ${INSTALL}\n`
    + '(--ignore-scripts: the root postinstall bundles, and this machine builds nothing.)');
  process.exit(2);
}
