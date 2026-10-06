/**
 * git/worktree/cachetree.ts — the index's TREE extension (cache-tree.c): for
 * each directory, how many index entries it covers and, while still valid,
 * the id of the tree those entries make.
 *
 * A valid node whose id is the id of a tree being compared with the index
 * says, without reading it, that the tree and that run of entries agree: a
 * status or diff against HEAD skips the subtree. Commit writes the whole
 * tree; anything that changes an entry invalidates the nodes on its path
 * (cache_tree_invalidate_path), so the rest stays usable.
 *
 * The extension stays its own bytes. Reading it builds a table of where each
 * node lies, a few integers a node and no object, as next.js has 17,000
 * directories: as objects, its cache tree was 11 MiB of heap. A walk asks
 * for one node's subtrees at a time; a write rewrites the bytes in one pass.
 */
/** One subtree being built: its name and its bytes as written (name first). */
export interface BuiltSubtree {
    name: Uint8Array;
    bytes: Uint8Array;
}
/**
 * A node's bytes as written: `count` -1 for an invalid node (no id), its
 * subtrees (each already written) in git's order. The root's name is ''.
 */
export declare function encodeNode(name: string, count: number, oid: string | null, subtrees: BuiltSubtree[]): BuiltSubtree;
/**
 * The extension read: where each node lies, in the order written (root
 * first, each node before its subtrees).
 */
export declare class CacheTree {
    readonly bytes: Uint8Array;
    /** Per node: where its name starts and ends, its count, where its id is (-1: invalid), its subtrees, the node after its last descendant. */
    private readonly nameAt;
    private readonly nameEnd;
    private readonly counts;
    private readonly oidAt;
    private readonly subtreeCounts;
    private readonly ends;
    private constructor();
    /** cache_tree_read: the table, or null when the bytes do not parse (git then ignores them). */
    static parse(bytes: Uint8Array): CacheTree | null;
    /** The root node. */
    get root(): number;
    /** Node `node`'s entry count, -1 when it is invalid. */
    count(node: number): number;
    /** Node `node`'s tree id while valid, else null. */
    oid(node: number): string | null;
    /** Node `node` as written, its subtrees with it: a subtree a walk keeps whole. */
    nodeBytes(node: number): BuiltSubtree;
    /** Node `node`'s subtrees by name: asked for once per directory a walk enters, and dropped with it. */
    subtrees(node: number): Map<string, number>;
    private child;
    /**
     * cache_tree_invalidate_path for each of `paths`: every directory on a
     * path loses its tree id, and a subtree at the path itself goes, as git
     * drops one a file replaces. The extension rewritten, or these bytes when
     * nothing changed.
     */
    invalidate(paths: Iterable<string>): Uint8Array;
}
//# sourceMappingURL=cachetree.d.ts.map