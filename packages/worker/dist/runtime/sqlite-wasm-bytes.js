/**
 * sqlite-wasm-bytes.ts — supervisor-side fetcher for the sql.js wasm
 * binary backing the node:sqlite shim. The bytes live in the
 * static-assets layer (env.ASSETS); this module hands them to the caller
 * as an ArrayBuffer when a facet imports node:sqlite.
 *
 * The caller (FacetManager) feeds these bytes into the Worker Loader
 * module map as a `wasm` module so workerd compiles them into a
 * WebAssembly.Module ahead of facet dispatch. The shim then drives sql.js
 * via its `instantiateWasm` hook with that pre-compiled module —
 * request-time WebAssembly.compile(bytes) is blocked inside facets.
 *
 * NO module-scope cache (no supervisor residency). The read itself is
 * runtime/staged-source.ts: L2 keyed by the version-pinned asset URL, ASSETS
 * as the source of truth, and a sha-256 check on both tiers so a stale or
 * tampered asset never gets compiled.
 */
import { SQLJS_VERSION } from '@nimbus-sh/core/constants.js';
import { SQLITE_WASM_SHA256 } from '../sqlite-wasm-bundle.generated.js';
import { fetchStagedBytes } from './staged-source.js';
/**
 * Path inside env.ASSETS where the sql.js wasm binary lives. Versioned so
 * a future sql.js bump produces a different asset name and forces a fresh
 * fetch. Staged at public/_assets/sqljs-<version>.wasm by
 * scripts/bundle-sqlite-wasm.mjs at predeploy time.
 */
export const SQLITE_WASM_ASSET_PATH = `/_assets/sqljs-${SQLJS_VERSION}.wasm`;
/**
 * Synthetic L2 cache key for the sql.js wasm asset. Version-pinned so each
 * sql.js upgrade lands a fresh entry and old entries evict on TTL.
 */
export const SQLITE_WASM_L2_KEY = `https://nimbus-cache.invalid/_assets/sqljs-${SQLJS_VERSION}.wasm`;
/**
 * Fetch the sql.js wasm bytes from the static-assets layer.
 *
 * L2 (caches.default) fast path; ASSETS on miss with write-back. Cache
 * failures are silent — ASSETS is always the source of truth. A non-200
 * from ASSETS, or a digest mismatch on either tier, throws.
 */
export function fetchSqliteWasmBytes(env) {
    return fetchStagedBytes(env, SQLITE_WASM_ASSET);
}
const SQLITE_WASM_ASSET = {
    path: SQLITE_WASM_ASSET_PATH,
    l2Key: SQLITE_WASM_L2_KEY,
    sha256: SQLITE_WASM_SHA256,
    contentType: 'application/wasm',
    poisonedCache: 'reject',
    missingBinding: `Nimbus: node:sqlite requires an env.ASSETS binding (serves ${SQLITE_WASM_ASSET_PATH})`,
    fetchFailed: (res) => `sql.js wasm asset fetch failed: ${res.status} ${res.statusText} ` +
        `for ${SQLITE_WASM_ASSET_PATH} — deploy is missing the wasm asset`,
    integrityFailed: (digest, from) => `sql.js wasm integrity check failed: expected ${SQLITE_WASM_SHA256}, got ` +
        `${digest} (${from}) for ${SQLITE_WASM_ASSET_PATH} — ` +
        'the staged asset is corrupt or out of sync; rerun ' +
        'scripts/bundle-sqlite-wasm.mjs and redeploy',
};
