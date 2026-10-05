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
 *
 * And of the request, since the output is a function of it too: a row
 * another configuration made is not this one's, though the code is the same.
 *
 * - a user-module transform: the dev server's whole request
 *   (vite-dev-server.ts's transformRequest: the transform's options with its
 *   define, the router basename it injects, the aliases, base and
 *   `package.json#imports` the import rewrite reads). Keyed on the engines
 *   alone, a row made under one vite.config `define` or `resolve.alias` was
 *   served after the config changed.
 * - a pre-bundle: its build options (core's prebundleBuildOptions: format,
 *   platform, target, conditions, define), its externals, and the package
 *   manifests among the files it was built from. Keyed on the engine alone,
 *   a dependency reinstalled at another version kept its old bundle (the
 *   installer saw the row as current and skipped it), and the installer's
 *   bundles (no define) and the dev server's (its define) shared rows.
 */
import { type SliceEntry } from '@nimbus-sh/core/runtime/prebundle-slice.js';
/** `value` as JSON with every object's keys in order: two equal requests are one text. */
export declare function canonicalJson(value: unknown): string;
/** What a pre-bundle is built with and from, beside the engine that builds it. */
export interface PrebundleRequest {
    /** The build's options but its entry (core's prebundleBuildOptions, or the service's). */
    readonly options: unknown;
    /** The specifiers it leaves external. */
    readonly externals: readonly string[];
    /** Each package manifest among the files it was built from, with its text (null: gone): manifestsOf. */
    readonly manifests: ReadonlyArray<readonly [path: string, text: string | null]>;
}
/**
 * The package manifests of a pre-bundle's `sources`, in order, each with its
 * text as `read` gives it (null where it cannot): the package.json of every
 * package a source is in (the last `node_modules/<name>` or
 * `node_modules/@scope/<name>` of its path), and any package.json among
 * them. A reinstall at another version changes one; a row records its
 * sources, so the same manifests are read back to check it.
 */
export declare function manifestsOf(sources: readonly string[], read: (path: string) => string | null): Array<[string, string | null]>;
/**
 * manifestsOf a slice: each manifest as the slice read it (what a pre-bundle
 * built from it was built from), else as `read` gives it now.
 */
export declare function sliceManifests(slice: readonly SliceEntry[], read: (path: string) => string | null): Array<[string, string | null]>;
/**
 * The request the installer and the Vite dev server alike pre-bundle
 * `specifier` with on the build facet, from files whose manifests are
 * `manifests`: one define (core's PREBUNDLE_DEFINE), the shared runtime
 * externals.
 */
export declare function prebundleRequest(specifier: string, manifests: PrebundleRequest['manifests']): PrebundleRequest;
/** pkg_esm_bundles.bundle_hash of a pre-bundle the build facet made for `request`. */
export declare function prebundleCacheKey(request: PrebundleRequest, buildFacetId?: string): Promise<string>;
/** pkg_esm_bundles.bundle_hash of a bundle built by a service's build() for `request`, as the dev server does without a pool. */
export declare function serviceBuildCacheKey(transformHostId: string | null, request: PrebundleRequest, buildFacetId?: string, pipelineId?: string): Promise<string>;
/** user_module_transforms.bundler_version of a module transformed for `request` by a service with this transform host. */
export declare function userModuleTransformCacheKey(transformHostId: string | null, request: unknown, pipelineId?: string): Promise<string>;
//# sourceMappingURL=cache-keys.d.ts.map