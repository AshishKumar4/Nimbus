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
/** Minimal env shape — any env with an ASSETS Fetcher binding. */
export interface OpencodeAssetEnv {
    ASSETS: {
        fetch(req: Request): Promise<Response>;
    };
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
export declare const OPENCODE_ATTACH_BUNDLE_FILE = "index-attach.js";
export declare function fetchOpencodeBundle(env: OpencodeAssetEnv, mode?: 'default' | 'attach'): Promise<string>;
/**
 * Fetch a staged opencode wasm sidecar (raw bytes for a `{ wasm }` module) —
 * the tree-sitter grammars and the yoga-layout engine.
 */
export declare function fetchOpencodeWasmBytes(env: OpencodeAssetEnv, file: string): Promise<ArrayBuffer>;
/**
 * Fetch a staged TUI worker bundle source as text (the API server worker.js or
 * the OpenTUI parser.worker.js). Rides into the facet module map as an ESM
 * module the in-isolate Worker polyfill imports.
 */
export declare function fetchOpencodeWorkerSource(env: OpencodeAssetEnv, file: string): Promise<string>;
/**
 * Fetch and expand the split-build chunk pack (chunks.json): one JSON asset
 * mapping every `chunk-<hash>.js` module name to its ESM source. index.js and
 * worker.js import these shared chunks; the facet module map carries each as
 * its own module.
 */
export declare function fetchOpencodeChunkSources(env: OpencodeAssetEnv, packFile: string): Promise<Record<string, string>>;
//# sourceMappingURL=opencode-artifact.d.ts.map