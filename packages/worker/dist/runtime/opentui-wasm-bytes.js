/**
 * opentui-wasm-bytes.ts — supervisor-side fetcher for the staged OpenTUI
 * wasm32-wasi reactor artifact backing the in-facet FFI render backend.
 *
 * The bytes live in the static-assets layer (env.ASSETS) at the path the
 * generated constants pin (OPENTUI_WASM_ENTRY). The caller (FacetManager)
 * feeds them into the Worker Loader module map as a `wasm` module so workerd
 * compiles them into a WebAssembly.Module ahead of facet dispatch; the opencode
 * facet runner instantiates that pre-compiled module via OpenTUIWasmBackend —
 * request-time WebAssembly.compile(bytes) is blocked inside facets.
 *
 * Mirrors sqlite-wasm-bytes.ts: NO module-scope cache (no supervisor
 * residency), an L2 colo cache via caches.default keyed by the build-id-pinned
 * asset URL, ASSETS as the source of truth. The fetched bytes are integrity-
 * checked against OPENTUI_WASM_SHA256 so a stale/corrupt asset never reaches
 * the backend.
 */
import { OPENTUI_WASM_BUILD_ID, OPENTUI_WASM_ENTRY, OPENTUI_WASM_SHA256, } from '../opentui-wasm-artifact.generated.js';
import { disposeRpcResource } from '../_shared/rpc-dispose.js';
/**
 * Synthetic L2 cache key for the OpenTUI wasm asset. Build-id-pinned so a
 * same-version rebuild with different bytes lands a fresh entry instead of
 * serving stale content from a warm colo cache.
 */
const OPENTUI_WASM_L2_KEY = `https://nimbus-cache.invalid${OPENTUI_WASM_ENTRY}?build=${OPENTUI_WASM_BUILD_ID}`;
async function sha256Hex(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const view = new Uint8Array(digest);
    let hex = '';
    for (let i = 0; i < view.length; i++)
        hex += view[i].toString(16).padStart(2, '0');
    return hex;
}
/**
 * Fetch the staged OpenTUI wasm bytes and verify their SHA-256 against the
 * generated digest.
 *
 * L2 (caches.default) fast path; ASSETS on miss with write-back. Cache
 * failures are silent — ASSETS is always the source of truth. A non-200 from
 * ASSETS, or a digest mismatch, throws.
 */
export async function fetchOpenTUIWasmBytes(env) {
    const caches = globalThis.caches;
    let bytes = null;
    try {
        if (caches?.default) {
            const hit = await caches.default.match(new Request(OPENTUI_WASM_L2_KEY));
            if (hit && hit.ok)
                bytes = await hit.arrayBuffer();
        }
    }
    catch { /* fall through to ASSETS */ }
    let fromCache = bytes !== null;
    if (!bytes) {
        const url = `https://nimbus-internal.invalid${OPENTUI_WASM_ENTRY}`;
        const res = await env.ASSETS.fetch(new Request(url));
        try {
            if (!res.ok) {
                throw new Error(`OpenTUI wasm asset fetch failed: ${res.status} ${res.statusText} for ` +
                    `${OPENTUI_WASM_ENTRY} — deploy is missing the staged opentui artifact`);
            }
            bytes = await res.arrayBuffer();
        }
        finally {
            disposeRpcResource(res);
        }
    }
    const digest = await sha256Hex(bytes);
    if (digest !== OPENTUI_WASM_SHA256) {
        throw new Error(`OpenTUI wasm integrity check failed: expected ${OPENTUI_WASM_SHA256}, got ` +
            `${digest} (${fromCache ? 'L2 cache' : 'ASSETS'}) — the staged artifact is ` +
            `corrupt or out of sync with opentui-wasm-artifact.generated.ts`);
    }
    if (!fromCache) {
        try {
            if (caches?.default) {
                const writeBack = new Response(new Uint8Array(bytes), {
                    headers: {
                        'Content-Type': 'application/wasm',
                        'Cache-Control': 'public, max-age=31536000, immutable',
                    },
                });
                await caches.default.put(new Request(OPENTUI_WASM_L2_KEY), writeBack);
            }
        }
        catch { /* silent */ }
    }
    return bytes;
}
