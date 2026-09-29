/**
 * esbuild-wasm-bytes.ts — supervisor-side fetcher for the staged artifacts
 * the esbuild facet is built from: the JS adapter that drives the wasm, and
 * the runner of the `esbuild` command. Both live in the static-assets layer
 * (env.ASSETS); this module hands them to the caller when needed.
 *
 * The wasm itself is not staged. The host Worker bundles it (core's
 * EsbuildService imports `esbuild-wasm/esbuild.wasm`), workerd compiles it
 * at startup, and facets are handed that compiled module
 * (runtime/host-wasm.ts). It was staged here as 12 MiB of bytes, fetched,
 * verified and compiled again by every facet that used it.
 *
 * The JS adapter is staged for the reason the wasm once was, at a smaller
 * scale: the supervisor already imports esbuild-wasm's browser build as a
 * module for its own transforms, so carrying the same 117 KiB again as a
 * string literal for facets doubled it in the Worker bundle. The CLI runner
 * (32 KiB of Go glue and fs shim) only ever runs in the facet, so it is
 * staged too; its name carries a prefix of its digest, because unlike the
 * adapter it changes without an esbuild upgrade.
 *
 * Cache strategy
 * ──────────────
 * - NO module-scope cache: the texts are small, and a facet's loader cache
 *   holds the only long-lived copy.
 * - L2 colo cache via `caches.default`: the paths are version-pinned
 *   (`/_assets/esbuild-<ESBUILD_VERSION>.js`, the runner by build id), so an
 *   `immutable` cache entry is correct.
 *
 * Failure model
 * ─────────────
 * Cache lookup failure (any throw) → fall through to ASSETS.
 * ASSETS fetch returning non-200 → throw (deploy bug, surface loudly).
 * Digest mismatch on either tier → throw (the texts are evaluated as facet
 * code, so they are verified against the digest the generator recorded
 * before returning).
 */
import { ESBUILD_JS_ASSET_PATH, ESBUILD_JS_SHA256 } from '../esbuild-wasm-bundle.generated.js';
import { ESBUILD_CLI_ASSET_PATH, ESBUILD_CLI_SHA256 } from '../esbuild-cli-artifact.generated.js';
import { fetchStagedText } from './staged-source.js';
/**
 * Synthetic L2 cache keys for the staged esbuild artifacts. Versioned via
 * the asset paths so each esbuild upgrade lands fresh entries and old ones
 * naturally evict on TTL.
 */
export const ESBUILD_JS_L2_KEY = `https://nimbus-cache.invalid${ESBUILD_JS_ASSET_PATH}`;
/** The CLI runner's key names its build id, so each rebuild lands a fresh entry. */
export const ESBUILD_CLI_L2_KEY = `https://nimbus-cache.invalid${ESBUILD_CLI_ASSET_PATH}`;
/** One esbuild artifact, verified against its pin (runtime/staged-source.ts). */
function esbuildAsset(label, path, l2Key, sha256, contentType, stagedBy) {
    return {
        path,
        l2Key,
        sha256,
        contentType,
        poisonedCache: 'reject',
        missingBinding: `Nimbus: the esbuild facet requires an env.ASSETS binding (serves ${path})`,
        fetchFailed: (res) => `${label} asset fetch failed: ${res.status} ${res.statusText} ` +
            `for ${path} — deploy is missing the asset`,
        integrityFailed: (digest, from) => `${label} integrity check failed: expected ${sha256}, got ` +
            `${digest} (${from}) for ${path} — ` +
            'the staged asset is corrupt or out of sync; rerun ' +
            `${stagedBy} and redeploy`,
    };
}
const ESBUILD_JS_ASSET = esbuildAsset('esbuild-wasm JS adapter', ESBUILD_JS_ASSET_PATH, ESBUILD_JS_L2_KEY, ESBUILD_JS_SHA256, 'text/javascript; charset=utf-8', 'scripts/bundle-esbuild-wasm.mjs');
const ESBUILD_CLI_ASSET = esbuildAsset('esbuild CLI runner', ESBUILD_CLI_ASSET_PATH, ESBUILD_CLI_L2_KEY, ESBUILD_CLI_SHA256, 'text/javascript; charset=utf-8', 'scripts/bundle-facet-workers.mjs');
/**
 * Fetch the esbuild-wasm JS adapter: the function body that, wrapped in
 * `new Function(...)()`, returns the esbuild namespace. Facet sources
 * splice it in verbatim, so it is verified before it is evaluated.
 */
export function fetchEsbuildJsFnBody(env) {
    return fetchStagedText(env, ESBUILD_JS_ASSET);
}
/**
 * Fetch the `esbuild` command's runner: Go's wasm_exec.js and the typed fs
 * shim, a script that installs `globalThis.__esbuildCliRun` when the esbuild
 * facet evaluates it. Verified like the adapter it sits beside.
 */
export function fetchEsbuildCliRunner(env) {
    return fetchStagedText(env, ESBUILD_CLI_ASSET);
}
