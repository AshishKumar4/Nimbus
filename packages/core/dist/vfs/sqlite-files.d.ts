/**
 * SqliteVFS as a `VFS`: what a CompositeVFS mounts.
 *
 * The engine keeps its own POSIX surface (CredentialedVfs, keys without a
 * leading slash, stat that throws); this is the same credentialed view
 * speaking the filesystem interface. It is synchronous (its `sync` is
 * itself), credentialed (`as(cred)` is another principal's view of the same
 * database), and revisioned: every stat carries the row's revision, so a
 * cache over it can see a change. Errors become VfsError with the engine's
 * code.
 */
import { type CredentialedVfs, type SqliteVFS } from './sqlite-vfs.js';
import type { SyncVFS, VFS, VfsCasResult, VfsChanges, VfsCopyOptions, VfsCred, VfsDirent, VfsOpenFile, VfsRemoval, VfsRevision, VfsStat, VfsViewOptions, VfsWriteObserver } from './vfs.js';
import { type VfsEvent } from './events.js';
import type { FsTime } from '../runtime/os-contracts.js';
export declare class SqliteFiles implements VFS {
    private readonly engine;
    private readonly view;
    /** VFS.storesWrites: a regular file holds what it was written. */
    readonly storesWrites = true;
    readonly sync: SyncVFS;
    /** The database's change feed, in this principal's view (names it could list). */
    readonly changes: VfsChanges;
    constructor(engine: SqliteVFS, view: CredentialedVfs);
    /** VFS.fileStore: the database, through every principal's view of it. */
    get fileStore(): object;
    /** The engine's credentialed view this speaks for (for the engine's own callers). */
    get credentialed(): CredentialedVfs;
    as(cred: VfsCred, actor?: string, options?: VfsViewOptions): SqliteFiles;
    /** Every mutation that lands on the database, through any view (SqliteVFS.observeWrites); paths absolute. */
    observeWrites(observer: VfsWriteObserver): () => void;
    /**
     * Every mutation that lands at `path` or under it, through any view, as
     * the one rule tells a watch (projectChange); paths absolute. The kernel
     * sees everywhere, and its names are the database's: its watch is the
     * engine's own stream, batched as it publishes (SqliteVFS.events). Any
     * other principal's is judged as each change is published, under its names
     * (CredentialedVfs.subscribe).
     */
    watchChanges(path: string, listener: (events: readonly VfsEvent[]) => void): () => void;
    /** `op`, its engine errors as Node's for `syscall` on `path` (and `dest`). */
    private run;
    stat(path: string, options?: {
        follow?: boolean;
    }): VfsStat | null;
    landedAt(path: string): boolean;
    readFile(path: string): Uint8Array;
    readRange(path: string, offset: number, length: number): Uint8Array;
    access(path: string, mode: number): void;
    /** The engine's own description of the file (its access the open's): its inode, whatever name it has later. */
    openFile(path: string, rights: {
        read: boolean;
        write: boolean;
    }): VfsOpenFile;
    writeFile(path: string, data: Uint8Array, options?: {
        mode?: number;
    }): void;
    writeRange(path: string, offset: number, bytes: Uint8Array): void;
    truncate(path: string, size: number): void;
    readdir(path: string): VfsDirent[];
    mkdir(path: string, options?: {
        recursive?: boolean;
        mode?: number;
    }): void;
    unlink(path: string): void;
    rmdir(path: string): void;
    rename(from: string, to: string): void;
    /** rm -r, with its report (SqliteVFS's, the walk's own result). */
    removeRecursive(path: string, options?: {
        keepVanishedAncestors?: boolean;
    }): VfsRemoval;
    symlink(target: string, path: string): void;
    readlink(path: string): string;
    chmod(path: string, mode: number): void;
    chown(path: string, uid: number | null, gid: number | null): void;
    utimes(path: string, atime: FsTime, mtime: FsTime): void;
    /** Copy inside the database: rows, not bytes. */
    copy(from: string, to: string, options?: VfsCopyOptions): number;
    /**
     * Compare-and-write against the row's revision, in one synchronous step:
     * nothing can commit between the check and the write, because both run in
     * this isolate's turn on the same database.
     */
    writeFileIfRevision(path: string, data: Uint8Array, expected: VfsRevision): VfsCasResult;
    describe(): {
        source: string;
        type: string;
        options: readonly ["rw"];
    };
}
/** The database as `cred` sees it, as a VFS. */
export declare function sqliteFiles(engine: SqliteVFS, cred: VfsCred): SqliteFiles;
//# sourceMappingURL=sqlite-files.d.ts.map