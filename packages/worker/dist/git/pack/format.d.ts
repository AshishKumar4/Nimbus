/**
 * git/pack/format.ts — the bytes of a git packfile (Documentation/gitformat-pack.txt).
 *
 *   header   "PACK", version (2 or 3), object count; all big-endian u32
 *   object   type+size varint, then for ofs-delta a negative-offset varint or
 *            for ref-delta the 20-byte base id, then one zlib stream
 *   trailer  SHA-1 of everything before it
 *
 * Every varint is refused once it would pass 2^53: a size or offset past
 * that cannot be a real object, and past it a JS number silently loses bits.
 */
export declare const PACK_HEADER_BYTES = 12;
export declare const PACK_TRAILER_BYTES = 20;
export declare const OID_BYTES = 20;
export declare const OBJ_COMMIT = 1;
export declare const OBJ_TREE = 2;
export declare const OBJ_BLOB = 3;
export declare const OBJ_TAG = 4;
export declare const OBJ_OFS_DELTA = 6;
export declare const OBJ_REF_DELTA = 7;
/** A resolved (non-delta) object type. */
export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
/**
 * The longest object header: 10 size bytes (a 64-bit size), then either 10
 * offset bytes or a 20-byte base id. A window this long always holds one.
 */
export declare const MAX_OBJECT_HEADER_BYTES: number;
export declare class PackFormatError extends Error {
    constructor(message: string);
}
export declare function typeName(code: number): GitObjectType;
export declare function typeCode(name: GitObjectType): number;
export interface PackHeader {
    version: 2 | 3;
    objects: number;
}
export declare function parsePackHeader(bytes: Uint8Array): PackHeader;
export declare function encodePackHeader(objects: number, version?: 2 | 3): Uint8Array;
/** One object's entry header, as it sits at its pack offset. */
export interface ObjectHeader {
    /** OBJ_* code. */
    type: number;
    /** Inflated size: of the object, or of the delta for a delta. */
    size: number;
    /** Bytes from the object's offset to its zlib stream. */
    headerBytes: number;
    /** ofs-delta: the base's absolute pack offset. */
    baseOffset?: number;
    /** ref-delta: the base's object id. */
    baseOid?: Uint8Array;
}
/**
 * Parse the entry header at `at` in `bytes`, for the object whose pack offset
 * is `objectOffset`. Null when `bytes` ends before the header does.
 */
export declare function parseObjectHeader(bytes: Uint8Array, at: number, objectOffset: number): ObjectHeader | null;
/** The entry header git writes for a non-delta object of `size` bytes. */
export declare function encodeObjectHeader(type: number, size: number): Uint8Array;
/**
 * zlib's deflateBound for the default window and memory level: no stream of
 * `size` input bytes is longer, so a read of the header plus this many bytes
 * always holds an object's whole zlib stream.
 */
export declare function deflateBound(size: number): number;
/**
 * inflateSync's output buffer for an object of `size` bytes. Its default is
 * 16 KiB, and a small object comes back as a view of that whole buffer: a
 * cache of small objects would hold 16 KiB apiece. zlib's minimum is 64.
 */
export declare function inflateChunkSize(size: number): number;
/** A delta's two leading sizes, and where its instructions start. */
export interface DeltaSizes {
    baseSize: number;
    resultSize: number;
    at: number;
}
export declare function deltaSizes(delta: Uint8Array): DeltaSizes;
/** Apply a git delta to its base (patch-delta.c), every instruction bounds-checked. */
export declare function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array;
/** "<type> <size>\0", the prefix an object id hashes before the content. */
export declare function objectIdPrefix(type: GitObjectType, size: number): Uint8Array;
export declare function oidToHex(oid: Uint8Array, at?: number): string;
export declare function oidFromHex(hex: string): Uint8Array;
/** Byte order of two ids, each at its own offset; the idx's sort order. */
export declare function compareOids(a: Uint8Array, aAt: number, b: Uint8Array, bAt: number): number;
//# sourceMappingURL=format.d.ts.map