/**
 * git/pack/reader.ts — objects out of one pack, by range.
 *
 * Every read is a generator that yields the byte ranges it needs and is
 * handed their bytes back, so one implementation serves two kinds of
 * storage: driven synchronously over the session's SQLite (readRange is a
 * local call there) or asynchronously over a facet's range RPC, possibly with
 * many reads batched into one round trip. Nothing here holds a pack: an
 * object costs its entry's bytes, the deltas of its chain, and the
 * delta-base cache's budget.
 */
import { type GitObjectType, type ObjectHeader } from './format.js';
/** A range of a file's bytes; the answer is exactly those bytes, clipped to the file's end. */
export interface PackRange {
    file: string;
    offset: number;
    length: number;
}
export type PackRead<T> = Generator<PackRange, T, Uint8Array>;
export interface ResolvedObject {
    type: GitObjectType;
    data: Uint8Array;
}
/** A resolved object, sized for a ByteLru. */
export interface CachedObject extends ResolvedObject {
    byteLength: number;
}
/** One entry as it sits in the pack: its header, inflated payload, and packed length. */
export interface PackEntry {
    header: ObjectHeader;
    payload: Uint8Array;
    /** The entry's bytes in the pack, header included (what its CRC covers). */
    packed: Uint8Array;
}
/** Resolved objects of one pack, by offset (a ByteLru, or a view of one shared by several packs). */
export interface BaseCache {
    get(offset: number): CachedObject | undefined;
    set(offset: number, object: CachedObject): void;
}
/** A ref-delta's base is not in this pack and nothing else supplied it. */
export declare class MissingBaseError extends Error {
    readonly baseOid: Uint8Array;
    constructor(baseOid: Uint8Array);
}
/** Where a ref-delta's base comes from: an offset in this pack, or the object itself. */
export type RefBase = {
    offset: number;
} | {
    object: ResolvedObject;
};
/**
 * A first read this long holds a typical entry whole; a longer one is read
 * again at its deflate bound. Pages of the page-cached drivers are larger.
 */
export declare const ENTRY_PROBE_BYTES: number;
export interface PackObjectResolverOptions {
    /** The pack's path, which every range this resolver asks for names. */
    file: string;
    /** Offset of the pack's trailer: where object data ends. */
    dataEnd: number;
    /** Resolved objects by pack offset, shared by every read of this pack. */
    cache: BaseCache;
    /** A ref-delta's base, by id; MissingBaseError when there is none. */
    refBase(oid: Uint8Array): PackRead<RefBase>;
}
export declare class PackObjectResolver {
    private readonly options;
    dataEnd: number;
    constructor(options: PackObjectResolverOptions);
    /** The entry at `offset`: one probe, and one more read only when its stream is longer. */
    entryAt(offset: number): PackRead<PackEntry>;
    /**
     * The object at `offset`, its delta chain applied, each base it is built
     * on cached. The walk to the base reads only headers; the deltas are then
     * applied outward, each inflated as it is applied, so a long chain of
     * large deltas holds one of them, never all. The object itself is cached
     * only when `rememberTarget` (a base the caller asked for): a command's
     * one-shot read keeps the cache for bases, as git's delta_base_cache does.
     */
    objectAt(offset: number, rememberTarget?: boolean): PackRead<ResolvedObject>;
    /** The header of the entry at `offset`, its payload unread. */
    private headerOf;
    /** An object's type and size, inflating no more than each delta's leading sizes. */
    headerAt(offset: number): PackRead<{
        type: GitObjectType;
        size: number;
    }>;
    private remember;
}
/** Run a read to completion over synchronous storage. */
export declare function runSync<T>(read: Generator<PackRange, T, Uint8Array>, fetch: (range: PackRange) => Uint8Array): T;
/** Run a read to completion over asynchronous storage. */
export declare function runAsync<T>(read: Generator<PackRange, T, Uint8Array>, fetch: (range: PackRange) => Promise<Uint8Array>): Promise<T>;
//# sourceMappingURL=reader.d.ts.map