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
/** pkg_esm_bundles.bundle_hash of a pre-bundle the build facet made. */
export declare function prebundleCacheKey(buildFacetId?: string): Promise<string>;
/** pkg_esm_bundles.bundle_hash of a bundle built by a service's build(), as the dev server does without a pool. */
export declare function serviceBuildCacheKey(transformHostId: string | null, buildFacetId?: string, pipelineId?: string): Promise<string>;
/** user_module_transforms.bundler_version of a module transformed by a service with this transform host. */
export declare function userModuleTransformCacheKey(transformHostId: string | null, pipelineId?: string): Promise<string>;
//# sourceMappingURL=cache-keys.d.ts.map