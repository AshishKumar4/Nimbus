/**
 * transform-store.ts — a session's launch transform results, kept by content
 * in its SQLite database.
 *
 * A launch lowers every ES module and TypeScript source in its closure to
 * CommonJS (core runtime/bundle-cell-transform.ts). For pi that is 11.5 MB of
 * source and 11-15 s of esbuild CPU, and it was kept only in the isolate's
 * heap, so every reset, eviction and re-drive paid it again: session
 * zealous-pangolin-6268 was torn down five times in 4.4 h and redid the whole
 * transform after each one. Here a result outlives the isolate, and a
 * re-driven or repeated launch reads it back instead.
 *
 * Addressing. A result is stored under the sha256 of everything its output is
 * a function of: the pipeline's code (TRANSFORM_PIPELINE_ID, which core's
 * build pins from the bundled closure of bundle-cell-transform.ts and
 * EsbuildService and ships with that code), the transform host's code (the
 * store is bound to one host — for the session, its esbuild facet, whose id
 * carries the esbuild version, the facet body and the staged CLI runner),
 * what is transformed (a module cell or an entry script), where it is staged
 * (its path or URL: the loader, format, TypeScript-ness and import.meta all
 * follow from it), and the source. The old in-heap key was a 32-bit hash of
 * the source and its URL, and two sources that shared it got each other's
 * code.
 *
 * What is kept. Only transforms that succeeded: a host can report a crash as
 * a rejection, and a stored diagnostic shim would outlive the crash.
 *
 * Why its own tables. The facet image store (fabric image-store.ts) is
 * addressed by its OUTPUT, and is swept of every image no running process
 * boots from — after a reset, all of them — which is exactly the case this
 * store exists for. The VFS's content store would hold the bytes, but only as
 * files: hundreds of kernel files in the namespace every resident process
 * lists and stores a row for, each write advancing the revision clock that
 * live processes and the prefetch cache key on.
 *
 * Layout. `nimbus_transform_results` has a row per result. A result of at
 * most MAX_TX_BLOB_BYTES is in its row, written in one statement. A larger
 * one is in `nimbus_transform_result_parts`, in parts of MAX_TX_BLOB_BYTES
 * under an id of the write that made them, and its row names that write: the
 * parts go down first, one statement each and paced by the caller between
 * them — the platform resets an object over what one turn has outstanding in
 * storage — and the row last. A reader believes a row only when its parts add
 * up to it. A write that fails deletes its own parts; one cut short by a
 * reset leaves parts no row names, which the store's first use in the next
 * isolate deletes. `nimbus_transform_store` holds the charge and the
 * generation (key schema, pipeline, host) the rows were written under: a
 * store of another generation — a deploy that changed any of them — drops
 * them all when it opens, rather than let them hold the bound.
 *
 * Bound and admission. At most TRANSFORM_STORE_MAX_BYTES of charge (a
 * result's bytes plus LEDGER_ROW_BYTES per row it occupies); the least
 * recently used leave first. Recency is kept to the hour, so a warm launch
 * does not rewrite a row per hit. Every write is admitted through the
 * session's storage ledger first. A write the ledger or SQLite refuses for
 * space is not kept, and counted (the launch's stats, GET /api/_diag/cache);
 * any other storage failure throws.
 */
import type { BundleCellResultStore, StoredBundleCell } from '@nimbus-sh/core/runtime/bundle-cell-transform.js';
import type { SqlDatabase, SqlTransactions } from '@nimbus-sh/core/runtime/os-contracts.js';
/** The session storage ledger's admission, as the store uses it (core StorageLedger). */
export interface TransformStoreLedger {
    admit(bytes: number): void;
    reserve(id: string, bytes: number): void;
    draw(id: string, bytes: number): number;
    release(id: string): void;
}
/** What the store holds, for diagnostics. */
export interface TransformStoreStats {
    entries: number;
    /** UTF-8 bytes of the results. */
    bytes: number;
    /** What the bound is charged: the bytes plus a ledger row per row. */
    charge: number;
    limit: number;
    /** Writes refused for space in this isolate, and the first refusal's reason. */
    storeErrors: number;
    storeError: string | null;
}
/** What the store holds, read without a store bound to any host. */
export declare function transformStoreStats(sql: SqlDatabase, transactions: SqlTransactions): TransformStoreStats;
export interface TransformStoreOptions {
    /** The pipeline's code identity. Defaults to the one core shipped with. */
    pipeline?: string;
    /** Charge the store may hold. */
    maxBytes?: number;
    /** Largest result kept. */
    maxEntryBytes?: number;
}
export declare class TransformStore implements BundleCellResultStore {
    private readonly sql;
    private readonly transactions;
    private readonly ledger;
    private readonly host;
    private readonly pipeline;
    private readonly maxBytes;
    private readonly maxEntryBytes;
    private readonly generation;
    private opened;
    /**
     * @param host The identity of the transform host whose results this store
     *   holds: EsbuildService.transformHostId, for the session its esbuild
     *   facet's ESBUILD_FACET_WORKER_ID.
     * @param ledger The session's storage ledger, which admits every write.
     */
    constructor(sql: SqlDatabase, transactions: SqlTransactions, ledger: TransformStoreLedger, host: string, options?: TransformStoreOptions);
    key(kind: 'cell' | 'entry', at: string, source: string): Promise<string>;
    getMany(keys: readonly string[]): Map<string, StoredBundleCell>;
    /** The result a row holds, or null when its parts do not add up to it. */
    private readCode;
    put(key: string, result: StoredBundleCell, spend?: (bytes: number) => Promise<void>): Promise<string | null>;
    private holds;
    /**
     * Run `write`, answering null. A refusal for space is counted and answered
     * with its reason; every other failure — a malformed statement, a schema
     * this code does not know — is thrown, so a store that cannot work is never
     * mistaken for one that has nothing.
     */
    private refusable;
    /**
     * The row, with the charge, in one transaction; then the bound is restored.
     * False when another write of the same result got there first, which
     * leaves this write's parts to its caller.
     */
    private commit;
    /** Remove one result: its row, its parts and its charge, together. */
    private forget;
    /**
     * The schema; the rows of another generation, dropped; and once per
     * isolate, before any write of this isolate can have parts in flight, the
     * parts no row names (a write a reset cut short), with the charge recounted.
     * Null when the store is open; the reason when storage refused it for space.
     */
    private open;
    /** Every result of another generation, a bounded batch of rows per transaction. */
    private dropAll;
}
//# sourceMappingURL=transform-store.d.ts.map