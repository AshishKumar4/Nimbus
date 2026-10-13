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
import { OID_BYTES } from './format.js';
/**
 * A walk of `tree`: each next() reads one entry into mode, its name at
 * tree[nameAt, nameEnd) and its id at tree[oidAt, oidAt + OID_BYTES), and is
 * false past the last; git's error, thrown, for a malformed tree.
 */
export class TreeEntries {
    tree;
    mode = 0;
    nameAt = 0;
    nameEnd = 0;
    oidAt = 0;
    at = 0;
    constructor(tree) {
        this.tree = tree;
        const end = tree.byteLength;
        // Each name ends at a NUL at or before this one, so no name or id runs past the tree.
        if (end > 0 && (end < OID_BYTES + 3 || tree[end - OID_BYTES - 1] !== 0))
            throw new Error('too-short tree object');
    }
    next() {
        const tree = this.tree;
        let p = this.at;
        if (p === tree.byteLength)
            return false;
        if (tree.byteLength - p < OID_BYTES + 3)
            throw new Error('too-short tree object');
        if (tree[p] === 0x20)
            throw new Error('malformed mode in tree entry');
        // git keeps 16 bits of the mode.
        let mode = 0;
        for (let c = tree[p++]; c !== 0x20; c = tree[p++]) {
            if (c < 0x30 || c > 0x37)
                throw new Error('malformed mode in tree entry');
            mode = ((mode << 3) | (c - 0x30)) & 0xffff;
        }
        if (tree[p] === 0)
            throw new Error('empty filename in tree entry');
        // The NUL at the tree's end - 21 ends the scan at the latest.
        let nameEnd = p;
        while (tree[nameEnd] !== 0)
            nameEnd++;
        // canon_mode: a file 100644 or 100755, a link, a tree, and anything else a gitlink.
        const type = mode & 0o170000;
        this.mode = type === 0o100000 ? (mode & 0o100 ? 0o100755 : 0o100644) : type === 0o120000 || type === 0o040000 ? type : 0o160000;
        this.nameAt = p;
        this.nameEnd = nameEnd;
        this.oidAt = nameEnd + 1;
        this.at = nameEnd + 1 + OID_BYTES;
        return true;
    }
}
