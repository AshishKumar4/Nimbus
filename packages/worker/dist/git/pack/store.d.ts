/**
 * git/pack/store.ts — a repository's packed objects, read by range.
 *
 * No pack and no idx is ever read whole: an idx is consulted a page at a
 * time (its fanout, then a binary search over the pages of its id table),
 * and an object costs its entry and its delta chain's entries, the bases
 * held in a byte-bounded cache shared by every pack. A clone of any size can
 * be read with the memory of its largest object and the two caches.
 *
 * cf-git's readObjectPacked, hasObjectPacked and expandOidPacked delegate
 * here when the filesystem it is given carries a store (the tracked patch's
 * seam); Nimbus's filesystems always do.
 */
import { type ResolvedObject } from './reader.js';
/** The filesystem calls a store makes. */
export interface PackStoreFs {
    /** Bytes [offset, offset + length) of `path`, clipped to its end. */
    readRange(path: string, offset: number, length: number): Promise<Uint8Array>;
    size(path: string): Promise<number | null>;
    /** Names in `dir`, or [] when it is absent. */
    readdir(dir: string): Promise<string[]>;
}
export interface PackStoreOptions {
    /** Delta-base cache, bytes, shared by every pack. */
    cacheBytes?: number;
    /** idx page cache, bytes. */
    pageCacheBytes?: number;
}
export interface StoredObject extends ResolvedObject {
    /** The pack it came from, relative to the git directory. */
    source: string;
}
export declare class PackObjectStore {
    private readonly fs;
    private readonly gitdir;
    private packs;
    private readonly cache;
    private readonly pages;
    constructor(fs: PackStoreFs, gitdir: string, options?: PackStoreOptions);
    /** Whether some pack holds `oid`. */
    has(oid: string): Promise<boolean>;
    /** The object, its deltas applied; null when no pack holds it. */
    read(oid: string): Promise<StoredObject | null>;
    /** Every packed id starting with `prefix` (hex). */
    expand(prefix: string): Promise<string[]>;
    /** Forget the pack list: a fetch added one. */
    refresh(): void;
    private list;
    private locate;
    /** Binary search of one idx's fanout bucket, a page at a time; null when absent. */
    private find;
    /** `length` bytes at `at` of `path`, from whole cached pages (a range spans at most two). */
    private page;
    private fetch;
    /** A ref-delta's base in a stored pack: in the same pack, which on disk is self-contained. */
    private refBase;
}
/** cf-git's `packs` seam (the tracked patch) over one filesystem: a store per git directory. */
export interface GitPacksSeam {
    read(gitdir: string, oid: string): Promise<StoredObject | null>;
    has(gitdir: string, oid: string): Promise<boolean>;
    expand(gitdir: string, prefix: string): Promise<string[]>;
}
export declare function packsSeam(fs: PackStoreFs, options?: PackStoreOptions): GitPacksSeam;
//# sourceMappingURL=store.d.ts.map