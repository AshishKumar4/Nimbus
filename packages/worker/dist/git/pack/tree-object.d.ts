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
/** A tree entry as its tree holds it: its name's bytes, its canonical mode, its id's bytes. */
export interface RawTreeEntry {
    readonly name: Uint8Array;
    readonly mode: number;
    readonly oid: Uint8Array;
}
/** A tree's bytes, by its id. */
export type TreeReader = (oid: Uint8Array) => Promise<Uint8Array>;
/** `tree`'s entries, in its order, as views of its bytes. */
export declare function rawTreeEntries(tree: Uint8Array): RawTreeEntry[];
/**
 * A recursive tree diff (git's diff_tree_oid, no renames) of `from` to `to`
 * (null: the empty tree): `changed` gets each leaf (a file, a symlink, a
 * submodule) added, removed or modified (its id or mode), with its path and
 * each side's entry or null, in git's order; a directory one side alone holds
 * by each leaf below it. A tree both sides hold with the same id is never
 * read, the two roots too. A tree on one side and a leaf of its name on the
 * other sort apart (base_name_compare): each is its own change. Ends, false,
 * when `changed` answers false.
 */
export declare function diffTreeLeaves(read: TreeReader, from: Uint8Array | null, to: Uint8Array | null, changed: (path: Uint8Array, before: RawTreeEntry | null, after: RawTreeEntry | null) => boolean | Promise<boolean>): Promise<boolean>;
//# sourceMappingURL=tree-object.d.ts.map