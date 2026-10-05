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
 */
export interface CacheTree {
    /** Index entries below this directory; -1 when the node is invalid. */
    count: number;
    /** The tree's id (hex) while valid. */
    oid: string | null;
    /** Subtrees in git's order: by name length, then name bytes (subtree_name_cmp). */
    subtrees: {
        name: Uint8Array;
        tree: CacheTree;
    }[];
}
/** cache_tree_read: the extension's bytes as a tree, or null when they do not parse (git then ignores them). */
export declare function parseCacheTree(bytes: Uint8Array): CacheTree | null;
/** write_one, root first: the extension's bytes. */
export declare function encodeCacheTree(root: CacheTree): Uint8Array;
/**
 * cache_tree_invalidate_path: every directory on `path` loses its tree id,
 * and a subtree at `path` itself goes, as git drops one a file replaces.
 */
export declare function invalidatePath(root: CacheTree, path: string): void;
/** A node's subtree `name` (null when absent): a walk's next step down. */
export declare function cacheSubtree(node: CacheTree | null, name: string): CacheTree | null;
/** Add `name`'s node under `parent` in its place (a fresh tree being built). */
export declare function addSubtree(parent: CacheTree, name: string, tree: CacheTree): void;
//# sourceMappingURL=cachetree.d.ts.map