/**
 * transform-store.ts — a session's launch transform results, kept by content
 * in its SQLite database.
 *
 * A launch lowers every ES module and TypeScript source in its closure to
 * CommonJS (core runtime/bundle-cell-transform.ts). For pi that is 25-45 s of
 * esbuild CPU, and it was kept only in the isolate's heap, so every reset,
 * eviction and re-drive paid it again: session zealous-pangolin-6268 was torn
 * down five times in 4.4 h and redid the whole transform after each one. Here
 * a result outlives the isolate, and a re-driven or repeated launch reads it
 * back instead.
 *
 * Addressing. A result is stored under the sha256 of everything its output is
 * a function of: the pipeline's code (TRANSFORM_PIPELINE_ID, pinned at build
 * from the bundled closure of bundle-cell-transform.ts and EsbuildService),
 * the transform host's code (the store is bound to one host — for the session,
 * its esbuild facet, whose id carries the esbuild version, the facet body and
 * the staged CLI runner), what is transformed (a module cell or an entry
 * script), where it is staged (its path or URL: the loader, format,
 * TypeScript-ness and import.meta all follow from it), and the source. A different deploy or
 * esbuild addresses different rows; nothing is ever served across them. The
 * old in-heap key was a 32-bit hash of the source and its length, and two
 * sources that shared it got each other's code.
 *
 * Why its own tables. The facet image store (fabric image-store.ts) is
 * addressed by its OUTPUT, and is swept of every image no running process
 * boots from — after a reset, all of them — which is exactly the case this
 * store exists for. The VFS's content store would hold the bytes, but only as
 * files: hundreds of kernel files in the namespace every resident process
 * lists and stores a row for, each write advancing the revision clock that
 * live processes and the prefetch cache key on. So results live in
 * `nimbus_transforms` (one row per result: its flags, size, part count and
 * recency) and `nimbus_transform_parts` (its UTF-8 bytes in parts of at most
 * MAX_TX_BLOB_BYTES, each far under SQLite's 2 MB row bound), with the
 * store's charge and recency clock in `nimbus_transform_state`. The ledger
 * counts them with the rest of the session's database, and `stats()` reports
 * them (GET /api/_diag/cache).
 *
 * Bound and eviction. At most TRANSFORM_STORE_MAX_BYTES of charge (a
 * result's bytes plus LEDGER_ROW_BYTES per row it occupies); the least
 * recently used results leave first, as soon as a write takes the store past
 * it. A result over TRANSFORM_STORE_MAX_ENTRY_BYTES is not kept.
 *
 * Writes. A result's parts go down first, one statement each and paced by the
 * caller between them — the platform resets an object over what one turn has
 * outstanding in storage — and its row last, in one transaction with the
 * charge. A reader believes a row only when its parts add up to it, so a write
 * cut short leaves parts no row names and never a wrong result; the store's
 * first use in each isolate deletes such parts, before this isolate can have a
 * write of its own in flight. A write that fails leaves the result unkept and
 * the launch unharmed.
 */
import type { BundleCellResult, BundleCellResultStore } from '@nimbus-sh/core/runtime/bundle-cell-transform.js';
import type { SqlDatabase, SqlTransactions } from '@nimbus-sh/core/runtime/os-contracts.js';
/** What the store holds, for diagnostics. */
export interface TransformStoreStats {
    entries: number;
    /** UTF-8 bytes of the results. */
    bytes: number;
    /** What the bound is charged: the bytes plus a ledger row per row. */
    charge: number;
    limit: number;
}
/** What the store holds, read without a store bound to any host. */
export declare function transformStoreStats(sql: SqlDatabase): TransformStoreStats;
export interface TransformStoreOptions {
    /** The pipeline's code identity. Defaults to this build's. */
    pipeline?: string;
    /** Charge the store may hold. */
    maxBytes?: number;
    /** Largest result kept. */
    maxEntryBytes?: number;
}
export declare class TransformStore implements BundleCellResultStore {
    private readonly sql;
    private readonly transactions;
    private readonly host;
    private readonly pipeline;
    private readonly maxBytes;
    private readonly maxEntryBytes;
    private schemaReady;
    /**
     * @param host The identity of the transform host whose results this store
     *   holds (for the session, ESBUILD_FACET_WORKER_ID). Given with the host,
     *   by whoever composes both.
     */
    constructor(sql: SqlDatabase, transactions: SqlTransactions, host: string, options?: TransformStoreOptions);
    key(kind: 'cell' | 'entry', at: string, source: string): Promise<string>;
    getMany(keys: readonly string[]): Map<string, BundleCellResult>;
    private read;
    put(key: string, result: BundleCellResult, spend?: (bytes: number) => Promise<void>): Promise<void>;
    /**
     * One storage step. A step that fails (the storage wall, a reset) leaves a
     * result unkept or unread, which costs a launch a transform and never its
     * result; parts a failed put left behind name no row, and go.
     */
    private write;
    /** Drop least recently used results until the charge is within the bound; never `keep`. */
    private evict;
    /** Remove one result: its row, its parts and its charge, together. */
    private forget;
    /** Advance the recency clock and return its new value. Inside a transaction. */
    private tick;
    private open;
}
//# sourceMappingURL=transform-store.d.ts.map