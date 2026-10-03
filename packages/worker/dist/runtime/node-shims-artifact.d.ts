/**
 * node-shims-artifact.ts — supervisor-side fetcher for the staged sources of
 * the node-compat layer: the shims, the VFS write ledger, the resident store,
 * and the runtime-code interpreter with its host module.
 *
 * All three are staged as static assets by scripts/bundle-node-shims.mjs and
 * promoted out of the worker bundle for its size gate: only a node facet ever
 * runs them, and every node facet's generated worker text splices them. This
 * fetch therefore sits on the exec hot path: the result is memoized at module
 * scope (one fetch per isolate); each source is read and verified by
 * runtime/staged-source.ts. A missing ASSETS binding fails loud rather than
 * producing a facet with no node-compat layer.
 */
import { type StagedSourceEnv } from './staged-source.js';
/** What a node facet's generated worker text splices around the program. */
export interface NodeFacetSources {
    /** The node-compat shims: node-shims.ts generateShimsCode(). */
    shims: string;
    /** The write ledger the shims' filesystem writes go through: core VFS_WRITE_LEDGER_SOURCE. */
    ledger: string;
    /** A resident facet's SQLite-backed resident set: vfs/facet-resident-store.ts FACET_RESIDENT_STORE_SOURCE. */
    residentStore: string;
    /** The built-ins the interpreter calls, captured at the launch's start (core interpreter/primordials.ts), a module of the map. */
    interpreterPrimordials: string;
    /** The runtime-code interpreter (core interpreter/), a module of the map. */
    interpreter: string;
    /** The interpreter's host module (core interpreter/host-ops.ts HOST_OPS_SOURCE), a module of the map. */
    interpreterOps: string;
}
/**
 * The node-compat layer's sources for facet worker codegen. Memoized per
 * isolate; a failed fetch clears the memo so the next exec retries instead of
 * pinning the error.
 */
export declare const fetchNodeFacetSources: (env: StagedSourceEnv) => Promise<NodeFacetSources>;
//# sourceMappingURL=node-shims-artifact.d.ts.map