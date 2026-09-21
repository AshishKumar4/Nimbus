import { type CredentialedVfs, type SqliteVFS, type VfsOpenDescription } from '../vfs/sqlite-vfs.js';
import type { VFS } from '../substrate/lifo/kernel/vfs/index.js';
import type { RuntimeFileHandle, RuntimeFsPath, RuntimeReadOptions, RuntimeSynchronousFs, RuntimeFsBridge, RuntimeOpenFlags, RuntimeVfsDirEntry, RuntimeVfsStat, VfsAcquireResult, VfsListPage, VfsMutationReceipt } from './os-contracts.js';
interface OpenDescription {
    handle: RuntimeFileHandle;
    node: VfsOpenDescription;
    refs: number;
}
export interface SqliteDescriptorScope {
    nextId: number;
    handles: Map<number, OpenDescription>;
    closed: boolean;
    /** Aborted when the scope closes; cancels in-flight stream commits. */
    abort: AbortController;
    subscriptions: Set<() => void>;
}
export declare function createSqliteDescriptorScope(): SqliteDescriptorScope;
export declare class SqliteRuntimeFsBridge implements RuntimeFsBridge {
    private readonly rawVfs;
    private readonly scope;
    private readonly getKernel?;
    readonly synchronous: RuntimeSynchronousFs;
    private legacySymlinks;
    private readonly vfs;
    constructor(vfs: CredentialedVfs, rawVfs: SqliteVFS, scope?: SqliteDescriptorScope, getKernel?: (() => VFS | undefined) | undefined);
    private get kernel();
    dispose(): void;
    /**
     * Where a path lives, decided only after confinement: a kernel mount is
     * consulted with the fully resolved path, so a `..` or an absolute path
     * inside a capability can never reach `/proc` or `/dev` sideways.
     */
    private locate;
    private virtualStat;
    /** SQLite stores no row for the namespace root; it is the one directory that always exists. */
    private rootStat;
    stat(path: RuntimeFsPath, options?: {
        followSymlinks?: boolean;
    }): RuntimeVfsStat | null;
    readFile(path: RuntimeFsPath, options?: {
        followSymlinks?: boolean;
    }): Uint8Array | null;
    writeFile(path: RuntimeFsPath, bytes: string | Uint8Array, options?: {
        createParents?: boolean;
        expectedRevision?: number;
    }): number;
    readRange(path: RuntimeFsPath, offset: number, length: number, options?: RuntimeReadOptions): Uint8Array | null;
    writeRange(path: RuntimeFsPath, offset: number, bytes: Uint8Array, options?: {
        createParents?: boolean;
        expectedRevision?: number;
    }): VfsMutationReceipt;
    appendOnce(path: RuntimeFsPath, pid: number, writerId: string, moduleId: string, operationId: number, digest: string, bytes: Uint8Array): number;
    acknowledgeAppend(pid: number, writerId: string, moduleId: string, operationId: number): void;
    truncate(path: RuntimeFsPath, size: number, options?: {
        followSymlinks?: boolean;
    }): VfsMutationReceipt;
    utimes(path: RuntimeFsPath, atimeMs: number, mtimeMs: number, options?: {
        followSymlinks?: boolean;
    }): VfsMutationReceipt;
    chmod(path: RuntimeFsPath, mode: number): VfsMutationReceipt;
    access(path: RuntimeFsPath, mode: number): void;
    chown(path: RuntimeFsPath, uid: number, gid: number, options?: {
        followSymlinks?: boolean;
    }): VfsMutationReceipt;
    open(path: RuntimeFsPath, flags: RuntimeOpenFlags): RuntimeFileHandle;
    read(handleId: number, offset: number | null, length: number): Uint8Array;
    write(handleId: number, offset: number | null, bytes: Uint8Array): number;
    close(handleId: number): void;
    readdir(path: RuntimeFsPath, options?: {
        followSymlinks?: boolean;
    }): RuntimeVfsDirEntry[];
    mkdir(path: RuntimeFsPath, options?: {
        recursive?: boolean;
        mode?: number;
    }): void;
    unlink(path: RuntimeFsPath): void;
    rmdir(path: RuntimeFsPath): void;
    rename(from: RuntimeFsPath, to: RuntimeFsPath): void;
    readlink(path: RuntimeFsPath): string | null;
    symlink(target: string, path: RuntimeFsPath): void;
    fsync(handleId?: number): void;
    revision(path?: RuntimeFsPath): number;
    acquire(epoch: string | null, cursor: number): VfsAcquireResult;
    list(after?: string | null, limit?: number): VfsListPage;
    subscribe(path: string, listener: Parameters<NonNullable<RuntimeFsBridge['subscribe']>>[1]): () => void;
    realpath(path: RuntimeFsPath): string;
    remove(path: RuntimeFsPath, options?: {
        recursive?: boolean;
        force?: boolean;
    }): void;
    copyFile(from: RuntimeFsPath, to: RuntimeFsPath): void;
    writeBatch(payload: Parameters<CredentialedVfs['writeBatch']>[0]): {
        inodes: number;
        chunks: number;
    };
    writeStream(stream: ReadableStream<Uint8Array>, options?: Parameters<CredentialedVfs['writeStream']>[1]): Promise<import("../vfs/sqlite-vfs.js").WriteBatchStreamResult>;
    acquireExclusiveMutation(path: RuntimeFsPath, options?: {
        includeMissingAncestors?: boolean;
    }): import("../vfs/sqlite-vfs.js").ExclusiveMutationLease;
    releaseExclusiveMutation(owner: string): void;
    private pathArgument;
    private resolveDataPath;
    private locateMutation;
    /** Operations with SQLite-only semantics (journals, atomic renames, mutation leases) refuse kernel mounts. */
    private sqlitePath;
    private openRoot;
    private openMount;
    private ensureParent;
    private assertParentDirectory;
    /**
     * Run one mutation of storage path `p` and report its revision on either
     * side, both read in the mutation's own synchronous turn: across an await
     * either would report a peer's clock as ours.
     */
    private receipted;
    /** A mount never moves the raw clock, and ACQUIRE never lists its paths. */
    private mountReceipt;
    private assertExpectedRevision;
    private description;
    private getHandle;
    fstat(handleId: number): RuntimeVfsStat;
    dup(handleId: number): RuntimeFileHandle;
    seek(handleId: number, offset: number, whence: 'set' | 'current' | 'end'): number;
    setStatus(handleId: number, status: {
        append?: boolean;
    }): void;
    readdirHandle(handleId: number): RuntimeVfsDirEntry[];
    ftruncate(handleId: number, size: number): void;
    fchmod(handleId: number, mode: number): void;
    fchown(handleId: number, uid: number, gid: number): void;
    futimes(handleId: number, atime: number, mtime: number): void;
}
export {};
//# sourceMappingURL=sqlite-runtime-fs-bridge.d.ts.map