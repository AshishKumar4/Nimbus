/**
 * opencode-artifact.ts — supervisor-side fetcher for the staged opencode
 * CLI bundle and its tree-sitter wasm sidecars.
 *
 * `npm install opencode-ai` resolves (via PACKAGE_ABI_POLICY.stagedArtifacts)
 * to the prebuilt JS bundle staged by scripts/bundle-opencode.mjs at
 * public/_assets/opencode/<version>/. This module fetches:
 *
 *   - the CLI bundle text (index.js) — installed as the package's `opencode`
 *     bin, executed by the node runtime;
 *   - a named tree-sitter wasm sidecar as ArrayBuffer — handed to the facet
 *     Worker Loader module map so opencode's bash-tool parser instantiates it
 *     via the emscripten `instantiateWasm` hook (request-time
 *     WebAssembly.compile is blocked inside facets).
 *
 * Mirrors sqlite-wasm-bytes.ts: ASSETS is the source of truth; L2
 * (caches.default) keyed on a version-pinned synthetic URL; no module-scope
 * residency.
 */
/** Base asset path of the staged opencode bundle directory. */
export declare const OPENCODE_ASSET_BASE: string;
/** Minimal env shape — any env with an ASSETS Fetcher binding. */
export interface OpencodeAssetEnv {
    ASSETS: {
        fetch(req: Request): Promise<Response>;
    };
}
/** Fetch the opencode CLI bundle source as text. */
export declare function fetchOpencodeBundle(env: OpencodeAssetEnv): Promise<string>;
/** Fetch a tree-sitter wasm sidecar as ArrayBuffer for the facet module map. */
export declare function fetchOpencodeWasm(env: OpencodeAssetEnv, file: string): Promise<ArrayBuffer>;
//# sourceMappingURL=opencode-artifact.d.ts.map