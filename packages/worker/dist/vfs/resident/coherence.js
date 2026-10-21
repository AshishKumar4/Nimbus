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
export function createCoherence() {
    let t = null;
    let heap = null;
    let isSealed = true;
    /**
     * Set when this facet booted from a snapshot carrying no cursor, so the store
     * holds nothing. Read by residency-miss reporting: without it, "not resident"
     * is indistinguishable from "resident set was never adoptable", and the second
     * is a much more actionable thing to be told.
     */
    let undated = false;
    let sealReason = 'the store has not reconciled with the authority in this incarnation';
    return {
        bind(tables, heapTables) { t = tables; heap = heapTables; },
        bound: () => t !== null,
        serving: () => t !== null && !isSealed,
        tables(doing) {
            if (t === null)
                throw new Error('Nimbus: ' + doing + ' before the store was bound');
            return t;
        },
        get heap() { return heap; },
        require() {
            if (t === null) {
                throw new Error('Nimbus: the resident store was read before its facet bound its storage. '
                    + 'store.bind(ctx) must run in the process DO constructor, ahead of the program.');
            }
            if (isSealed) {
                throw new Error('Nimbus: the resident store is sealed — ' + sealReason + '. '
                    + "cells.admit(fsAcquire(...)) must apply the authority's delta before "
                    + 'the program runs; serving a row now would serve bytes of unknown age.');
            }
            return t;
        },
        sealed: () => (isSealed ? sealReason : null),
        seal(reason) {
            isSealed = true;
            sealReason = String(reason || 'resealed');
        },
        unseal() {
            isSealed = false;
            sealReason = '';
        },
        get undated() { return undated; },
        setUndated(value) { undated = value; },
        cursor() {
            if (t === null)
                return null;
            const epoch = t.metaGet('epoch');
            const rev = t.metaGet('rev');
            return epoch === undefined || rev === undefined ? null : { epoch, rev: Number(rev) };
        },
        writeCursor(tables, cursor) {
            tables.metaSet('epoch', String(cursor.epoch));
            tables.metaSet('rev', String(Number(cursor.rev)));
        },
    };
}
