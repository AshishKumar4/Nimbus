/**
 * esbuild-wasm-bytes.ts — supervisor-side fetcher for the staged artifacts
 * the esbuild facet is built from: esbuild's wasm, the JS adapter that
 * drives it, and the runner of the `esbuild` command. All three live in the
 * static-assets layer (env.ASSETS) and are fetched only when the facet is
 * loaded: for the `esbuild` command, a module too deep for Oxc's stack, or
 * a build whose rolldown binding died.
 *
 * The wasm was the host Worker's own module (core's EsbuildService imported
 * `esbuild-wasm/esbuild.wasm`), which workerd compiled at startup in every
 * isolate of the Worker, building or not: 11.4 MiB of every Durable
 * Object's code. Staged, it is compiled only by the facet's own module map.
 * The adapter is staged as text for the facet to splice into its source;
 * the CLI runner (32 KiB of Go glue and fs shim) likewise, its name
 * carrying a prefix of its digest, because unlike the adapter it changes
 * without an esbuild upgrade.
 *
 * Cache strategy
 * ──────────────
 * - NO module-scope cache: a facet's loader cache holds the only long-lived
 *   copy, and the supervisor drops its own once the loader has the code.
 * - L2 colo cache via `caches.default`: the paths are version-pinned
 *   (`/_assets/esbuild-<ESBUILD_VERSION>.{js,wasm}`, the runner by build id),
 *   so an `immutable` cache entry is correct.
 *
 * Failure model
 * ─────────────
 * Cache lookup failure (any throw) → fall through to ASSETS.
 * ASSETS fetch returning non-200 → throw (deploy bug, surface loudly).
 * Digest mismatch on either tier → throw (each is facet code, so it is
 * verified against the digest the generator recorded before returning).
 */

import {
  ESBUILD_JS_ASSET_PATH,
  ESBUILD_JS_SHA256,
  ESBUILD_WASM_ASSET_PATH,
  ESBUILD_WASM_SHA256,
} from '../esbuild-wasm-bundle.generated.js';
import { ESBUILD_CLI_ASSET_PATH, ESBUILD_CLI_SHA256 } from '../esbuild-cli-artifact.generated.js';
import { fetchStagedBytes, fetchStagedText, type StagedAsset } from './staged-source.js';

/**
 * The minimal env shape this module needs. Defined narrowly so the
 * caller can pass any env with an ASSETS Fetcher binding without
 * dragging in the full Workers env type.
 */
export interface EsbuildWasmFetchEnv {
  ASSETS: { fetch(req: Request): Promise<Response> };
}

/**
 * Synthetic L2 cache keys for the staged esbuild artifacts. Versioned via
 * the asset paths so each esbuild upgrade lands fresh entries and old ones
 * naturally evict on TTL.
 */
export const ESBUILD_JS_L2_KEY = `https://nimbus-cache.invalid${ESBUILD_JS_ASSET_PATH}`;
export const ESBUILD_WASM_L2_KEY = `https://nimbus-cache.invalid${ESBUILD_WASM_ASSET_PATH}`;
/** The CLI runner's key names its build id, so each rebuild lands a fresh entry. */
export const ESBUILD_CLI_L2_KEY = `https://nimbus-cache.invalid${ESBUILD_CLI_ASSET_PATH}`;

/** One esbuild artifact, verified against its pin (runtime/staged-source.ts). */
function esbuildAsset(label: string, path: string, l2Key: string, sha256: string, contentType: string, stagedBy: string): StagedAsset {
  return {
    path,
    l2Key,
    sha256,
    contentType,
    poisonedCache: 'reject',
    missingBinding: `Nimbus: the esbuild facet requires an env.ASSETS binding (serves ${path})`,
    fetchFailed: (res) =>
      `${label} asset fetch failed: ${res.status} ${res.statusText} ` +
      `for ${path} — deploy is missing the asset`,
    integrityFailed: (digest, from) =>
      `${label} integrity check failed: expected ${sha256}, got ` +
      `${digest} (${from}) for ${path} — ` +
      'the staged asset is corrupt or out of sync; rerun ' +
      `${stagedBy} and redeploy`,
  };
}

const ESBUILD_JS_ASSET = esbuildAsset(
  'esbuild-wasm JS adapter', ESBUILD_JS_ASSET_PATH, ESBUILD_JS_L2_KEY, ESBUILD_JS_SHA256,
  'text/javascript; charset=utf-8', 'scripts/bundle-esbuild-wasm.mjs',
);
const ESBUILD_WASM_ASSET = esbuildAsset(
  'esbuild-wasm wasm', ESBUILD_WASM_ASSET_PATH, ESBUILD_WASM_L2_KEY, ESBUILD_WASM_SHA256,
  'application/wasm', 'scripts/bundle-esbuild-wasm.mjs',
);
const ESBUILD_CLI_ASSET = esbuildAsset(
  'esbuild CLI runner', ESBUILD_CLI_ASSET_PATH, ESBUILD_CLI_L2_KEY, ESBUILD_CLI_SHA256,
  'text/javascript; charset=utf-8', 'scripts/bundle-facet-workers.mjs',
);

/**
 * Fetch esbuild's wasm, for the facet's module map to compile. Verified
 * before it is handed over.
 */
export function fetchEsbuildWasmBytes(env: EsbuildWasmFetchEnv): Promise<ArrayBuffer> {
  return fetchStagedBytes(env, ESBUILD_WASM_ASSET);
}

/**
 * Fetch the esbuild-wasm JS adapter: the function body that, wrapped in
 * `new Function(...)()`, returns the esbuild namespace. Facet sources
 * splice it in verbatim, so it is verified before it is evaluated.
 */
export function fetchEsbuildJsFnBody(env: EsbuildWasmFetchEnv): Promise<string> {
  return fetchStagedText(env, ESBUILD_JS_ASSET);
}

/**
 * Fetch the `esbuild` command's runner: Go's wasm_exec.js and the typed fs
 * shim, a script that installs `globalThis.__esbuildCliRun` when the esbuild
 * facet evaluates it. Verified like the adapter it sits beside.
 */
export function fetchEsbuildCliRunner(env: EsbuildWasmFetchEnv): Promise<string> {
  return fetchStagedText(env, ESBUILD_CLI_ASSET);
}
