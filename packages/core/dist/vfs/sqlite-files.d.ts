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
import type { CredentialedVfs, SqliteVFS } from './sqlite-vfs.js';
import type { SyncVFS, VFS, VfsCasResult, VfsChanges, VfsCred, VfsDirent, VfsRevision, VfsStat } from './vfs.js';
export declare class SqliteFiles implements VFS {
    private readonly engine;
    private readonly view;
    readonly sync: SyncVFS;
    /** The database's change feed, in this principal's view (names it could list). */
    readonly changes: VfsChanges;
    constructor(engine: SqliteVFS, view: CredentialedVfs);
    /** The engine's credentialed view this speaks for (for the engine's own callers). */
    get credentialed(): CredentialedVfs;
    as(cred: VfsCred): SqliteFiles;
    private run;
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
    mkdir(path: string, options?: {
        recursive?: boolean;
        mode?: number;
    }): void;
    unlink(path: string): void;
    rmdir(path: string): void;
    rename(from: string, to: string): void;
    removeRecursive(path: string): void;
    symlink(target: string, path: string): void;
    readlink(path: string): string;
    chmod(path: string, mode: number): void;
    chown(path: string, uid: number, gid: number): void;
    utimes(path: string, atimeMs: number, mtimeMs: number): void;
    /** Copy inside the database: rows, not bytes. */
    copy(from: string, to: string, options?: {
        recursive?: boolean;
        preserve?: boolean;
    }): number;
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