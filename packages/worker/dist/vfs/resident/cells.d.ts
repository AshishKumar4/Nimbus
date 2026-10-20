/**
 * The store's cells: what a synchronous read is answered from, each dated by
 * the authority revision its bytes were read at, or as this facet's own
 * unacknowledged write (RK_OWN_WRITE), and moved forward by each ACQUIRE
 * delta (admit).
 *
 * 'file' carries one row per path, so existence, size and kind are one query
 * that never touches content. 'chunk' carries the bytes. Splitting them is
 * what makes _statLadder and __fileExists cheap: the common case reads a
 * short row and never pages a megabyte of blob in to answer "is it there".
 * 'rev' is never undated, and that IS the coherence guarantee rather than a
 * note about it. An undated row can never be invalidated, so it would be
 * served stale forever. The SQLite backing makes the column NOT NULL, so such
 * a row cannot be written; this is the r2-cache posture (an unverifiable key
 * cannot be constructed) moved to the only storage layer this store has.
 *
 * RK_OWN_WRITE is the one negative value: this facet's own bytes that the
 * authority has not acknowledged, which are strictly newer than anything it
 * can report and are always readable. It is a real provenance, not an absence
 * of one.
 */
import type { Admission } from './admission.js';
import { type ResidentCell } from './cell-cost.js';
import type { Coherence, Cursor } from './coherence.js';
import { type Namespace } from './namespace.js';
import type { VfsAcquireResult } from '@nimbus-sh/core/runtime/os-contracts.js';
import { type FileHead, type ResidentTables } from './tables.js';
/** What one admitted delta did. */
export interface Admitted {
    /** Paths that WERE held and are now gone: what the caller re-reads live. */
    dropped: string[];
    /** Rows kept because their revision already covers the report (this facet's own writes coming back). */
    kept: number;
    pushed: number;
    /** Directories an enumerated namespace must relist: no delta will itemise what is under them. */
    relist: string[];
    cursor: Cursor;
    /** An answer older than the store's cursor: nothing was applied. */
    stale?: boolean;
}
/** One fill's token (cells.beginFill): its own, compared by identity. */
export interface ResidentFill {
    readonly fill: number;
}
export interface Cells {
    /**
     * The resident set, as the shims have always seen it: `k in b`, `b[k]`,
     * `Object.keys(b)`, `delete b[k]` across a dozen call sites in
     * runtime/node-shims.ts, the shape the ledger uses for `__vfsWrites`. Every
     * trap is synchronous, because every reader of __vfsBundle is.
     */
    readonly bundle: Record<string, unknown>;
    /** Apply one authority delta and unseal (see admit below). */
    admit(result: VfsAcquireResult | null | undefined): Admitted;
    dropDated(): void;
    /** One row of 'file', or undefined. The existence/shape query. */
    head(path: string): FileHead | undefined;
    /** Whether `path` is held, in the tables or in memory. */
    has(path: string): boolean;
    /** Whether the cell held for `path` is a denial (what get answers { error } for), its bytes not read. */
    denied(path: string): boolean;
    get(path: string): ResidentCell | undefined;
    /** Write one cell as `rev`, or as an own write when `rev` is not a number (see put below). */
    put(t: ResidentTables, path: string, cell: ResidentCell | ArrayBuffer, rev?: number, ckey?: unknown): boolean;
    /**
     * A fill about to ask for `paths`: each one's chunk rows are its own, over
     * the head as it stands, until another fill begins for it or anything
     * changes its rows (rowsChanged).
     */
    beginFill(paths: ArrayLike<string>): ResidentFill;
    /** One chunk of `fill`: written only while the path's chunk rows are its own (false otherwise). */
    putChunk(t: ResidentTables, path: string, part: number, bytes: Uint8Array, fill: ResidentFill): boolean;
    /** The fill's file, once all its chunks are in: held as `rev`, if its chunk rows are still its (false otherwise). */
    publishFill(t: ResidentTables, path: string, kind: number, size: number, chunks: number, rev: number, ckey: unknown, fill: ResidentFill): boolean;
    /** A fill that did not finish `path`: the chunk rows it wrote, and the head they were written over, go, if they are still its. */
    abandonFill(t: ResidentTables, path: string, fill: ResidentFill): void;
    /**
     * The rows of `path` (every path: undefined) are about to change (tables.ts,
     * whoever changes them): the fill writing there is disowned, and what it
     * wrote with no head over it goes with it, bytes and accounting.
     */
    rowsChanged(path?: string): void;
    copyByKey(t: ResidentTables, path: string, ckey: unknown, rev: number): boolean;
    delete(t: ResidentTables, path: string): boolean;
    provenance(path: string): number | undefined;
    stamp(path: string, rev: number): void;
    lease(path: string): number | undefined;
    fill(path: string, cell: ResidentCell | ArrayBuffer, rev: number): boolean;
    keys(): string[];
    ownPaths(): string[];
    keysUnder(prefix: string): string[];
    hasUnder(prefix: string): boolean;
    /** Whether a miss on `path` is the storage's: its own write was held nowhere. */
    storageMiss(path: string): boolean;
    /** Every held cell that is not an own write still in flight, forgotten (or every one, with `all`). */
    dropHeld(all: boolean): void;
    /** Each own write held in memory, with what it is dated at (RK_OWN_WRITE until its write-back is acknowledged). */
    heldRevisions(): [string, number][];
    /** Forget the cell held in memory for `path`. */
    forget(path: string): void;
    clear(): void;
    stats(): {
        files: number;
        bytes: number;
        names: number;
        namespace: boolean;
        databaseSize: number;
        sealed: boolean;
        undatedSnapshot: boolean;
        cursor: Cursor | null;
    };
    /** Measurement: content reads asked of the store, those it answered, and the fills it installed. */
    readonly measured: {
        reads: number;
        hits: number;
        fills: number;
        filledBytes: number;
        /** Changes the session reported past the cursor; those that were this process's own (or already held as new); those to a file it held an older copy of (what a revocation would be for). */
        changes: number;
        ownOrCurrent: number;
        heldChanged: number;
    };
}
export declare function createCells(coherence: Coherence, admission: Admission, namespace: Namespace, observeRead: ((path: string) => void) | null): Cells;
//# sourceMappingURL=cells.d.ts.map