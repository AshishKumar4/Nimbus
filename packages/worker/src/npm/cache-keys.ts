/**
 * cache-keys.ts — what the session's persistent build caches are keyed by,
 * beside what was built: the code that built it.
 *
 * Two caches in the session's SQLite (npm/cache.ts) outlive the code that
 * wrote them: pkg_esm_bundles (pre-bundles, from the install and the Vite dev
 * server's /@modules/) by `bundle_hash`, and user_module_transforms (the dev
 * server's transformed .ts/.tsx/.jsx) by `bundler_version`. Both were keyed
 * on BUNDLER_VERSION alone, a constant bumped by hand, and core 0.15.1
 * changed the transform's output (an unused `import React` under the
 * automatic runtime dropped, as esbuild drops it) without a bump: a warm
 * session kept serving 0.15.0's output for every file it had not changed.
 *
 * Each key is now BUNDLER_VERSION, still bumped by hand for what the
 * supervisor does around an engine (the slice walk, import rewriting,
 * basename injection), and a digest of the engines' identities, which any
 * build of an engine changes without anyone remembering to:
 *
 * - a pre-bundle: the build facet's (BUILD_FACET_WORKER_ID: rolldown, its
 *   binding and loader, the facet runtime with core's adapter and slice
 *   bundler);
 * - a user-module transform: the transform pipeline's code
 *   (TRANSFORM_PIPELINE_ID: core's EsbuildService) and the service's transform
 *   host (EsbuildService.transformHostId: the transform facet's runtime and
 *   wasm, and the esbuild facet's; a service with no host, in-isolate);
 * - a bundle the dev server builds through its service, with no pool: all
 *   of these, since the service's build host is the build facet with the
 *   esbuild facet behind it.
 */

import { BUNDLER_VERSION } from '@nimbus-sh/core/runtime/esbuild-service.js';
import { TRANSFORM_PIPELINE_ID } from '@nimbus-sh/core/runtime/transform-pipeline.generated.js';
import { sha256Base64Url } from '@nimbus-sh/core/_shared/crypto.js';
import { BUILD_FACET_WORKER_ID } from '../facets/build-facet.js';

const keys = new Map<string, Promise<string>>();

/** `BUNDLER_VERSION:` and a digest of what the cached output is a function of. */
function keyOf(kind: string, parts: readonly string[]): Promise<string> {
  const identity = [kind, BUNDLER_VERSION, ...parts].join('\n');
  let key = keys.get(identity);
  if (!key) {
    key = sha256Base64Url(identity).then((digest) => `${BUNDLER_VERSION}:${digest.slice(0, 22)}`);
    keys.set(identity, key);
  }
  return key;
}

/** pkg_esm_bundles.bundle_hash of a pre-bundle the build facet made. */
export function prebundleCacheKey(buildFacetId: string = BUILD_FACET_WORKER_ID): Promise<string> {
  return keyOf('prebundle', [buildFacetId]);
}

/** pkg_esm_bundles.bundle_hash of a bundle built by a service's build(), as the dev server does without a pool. */
export function serviceBuildCacheKey(
  transformHostId: string | null,
  buildFacetId: string = BUILD_FACET_WORKER_ID,
  pipelineId: string = TRANSFORM_PIPELINE_ID,
): Promise<string> {
  return keyOf('service-build', [pipelineId, transformHostId ?? 'in-isolate', buildFacetId]);
}

/** user_module_transforms.bundler_version of a module transformed by a service with this transform host. */
export function userModuleTransformCacheKey(transformHostId: string | null, pipelineId: string = TRANSFORM_PIPELINE_ID): Promise<string> {
  return keyOf('user-module-transform', [pipelineId, transformHostId ?? 'in-isolate']);
}
