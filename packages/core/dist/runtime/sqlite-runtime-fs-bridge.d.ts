import { type CredentialedVfs, type SqliteVFS, type VfsOpenDescription } from '../vfs/sqlite-vfs.js';
import { type CompositeVFS } from '../vfs/composite.js';
import type { RuntimeFileHandle, RuntimeFsPath, RuntimeReadOptions, RuntimeSynchronousFs, RuntimeFsBridge, RuntimeOpenFlags, RuntimeVfsDirEntry, RuntimeVfsStat, VfsAcquireOptions, VfsAcquireResult, VfsListPage, VfsMutationReceipt } from './os-contracts.js';
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
    private readonly namespace?;
    /** A stable inode number for a mounted entry whose backend keeps none (shared across the session's bridges). */
    /** Bytes one buffered handle may hold before a write is EFBIG. */
    private readonly bufferedWriteBytes;
    readonly synchronous: RuntimeSynchronousFs;
    private legacySymlinks;
    private readonly vfs;
    /** The namespace as this caller sees it: what a path off the SQLite root reaches. */
    private readonly mounted;
    constructor(vfs: CredentialedVfs, rawVfs: SqliteVFS, scope?: SqliteDescriptorScope, namespace?: CompositeVFS | undefined, 
    /** A stable inode number for a mounted entry whose backend keeps none (shared across the session's bridges). */
    /** Bytes one buffered handle may hold before a write is EFBIG. */
    bufferedWriteBytes?: number);
    /**
     * The legacy registry's key for one of this caller's names. Its entries are
     * keyed by storage key, so a confined caller's /tmp/x is its own, and an
     * entry in the shared tmp is not its to see, follow or remove.
     */
    private legacyKey;
    dispose(): void;
    /**
     * Where a path lives, decided only after confinement: the namespace is
     * consulted with the fully resolved path, so a `..` or an absolute path
     * inside a capability can never reach `/proc` or `/dev` sideways.
     */
    private locate;
    /**
     * The path resolved in one walk on SQLite (SqliteVFS.resolveName), or null
     * for the walk component by component (resolveDataPath): for a walk
     * beneath a root, for a spelling with `..` (that walk takes `..`
     * physically, after the link before it, where the engine's names take it
     * lexically), where the namespace lays a mount or a directory above one,
     * and where a name is missing while the legacy registry could hold a link
     * there.
     */
    private walkOnSqlite;
    /** A mounted entry's stat in this contract's shape; a mount never moves the SQLite clock. */
    private virtualStat;
    /** SQLite stores no row for the namespace root; it is the one directory that always exists. */
    private rootStat;
    stat(path: RuntimeFsPath, options?: {
        followSymlinks?: boolean;
    }): RuntimeVfsStat | null;
    readFile(path: RuntimeFsPath, options?: {
        followSymlinks?: boolean;
    }): Uint8Array | null;
    /**
     * A mounted file as this process sees it while it holds buffered writes to
     * it (VFS-PF-001 viewAs, page-cache semantics): the mount's file with each
     * of this process's descriptions of it applied, in open order. Undefined
     * when it holds none pending: then the mount's own file is the answer.
     * Another process's pending writes are never in it.
     */
    private processView;
    writeFile(path: RuntimeFsPath, bytes: string | Uint8Array, options?: {
        createParents?: boolean;
        expectedRevision?: number;
    }): number;
    writeFileFrom(path: RuntimeFsPath, size: number, source: AsyncIterable<Uint8Array>): Promise<number>;
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
    utimes(path: RuntimeFsPath, atimeMs: number | null | undefined, mtimeMs: number | null | undefined, options?: {
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
    /**
     * Every per-path revision here is the caller's: `p` is its own name for a
     * path, and a confined caller's /tmp/x is its private file, whose revision
     * is not the shared tmp/x's. The global clock is everyone's.
     */
    revision(path?: RuntimeFsPath): number;
    acquire(epoch: string | null, cursor: number, options?: VfsAcquireOptions): VfsAcquireResult;
    list(after?: string | null, limit?: number): VfsListPage;
    /** A watch in the caller's view: its files, under its names, only those it could list. */
    subscribe(path: string, listener: Parameters<NonNullable<RuntimeFsBridge['subscribe']>>[1]): () => void;
    realpath(path: RuntimeFsPath): string;
    remove(path: RuntimeFsPath, options?: {
        recursive?: boolean;
        force?: boolean;
    }): void;
    copyFile(from: RuntimeFsPath, to: RuntimeFsPath): void;
    copyTree(from: RuntimeFsPath, to: RuntimeFsPath, options?: {
        preserve?: boolean;
    }): Promise<number>;
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
    /** A mounted (or composed) entry's link target, or null when it is not a link or not there. */
    private mountedLink;
    /** `call`: the syscall a refusal names, or the whole call when it names two paths. */
    private locateMutation;
    /** Operations with SQLite-only semantics (journals, atomic renames, mutation leases) refuse kernel mounts. */
    private sqlitePath;
    private openRoot;
    private openMount;
    /**
     * A mount that cannot write in place (no writeRange): the handle buffers
     * its writes, at most `bufferedWriteBytes` (EFBIG past it, nothing
     * buffered), and a flush (fsync, the last close, the process's release)
     * reads the file, applies them in order and writes it back.
     */
    private buffer;
    private ensureParent;
    /** ENOENT or ENOTDIR for `call` when `path`'s parent is missing or not a directory. */
    private assertParentDirectory;
    /**
     * Run one mutation of path `p` and report its revision on either side,
     * both read in the mutation's own synchronous turn: across an await either
     * would report a peer's clock as ours.
     */
    private receipted;
    /** A mount never moves the raw clock, and ACQUIRE never lists its paths. */
    private mountReceipt;
    private assertExpectedRevision;
    private description;
    private getHandle;
    /** The absolute path a descriptor was opened at. */
    descriptorPath(handleId: number): string;
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
/** One lookup a walk beneath a root asks of its filesystem: a stat that does not follow a link (null when absent), or a link's target. */
export type BeneathLookup = {
    readonly stat: string;
} | {
    readonly readlink: string;
};
type BeneathAnswer = {
    type: string;
    mode?: number;
    uid?: number;
    gid?: number;
} | string | null;
/**
 * A lookup beneath `root` (RESOLVE_BENEATH, a WASI preopen), as the
 * namespace walk does it (VFS-COMP-006): the root must be reachable (every
 * directory above it searchable); an absolute path, `..` at the root, and any
 * absolute link are ENOTCAPABLE; each component needs the directory it leaves
 * to be a searchable directory; a missing component is ENOENT unless it is
 * the last. Links resolve (the last only when `follow`), 40 hops, then null
 * (ELOOP). The one walk for every face: it yields its lookups, which the
 * synchronous bridge answers at once and a face over asynchronous mounts
 * awaits. `root` is normalized; the answer is the resolved path, normalized.
 */
export declare function walkBeneath(root: string, path: RuntimeFsPath, follow: boolean, cred: {
    uid: number;
    gid: number;
    groups: readonly number[];
}): Generator<BeneathLookup, string | null, BeneathAnswer>;
/** What one buffered mount handle holds before EFBIG: a whole-file rewrite at flush, kept off the heap's edge. */
export declare const BUFFERED_WRITE_BYTES: number;
/** POSIX rwx for `cred` on a stat: root reads and writes anything and executes what anyone may. */
export declare function modeAllows(stat: {
    mode?: number;
    uid?: number;
    gid?: number;
}, want: number, cred: {
    uid: number;
    gid: number;
    groups: readonly number[];
}): boolean;
/** An error carrying the fields Node's `fs` puts on a failed syscall. */
interface FsError extends Error {
    code: string;
    syscall: string;
    path: string;
    /** The second path of a call that names two (rename, symlink's link). */
    dest?: string;
}
/**
 * Node's error for `syscall` failing on `path`: `ENOENT: no such file or
 * directory, open 'x'`, and `rename 'a' -> 'b'` for a call naming `dest` too.
 */
export declare function fsError(code: string, syscall: string, path: RuntimeFsPath, dest?: RuntimeFsPath): FsError;
export {};
//# sourceMappingURL=sqlite-runtime-fs-bridge.d.ts.map