/**
 * Whether the store may serve: bound to its tables, and unsealed.
 *
 * Reads are SEALED until this incarnation has reconciled the store against the
 * authority. This is the whole coherence design, and it is a seal rather than a
 * check because a check gets forgotten.
 *
 * The hazard is specific to putting the resident set in storage, and it is
 * created by the property that makes the design affordable: a facet's storage
 * survives a fresh module scope (measured — same facet name, new loader key,
 * new module token, 7,141 rows and 45.7 MB intact). So a new incarnation opens
 * onto rows written by a PREVIOUS one, while every in-heap stamp and cursor
 * that described them is gone. Heap-side provenance cannot survive the thing it
 * is meant to describe, so provenance lives in the rows: 'file.rev' per path,
 * '(epoch, rev)' for the store, both in this storage.
 *
 * Sealed is the initial state and an admitted delta (cells.admit) is what
 * clears it, so a row cannot be served by an incarnation that has not applied
 * the authority's delta. There is one gate and it is on the only door —
 * `require`, which every read, scan and write goes through.
 */
import type { HeapTables, ResidentTables } from './tables.js';
import { type FeedPosition } from '@nimbus-sh/core/runtime/feed-position.js';
/** Where the store's rows are known-good: the namespace's position (feed-position.ts), each fed mount's feed. */
export type Cursor = FeedPosition;
export interface Coherence {
    /** Bound to tables (store.bind / store.bindInMemory), sealed. */
    bind(t: ResidentTables, heap: HeapTables | null): void;
    /** Bound, sealed or not. */
    bound(): boolean;
    /** Bound and unsealed: rows may be served. */
    serving(): boolean;
    /** The bound tables, sealed or not; `doing` names the call refused before binding. */
    tables(doing: string): ResidentTables;
    /** The bound heap tables, when the store is a one-shot's heap. */
    readonly heap: HeapTables | null;
    /** The bound tables, refused while the store is sealed. */
    require(): ResidentTables;
    /** Why the store is sealed, or null. */
    sealed(): string | null;
    seal(reason: string): void;
    unseal(): void;
    /** This facet booted from a snapshot carrying no cursor, so the store holds nothing. */
    readonly undated: boolean;
    setUndated(undated: boolean): void;
    /** The persisted cursor, or null when this store has never been populated. */
    cursor(): Cursor | null;
    /** Stamp the store with the authority state its rows are known-good at. */
    writeCursor(t: ResidentTables, cursor: Cursor): void;
}
export declare function createCoherence(): Coherence;
//# sourceMappingURL=coherence.d.ts.map