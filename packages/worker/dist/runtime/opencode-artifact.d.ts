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
 * Besides the CLI bundle this also fetches the tree-sitter wasm sidecars
 * (core + bash + powershell grammars) that ride into the facet module map as
 * pre-compiled WebAssembly.Modules for opencode's bash-tool command parser
 * (see OPENCODE_TREE_SITTER_WASMS and FacetManager.treeSitterModuleEntries).
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
/** Fetch a staged tree-sitter wasm sidecar (raw bytes for a `{ wasm }` module). */
export declare function fetchOpencodeTreeSitterWasm(env: OpencodeAssetEnv, file: string): Promise<ArrayBuffer>;
/**
 * Fetch a staged TUI worker bundle source as text (the API server worker.js or
 * the OpenTUI parser.worker.js). Rides into the facet module map as an ESM
 * module the in-isolate Worker polyfill imports.
 */
export declare function fetchOpencodeWorkerSource(env: OpencodeAssetEnv, file: string): Promise<string>;
//# sourceMappingURL=opencode-artifact.d.ts.map