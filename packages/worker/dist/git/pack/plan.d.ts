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
 */
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
export declare class CheckoutPlan {
    readonly count: number;
    private readonly oids;
    private readonly modes;
    private readonly pathStarts;
    private readonly pathBytes;
    private constructor();
    /** Walk `rootTree`'s tree, each subtree read with `tree(oid)`; a path is kept when `keep` says so. */
    static fromTrees(rootTree: Uint8Array, tree: (oid: Uint8Array, at: number) => Uint8Array, keep?: (path: string, mode: number) => boolean): CheckoutPlan;
    /** Bytes held, for the memory account. */
    get byteLength(): number;
    mode(index: number): number;
    path(index: number): string;
    pathBytesOf(index: number): Uint8Array;
    oidHex(index: number): string;
    oid(index: number): Uint8Array;
    /**
     * Each distinct blob, in walk order, and the entries it is checked out at.
     * Gitlinks name commits of another repository and are never fetched.
     */
    blobPaths(): Map<string, number[]>;
    /** The distinct blobs not in `present`, split into at most `batches` runs (see the class comment). */
    batches(batches: number, present?: ReadonlySet<string>): BlobBatch[];
}
export interface BlobBatch {
    index: number;
    /** Each blob, and the plan entries (indices) it is checked out at. */
    blobs: {
        oid: string;
        entries: number[];
    }[];
}
/**
 * A batch as one facet receives it: for each blob its id, then each path's
 * mode and repo-relative path. [oid 20][paths u16]([mode u32][length u16][utf-8])*
 */
export declare function encodeBatch(plan: CheckoutPlan, batch: BlobBatch): Uint8Array;
export interface BatchPath {
    mode: number;
    path: string;
}
/** A batch's blobs, by hex id, each with the paths it is checked out at. */
export declare function decodeBatch(bytes: Uint8Array): Map<string, BatchPath[]>;
//# sourceMappingURL=plan.d.ts.map