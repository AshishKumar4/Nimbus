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
import { PREBUNDLE_DEFINE, prebundleBuildOptions, sliceSources } from '@nimbus-sh/core/runtime/prebundle-slice.js';
import { TRANSFORM_PIPELINE_ID } from '@nimbus-sh/core/runtime/transform-pipeline.generated.js';
import { sha256Base64Url } from '@nimbus-sh/core/_shared/crypto.js';
import { BUILD_FACET_WORKER_ID } from '../facets/build-facet.js';
/** At most this many keys are remembered; past it, the memo starts over. */
const KEYS_KEPT = 512;
const keys = new Map();
/** `BUNDLER_VERSION:` and a digest of what the cached output is a function of. */
function keyOf(kind, parts) {
    const identity = [kind, BUNDLER_VERSION, ...parts].join('\n');
    let key = keys.get(identity);
    if (!key) {
        if (keys.size >= KEYS_KEPT)
            keys.clear();
        key = sha256Base64Url(identity).then((digest) => `${BUNDLER_VERSION}:${digest.slice(0, 22)}`);
        keys.set(identity, key);
    }
    return key;
}
/** `value` as JSON with every object's keys in order: two equal requests are one text. */
export function canonicalJson(value) {
    return JSON.stringify(value, (_key, item) => {
        if (item === null || typeof item !== 'object' || Array.isArray(item))
            return item;
        const entries = Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return Object.fromEntries(entries);
    });
}
/**
 * The manifests a source answers to: itself, where it is a package.json; the
 * package.json of the package it is in under node_modules (the last
 * `node_modules/<name>` or `node_modules/@scope/<name>` of its path); and
 * the closest package.json up from it (its package scope, which a nested
 * one such as `pkg/part/package.json` or a workspace package outside
 * node_modules is), with every place on the way up where none was (a
 * package.json appearing there would be the closer scope: its absence is
 * part of what the source was resolved under). `read` gives a file's text,
 * or null where there is none.
 */
function manifestPathsOf(path, read, closest) {
    const paths = [];
    if (path === 'package.json' || path.endsWith('/package.json'))
        paths.push(path);
    const at = path.lastIndexOf('/node_modules/');
    if (at >= 0) {
        const parts = path.slice(at + '/node_modules/'.length).split('/');
        const length = parts[0]?.startsWith('@') ? 2 : 1;
        if (parts.length > length)
            paths.push(`${path.slice(0, at)}/node_modules/${parts.slice(0, length).join('/')}/package.json`);
    }
    // The closest package.json up from the source's directory, memoized per directory.
    const visited = [];
    let found = null;
    for (let dir = path.slice(0, Math.max(0, path.lastIndexOf('/')));; dir = dir.slice(0, Math.max(0, dir.lastIndexOf('/')))) {
        if (closest.has(dir)) {
            found = closest.get(dir) ?? null;
            break;
        }
        visited.push(dir);
        const candidate = `${dir}/package.json`;
        paths.push(candidate);
        if (read(candidate) !== null) {
            found = candidate;
            break;
        }
        if (dir === '')
            break;
    }
    for (const dir of visited)
        closest.set(dir, found);
    return paths;
}
/**
 * The package manifests a pre-bundle built from `sources` answers to, in
 * order, each with its text as `read` gives it (null where it has none, a
 * place a nested one would be the closer scope): manifestPathsOf each
 * source. A reinstall at another version, or an edit of
 * a package's `imports`, `exports` or `type`, changes one; a row records its
 * sources, so the same manifests are read back to check it.
 */
export function manifestsOf(sources, read) {
    const paths = new Set();
    const closest = new Map();
    for (const path of sources)
        for (const manifest of manifestPathsOf(path, read, closest))
            paths.add(manifest);
    return [...paths].sort().map((path) => [path, read(path)]);
}
/**
 * manifestsOf a slice: each manifest as the slice read it (what a pre-bundle
 * built from it was built from), else as `read` gives it now, which is the
 * walk's moment where it runs right after the walk.
 */
export function sliceManifests(slice, read) {
    const decoder = new TextDecoder();
    const files = new Map();
    for (const entry of slice)
        if (!entry.isDir)
            files.set(entry.path, entry.bytes);
    const text = new Map();
    return manifestsOf(sliceSources(slice), (path) => {
        if (!text.has(path)) {
            const bytes = files.get(path);
            text.set(path, bytes ? decoder.decode(bytes) : read(path));
        }
        return text.get(path) ?? null;
    });
}
/**
 * What a build read its sources' manifests as: `saw(path, text)`, as the
 * build reads each file, records the text of every manifest that file
 * answers to (manifestPathsOf), at that moment, absences included;
 * `manifests(sources)` is manifestsOf the sources as recorded (as `read`
 * gives it now, for one never seen). `moved()`: the build itself read a
 * manifest as other than recorded (one that appeared, changed or went while
 * it ran), so what it made answers to no one moment's manifests: it is
 * served, never stored.
 */
export function recordingManifests(read) {
    const recorded = new Map();
    const closest = new Map();
    let moved = false;
    const once = (path) => {
        if (!recorded.has(path))
            recorded.set(path, read(path));
        return recorded.get(path) ?? null;
    };
    return {
        saw(path, text) {
            // Spelled as a pre-bundle's sources are: absolute.
            const at = '/' + path.replace(/^\/+/, '');
            if (text !== undefined && at.endsWith('/package.json')) {
                if (recorded.has(at) && recorded.get(at) !== text)
                    moved = true;
                else
                    recorded.set(at, text);
            }
            for (const manifest of manifestPathsOf(at, once, closest))
                once(manifest);
        },
        manifests: (sources) => manifestsOf(sources, once),
        moved: () => moved,
    };
}
/** Whether every manifest still reads as it was recorded: a build whose inputs moved under it is not stored. */
export function stillCurrent(manifests, read) {
    return manifests.every(([path, text]) => read(path) === text);
}
/**
 * The request the installer and the Vite dev server alike pre-bundle
 * `specifier` with on the build facet, from files whose manifests are
 * `manifests`: one define (core's PREBUNDLE_DEFINE), the shared runtime
 * externals.
 */
export function prebundleRequest(specifier, manifests) {
    return { options: prebundleBuildOptions(PREBUNDLE_DEFINE), externals: getSharedRuntimeExternals(specifier), manifests };
}
/** pkg_esm_bundles.bundle_hash of a pre-bundle the build facet made for `request`. */
export function prebundleCacheKey(request, buildFacetId = BUILD_FACET_WORKER_ID) {
    return keyOf('prebundle', [buildFacetId, canonicalJson(request)]);
}
/** pkg_esm_bundles.bundle_hash of a bundle built by a service's build() for `request`, as the dev server does without a pool. */
export function serviceBuildCacheKey(transformHostId, request, buildFacetId = BUILD_FACET_WORKER_ID, pipelineId = TRANSFORM_PIPELINE_ID) {
    return keyOf('service-build', [pipelineId, transformHostId ?? 'in-isolate', buildFacetId, canonicalJson(request)]);
}
/** user_module_transforms.bundler_version of a module transformed for `request` by a service with this transform host. */
export function userModuleTransformCacheKey(transformHostId, request, pipelineId = TRANSFORM_PIPELINE_ID) {
    return keyOf('user-module-transform', [pipelineId, transformHostId ?? 'in-isolate', canonicalJson(request)]);
}
