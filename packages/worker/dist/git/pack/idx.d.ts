/**
 * git/pack/idx.ts — pack index version 2 (Documentation/gitformat-pack.txt),
 * byte for byte what `git index-pack` writes for the same pack:
 *
 *   ff 74 4f 63, version 2
 *   fanout[256]          u32: objects whose first id byte is <= i
 *   ids[N]               20 bytes each, ascending
 *   crc32[N]             of each object's packed bytes, header included
 *   offset32[N]          offset, or 0x80000000 | index into offset64
 *   offset64[M]          u64, for every offset past 0x7fffffff, in id order
 *   pack checksum, then the SHA-1 of everything above
 *
 * Entries travel as fixed records (ENTRY_BYTES): id, u64 offset, u32 crc.
 */
export declare const IDX_V2_SIGNATURE: Uint8Array<ArrayBuffer>;
export declare const IDX_HEADER_BYTES: number;
export declare const ENTRY_BYTES: number;
/** Where each table of an idx with `count` objects starts. */
export interface IdxLayout {
    count: number;
    ids: number;
    crcs: number;
    offsets32: number;
    offsets64: number;
}
export declare function idxLayout(count: number): IdxLayout;
/** The fanout of an idx's first IDX_HEADER_BYTES. */
export declare function parseIdxHeader(bytes: Uint8Array): Uint32Array;
export declare function writeEntry(records: Uint8Array, index: number, oid: Uint8Array, oidAt: number, offset: number, crc: number): void;
export declare function entryOffset(records: Uint8Array, index: number): number;
export declare function entryCrc(records: Uint8Array, index: number): number;
/** Records in idx order: ascending id, then ascending offset for a repeated id. */
export declare function sortEntries(records: Uint8Array): Uint8Array;
/**
 * The idx, as a sequence of pieces, for `count` entries that `sweep` yields in
 * idx order (each yield a whole number of records). The tables are columns of
 * the records, so the entries are swept once per table and never held whole.
 */
export declare function encodeIdxV2(count: number, packChecksum: Uint8Array, sweep: () => AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array>;
//# sourceMappingURL=idx.d.ts.map