/**
 * git/worktree/tree.ts — trees read one at a time, and written from the index.
 *
 * A tree is read when the walk reaches it and dropped when the walk leaves
 * it, so a walk holds the trees along one path. Objects come through the
 * repository's store (loose, else the ranged pack store). Writing a commit's
 * trees from the index keeps one tree open per directory level, and writes
 * only the trees no store already holds.
 */
import { oidFromHex, oidToHex } from '../pack/format.js';
import { concatBytes } from '@nimbus-sh/core/_shared/bytes.js';
import { diffTreeLeaves, TreeEntries } from '../pack/tree-object.js';
import { encodeNode } from './cachetree.js';
import { S_IFMT, decodePath } from './dircache.js';
export const S_IFDIR = 0o040000;
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const encoder = new TextEncoder();
/** The tree a tree-ish names: a commit's, or the tree itself. */
export async function treeOf(store, oid) {
    for (;;) {
        if (oid === EMPTY_TREE)
            return oid;
        const { type, data } = await store.read(oid);
        if (type === 'tree')
            return oid;
        if (type === 'commit')
            return new TextDecoder().decode(data.subarray(5, 45));
        if (type !== 'tag')
            throw new Error(`object ${oid} is a ${type}, not a tree`);
        // An annotated tag names its object on its first line.
        oid = new TextDecoder().decode(data.subarray(7, 47));
    }
}
export async function readTree(store, oid) {
    if (oid === EMPTY_TREE)
        return [];
    const { type, data } = await store.read(oid);
    if (type !== 'tree')
        throw new Error(`object ${oid} is a ${type}, not a tree`);
    const entries = [];
    for (const e = new TreeEntries(data); e.next();)
        entries.push({ name: decodePath(data.subarray(e.nameAt, e.nameEnd)), mode: e.mode, oid: oidToHex(data, e.oidAt) });
    return entries;
}
const isTree = (mode) => (mode & S_IFMT) === S_IFDIR;
/**
 * Every leaf below `tree` in path order (git's index order), reading a tree
 * as the walk enters it. `within` prunes: a directory is entered only when
 * it answers true for it.
 */
export async function* treeLeaves(store, tree, prefix = '', within = () => true) {
    for (const entry of await readTree(store, tree)) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (isTree(entry.mode)) {
            if (within(path))
                yield* treeLeaves(store, entry.oid, path, within);
        }
        else {
            yield { path, mode: entry.mode, oid: entry.oid };
        }
    }
}
/** A tree path's bytes as treeLeaves names it: each name decoded on its own, as readTree decodes it. */
function decodeTreePath(raw) {
    let path = '';
    for (let start = 0;;) {
        const end = raw.indexOf(0x2f, start);
        const name = decodePath(raw.subarray(start, end === -1 ? raw.length : end));
        path = path ? `${path}/${name}` : name;
        if (end === -1)
            return path;
        start = end + 1;
    }
}
/**
 * diff-tree -r of two trees (null for none), as pack/tree-object.ts
 * diffTreeLeaves walks it: `visit` gets every leaf path whose entry
 * differs, with each side's leaf or null. A subtree both sides hold with the
 * same id is never read. Names that are not UTF-8 can decode alike: their
 * one path comes once for each.
 */
export async function diffTrees(store, from, to, visit) {
    const read = async (oid) => {
        const hex = oidToHex(oid);
        if (hex === EMPTY_TREE)
            return new Uint8Array(0);
        const { type, data } = await store.read(hex);
        if (type !== 'tree')
            throw new Error(`object ${hex} is a ${type}, not a tree`);
        return data;
    };
    const leaf = (path, entry) => (entry === null ? null : { path, mode: entry.mode, oid: oidToHex(entry.oid) });
    await diffTreeLeaves(read, from === null ? null : oidFromHex(from), to === null ? null : oidFromHex(to), async (raw, before, after) => {
        const path = decodeTreePath(raw);
        await visit(path, leaf(path, before), leaf(path, after));
        return true;
    });
}
function treeLine(mode, name, oid) {
    const head = encoder.encode(`${mode.toString(8)} ${name}\0`);
    const out = new Uint8Array(head.length + 20);
    out.set(head);
    out.set(oid, head.length);
    return out;
}
/**
 * write-tree: the index's stage-0 entries as trees, and the cache tree that
 * records them (every node valid), as the TREE extension's bytes. Entries
 * come in index order, which within one directory is tree order, so each
 * tree is complete the moment the walk leaves it.
 */
export async function writeTreeFromIndex(store, dc) {
    const open = (dir) => ({ dir, parts: [], count: 0, subtrees: [] });
    const frames = [open('')];
    const close = async () => {
        const frame = frames.pop();
        const oid = await store.write('tree', concatBytes(frame.parts));
        const parent = frames[frames.length - 1];
        const name = frame.dir.slice(parent.dir ? parent.dir.length + 1 : 0);
        parent.parts.push(treeLine(S_IFDIR, name, oidFromHex(oid)));
        parent.count += frame.count;
        parent.subtrees.push(encodeNode(name, frame.count, oid, frame.subtrees));
    };
    for (let i = 0; i < dc.count; i++) {
        if (dc.stage(i) !== 0 || dc.intentToAdd(i))
            continue;
        const path = dc.path(i);
        const cut = path.lastIndexOf('/');
        const dir = cut < 0 ? '' : path.slice(0, cut);
        while (frames.length > 1 && dir !== frames[frames.length - 1].dir && !dir.startsWith(`${frames[frames.length - 1].dir}/`)) {
            await close();
        }
        for (let top = frames[frames.length - 1].dir; top !== dir;) {
            const next = dir.indexOf('/', top ? top.length + 1 : 0);
            top = next < 0 ? dir : dir.slice(0, next);
            frames.push(open(top));
        }
        const frame = frames[frames.length - 1];
        frame.parts.push(treeLine(dc.mode(i), path.slice(cut + 1), dc.oidBytes(i).slice()));
        frame.count++;
    }
    while (frames.length > 1)
        await close();
    const root = frames[0];
    const oid = await store.write('tree', concatBytes(root.parts));
    return { oid, cacheTree: encodeNode('', root.count, oid, root.subtrees).bytes };
}
