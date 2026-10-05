/**
 * git/worktree/dircache.ts — the git index (Documentation/gitformat-index.txt)
 * as its own bytes.
 *
 * A repository's index is held as the file read (every entry in on-disk
 * version 2/3 layout, a version 4 file's prefix-compressed names expanded)
 * and a table of where each entry starts: about 110 bytes a file, no object
 * per entry. A path is decoded only when asked for, and a lookup compares
 * bytes. A stat refresh patches the entry where it lies; any other change is
 * written by one ordered merge of the old entries' bytes with the new ones.
 */
import { type CacheTree } from './cachetree.js';
export declare const S_IFMT = 61440;
export declare const S_IFREG = 32768;
export declare const S_IFLNK = 40960;
export declare const S_IFGITLINK = 57344;
/** The empty blob's id: a size-0 entry naming it is not racily smudged (read-cache.c). */
export declare const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775a2c2a1b9fb8ef";
/** The stat an entry records: the session's lstat, times in ms. */
export interface EntryStat {
    ctimeMs: number;
    mtimeMs: number;
    dev: number;
    ino: number;
    uid: number;
    gid: number;
    size: number;
}
/** An entry to write: stat null records none (all zero), as read-tree does. */
export interface NewEntry {
    path: string;
    mode: number;
    oid: string;
    stat: EntryStat | null;
    stage?: number;
    skipWorktree?: boolean;
}
/** What one command changes in the index, written in one merge. */
export interface IndexEdit {
    /** Old entries that go, by number. */
    removed?: ReadonlySet<number>;
    /** New entries, in any order; one replaces every old entry at its path. */
    added?: readonly NewEntry[];
}
/** The filesystem calls reading and writing the index make (ProjectFs's). */
export interface IndexFs {
    /** The file's bytes, a buffer of the caller's own, past the content cache. */
    readFileUncached(path: string): Promise<Uint8Array> | Uint8Array;
    writeFile(path: string, content: Uint8Array): Promise<void> | void;
    lstat(path: string): Promise<{
        mtime: number;
    }> | {
        mtime: number;
    };
}
/** git's name order: the bytes of the path. */
export declare function compareBytes(a: Uint8Array, b: Uint8Array): number;
/** A path's bytes as a string: ASCII without the decoder's cost. */
export declare function decodePath(bytes: Uint8Array): string;
/** git's order of two paths as strings: their UTF-8 bytes, which is code point order rather than UTF-16's. */
export declare function comparePaths(a: string, b: string): number;
/** An object's id: SHA-1 of `<type> <size>\0` and the bytes. */
export declare function objectId(type: string, data: Uint8Array): string;
export declare class IndexFormatError extends Error {
}
/**
 * The index of one repository. `timestamp` is the index file's mtime in
 * seconds as read (git's istate->timestamp), 0 when there was none: an entry
 * whose mtime is not older is racily clean.
 */
export declare class DirCache {
    private readonly bytes;
    private readonly offsets;
    readonly version: number;
    readonly timestamp: number;
    private readonly extensions;
    /** Entries verified against the worktree by this command: never smudged (CE_UPTODATE). */
    private readonly uptodate;
    /** A stat refresh happened: the index is worth writing. */
    refreshed: boolean;
    /** The TREE extension as read (undefined until asked for), or as set. */
    private tree;
    /** The cache tree changed: written, it saves the next command reading trees. */
    cacheTreeChanged: boolean;
    /** `bytes` are this index's own: a refresh patches them. */
    private constructor();
    get count(): number;
    /** A repository's index before anything is added: no file yet. */
    static empty(): DirCache;
    /** The index at `file`, empty when there is none. */
    static read(fs: IndexFs, file: string): Promise<DirCache>;
    /** read_index_from on bytes already read. */
    static parse(bytes: Uint8Array, timestamp: number): DirCache;
    private u32;
    private flags;
    private extendedFlags;
    /** Entry `i`'s name bytes, a view of the index. */
    pathBytes(i: number): Uint8Array;
    path(i: number): string;
    mode(i: number): number;
    oidBytes(i: number): Uint8Array;
    oid(i: number): string;
    stage(i: number): number;
    /** CE_VALID: assume unchanged, never stat'd. */
    assumeValid(i: number): boolean;
    skipWorktree(i: number): boolean;
    intentToAdd(i: number): boolean;
    ctimeSeconds(i: number): number;
    mtimeSeconds(i: number): number;
    ino(i: number): number;
    uid(i: number): number;
    gid(i: number): number;
    size(i: number): number;
    /** The first entry at or after `key` (path bytes) in [lo, hi). */
    lowerBound(key: Uint8Array, lo?: number, hi?: number): number;
    /** The first entry at `path` (its lowest stage), or -1. */
    find(path: string): number;
    /** [lo, hi): the entries below directory `dir` ('' is the whole index). */
    rangeUnder(dir: string, lo?: number, hi?: number): [number, number];
    /** The index's cache tree (its TREE extension), or null when it has none git would read. */
    cacheTree(): CacheTree | null;
    /** Record `tree` as the index's cache tree, when it says something the one held does not. */
    setCacheTree(tree: CacheTree): void;
    /** Mark entry `i` checked against the worktree by this command. */
    markUptodate(i: number): void;
    isUptodate(i: number): boolean;
    /** is_racy_timestamp: entry `i`'s matching stat proves nothing, as it is not older than the index. */
    isRacy(i: number): boolean;
    /** fill_stat_cache_info: entry `i` takes the file's fresh stat, its content having matched. */
    refresh(i: number, stat: EntryStat): void;
    /**
     * The index file with `edit` applied: header, entries in path order, the
     * extensions that still hold, and the checksum. `smudged` entries get size
     * 0 (ce_smudge_racily_clean_entry). The cache tree goes once an entry
     * changes, and the untracked cache and monitor tokens always: nothing here
     * keeps them, and git rebuilds them.
     */
    encode(edit?: IndexEdit, smudged?: ReadonlySet<number>): Uint8Array;
}
//# sourceMappingURL=dircache.d.ts.map