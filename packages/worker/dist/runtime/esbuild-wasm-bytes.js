/**
 * esbuild-wasm-bytes.ts — supervisor-side fetcher for the artifacts the
 * esbuild facet is built from: the wasm binary, the JS adapter that drives
 * it, and the runner of the `esbuild` command. All three live in the
 * static-assets layer (env.ASSETS); this module hands them to the caller when
 * needed.
 *
 * Cache strategy
 * ──────────────
 * - NO module-scope cache (would pin 16 MiB in supervisor heap; the
 *   reason this module exists, see Phase 2 A'.5 below).
 * - L2 colo cache via `caches.default` (cache-and-scrub W-D): the bytes
 *   are version-pinned by URL (`/_assets/esbuild-<ESBUILD_VERSION>.*`),
 *   so an `immutable` cache entry is correct. The Cache API holds its
 *   OWN reference outside the supervisor heap, so this does not
 *   re-introduce the residency that A'.5 removed.
 *
 * Why no module-scope cache (Phase 2 A'.5)
 * ────────────────────────────────────────
 * Pre-rebuild this module decoded a 16 MiB base64 string from
 * src/esbuild-wasm-bundle.generated.ts into an ArrayBuffer and cached
 * the result in module scope for the lifetime of the supervisor
 * isolate. The cache contributed 16 MiB to the supervisor heap, and the
 * base64 string contributed ~21 MiB to the worker bundle baseline.
 *
 * The architecturally correct path is to keep the bytes in the static-
 * assets layer (public/_assets/esbuild-<version>.wasm), fetch on
 * demand, and let workerd's loader own the only long-lived copy
 * (inside dynamic-worker isolates that need it). Cache API entries
 * are stored OUTSIDE the supervisor heap (workerd manages them), so
 * adding L2 wrap doesn't undo this.
 *
 * The JS adapter followed the wasm for the same reason at a smaller
 * scale: the supervisor already imports esbuild-wasm's browser build as a
 * module for its own transforms, so carrying the same 117 KiB again as a
 * string literal for facets doubled it in the Worker bundle. The CLI runner
 * (32 KiB of Go glue and fs shim) only ever runs in the facet, so it is
 * staged too; its name carries a prefix of its digest, because unlike the
 * other two it changes without an esbuild upgrade.
 *
 * Each call to `fetchEsbuildWasmBytes(env)` now does:
 *   - one `caches.default.match()` — sub-millisecond on hit
 *   - on miss: one env.ASSETS.fetch() + one cache write-back
 *   - one Response.arrayBuffer() — 12 MiB ArrayBuffer in supervisor
 *     heap, briefly, then GC'd
 *
 * Failure model
 * ─────────────
 * Cache lookup failure (any throw) → fall through to ASSETS.
 * ASSETS fetch returning non-200 → throw (deploy bug, surface loudly).
 * Digest mismatch on either tier → throw (the bytes are compiled as a wasm
 * module or evaluated as facet code, so they are verified against the
 * digest the generator recorded before returning).
 */
import { ESBUILD_JS_ASSET_PATH, ESBUILD_JS_SHA256, ESBUILD_WASM_ASSET_PATH, ESBUILD_WASM_SHA256, } from '../esbuild-wasm-bundle.generated.js';
import { ESBUILD_CLI_ASSET_PATH, ESBUILD_CLI_SHA256 } from '../esbuild-cli-artifact.generated.js';
import { disposeRpcResource } from '@nimbus-sh/platform/rpc-dispose.js';
import { sha256Hex } from '@nimbus-sh/core/_shared/crypto.js';
/**
 * Synthetic L2 cache keys for the esbuild-wasm assets, staged at
 * public/_assets/esbuild-<version>.{wasm,js} by scripts/bundle-esbuild-wasm.mjs
 * at predeploy time. Versioned via the asset paths so each esbuild upgrade
 * lands fresh entries and old ones naturally evict on TTL.
 *
 * Exported so the test endpoint at /api/_test/cache/wasm/reset can
 * purge the entries between probe runs (otherwise wrangler dev's
 * persistent caches.default.state preserves the L2 hit across sessions
 * and the cold path is unobservable).
 */
export const ESBUILD_WASM_L2_KEY = `https://nimbus-cache.invalid${ESBUILD_WASM_ASSET_PATH}`;
export const ESBUILD_JS_L2_KEY = `https://nimbus-cache.invalid${ESBUILD_JS_ASSET_PATH}`;
/** The CLI runner's key names its build id, so each rebuild lands a fresh entry. */
export const ESBUILD_CLI_L2_KEY = `https://nimbus-cache.invalid${ESBUILD_CLI_ASSET_PATH}`;
const ESBUILD_WASM_ASSET = {
    label: 'esbuild-wasm',
    path: ESBUILD_WASM_ASSET_PATH,
    l2Key: ESBUILD_WASM_L2_KEY,
    sha256: ESBUILD_WASM_SHA256,
    contentType: 'application/wasm',
    stagedBy: 'scripts/bundle-esbuild-wasm.mjs',
};
const ESBUILD_JS_ASSET = {
    label: 'esbuild-wasm JS adapter',
    path: ESBUILD_JS_ASSET_PATH,
    l2Key: ESBUILD_JS_L2_KEY,
    sha256: ESBUILD_JS_SHA256,
    contentType: 'text/javascript; charset=utf-8',
    stagedBy: 'scripts/bundle-esbuild-wasm.mjs',
};
const ESBUILD_CLI_ASSET = {
    label: 'esbuild CLI runner',
    path: ESBUILD_CLI_ASSET_PATH,
    l2Key: ESBUILD_CLI_L2_KEY,
    sha256: ESBUILD_CLI_SHA256,
    contentType: 'text/javascript; charset=utf-8',
    stagedBy: 'scripts/bundle-facet-workers.mjs',
};
/**
 * Fetch the esbuild-wasm bytes from the static-assets layer.
 *
 * The supervisor briefly holds the 12 MiB ArrayBuffer between this
 * call and the caller's hand-off to workerd's LOADER. After the
 * caller's reference goes out of scope, GC reclaims it; supervisor
 * residency drops back to zero.
 *
 * L2 (cache-and-scrub W-D): on hit, returns the bytes from
 * `caches.default` (per-colo, sub-millisecond). On miss, falls through
 * to env.ASSETS and write-back. Cache failures are silent — ASSETS is
 * always the correct source of truth.
 */
export function fetchEsbuildWasmBytes(env) {
    return fetchVerifiedAsset(env, ESBUILD_WASM_ASSET);
}
/**
 * Fetch the esbuild-wasm JS adapter: the function body that, wrapped in
 * `new Function(...)()`, returns the esbuild namespace. Facet sources
 * splice it in verbatim, so it is verified like the wasm it drives.
 */
export async function fetchEsbuildJsFnBody(env) {
    return new TextDecoder().decode(await fetchVerifiedAsset(env, ESBUILD_JS_ASSET));
}
/**
 * Fetch the `esbuild` command's runner: Go's wasm_exec.js and the typed fs
 * shim, a script that installs `globalThis.__esbuildCliRun` when the esbuild
 * facet evaluates it. Verified like the adapter it sits beside.
 */
export async function fetchEsbuildCliRunner(env) {
    return new TextDecoder().decode(await fetchVerifiedAsset(env, ESBUILD_CLI_ASSET));
}
async function fetchVerifiedAsset(env, asset) {
    const caches = globalThis.caches;
    // ── L2 fast path ────────────────────────────────────────────────
    let ab = null;
    try {
        if (caches?.default) {
            const hit = await caches.default.match(new Request(asset.l2Key));
            if (hit && hit.ok)
                ab = await hit.arrayBuffer();
        }
    }
    catch { /* fall through to ASSETS */ }
    const fromCache = ab !== null;
    if (!ab) {
        // ── L4 path (env.ASSETS) ──────────────────────────────────────
        // Construct a synthetic request — env.ASSETS routes by pathname only;
        // the host is ignored. Using `.invalid` per RFC-2606 makes it
        // unambiguous that this URL is internal-binding-only.
        const url = `https://nimbus-internal.invalid${asset.path}`;
        const res = await env.ASSETS.fetch(new Request(url));
        try {
            if (!res.ok) {
                throw new Error(`${asset.label} asset fetch failed: ${res.status} ${res.statusText} ` +
                    `for ${asset.path} — deploy is missing the asset`);
            }
            // Read the bytes once (Response body is a one-shot stream). The
            // caller needs the ArrayBuffer to hand to workerd's LOADER; we
            // also use it to write through to L2.
            ab = await res.arrayBuffer();
        }
        finally {
            disposeRpcResource(res);
        }
    }
    const digest = await sha256Hex(ab);
    if (digest !== asset.sha256) {
        throw new Error(`${asset.label} integrity check failed: expected ${asset.sha256}, got ` +
            `${digest} (${fromCache ? 'L2 cache' : 'ASSETS'}) for ${asset.path} — ` +
            'the staged asset is corrupt or out of sync; rerun ' +
            `${asset.stagedBy} and redeploy`);
    }
    if (!fromCache) {
        // ── L2 write-back ────────────────────────────────────────────
        // Eternal immutable TTL: the URL is version-pinned so a new
        // ESBUILD_VERSION lands a fresh cache entry; the old one naturally
        // evicts on TTL. The cache layer holds its own copy (workerd
        // structured-clones the body during put), so the supervisor's
        // reference to `ab` is unaffected.
        // Best-effort: a write failure does NOT block the caller.
        try {
            if (caches?.default) {
                // We pass a fresh Uint8Array view over the same buffer; the
                // cache stores a copy at put time. Returning `ab` to the
                // caller stays valid because Response constructor doesn't
                // detach the buffer (only ReadableStream consumption would).
                const writeBack = new Response(new Uint8Array(ab), {
                    headers: {
                        'Content-Type': asset.contentType,
                        'Cache-Control': 'public, max-age=31536000, immutable',
                    },
                });
                // Awaited so subsequent reads strictly hit L2 (no
                // double-fetch race). The wasm payload is 12 MiB; workerd
                // structured-clones it into the cache, ~1-5 ms locally.
                await caches.default.put(new Request(asset.l2Key), writeBack);
            }
        }
        catch { /* silent */ }
    }
    return ab;
}
