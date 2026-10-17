/**
 * A filesystem held in memory: for tests, a bare embedder's /tmp, and
 * anything that needs a scratch tree with POSIX shape and no storage.
 *
 * Synchronous (its `sync` is itself), no credentials (one identity: its
 * entries carry the uid/gid given at construction), and its own revision per
 * entry so a cache over it can tell a change.
 */
import type { SyncVFS, VFS, VfsDirent, VfsStat } from './vfs.js';
import type { FsTime } from '@nimbus-sh/platform/w7-frame.js';
export declare class MemoryVFS implements VFS {
    private readonly owner;
    /** VFS.storesWrites: a regular file holds what it was written. */
    readonly storesWrites = true;
    private readonly root;
    private clock;
    private inos;
    readonly sync: SyncVFS;
    constructor(owner?: {
        uid: number;
        gid: number;
    });
    private entry;
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