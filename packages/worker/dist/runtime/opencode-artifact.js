/**
 * opencode-artifact.ts — supervisor-side fetcher for the staged opencode
 * CLI bundle.
 *
 * `npm install opencode-ai` resolves (via PACKAGE_ABI_POLICY.stagedArtifacts)
 * to the prebuilt JS bundle staged by scripts/bundle-opencode.mjs at
 * public/_assets/opencode/<version>/. This module fetches the CLI bundle text
 * (index.js) — installed as the package's `opencode` bin, executed by the node
 * runtime.
 *
 * Mirrors sqlite-wasm-bytes.ts: ASSETS is the source of truth; L2
 * (caches.default) keyed on a version-pinned synthetic URL; no module-scope
 * residency. Every file is verified against its pinned SHA-256 on BOTH tiers —
 * these bytes are compiled as wasm modules or evaluated as facet ESM, so a
 * poisoned colo-cache entry would otherwise be executed unchecked.
 *
 * Besides the CLI bundle this also fetches the tree-sitter wasm sidecars
 * (core + bash + powershell grammars) that ride into the facet module map as
 * pre-compiled WebAssembly.Modules for opencode's bash-tool command parser
 * (see OPENCODE_TREE_SITTER_WASMS and FacetManager.treeSitterModuleEntries).
 */
import { OPENCODE_ARTIFACT_BUILD_ID, OPENCODE_ARTIFACT_DIGESTS, OPENCODE_ARTIFACT_PRESENT, OPENCODE_ARTIFACT_VERSION, } from '../opencode-artifact.generated.js';
import { disposeRpcResource } from '@nimbus-sh/platform/rpc-dispose.js';
import { sha256Hex } from '@nimbus-sh/core/_shared/crypto.js';
/** Base asset path of the staged opencode bundle directory. */
const OPENCODE_ASSET_BASE = `/_assets/opencode/${OPENCODE_ARTIFACT_VERSION}`;
// The build id (content hash of the staged dist) is part of the L2 key so a
// same-version rebuild with different bytes never serves stale content from a
// warm colo cache.
function l2Key(file) {
    return `https://nimbus-cache.invalid${OPENCODE_ASSET_BASE}/${OPENCODE_ARTIFACT_BUILD_ID}/${file}`;
}
function assetUrl(file) {
    return `https://nimbus-internal.invalid${OPENCODE_ASSET_BASE}/${file}`;
}
/**
 * The pinned digest for a staged file. Unstaged builds carry an empty map, so
 * the two conditions are reported apart: "this build has no artifact at all"
 * (the documented OPENCODE_ARTIFACT_PRESENT=false case) versus "the artifact
 * is staged but this file is not part of it".
 */
function pinnedDigest(file) {
    if (!OPENCODE_ARTIFACT_PRESENT) {
        throw new Error(`opencode artifact is not staged in this build — cannot serve ` +
            `${OPENCODE_ASSET_BASE}/${file}; rerun scripts/bundle-opencode.mjs with the ` +
            'opencode dist present');
    }
    if (!Object.prototype.hasOwnProperty.call(OPENCODE_ARTIFACT_DIGESTS, file)) {
        throw new Error(`opencode asset ${file} has no pinned digest — it is not part of the staged ` +
            `artifact ${OPENCODE_ARTIFACT_VERSION} (${OPENCODE_ARTIFACT_BUILD_ID}); rerun ` +
            'scripts/bundle-opencode.mjs');
    }
    return OPENCODE_ARTIFACT_DIGESTS[file];
}
async function fetchAsset(env, file) {
    const expected = pinnedDigest(file);
    const caches = globalThis.caches;
    let ab = null;
    try {
        if (caches?.default) {
            const hit = await caches.default.match(new Request(l2Key(file)));
            if (hit && hit.ok)
                ab = await hit.arrayBuffer();
        }
    }
    catch { /* fall through to ASSETS */ }
    const fromCache = ab !== null;
    if (!ab) {
        const res = await env.ASSETS.fetch(new Request(assetUrl(file)));
        try {
            if (!res.ok) {
                throw new Error(`opencode asset fetch failed: ${res.status} ${res.statusText} for ` +
                    `${OPENCODE_ASSET_BASE}/${file} — deploy is missing the staged opencode artifact`);
            }
            ab = await res.arrayBuffer();
        }
        finally {
            disposeRpcResource(res);
        }
    }
    const digest = await sha256Hex(ab);
    if (digest !== expected) {
        throw new Error(`opencode asset integrity check failed for ${OPENCODE_ASSET_BASE}/${file}: expected ` +
            `${expected}, got ${digest} (${fromCache ? 'L2 cache' : 'ASSETS'}) — the staged ` +
            'artifact is corrupt or out of sync; rerun scripts/bundle-opencode.mjs and redeploy');
    }
    if (!fromCache) {
        try {
            if (caches?.default) {
                const writeBack = new Response(new Uint8Array(ab), {
                    headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
                });
                await caches.default.put(new Request(l2Key(file)), writeBack);
            }
        }
        catch { /* silent */ }
    }
    return ab;
}
/** Fetch the opencode CLI bundle source as text. */
/**
 * The attach-mode entry variant: index.js rebuilt with the interactive-mode
 * chunk graph inlined STATICALLY. The TUI command's lazy
 * `import("./chunk-…")` of that graph triggers a prod-only workerd
 * process-wide kill (defect #20, dossier F13/F14); the attach facet therefore
 * boots an entry with that graph pre-linked in the boot pass — the one shape
 * never observed to kill. Serve/oneshot keep the original chunked entry (their
 * runtime chunk imports are boot-proven and the smaller static compile keeps
 * each mode inside the facet memory budget).
 */
export const OPENCODE_ATTACH_BUNDLE_FILE = 'index-attach.js';
export async function fetchOpencodeBundle(env, mode = 'default') {
    const ab = await fetchAsset(env, mode === 'attach' ? OPENCODE_ATTACH_BUNDLE_FILE : 'index.js');
    return new TextDecoder().decode(ab);
}
/**
 * Fetch a staged opencode wasm sidecar (raw bytes for a `{ wasm }` module) —
 * the tree-sitter grammars and the yoga-layout engine.
 */
export async function fetchOpencodeWasmBytes(env, file) {
    return fetchAsset(env, file);
}
/**
 * Fetch a staged TUI worker bundle source as text (the API server worker.js or
 * the OpenTUI parser.worker.js). Rides into the facet module map as an ESM
 * module the in-isolate Worker polyfill imports.
 */
export async function fetchOpencodeWorkerSource(env, file) {
    const ab = await fetchAsset(env, file);
    return new TextDecoder().decode(ab);
}
/**
 * Fetch and expand the split-build chunk pack (chunks.json): one JSON asset
 * mapping every `chunk-<hash>.js` module name to its ESM source. index.js and
 * worker.js import these shared chunks; the facet module map carries each as
 * its own module.
 */
export async function fetchOpencodeChunkSources(env, packFile) {
    const ab = await fetchAsset(env, packFile);
    const parsed = JSON.parse(new TextDecoder().decode(ab));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`opencode chunk pack ${packFile} is not a name→source object`);
    }
    for (const [name, source] of Object.entries(parsed)) {
        if (typeof source !== 'string') {
            throw new Error(`opencode chunk pack ${packFile} entry ${name} is not a source string`);
        }
    }
    return parsed;
}
