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

import { BUNDLER_VERSION, getSharedRuntimeExternals } from '@nimbus-sh/core/runtime/esbuild-service.js';
import { PREBUNDLE_DEFINE, prebundleBuildOptions, sliceSources, type SliceEntry } from '@nimbus-sh/core/runtime/prebundle-slice.js';
import { TRANSFORM_PIPELINE_ID } from '@nimbus-sh/core/runtime/transform-pipeline.generated.js';
import { sha256Base64Url } from '@nimbus-sh/core/_shared/crypto.js';
import { BUILD_FACET_WORKER_ID } from '../facets/build-facet.js';

/** At most this many keys are remembered; past it, the memo starts over. */
const KEYS_KEPT = 512;
const keys = new Map<string, Promise<string>>();

/** `BUNDLER_VERSION:` and a digest of what the cached output is a function of. */
function keyOf(kind: string, parts: readonly string[]): Promise<string> {
  const identity = [kind, BUNDLER_VERSION, ...parts].join('\n');
  let key = keys.get(identity);
  if (!key) {
    if (keys.size >= KEYS_KEPT) keys.clear();
    key = sha256Base64Url(identity).then((digest) => `${BUNDLER_VERSION}:${digest.slice(0, 22)}`);
    keys.set(identity, key);
  }
  return key;
}

/** `value` as JSON with every object's keys in order: two equal requests are one text. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;
    const entries = Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries);
  });
}

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
export function manifestsOf(sources: readonly string[], read: (path: string) => string | null): Array<[string, string | null]> {
  const paths = new Set<string>();
  for (const path of sources) {
    if (path === 'package.json' || path.endsWith('/package.json')) paths.add(path);
    const at = path.lastIndexOf('/node_modules/');
    if (at < 0) continue;
    const parts = path.slice(at + '/node_modules/'.length).split('/');
    const name = parts[0]?.startsWith('@') ? parts.slice(0, 2) : parts.slice(0, 1);
    if (name.length === (parts[0]?.startsWith('@') ? 2 : 1) && parts.length > name.length) {
      paths.add(`${path.slice(0, at)}/node_modules/${name.join('/')}/package.json`);
    }
  }
  return [...paths].sort().map((path) => [path, read(path)]);
}

/**
 * manifestsOf a slice: each manifest as the slice read it (what a pre-bundle
 * built from it was built from), else as `read` gives it now.
 */
export function sliceManifests(slice: readonly SliceEntry[], read: (path: string) => string | null): Array<[string, string | null]> {
  const decoder = new TextDecoder();
  const files = new Map<string, Uint8Array>();
  for (const entry of slice) if (!entry.isDir) files.set(entry.path, entry.bytes);
  return manifestsOf(sliceSources(slice), (path) => {
    const bytes = files.get(path);
    return bytes ? decoder.decode(bytes) : read(path);
  });
}

/**
 * The request the installer and the Vite dev server alike pre-bundle
 * `specifier` with on the build facet, from files whose manifests are
 * `manifests`: one define (core's PREBUNDLE_DEFINE), the shared runtime
 * externals.
 */
export function prebundleRequest(specifier: string, manifests: PrebundleRequest['manifests']): PrebundleRequest {
  return { options: prebundleBuildOptions(PREBUNDLE_DEFINE), externals: getSharedRuntimeExternals(specifier), manifests };
}

/** pkg_esm_bundles.bundle_hash of a pre-bundle the build facet made for `request`. */
export function prebundleCacheKey(request: PrebundleRequest, buildFacetId: string = BUILD_FACET_WORKER_ID): Promise<string> {
  return keyOf('prebundle', [buildFacetId, canonicalJson(request)]);
}

/** pkg_esm_bundles.bundle_hash of a bundle built by a service's build() for `request`, as the dev server does without a pool. */
export function serviceBuildCacheKey(
  transformHostId: string | null,
  request: PrebundleRequest,
  buildFacetId: string = BUILD_FACET_WORKER_ID,
  pipelineId: string = TRANSFORM_PIPELINE_ID,
): Promise<string> {
  return keyOf('service-build', [pipelineId, transformHostId ?? 'in-isolate', buildFacetId, canonicalJson(request)]);
}

/** user_module_transforms.bundler_version of a module transformed for `request` by a service with this transform host. */
export function userModuleTransformCacheKey(
  transformHostId: string | null,
  request: unknown,
  pipelineId: string = TRANSFORM_PIPELINE_ID,
): Promise<string> {
  return keyOf('user-module-transform', [pipelineId, transformHostId ?? 'in-isolate', canonicalJson(request)]);
}
