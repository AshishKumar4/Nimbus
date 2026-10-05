/**
 * git/worktree/walk.ts — the worktree against the index, one directory at a
 * time (git's diff-files and read_directory in one pass).
 *
 * A directory's listing is merged with the index entries below it, which are
 * one contiguous range of the sorted index: a tracked file is lstat'd and
 * matched as read-cache.c ie_match_stat matches it, a tracked directory is
 * entered, and what the listing has and the index does not is untracked,
 * checked against the exclude rules. Only entries that changed, and the
 * untracked paths, come back; a clean entry costs its lstat and nothing
 * else. Content is read only where the stat cannot decide: stat fields other
 * than the size moved, the entry is racily clean, or it was smudged.
 *
 * What is held is the listing of each directory on the current path, so
 * memory follows the tree's depth and its widest directory, not its size.
 */
import { type DirCache, type EntryStat } from './dircache.js';
import type { Excludes } from './excludes.js';
/** What a worktree lstat says (the VFS's stat, times in ms). */
export interface WorktreeStat extends EntryStat {
    type: 'file' | 'directory' | 'symlink' | 'other';
    mode: number;
}
export type WorktreeType = WorktreeStat['type'];
/** The worktree calls a walk makes, at repo-relative paths ('' is the top). */
export interface WorktreeFs {
    /** A directory's entries and their types; [] when it is not a directory. */
    list(dir: string): Promise<Array<{
        name: string;
        type: WorktreeType;
    }>>;
    lstat(path: string): Promise<WorktreeStat | null>;
    readFile(path: string): Promise<Uint8Array>;
    /** Bytes [offset, offset + length), clipped to the file's end. */
    readRange(path: string, offset: number, length: number): Promise<Uint8Array>;
    readlink(path: string): Promise<string>;
}
/** What reading the worktree cost, for the measurements. */
export interface WalkCounters {
    readdirs: number;
    lstats: number;
    filesRead: number;
    bytesRead: number;
    /** Objects read from the store: trees, mostly. */
    objectsRead: number;
    /** When kept, why each of the first entries read had to be: the stat fields that did not match. */
    why?: string[];
}
export declare function newCounters(): WalkCounters;
/** One worktree in its repository's terms. */
export interface Worktree {
    fs: WorktreeFs;
    /** core.filemode: the owner's exec bit is a change. */
    filemode: boolean;
    /** core.autocrlf=true: a valid UTF-8 file is hashed with CRLF as LF, as cf-git adds it. */
    autocrlf: boolean;
    counters: WalkCounters;
}
/** The bytes git would store for the worktree file or link at `path` (convert_to_git's share of it). */
export declare function worktreeBlob(tree: Worktree, path: string, type: WorktreeType): Promise<Uint8Array>;
/** The id of the blob git would store for the file or link at `path`, `st` its lstat. */
export declare function worktreeBlobId(tree: Worktree, path: string, st: WorktreeStat): Promise<string>;
/** The index mode of a worktree file (ce_mode_from_stat): without a trusted exec bit a file keeps `indexMode`. */
export declare function modeFromStat(stat: WorktreeStat, indexMode: number | undefined, filemode: boolean): number;
/** ce_match_stat_basic, in whole seconds (git without USE_NSEC), dev ignored (without USE_STDEV): 0 when the stat matches. */
export declare function matchStat(dc: DirCache, i: number, st: WorktreeStat, filemode: boolean): number;
/** How a tracked entry differs from the worktree. */
export interface Dirty {
    /** M: content or exec bit; D: gone (or a directory where a file was); T: a file became a link, or back. */
    change: 'M' | 'D' | 'T';
    /** The worktree's lstat, absent for D. */
    stat: WorktreeStat | null;
    /** The worktree blob's id, when the walk hashed it. */
    oid?: string;
    /** D because a directory stands where the file was, not because nothing does. */
    directory?: boolean;
}
/**
 * refresh_cache_ent for one entry the worktree holds: null when it matches
 * (its stat refreshed in `dc` when the content had to decide), else how it
 * differs.
 */
export declare function compareEntry(tree: Worktree, dc: DirCache, i: number, path: string, st: WorktreeStat, uncleanIsDirty?: boolean): Promise<Dirty | null>;
export interface ScanOptions {
    /** Repo-relative literal pathspecs; none, or '', is the whole tree. */
    specs?: readonly string[];
    /** Untracked files: none, collapsed to the directories holding them (git's normal), or each one. */
    untracked: 'no' | 'normal' | 'all';
    /** The exclude rules; null lists ignored paths as untracked too (ls-files -o without --exclude-standard). */
    excludes: Excludes | null;
    /** Ignored files are untracked too, each one (add -f). */
    ignoredToo?: boolean;
    /**
     * An entry whose stat does not prove it clean (stat moved, or racily clean)
     * is 'M' unhashed, for the caller to add again, as git add and commit -a
     * do: the entry takes fresh stat and its directories' cache trees go.
     */
    uncleanIsDirty?: boolean;
    /** Unmerged paths too, with what the worktree holds at each (add and commit -a resolve them). */
    unmerged?: boolean;
}
/** An unmerged path: its stages, entries [lo, hi), and the worktree's lstat there (null: nothing). */
export interface Unmerged {
    path: string;
    lo: number;
    hi: number;
    stat: WorktreeStat | null;
}
export interface ScanResult {
    /** Tracked entries that differ from the worktree, by entry number. */
    dirty: Map<number, Dirty>;
    /** Untracked paths in walk order; a directory ends in '/'. */
    untracked: string[];
    /** With `unmerged`, the unmerged paths in index order. */
    unmerged: Unmerged[];
    /**
     * What could not be read, as git reports it on stderr: an entry's lstat
     * (`<path>: <strerror>`, diff-files'), and a directory the untracked scan
     * could not open (read_directory's warning). Each command prints the two
     * in its own order.
     */
    errors: {
        tracked: string[];
        untracked: string[];
    };
}
/**
 * diff-files and read_directory over the whole worktree (or `specs`):
 * every tracked entry that differs, and what is untracked. Unmerged entries
 * (stage > 0) are left to the caller; skip-worktree and assume-unchanged
 * entries are never looked at, as git never looks at them.
 */
export declare function scanWorktree(tree: Worktree, dc: DirCache, options: ScanOptions): Promise<ScanResult>;
//# sourceMappingURL=walk.d.ts.map