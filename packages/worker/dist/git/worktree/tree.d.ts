/**
 * git/worktree/tree.ts — trees read one at a time, and written from the index.
 *
 * A tree is read when the walk reaches it and dropped when the walk leaves
 * it, so a walk holds the trees along one path. Objects come through the
 * repository's store (loose, else the ranged pack store). Writing a commit's
 * trees from the index keeps one tree open per directory level, and writes
 * only the trees no store already holds.
 */
import { type CacheTree } from './cachetree.js';
import { DirCache } from './dircache.js';
export declare const S_IFDIR = 16384;
export declare const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
/** The object calls trees, commits and staging make. */
export interface ObjectStore {
    read(oid: string): Promise<{
        type: string;
        data: Uint8Array;
    }>;
    /** Whether the repository holds `oid`, loose or packed. */
    has(oid: string): Promise<boolean>;
    /** Write an object the repository does not hold yet; its id either way. */
    write(type: 'blob' | 'tree' | 'commit', data: Uint8Array): Promise<string>;
    /** Fetch in one request those of `oids` a partial clone lacks, before they are read one at a time. */
    prefetch(oids: Iterable<string>): Promise<void>;
}
export interface TreeEntry {
    name: string;
    mode: number;
    oid: string;
}
/** A leaf below a tree: a file, a link or a gitlink, at its repo-relative path. */
export interface Leaf {
    path: string;
    mode: number;
    oid: string;
}
/** A tree object's entries, in the tree's own order. */
export declare function parseTree(data: Uint8Array): TreeEntry[];
/** The tree a tree-ish names: a commit's, or the tree itself. */
export declare function treeOf(store: ObjectStore, oid: string): Promise<string>;
export declare function readTree(store: ObjectStore, oid: string): Promise<TreeEntry[]>;
/**
 * Every leaf below `tree` in path order (git's index order), reading a tree
 * as the walk enters it. `within` prunes: a directory is entered only when
 * it answers true for it.
 */
export declare function treeLeaves(store: ObjectStore, tree: string, prefix?: string, within?: (dir: string) => boolean): AsyncGenerator<Leaf>;
/**
 * diff-tree -r of two trees (null for none): `visit` gets every leaf path
 * whose entry differs, with each side's leaf or null. A subtree both sides
 * hold with the same id is never read.
 */
export declare function diffTrees(store: ObjectStore, from: string | null, to: string | null, visit: (path: string, before: Leaf | null, after: Leaf | null) => Promise<void>, prefix?: string): Promise<void>;
/**
 * write-tree: the index's stage-0 entries as trees, and the cache tree that
 * records them (every node valid). Entries come in index order, which
 * within one directory is tree order, so each tree is complete the moment
 * the walk leaves it.
 */
export declare function writeTreeFromIndex(store: ObjectStore, dc: DirCache): Promise<{
    oid: string;
    cacheTree: CacheTree;
}>;
//# sourceMappingURL=tree.d.ts.map