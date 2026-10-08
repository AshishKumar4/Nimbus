/**
 * git/pack/plan.ts — what a checkout writes, held compactly.
 *
 * A checkout plan is the commit's tree flattened: every path with its mode
 * and object id, in the order a checkout walks them. It is held as columns
 * (ids in one Uint8Array, modes in a Uint32Array, paths in one UTF-8 arena
 * with offsets), about 26 bytes per entry plus the path itself: Linux's
 * 96,053 entries in ~6 MB, where an array of objects would take several
 * times that.
 *
 * Batches split the plan's distinct blobs into contiguous runs, so each
 * batch is a set of nearby paths (the server deltifies within a request,
 * and nearby paths are the similar ones) and every path of a blob lands in
 * the blob's batch.
 *
 * A sparse checkout's plan still holds every path (the index lists them
 * all); a path outside its cone is marked skip-worktree and never written.
 */
import type { SparseMatcher } from './sparse.js';
export declare const MODE_TREE = 16384;
export declare const MODE_FILE = 33188;
export declare const MODE_EXECUTABLE = 33261;
export declare const MODE_SYMLINK = 40960;
export declare const MODE_GITLINK = 57344;
export interface TreeEntry {
    mode: number;
    name: string;
    /** Offset of the entry's 20-byte id in the tree's bytes. */
    oidAt: number;
}
/** A tree object's entries, in the tree's own order. */
export declare function parseTree(tree: Uint8Array): TreeEntry[];
/** `bytes` copied into a longer buffer. */
export declare function growBytes(bytes: Uint8Array, length: number): Uint8Array;
export declare class CheckoutPlan {
    readonly count: number;
    private readonly oids;
    private readonly modes;
    /** 1 for a skip-worktree entry (outside a sparse checkout's cone). */
    private readonly skips;
    private readonly pathStarts;
    private readonly pathBytes;
    private constructor();
    /**
     * Walk `rootTree`'s tree, each subtree read with `tree(oid)`. With
     * `sparse`, a path outside its cone is skip-worktree; every tree is still
     * walked, as the index holds every path.
     */
    static fromTrees(rootTree: Uint8Array, tree: (oid: Uint8Array, at: number) => Uint8Array, sparse?: SparseMatcher): CheckoutPlan;
    /** Bytes held, for the memory account. */
    get byteLength(): number;
    mode(index: number): number;
    /** Whether the entry is outside the sparse checkout: in the index, skip-worktree, not written. */
    skipWorktree(index: number): boolean;
    path(index: number): string;
    pathBytesOf(index: number): Uint8Array;
    oidHex(index: number): string;
    oid(index: number): Uint8Array;
    /**
     * Each distinct blob, in walk order, and the entries it is checked out at.
     * Gitlinks name commits of another repository and are never fetched. A
     * skip-worktree entry is checked out nowhere; with `storeSkipped` a blob
     * only such entries name is kept, at no entries (fetched and stored, as a
     * clone that is not partial holds every object).
     */
    blobPaths(options?: {
        storeSkipped?: boolean;
    }): Map<string, number[]>;
    /** The distinct blobs not in `present`, split into at most `batches` runs (see the class comment). */
    batches(batches: number, present?: ReadonlySet<string>, options?: {
        storeSkipped?: boolean;
    }): BlobBatch[];
}
export interface BlobBatch {
    index: number;
    /** Each blob, and the plan entries (indices) it is checked out at: none for a blob only stored. */
    blobs: {
        oid: string;
        entries: number[];
    }[];
}
/**
 * A batch as one facet receives it: for each blob its id, then each path's
 * mode and repo-relative path (none: the blob is fetched and stored only).
 * [oid 20][paths u16]([mode u32][length u16][utf-8])*
 */
export declare function encodeBatch(plan: CheckoutPlan, batch: BlobBatch): Uint8Array;
export interface BatchPath {
    mode: number;
    path: string;
}
/** A batch's blobs, by hex id, each with the paths it is checked out at. */
export declare function decodeBatch(bytes: Uint8Array): Map<string, BatchPath[]>;
//# sourceMappingURL=plan.d.ts.map