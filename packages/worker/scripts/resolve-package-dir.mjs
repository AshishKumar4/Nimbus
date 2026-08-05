/**
 * Locate an installed package's directory without assuming a node_modules layout.
 *
 * bun moves packages between layouts across releases: 1.3.1 links this
 * workspace isolated (`packages/worker/node_modules/<pkg>` → `node_modules/.bun/…`,
 * nothing at the repo root), 1.3.14 hoists to the repo root and leaves the
 * workspace tree empty. A hardcoded path therefore works for whoever installed
 * last and breaks for everyone else — which is exactly how the cf-git unit
 * tests came to fail in CI and pass locally.
 */

import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * @param {string} pkgName  Package name as it appears in node_modules — for an
 *                          aliased dependency, the alias (`isomorphic-git`),
 *                          not the package it resolves to.
 * @param {{ start: string }} options  Directory whose dependency this is; the
 *                          walk goes up from here.
 */
export function resolvePackageDir(pkgName, { start }) {
  for (let dir = start; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', pkgName);
    try {
      statSync(candidate);
      return candidate;
    } catch { /* not this level */ }
    if (dirname(dir) === dir) break;
  }

  // A layout that stores packages outside every ancestor node_modules still
  // resolves through node's algorithm.
  try {
    const require = createRequire(join(start, 'package.json'));
    return dirname(require.resolve(`${pkgName}/package.json`));
  } catch { /* report the walk failure below, which names the search root */ }

  throw new Error(`cannot locate node_modules/${pkgName} from ${start} — is the workspace installed?`);
}
