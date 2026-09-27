/**
 * git-bundle-artifact.ts — supervisor-side fetcher for the staged git module
 * the git network facet imports as `git-bundle.js`.
 *
 * scripts/bundle-git.mjs builds one module: vendor/git.generated.mjs, which the
 * supervisor imports, and a byte-identical copy staged under
 * public/_assets/runtime/ for the facet, which only receives modules as source
 * text. Staging keeps that text out of the Worker bundle's size gate. Memoized
 * per isolate; a failed fetch clears the memo so the next git operation
 * retries instead of pinning the error.
 */

import { GIT_BUNDLE_BUILD_ID, GIT_BUNDLE_ENTRY, GIT_BUNDLE_SHA256 } from '../git-bundle.generated.js';
import { fetchStagedSource, type StagedSourceEnv } from './staged-source.js';

let memo: Promise<string> | null = null;

/** The git module's source text for the network facet's `modules` record. */
export function fetchGitBundleSource(env: StagedSourceEnv): Promise<string> {
  if (!memo) {
    memo = fetchStagedSource(env, {
      label: 'git-bundle',
      entry: GIT_BUNDLE_ENTRY,
      buildId: GIT_BUNDLE_BUILD_ID,
      sha256: GIT_BUNDLE_SHA256,
      stagedBy: 'scripts/bundle-git.mjs',
      requiredBy: 'the git network facet',
    }).catch((e: unknown) => {
      memo = null;
      throw e;
    });
  }
  return memo;
}
