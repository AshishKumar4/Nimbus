import { type CredentialedVfs, type DelegationTerms, type SqliteVFS, type VfsOpenDescription } from '../vfs/sqlite-vfs.js';
import { type CompositeVFS } from '../vfs/composite.js';
export { fsError, modeAllows, walkBeneath, type BeneathLookup } from './beneath-walk.js';
import type { RuntimeFileHandle, RuntimeFsPath, RuntimeReadOptions, RuntimeSynchronousFs, RuntimeFsBridge, RuntimeOpenFlags, RuntimeVfsDirEntry, RuntimeVfsStat, VfsAcquireOptions, VfsAcquireResult, VfsListPage, VfsMutationReceipt, RuntimeMutationOwner, ExclusiveMutationGrant, ExclusiveMutationRequest } from './os-contracts.js';
interface OpenDescription {
    handle: RuntimeFileHandle;
    node: VfsOpenDescription;
    refs: number;
}
export interface SqliteDescriptorScope {
    nextId: number;
    handles: Map<number, OpenDescription>;
    /** The process's open descriptions its waves name (W7Call description), by the id it chose: descriptors of its own. */
    waveDescriptions: Map<string, number>;
    closed: boolean;
    /** Aborted when the scope closes; cancels in-flight stream commits. */
    abort: AbortController;
    subscriptions: Set<() => void>;
}
export declare function createSqliteDescriptorScope(): SqliteDescriptorScope;
/**
 * Closes every description `scope` holds, each whatever another's flush
 * answers, and empties it. The flushes that failed (lastClose's errors) are
 * returned, for the caller to report once the rest of its teardown is done
 * (reportLost): a teardown that stopped at the first one would keep the
 * scope, and everything it revokes, open.
 */
export declare function closeDescriptions(scope: SqliteDescriptorScope): unknown[];
/** Reports closeDescriptions' failures: the one, or EIO over them all. */
export declare function reportLost(lost: readonly unknown[]): void;
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
    private writeFileFromSource;
    readRange(path: RuntimeFsPath, offset: number, length: number, options?: RuntimeReadOptions): Uint8Array | null;
    writeRange(path: RuntimeFsPath, offset: number, bytes: Uint8Array, options?: {
        createParents?: boolean;
        expectedRevision?: number;
    } & RuntimeMutationOwner): VfsMutationReceipt;
    /** This caller's view, presenting `owner`'s exclusive mutation lease when it names one. */
    private owned;
    truncate(path: RuntimeFsPath, size: number, options?: {
        followSymlinks?: boolean;
    } & RuntimeMutationOwner): VfsMutationReceipt;
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
    rename(from: RuntimeFsPath, to: RuntimeFsPath, options?: RuntimeMutationOwner): void;
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
    /** Where the namespace places it: atomic on SQLite, a routed wave when a record lands on a mount. */
    writeBatch(payload: Parameters<CredentialedVfs['writeBatch']>[0], options?: {
        signal?: AbortSignal;
    }): Promise<{
        inodes: number;
        chunks: number;
    }>;
    writeStream(stream: ReadableStream<Uint8Array>, options?: Parameters<CredentialedVfs['writeStream']>[1]): Promise<import("../vfs/sqlite-vfs.js").WriteBatchStreamResult>;
    /**
     * The open descriptions a process's waves name (WaveDescriptions): each one
     * this binding's descriptor, so the process reads, stats and closes it as
     * any of its own; its access decided at its open (SqliteVFS.describeInode),
     * and its file alive until its close.
     */
    private readonly waveDescriptions;
    /**
     * A lease, or with `terms` a delegation (made by the process that holds
     * it: ProcessFiles' bridge, which answers its recalls). This bridge serves
     * no process, so it delegates nothing itself (`delegate`: EINVAL).
     */
    acquireExclusiveMutation(path: RuntimeFsPath, options?: ExclusiveMutationRequest, terms?: DelegationTerms): ExclusiveMutationGrant;
    releaseExclusiveMutation(owner: string): void;
    /** No process, so no delegation: whatever `owner` names is not one of this bridge's (ESTALE). */
    awaitRecall(owner: string): never;
    recalled(owner: string): never;
    private pathArgument;
    private resolveDataPath;
    /**
     * A mounted (or composed) entry's link target, or null when it is not a
     * link or not there, or when the namespace has no name for where it leads
     * (linkLeadsTo): then the walk keeps the link's own name, and the
     * namespace hands it to the backend that follows it.
     */
    private mountedLink;
    /** Where the link at `path`, reading `link`, leads: the namespace's link-root rule (CompositeVFS.linkLeadsTo); SQLite alone, its text. */
    linkLeadsTo(path: string, link: string): string | null;
    /** `call`: the syscall a refusal names, or the whole call when it names two paths. */
    private locateMutation;
    /**
     * Refuses a mutation at the namespace path `path` that another owner's
     * exclusive-mutation lease covers (EBUSY), or that lies outside the
     * caller's own lease root (EPERM). Leases are held on storage keys: a
     * confined caller's /tmp/x is its private file, not the shared tmp/x.
     */
    private leaseAllows;
    /** Operations with SQLite-only semantics (journals, atomic renames, mutation leases) refuse kernel mounts. */
    private sqlitePath;
    private openRoot;
    /** `mode`: the file's mode if this creates it, made at it, as the asynchronous mount path makes it. */
    private openMount;
    /**
     * A mount that cannot write in place (no writeRange): the handle buffers
     * its writes, at most `bufferedWriteBytes` (EFBIG past it, nothing
     * buffered), and a flush (fsync, the last close, the process's release)
     * reads the file, applies them in order and writes it back. Opened `sync`
     * (O_SYNC), each write is flushed before it returns, so its answer is what
     * the mount did.
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
/** What one buffered mount handle holds before EFBIG: a whole-file rewrite at flush, kept off the heap's edge. */
export declare const BUFFERED_WRITE_BYTES: number;
//# sourceMappingURL=sqlite-runtime-fs-bridge.d.ts.map