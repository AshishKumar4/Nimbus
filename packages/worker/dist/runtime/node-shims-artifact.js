/**
 * node-shims-artifact.ts — supervisor-side fetcher for the staged sources of
 * the node-compat layer: the shims, the VFS write ledger and the resident store.
 *
 * All three are staged as static assets by scripts/bundle-node-shims.mjs and
 * promoted out of the worker bundle for its size gate: only a node facet ever
 * runs them, and every node facet's generated worker text splices them. This
 * fetch therefore sits on the exec hot path: the result is memoized at module
 * scope (one fetch per isolate), fronted by L2 (caches.default) keyed on each
 * source's content-hash build id, with ASSETS as the source of truth and a
 * sha-256 integrity check so a stale or partial asset can never reach a facet.
 *
 * Mirrors opencode-artifact.ts / sqlite-wasm-bytes.ts. ASSETS is already a
 * mandatory embed binding (it serves the shell, sqlite wasm, opencode
 * artifacts); a missing binding fails loud here rather than producing a
 * facet with no node-compat layer.
 */
import { NODE_SHIMS_BUILD_ID, NODE_SHIMS_ENTRY, NODE_SHIMS_SHA256, RESIDENT_STORE_BUILD_ID, RESIDENT_STORE_ENTRY, RESIDENT_STORE_SHA256, VFS_WRITE_LEDGER_BUILD_ID, VFS_WRITE_LEDGER_ENTRY, VFS_WRITE_LEDGER_SHA256, } from '../node-shims-artifact.generated.js';
import { disposeRpcResource } from '@nimbus-sh/platform/rpc-dispose.js';
import { sha256Hex } from '@nimbus-sh/core/_shared/crypto.js';
const NODE_SHIMS = {
    label: 'node-shims',
    entry: NODE_SHIMS_ENTRY,
    buildId: NODE_SHIMS_BUILD_ID,
    sha256: NODE_SHIMS_SHA256,
};
const VFS_WRITE_LEDGER = {
    label: 'vfs-write-ledger',
    entry: VFS_WRITE_LEDGER_ENTRY,
    buildId: VFS_WRITE_LEDGER_BUILD_ID,
    sha256: VFS_WRITE_LEDGER_SHA256,
};
const RESIDENT_STORE = {
    label: 'resident-store',
    entry: RESIDENT_STORE_ENTRY,
    buildId: RESIDENT_STORE_BUILD_ID,
    sha256: RESIDENT_STORE_SHA256,
};
let memo = null;
/** The colo cache, where the runtime has one: workerd does, a test harness may not. */
function l2Cache() {
    return typeof caches === 'undefined' ? undefined : caches.default;
}
async function fetchAndVerify(env, source) {
    if (!env.ASSETS) {
        throw new Error('Nimbus: the node runtime requires an env.ASSETS binding (serves the ' +
            'staged node-compat source at ' + source.entry + ') — add the assets ' +
            'binding from the embed config (see packages/worker README)');
    }
    const l2Key = `https://nimbus-cache.invalid${source.entry}?build=${source.buildId}`;
    const cache = l2Cache();
    let text = null;
    try {
        if (cache) {
            const hit = await cache.match(new Request(l2Key));
            if (hit && hit.ok)
                text = await hit.text();
        }
    }
    catch { /* fall through to ASSETS */ }
    if (text === null) {
        const res = await env.ASSETS.fetch(new Request(`https://nimbus-internal.invalid${source.entry}`));
        try {
            if (!res.ok) {
                throw new Error(`${source.label} asset fetch failed: ${res.status} ${res.statusText} for ` +
                    `${source.entry} — deploy is missing the staged source ` +
                    `(run scripts/bundle-node-shims.mjs)`);
            }
            text = await res.text();
        }
        finally {
            disposeRpcResource(res);
        }
        try {
            if (cache) {
                await cache.put(new Request(l2Key), new Response(text, {
                    headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
                }));
            }
        }
        catch { /* silent */ }
    }
    const digest = await sha256Hex(text);
    if (digest !== source.sha256) {
        throw new Error(`${source.label} asset integrity mismatch for ${source.entry}: ` +
            `expected ${source.sha256.slice(0, 16)}…, got ${digest.slice(0, 16)}… — ` +
            'the staged asset is stale; rerun scripts/bundle-node-shims.mjs and redeploy');
    }
    return text;
}
/**
 * The node-compat layer's sources for facet worker codegen. Memoized per
 * isolate; a failed fetch clears the memo so the next exec retries instead of
 * pinning the error.
 */
export function fetchNodeFacetSources(env) {
    if (!memo) {
        memo = Promise.all([
            fetchAndVerify(env, NODE_SHIMS),
            fetchAndVerify(env, VFS_WRITE_LEDGER),
            fetchAndVerify(env, RESIDENT_STORE),
        ]).then(([shims, ledger, residentStore]) => ({ shims, ledger, residentStore }))
            .catch((e) => {
            memo = null;
            throw e;
        });
    }
    return memo;
}
