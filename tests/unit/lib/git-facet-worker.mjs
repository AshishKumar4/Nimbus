// The git network facet as its tests load it: the assembled facet module
// written to a directory beside the git bundle it imports (git-bundle.js),
// then imported from there.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { assembleGitNetworkFacetSource } from '../../../packages/worker/src/git/network-facet.ts';

/**
 * Write the assembled facet and `bundleSource` (the git-bundle.js it
 * imports: a fake isomorphic-git, or the real one) into `dir`, and import
 * the facet. `dir` stays the caller's to remove.
 */
export async function importGitFacetWorker(dir, bundleSource) {
  writeFileSync(join(dir, 'git-network-worker.mjs'), assembleGitNetworkFacetSource());
  writeFileSync(join(dir, 'git-bundle.js'), bundleSource);
  return import(pathToFileURL(join(dir, 'git-network-worker.mjs')).href);
}
