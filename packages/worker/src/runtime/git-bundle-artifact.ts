/**
 * git-bundle-artifact.ts — supervisor-side fetcher for the staged git module
 * the git network facet imports as `git-bundle.js`.
 *
 * scripts/bundle-git.mjs builds one module: vendor/git.generated.mjs, which the
 * supervisor imports, and a byte-identical copy staged under
 * public/_assets/runtime/ for the facet, which only receives modules as source
 * text. Staging keeps that text out of the Worker bundle's size gate.
 */

import { GIT_BUNDLE_BUILD_ID, GIT_BUNDLE_ENTRY, GIT_BUNDLE_SHA256 } from '../git-bundle.generated.js';
import {
  fetchStagedText,
  memoizeUntilRejected,
  stagedRuntimeSource,
  type StagedSourceEnv,
} from './staged-source.js';

const GIT_BUNDLE = stagedRuntimeSource({
  label: 'git-bundle',
  entry: GIT_BUNDLE_ENTRY,
  buildId: GIT_BUNDLE_BUILD_ID,
  sha256: GIT_BUNDLE_SHA256,
  stagedBy: 'scripts/bundle-git.mjs',
  requiredBy: 'the git network facet',
});

/**
 * The git module's source text for the network facet's `modules` record.
 * Memoized per isolate; a failed fetch clears the memo so the next git
 * operation retries instead of pinning the error.
 */
export const fetchGitBundleSource: (env: StagedSourceEnv) => Promise<string> =
  memoizeUntilRejected((env: StagedSourceEnv) => fetchStagedText(env, GIT_BUNDLE));
