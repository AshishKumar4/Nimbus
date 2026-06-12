/**
 * node-shims-artifact.ts — supervisor-side fetcher for the staged node-compat
 * shim source.
 *
 * The ~230 KiB generateShimsCode() output is staged as a static asset by
 * scripts/bundle-node-shims.mjs (promoted out of the worker bundle for the
 * ≤6 MiB bundle gate). Every node facet's generated worker text interpolates
 * it, so this fetch sits on the exec hot path: the result is memoized at
 * module scope (one fetch per isolate), fronted by L2 (caches.default) keyed
 * on the content-hash build id, with ASSETS as the source of truth and a
 * sha-256 integrity check so a stale or partial asset can never reach a facet.
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
/**
 * The node-compat shim source for facet worker codegen. Memoized per isolate;
 * a failed fetch clears the memo so the next exec retries instead of pinning
 * the error.
 */
export declare function fetchNodeShimsCode(env: NodeShimsAssetEnv): Promise<string>;
//# sourceMappingURL=node-shims-artifact.d.ts.map