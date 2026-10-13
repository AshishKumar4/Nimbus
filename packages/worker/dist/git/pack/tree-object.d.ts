/**
 * git/pack/tree-object.ts — a tree object's entries, as git's tree walk
 * decodes them (tree-walk.c decode_tree_entry): "<octal mode> <name>\0<id>"
 * each, in the tree's order.
 *
 * Every reader of a tree decodes it here, each making its own entry from the
 * entry's mode, as git's walk canonicalizes it (canon_mode), and its name and
 * id as spans of the tree's bytes, so a name is never re-encoded. A malformed
 * tree is git's error, and the decoding always ends: a tree whose last 21
 * bytes are not a NUL and an id holds no whole entry.
 */
/**
 * A tree object's entries, in its order, each as `entry` makes it from its
 * mode, its id at tree[oidAt, oidAt + OID_BYTES) and its name at
 * tree[nameAt, nameEnd); git's error, thrown, for a malformed tree.
 */
export declare function decodeTree<T>(tree: Uint8Array, entry: (mode: number, oidAt: number, nameAt: number, nameEnd: number) => T): T[];
//# sourceMappingURL=tree-object.d.ts.map