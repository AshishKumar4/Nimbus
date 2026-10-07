/**
 * git/worktree/dircache.ts — the git index (Documentation/gitformat-index.txt)
 * as its own bytes.
 *
 * A repository's index is held as the file read (every entry in on-disk
 * version 2/3 layout, a version 4 file's prefix-compressed names expanded)
 * and a table of where each entry starts: about 110 bytes a file, no object
 * per entry. A path is decoded only when asked for, and a lookup compares
 * bytes. A stat refresh patches the entry where it lies; any other change is
 * written by one ordered merge of the old entries' bytes with the new ones,
 * which are themselves held as bytes (NewEntries), straight into the file.
 */
import { CacheTree } from './cachetree.js';
export declare const S_IFMT = 61440;
export declare const S_IFREG = 32768;
export declare const S_IFLNK = 40960;
export declare const S_IFGITLINK = 57344;
/** The empty blob's id: a size-0 entry naming it is not racily smudged (read-cache.c). */
export declare const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
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
    added?: NewEntries;
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
/** An index extension: its 4-byte signature and its data (gitformat-index.txt, "Extensions"). */
export interface IndexExtension {
    signature: string;
    bytes: Uint8Array;
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
 * New index entries as their bytes, each encoded (encodeIndexEntry's layout)
 * as it is added, into chunks of CHUNK_BYTES: an entry costs its own size and
 * eight bytes, no object. As objects (a path and an id as strings, a stat, a
 * key for the sort, then the encoded piece), staging every file of a large
 * worktree held about 900 bytes a file: 80 MiB for add -A at Linux's 96,000.
 */
export declare class NewEntries {
    private readonly chunks;
    /** Bytes used of the last chunk. */
    private used;
    private chunkOf;
    private offsetOf;
    count: number;
    /** Encode `entry`; its path and stat are not kept. */
    add(entry: NewEntry): void;
    /** Entry `k`'s bytes, a view. */
    entry(k: number): Uint8Array;
    /** Entry `k`'s name bytes, a view. */
    name(k: number): Uint8Array;
    path(k: number): string;
    stage(k: number): number;
    /** The order of entries `k` and `j`: by name, then stage. */
    private compare;
    /**
     * The entries' numbers in index order (name, then stage): as added when they
     * came in it, as most commands add them. One path twice at one stage is refused.
     */
    order(): Int32Array;
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
    /** The checksum the file read ended with (null: there was none): what a revision check compares. */
    readonly trailer: Uint8Array | null;
    /** The TREE extension's bytes as read, or as set; null for none. */
    private treeBytes;
    /** Those bytes read (undefined until asked for); null when there are none git would read. */
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
    /** The paths with unmerged entries (stages 1-3), each once, in index order. */
    unmergedPaths(): string[];
    /** The first entry at `path` (its lowest stage), or -1. */
    find(path: string): number;
    /** [lo, hi): the entries below directory `dir` ('' is the whole index). */
    rangeUnder(dir: string, lo?: number, hi?: number): [number, number];
    /** The index's cache tree (its TREE extension), or null when it has none git would read. */
    cacheTree(): CacheTree | null;
    /** Record `bytes` as the index's TREE extension, when they say something the one held does not. */
    setCacheTree(bytes: Uint8Array): void;
    /** Mark entry `i` checked against the worktree by this command. */
    markUptodate(i: number): void;
    isUptodate(i: number): boolean;
    /** is_racy_timestamp: entry `i`'s matching stat proves nothing, as it is not older than the index. */
    isRacy(i: number): boolean;
    /** fill_stat_cache_info: entry `i` takes the file's fresh stat, its content having matched. */
    refresh(i: number, stat: EntryStat): void;
    /** Where entry `i` ends: the next one's start, or its own padded length for the last. */
    private entryEnd;
    /**
     * The ordered merge an edit writes: the old entries but `removed` and those
     * an added one replaces, and the added ones (`order`), each passed to
     * `emit` in path order. Old entries kept one after another go as one run
     * (but at version 4, which re-encodes each name); a `smudged` one alone.
     */
    private merge;
    /**
     * The index file with `edit` applied: header, entries in path order, the
     * extensions that still hold, and the checksum. `smudged` entries get size
     * 0 (ce_smudge_racily_clean_entry). The cache tree goes once an entry
     * changes, and the untracked cache and monitor tokens always: nothing here
     * keeps them, and git rebuilds them.
     *
     * Written straight into the file's bytes: the merge runs once to size the
     * file and once to fill it, so the file is the one copy this makes.
     */
    encode(edit?: IndexEdit, smudged?: ReadonlySet<number>): Uint8Array;
}
/** Entries in version 2/3 layout laid back to back (a clone batch's share of the index), one by one. */
export declare function splitIndexEntries(bytes: Uint8Array): Uint8Array[];
/**
 * An index file of `entries` (encodeIndexEntry's, in any order; one path
 * twice at one stage is refused), then `extensions`: version 2, or 3 when an
 * entry has the second flags word. How a clone writes the index it checked
 * out; DirCache.encode writes every later one.
 */
export declare function encodeIndexFile(entries: readonly Uint8Array[], extensions?: readonly IndexExtension[]): Uint8Array;
/**
 * One entry in version 2/3 layout: its stat (all zero when null, as for an
 * entry never checked out or a gitlink), mode, id, flags, then its name and
 * 1-8 NULs to a multiple of 8. A skip-worktree entry takes the second flags
 * word, which makes the file version 3.
 */
export declare function encodeIndexEntry(path: string | Uint8Array, mode: number, oid: string | Uint8Array, stat: EntryStat | null, options?: {
    stage?: number;
    skipWorktree?: boolean;
}): Uint8Array;
//# sourceMappingURL=dircache.d.ts.map