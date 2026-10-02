/**
 * oxc-wasm-bytes.ts — supervisor-side fetcher for what the transform facet is
 * built from: the Oxc wasm (scripts/bundle-oxc-wasm.mjs) and the facet's
 * runtime script (scripts/bundle-facet-workers.mjs). Both are staged in the
 * static-assets layer under names carrying a prefix of their digest, read
 * through the colo cache (runtime/staged-source.ts), and verified against
 * their pins before the loader compiles or evaluates them.
 *
 * Neither is kept in module scope: they are read only when the facet's
 * loader has no worker cached under the facet's id, and that loader holds
 * the only long-lived copy, as compiled code. The host Worker never compiles
 * the wasm.
 */
import { OXC_WASM_ASSET_PATH, OXC_WASM_SHA256 } from '../oxc-wasm-artifact.generated.js';
import { OXC_FACET_ASSET_PATH, OXC_FACET_SHA256 } from '../oxc-facet-artifact.generated.js';
import { fetchStagedBytes, fetchStagedText } from './staged-source.js';
function oxcAsset(label, path, sha256, contentType, stagedBy) {
    return {
        path,
        l2Key: `https://nimbus-cache.invalid${path}`,
        sha256,
        contentType,
        poisonedCache: 'reject',
        missingBinding: `Nimbus: the transform facet requires an env.ASSETS binding (serves ${path})`,
        fetchFailed: (res) => `${label} asset fetch failed: ${res.status} ${res.statusText} for ${path} — deploy is missing the asset`,
        integrityFailed: (digest, from) => `${label} integrity check failed: expected ${sha256}, got ${digest} (${from}) for ${path} — ` +
            `the staged asset is corrupt or out of sync; rerun ${stagedBy} and redeploy`,
    };
}
const OXC_WASM_ASSET = oxcAsset('Oxc wasm', OXC_WASM_ASSET_PATH, OXC_WASM_SHA256, 'application/wasm', 'scripts/bundle-oxc-wasm.mjs');
const OXC_FACET_ASSET = oxcAsset('transform facet runtime', OXC_FACET_ASSET_PATH, OXC_FACET_SHA256, 'text/javascript; charset=utf-8', 'scripts/bundle-facet-workers.mjs');
/** The Oxc wasm's bytes, for the transform facet's module map. */
export function fetchOxcWasmBytes(env) {
    return fetchStagedBytes(env, OXC_WASM_ASSET);
}
/** The transform facet's runtime: a script that installs the globals its class reads. */
export function fetchOxcFacetRuntime(env) {
    return fetchStagedText(env, OXC_FACET_ASSET);
}
