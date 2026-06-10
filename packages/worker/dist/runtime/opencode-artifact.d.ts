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
 * residency.
 *
 * Next boundary for real bash-tool execution: wiring opencode's tree-sitter
 * wasm into the facet module map (the facet's emscripten `instantiateWasm`
 * hook) the way sql.js is wired today. Until then only sql.js rides in, and
 * the proven matrix is --version/--help/run-to-model-resolution.
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
//# sourceMappingURL=opencode-artifact.d.ts.map