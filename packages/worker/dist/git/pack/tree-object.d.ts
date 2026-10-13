/**
 * git/pack/tree-object.ts — a tree object's entries, as git's tree walk
 * decodes them (tree-walk.c decode_tree_entry): "<octal mode> <name>\0<id>"
 * each, in the tree's order.
 *
 * Every reader of a tree walks it here, one entry at a time, and makes what
 * it needs of the entry: its mode, as git's walk canonicalizes it
 * (canon_mode), and its name and id as spans of the tree's bytes, so a name
 * is never re-encoded. A malformed tree is git's error, and the walk always
 * ends: a tree whose last 21 bytes are not a NUL and an id holds no whole
 * entry.
 */
/**
 * A walk of `tree`: each next() reads one entry into mode, its name at
 * tree[nameAt, nameEnd) and its id at tree[oidAt, oidAt + OID_BYTES), and is
 * false past the last; git's error, thrown, for a malformed tree.
 */
export declare class TreeEntries {
    private readonly tree;
    mode: number;
    nameAt: number;
    nameEnd: number;
    oidAt: number;
    private at;
    constructor(tree: Uint8Array);
    next(): boolean;
}
//# sourceMappingURL=tree-object.d.ts.map