/**
 * git/worktree/pairs.ts — a diff's changed paths in columns, git's diff
 * queue without an object per pair.
 *
 * Each pair is its path (once: both sides of a diff-files or diff-index pair
 * share it), each side's object id and mode, which sides it has, and whether
 * its second side is the worktree's. With every file of a 96,000-file tree
 * changed, the queue as objects held about 70 MiB; as columns it is the
 * paths plus 53 bytes a pair. A pair becomes an object only while it is
 * printed, or when rename detection needs it (additions and deletions).
 */
/** One side of a pair: what a diff prints and reads. */
export interface PairSide {
    path: string;
    oid: string;
    mode: number;
    /** Content lives in the worktree rather than the object store. */
    worktree: boolean;
}
export interface Pair {
    one: PairSide | null;
    two: PairSide | null;
}
export declare class PairList {
    count: number;
    private pathStarts;
    private paths;
    /** Two ids a pair: its first side's, then its second's. */
    private oids;
    private modes;
    private flags;
    /** Pairs were added in path order. */
    private ordered;
    /** Add the pair at `path`, unless both sides are there and the same. */
    add(path: string, one: {
        oid: string;
        mode: number;
    } | null, two: {
        oid: string;
        mode: number;
        worktree: boolean;
    } | null): void;
    private pathBytes;
    /** The pairs' numbers in path order. */
    order(): Uint32Array;
    /** Both sides there: a modification, which rename detection passes over. */
    modified(k: number): boolean;
    /** The ids a diff reads from the object store: every first side, and second sides not in the worktree. */
    storeOids(): Generator<string>;
    pair(k: number): Pair;
}
//# sourceMappingURL=pairs.d.ts.map