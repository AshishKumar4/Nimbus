/**
 * git/worktree/status.ts — `git status`'s short and porcelain v1 forms
 * (wt-status.c), from the tree walk, the index and the worktree walk.
 *
 * HEAD's tree against the index gives the first column (diff-index --cached,
 * renames found among its adds and deletes), the worktree walk the second
 * (diff-files) and the untracked list. Only changed paths are held, sorted
 * once at the end as git's string lists sort them.
 */
import { type CacheTree } from './cachetree.js';
import { type DirCache } from './dircache.js';
import { type Leaf, type ObjectStore } from './tree.js';
import { type ScanOptions, type Worktree } from './walk.js';
/** Whether `path` is one of `specs` or below one; no specs is everything. */
export declare function inSpecs(specs: readonly string[], path: string): boolean;
/** Whether directory `dir` holds one of `specs`, so a walk enters it on the way. */
export declare function holdsSpec(specs: readonly string[], dir: string): boolean;
/**
 * diff-index --cached: the leaves of `tree` against the index's entries, in
 * path order, one directory at a time. `visit` gets each path where either
 * has something: the leaf (or null) and the index entries [lo, hi) at that
 * path (lo === hi for none; more than one, or a stage, for an unmerged
 * path). Unchanged paths are visited too; the caller compares.
 *
 * A directory the index's cache tree records as valid, with the id of the
 * tree's subtree there and as many entries as the index holds below it, is
 * the same on both sides: it is skipped, its tree never read. With `build`,
 * the walk answers the cache tree the index has against `tree` (a node for
 * every directory where the two agree, valid), for the caller to record.
 */
export declare function walkTreeAndIndex(store: ObjectStore, tree: string, dc: DirCache, specs: readonly string[], visit: (path: string, leaf: Leaf | null, lo: number, hi: number) => Promise<void> | void, { cacheTree, build }?: {
    cacheTree?: CacheTree | null;
    build?: boolean;
}): Promise<CacheTree | null>;
/** One path's line: its two columns (or its unmerged code) and, for a rename, where it came from. */
export interface StatusChange {
    path: string;
    index: string;
    worktree: string;
    from?: string;
    /** DD, AU, UD, UA, DU, AA or UU. */
    unmerged?: string;
}
export interface StatusOptions {
    specs: readonly string[];
    untracked: ScanOptions['untracked'];
    excludes: ScanOptions['excludes'];
    renames: boolean;
}
/** wt_status_collect: every changed path, then the untracked ones, each list in git's order. */
export declare function collectStatus(store: ObjectStore, tree: Worktree, dc: DirCache, head: string, options: StatusOptions): Promise<{
    changes: StatusChange[];
    untracked: string[];
}>;
/**
 * path.c relative_path: `path` as seen from `prefix` (which ends in '/'),
 * climbing with '../'; './' for the prefix itself.
 */
export declare function relativePath(path: string, prefix: string): string;
/**
 * wt_shortstatus_print as a binary string. `prefix` (the cwd below the top,
 * ending in '/', or '') makes paths relative, as short status does and
 * porcelain does not; `z` ends entries with NUL and prints paths as they are.
 */
export declare function formatShortStatus(status: {
    changes: readonly StatusChange[];
    untracked: readonly string[];
}, { prefix, z }: {
    prefix: string;
    z: boolean;
}): string;
//# sourceMappingURL=status.d.ts.map