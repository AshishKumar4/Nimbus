import type { SyncVFS, VFS, VfsChanges, VfsDirent, VfsStat } from './vfs.js';
import type { FsTime } from '@nimbus-sh/platform/w7-frame.js';
export declare class MemoryVFS implements VFS {
    private readonly owner;
    /** VFS.storesWrites: a regular file holds what it was written. */
    readonly storesWrites = true;
    private readonly root;
    private clock;
    private inos;
    /** Entries in its tree, its root among them: what bounds its tombstones. */
    private count;
    /** Each changed path's newest change (absolute), in the order of their revisions; `gone`: a removal. */
    private readonly changed;
    private tombstones;
    /** The newest pruned removal's revision: a cursor below it is a poison. */
    private floor;
    private listed;
    private readonly epoch;
    readonly sync: SyncVFS;
    readonly changes: VfsChanges;
    constructor(owner?: {
        uid: number;
        gid: number;
    });
    private entry;
    /** What changed since `cursor` of `epoch`: each path's newest change after it, with its lstat now where `stats`. */
    private since;
    /**
     * The name in the tree `path` leads to, as find walks it: each link on the
     * way followed, a final one where `follow`; where a name on the way is
     * missing, the rest as spelled.
     */
    private treePath;
    /** The tree name of `path`'s directory, as parentOf finds it (its links followed). */
    private treeParent;
    /**
     * The tree name `key` changed now (treePath, treeParent: a change through a
     * link is its target's). `structural`: a directory removed, moved or given
     * another mode; `gone`: nothing is there.
     */
    private note;
    /** The entries `entry` holds, itself among them. */
    private static sizeOf;
    private touch;
    /** The entry at `path`, following symlinks except a final one when `follow` is false; `call` names a failure. */
    private find;
    private parentOf;
    /** VFS.fileStore: its tree, whichever object (a wrapper of it) is asked. */
    get fileStore(): object;
    private stats;
    private file;
    stat(path: string, options?: {
        follow?: boolean;
    }): VfsStat | null;
    readFile(path: string): Uint8Array;
    readRange(path: string, offset: number, length: number): Uint8Array;
    writeFile(path: string, data: Uint8Array, options?: {
        mode?: number;
    }): void;
    writeRange(path: string, offset: number, bytes: Uint8Array): void;
    truncate(path: string, size: number): void;
    readdir(path: string): VfsDirent[];
    /** With `recursive`, the directories it made, top down (VFS.mkdir). */
    mkdir(path: string, options?: {
        recursive?: boolean;
        mode?: number;
    }): readonly string[] | void;
    unlink(path: string): void;
    rmdir(path: string): void;
    removeRecursive(path: string): void;
    /**
     * POSIX rename(2): a file target is replaced; a directory replaces an empty
     * directory; onto itself, nothing changes.
     */
    rename(from: string, to: string): void;
    symlink(target: string, path: string): void;
    readlink(path: string): string;
    chmod(path: string, mode: number): void;
    /** Its entries keep an mtime alone: the atime is taken and dropped. */
    utimes(path: string, _atime: FsTime, mtime: FsTime): void;
    describe(): {
        source: string;
        type: string;
        options: string[];
    };
}
//# sourceMappingURL=memory.d.ts.map