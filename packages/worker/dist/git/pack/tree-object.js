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
const MODE_TREE = 0o040000;
const EMPTY_PATH = new Uint8Array(0);
/** `tree`'s entries, in its order, as views of its bytes. */
export function rawTreeEntries(tree) {
    const entries = [];
    for (const e = new TreeEntries(tree); e.next();)
        entries.push({ name: tree.subarray(e.nameAt, e.nameEnd), mode: e.mode, oid: tree.subarray(e.oidAt, e.oidAt + OID_BYTES) });
    return entries;
}
const isTreeMode = (mode) => (mode & 0o170000) === MODE_TREE;
/** base_name_compare: names by bytes, a tree's as if it ended in '/'. */
function compareRawEntries(a, b) {
    const n = Math.min(a.name.byteLength, b.name.byteLength);
    for (let i = 0; i < n; i++)
        if (a.name[i] !== b.name[i])
            return a.name[i] - b.name[i];
    const ca = a.name.byteLength > n ? a.name[n] : isTreeMode(a.mode) ? 0x2f : 0;
    const cb = b.name.byteLength > n ? b.name[n] : isTreeMode(b.mode) ? 0x2f : 0;
    return ca - cb;
}
function joinPath(base, name) {
    if (base.byteLength === 0)
        return name;
    const out = new Uint8Array(base.byteLength + 1 + name.byteLength);
    out.set(base);
    out[base.byteLength] = 0x2f;
    out.set(name, base.byteLength + 1);
    return out;
}
function sameOid(a, b) {
    for (let i = 0; i < OID_BYTES; i++)
        if (a[i] !== b[i])
            return false;
    return true;
}
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
export async function diffTreeLeaves(read, from, to, changed) {
    // One entry's change below `base`: a tree's leaves, or itself.
    const entry = (base, named, before, after) => {
        const path = joinPath(base, named.name);
        return isTreeMode(named.mode) ? walk(before?.oid ?? null, after?.oid ?? null, path) : changed(path, before, after);
    };
    const walk = async (a, b, base) => {
        if (a !== null && b !== null && sameOid(a, b))
            return true;
        const left = a === null ? [] : rawTreeEntries(await read(a));
        const right = b === null ? [] : rawTreeEntries(await read(b));
        let i = 0;
        let j = 0;
        while (i < left.length || j < right.length) {
            const cmp = i >= left.length ? 1 : j >= right.length ? -1 : compareRawEntries(left[i], right[j]);
            if (cmp < 0) {
                const l = left[i++];
                if (!(await entry(base, l, l, null)))
                    return false;
            }
            else if (cmp > 0) {
                const r = right[j++];
                if (!(await entry(base, r, null, r)))
                    return false;
            }
            else {
                const l = left[i++];
                const r = right[j++];
                if (l.mode === r.mode && sameOid(l.oid, r.oid))
                    continue;
                if (!(await entry(base, l, l, r)))
                    return false;
            }
        }
        return true;
    };
    return walk(from, to, EMPTY_PATH);
}
