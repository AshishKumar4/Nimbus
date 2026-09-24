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
 * L2 is written only with bytes that passed that check, and an entry that
 * fails it is dropped and read from ASSETS again: an immutable entry is served
 * to every later fetch in the colo for the build.
 *
 * Mirrors opencode-artifact.ts / sqlite-wasm-bytes.ts. ASSETS is already a
 * mandatory embed binding (it serves the shell, sqlite wasm, opencode
 * artifacts); a missing binding fails loud here rather than producing a
 * facet with no node-compat layer.
 */
/** Minimal env shape — any env with an ASSETS Fetcher binding. */
export interface NodeShimsAssetEnv {
    ASSETS?: {
        fetch(req: Request): Promise<Response>;
    };
}
/** What a node facet's generated worker text splices around the program. */
export interface NodeFacetSources {
    /** The node-compat shims: node-shims.ts generateShimsCode(). */
    shims: string;
    /** The write ledger the shims' filesystem writes go through: core VFS_WRITE_LEDGER_SOURCE. */
    ledger: string;
    /** A resident facet's SQLite-backed resident set: vfs/facet-resident-store.ts FACET_RESIDENT_STORE_SOURCE. */
    residentStore: string;
}
/**
 * The node-compat layer's sources for facet worker codegen. Memoized per
 * isolate; a failed fetch clears the memo so the next exec retries instead of
 * pinning the error.
 */
export declare function fetchNodeFacetSources(env: NodeShimsAssetEnv): Promise<NodeFacetSources>;
//# sourceMappingURL=node-shims-artifact.d.ts.map