/**
 * The session's storage ledger (Kinu N18; model Nimbus.Vfs.Ledger, N18-001).
 *
 * One storage limit (10 GB, DO_STORAGE_LIMIT_BYTES) is shared by the session's
 * Durable Object and every facet database under it, and `databaseSize` reports
 * only one database. At the wall an ordinary write fails catchably as
 * SQLITE_FULL; a facet clone over it is an uncatchable reset that empties the
 * destination. So every write is admitted against the shared limit before it
 * is made, and clone admission is decided before the clone:
 *
 *   used = the session DO's own bytes
 *        + every recorded facet database (live, dead or persisted)
 *        + reservations held by running operations.
 *
 * A write that does not fit is refused with ENOSPC and nothing changes.
 * Nothing in the ledger is evictable: the per-principal namespace image cache
 * the original design proposed never gained a producer and was removed
 * rather than shipped as dead accounting. A facet's row leaves only through
 * `deleteFacet` (facets.delete): an aborted facet's database persists, and a
 * restart re-reads the tables.
 */
import type { SqlDatabase } from './os-contracts.js';
export interface StorageLedgerOptions {
    /** The session DO's database bytes; defaults to the database's own size. */
    sessionBytes?: () => number;
    limit?: number;
    /**
     * Bytes below the limit only privileged (uid 0) admissions may use, as ext4
     * reserves blocks for root: the kernel's own bookkeeping (session state,
     * receipts, leases), much of it written outside admission, still has room
     * when a user has filled the store. Defaults to 1% of the limit, at least
     * 16 MiB.
     */
    kernelReserve?: number;
}
/** The bytes a database occupies on the host: workerd's databaseSize, else SQLite's pages. */
export declare function databaseBytesOf(sql: SqlDatabase): number;
export interface StorageLedgerView {
    limit: number;
    used: number;
    /** Bytes facets reported beyond what they were admitted, cumulative. */
    overshoot: number;
    /** Admitted to running operations and not yet written. */
    reserved: number;
    /** The same, per operation (none held at zero). */
    reservations: Record<string, number>;
    session: number;
    facets: Record<string, number>;
}
/** What admission charges a stored row (an inode, manifest or namespace row and its index entries), rounded up. */
export declare const LEDGER_ROW_BYTES = 256;
export declare class StorageLedger {
    private readonly sql;
    readonly limit: number;
    readonly kernelReserve: number;
    private readonly sessionBytes;
    constructor(sql: SqlDatabase, options?: StorageLedgerOptions);
    /** A session-DO write of `bytes`: admitted or ENOSPC, changing nothing. */
    admit(bytes: number, privileged?: boolean): void;
    /** What an admission may fill up to. */
    private limitFor;
    /** A fill of `bytes` into facet `name`: admitted, and recorded before the fill is acknowledged. */
    fill(name: string, bytes: number): void;
    /**
     * An operation that writes over several turns (a sliced copy, a paged
     * import) reserves what it is admitted for: every other writer counts it as
     * used until the operation draws it (as its writes land) or releases it.
     * So the operation's own writes, within the reservation, are never refused.
     */
    reserve(id: string, bytes: number, privileged?: boolean): void;
    /**
     * A write of `bytes` by the operation that reserved `id`: taken from its
     * reservation first; only what exceeds it is admitted like any write.
     * Returns what it took, for `refund` if the write does not land.
     */
    draw(id: string, bytes: number, privileged?: boolean): number;
    /** A drawn write rolled back: its bytes go back to the reservation. */
    refund(id: string, bytes: number): void;
    /** The operation ended (done or failed): what it did not use is free again. */
    release(id: string): void;
    /** Reservations no running operation holds (after a restart): all of them are released. */
    releaseAll(): void;
    /** `facets.delete(name)`: its database is gone. The only way a facet leaves the ledger. */
    deleteFacet(name: string): void;
    /** A facet reported `databaseSize` at or below its record (it freed space): the row becomes the smaller. */
    settle(name: string, bytes: number): void;
    /**
     * A facet reported `databaseSize` (at boot, after a fill, at exit): the row
     * becomes the larger of the report and the record. What exceeds the record
     * was never admitted; it is overshoot, and further writes are refused
     * until something frees space.
     */
    report(name: string, bytes: number): void;
    /** A facet's measured `databaseSize`: at or below its record it settles, above it is overshoot. */
    reportSize(name: string, bytes: number): void;
    view(): StorageLedgerView;
    /** `fixed`: the session's own bytes, the facets' and the reservations. */
    private totals;
    private reservation;
    private facet;
    private hasFacet;
    private setFacet;
}
/**
 * `facets.delete(name)` dropped that facet's database: it leaves the ledger in
 * the same step. For the facet hosts, which hold the session's SQL but not
 * its engine.
 */
export declare function forgetFacetStorage(sql: SqlDatabase, name: string): void;
//# sourceMappingURL=storage-ledger.d.ts.map