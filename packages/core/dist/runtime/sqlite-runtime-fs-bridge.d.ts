import { type CredentialedVfs, type DelegationTerms, type SqliteVFS } from '../vfs/sqlite-vfs.js';
import { type Authority } from './descriptors.js';
import type { WriteStreamOptions } from './wave-contracts.js';
import { WaveIngest } from './wave-ingest.js';
import type { CompositeVFS, MountWalk } from '../vfs/composite.js';
import { type FeedPosition } from './feed-position.js';
import { type Awaitable, type VfsRemoval } from '../vfs/vfs.js';
export { fsError, walkBeneath, type BeneathLookup } from './beneath-walk.js';
import type { RuntimeFileHandle, RuntimeOpenedFile, RuntimeFsPath, RuntimeReadFileOptions, RuntimeReadOptions, RuntimeSynchronousFs, RuntimeFsBridge, RuntimeOpenFlags, RuntimeReopenTarget, RuntimeVfsDirEntry, RuntimeVfsStat, VfsAcquireOptions, VfsAcquireResult, VfsCred, VfsListOptions, VfsListPage, VfsMutationReceipt, RuntimeMutationOwner, ExclusiveMutationGrant, ExclusiveMutationRequest } from './os-contracts.js';
import type { FsTime } from '@nimbus-sh/platform/w7-frame.js';
export declare class SqliteRuntimeFsBridge implements RuntimeFsBridge {
    private readonly rawVfs;
    private readonly scope;
    private readonly namespace?;
    /** A stable inode number for a mounted entry whose backend keeps none (shared across the session's bridges). */
    /** Bytes one buffered handle may hold before a write is EFBIG. */
    private readonly bufferedWriteBytes;
    /** The namespace's wave ingestion (ProcessFiles.waves); without a namespace, none places anything elsewhere. */
    private readonly waves;
    /** Its binding's Authority, its standing (Descriptors' `owned`), and its caller's abort; else its scope alone. */
    private readonly binding;
    readonly synchronous: RuntimeSynchronousFs;
    private readonly vfs;
    /** The namespace as this caller sees it: what a path off the SQLite root reaches. */
    private readonly mounted;
    private readonly descriptors;
    constructor(vfs: CredentialedVfs, rawVfs: SqliteVFS, scope?: import("./descriptors.js").DescriptorScope, namespace?: CompositeVFS | undefined, 
    /** A stable inode number for a mounted entry whose backend keeps none (shared across the session's bridges). */
    /** Bytes one buffered handle may hold before a write is EFBIG. */
    bufferedWriteBytes?: number, 
    /** The namespace's wave ingestion (ProcessFiles.waves); without a namespace, none places anything elsewhere. */
    waves?: WaveIngest, 
    /** Its binding's Authority, its standing (Descriptors' `owned`), and its caller's abort; else its scope alone. */
    binding?: {
        authority: Authority;
        owned: Authority;
        signal?: AbortSignal;
    });
    dispose(): Awaitable<void>;
    /**
     * Where a path lives, decided only after confinement: the namespace is
     * consulted with the fully resolved path, so a `..` or an absolute path
     * inside a capability can never reach `/proc` or `/dev` sideways.
     */
    private locate;
    /**
     * The path resolved in one walk on SQLite (SqliteVFS.resolveName), or null
     * for the walk component by component (resolveDataPath): for a walk
     * beneath a root, for a spelling with `..`, and where the namespace lays a
     * mount or a directory above one. Plain SQLite names keep their one walk.
     */
    private walkOnSqlite;
    /** SQLite stores no row for the namespace root; it is the one directory that always exists. */
    private rootStat;
    stat(path: RuntimeFsPath, options?: {
        followSymlinks?: boolean;
    }): RuntimeVfsStat | null;
    readFile(path: RuntimeFsPath, options?: RuntimeReadFileOptions): Uint8Array | null;
    /** Before a cut of a mounted file (a truncate, a whole-file write): the writes this process holds on it, written (settleHeldAt). */
    private settleAt;
    /** A mounted file as this process sees it, its pending writes applied (processView); undefined when it holds none. */
    private processView;
    writeFile(path: RuntimeFsPath, bytes: string | Uint8Array, options?: {
        createParents?: boolean;
        expectedRevision?: number;
        umask?: number;
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
    utimes(path: RuntimeFsPath, atime: FsTime, mtime: FsTime, options?: {
        followSymlinks?: boolean;
    }): VfsMutationReceipt;
    chmod(path: RuntimeFsPath, mode: number): VfsMutationReceipt;
    access(path: RuntimeFsPath, mode: number): void;
    chown(path: RuntimeFsPath, uid: number | null, gid: number | null, options?: {
        followSymlinks?: boolean;
    }): VfsMutationReceipt;
    /** `options.mutationOwner`: the exclusive-mutation lease an open for writing presents (a read-only open presents none). */
    open(path: RuntimeFsPath, flags: RuntimeOpenFlags, options?: RuntimeMutationOwner): RuntimeOpenedFile;
    read(handleId: number, offset: number | null, length: number): Uint8Array;
    write(handleId: number, offset: number | null, bytes: Uint8Array): number;
    /** A description that awaits, closed by a caller that cannot wait: its backend's close answers no one (it holds no writes: each landed as made). */
    close(handleId: number): void;
    readdir(path: RuntimeFsPath, options?: {
        followSymlinks?: boolean;
    }): RuntimeVfsDirEntry[];
    mkdir(path: RuntimeFsPath, options?: {
        recursive?: boolean;
        mode?: number;
        umask?: number;
    } & RuntimeMutationOwner): void;
    /**
     * Whether anything may be at `located`: a mounted name (its mount
     * answers), `/` (which has no row), or a row. A walk that met the name
     * absent has looked at all of them.
     */
    private mayExist;
    unlink(path: RuntimeFsPath, options?: RuntimeMutationOwner): void;
    rmdir(path: RuntimeFsPath, options?: RuntimeMutationOwner): void;
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
    contentKey(path: RuntimeFsPath): string;
    /**
     * What changed since `position`: the namespace's feed (CompositeFeed.since),
     * each fed mount's changes where the namespace routes to it, or a poison
     * (none held, or another mount table); SQLite's alone where this bridge
     * has no namespace.
     */
    acquire(position: FeedPosition | null, options?: VfsAcquireOptions): VfsAcquireResult;
    /** Whether a read lease may be granted over this caller's namespace: no feed but the engine's moves (CompositeVFS.movesWithTheRootAlone). */
    leasable(): boolean;
    /** One page of every name this caller's namespace shows (namespacePage), or SQLite's where it has none. */
    list(after?: string | null, limit?: number, options?: VfsListOptions): VfsListPage;
    realpath(path: RuntimeFsPath): string;
    remove(path: RuntimeFsPath, options?: {
        recursive?: boolean;
        force?: boolean;
        report?: boolean;
        keepVanishedAncestors?: boolean;
    }): void | VfsRemoval;
    copyFile(from: RuntimeFsPath, to: RuntimeFsPath, options?: {
        keepMode?: boolean;
        preserve?: boolean;
    }): void;
    copyTree(from: RuntimeFsPath, to: RuntimeFsPath, options?: {
        preserve?: boolean;
        follow?: boolean;
    }): Promise<number>;
    /** Where the namespace places it: atomic on SQLite, a routed wave when a record lands on a mount. */
    writeBatch(payload: Parameters<CredentialedVfs['writeBatch']>[0], options?: {
        signal?: AbortSignal;
    }): Promise<{
        inodes: number;
        chunks: number;
    }>;
    writeStream(stream: ReadableStream<Uint8Array>, options?: WriteStreamOptions): Promise<import("./wave-contracts.js").WriteBatchStreamResult>;
    /**
     * The open descriptions a process's waves name (WaveDescriptions): each one
     * this binding's descriptor, so the process reads, stats and closes it as
     * any of its own; its access decided at its open (SqliteVFS.describeInode),
     * and its file alive until its close.
     */
    private readonly waveDescriptions;
    private waveDescription;
    /** `node`, the description a wave's open of `id` made: the session's descriptor of it. */
    private keepWaveDescription;
    /**
     * A lease; with `held`, a process's own (ProcessFiles' bridge), which ends
     * with the process; with its `terms`, a delegation, whose recalls that
     * bridge answers. This bridge serves no process, so it delegates nothing
     * itself (`delegate`: EINVAL).
     */
    acquireExclusiveMutation(path: RuntimeFsPath, options?: ExclusiveMutationRequest, held?: {
        terms?: DelegationTerms;
    }): ExclusiveMutationGrant;
    releaseExclusiveMutation(owner: string): void;
    acquireReadLease(terms: DelegationTerms, at: {
        readonly epoch: string;
        readonly cursor: number;
    }): {
        readonly owner: string;
    };
    /** No process, so no delegation: whatever `owner` names is not one of this bridge's (ESTALE). */
    awaitRecall(owner: string): never;
    recalled(owner: string): never;
    /** No process: its writes wait for their publication, so none is held. */
    published(): void;
    private pathArgument;
    /** The walk component by component: the name reached and its spelling for the namespace (walkBeneath's BeneathReached). */
    private resolveDataPath;
    /** Where the link at `path`, reading `link`, leads: the namespace's link-root rule (CompositeVFS.linkLeadsTo); SQLite alone, its text. */
    linkLeadsTo(path: string, link: string): string | null;
    /** `call`: the syscall a refusal names, or the whole call when it names two paths. */
    /** `absentDirectory`: an absent entry named with a trailing slash may be made here (a directory renamed to it); otherwise it is ENOENT, only mkdir makes one. */
    private locateMutation;
    /** The name a mutation by `owner` reaches, checked against the leases on a mount as on SQLite. */
    private reached;
    /**
     * Refuses a mutation at the namespace path `path` that another owner's
     * exclusive-mutation lease covers (EBUSY), or that lies outside the
     * caller's own lease root (EPERM). Leases are held on storage keys: a
     * confined caller's /tmp/x is its private file, not the shared tmp/x.
     */
    private leaseAllows;
    /** Operations with SQLite-only semantics (journals, atomic renames, mutation leases) refuse kernel mounts. */
    private sqlitePath;
    reopen(target: RuntimeReopenTarget, flags: RuntimeOpenFlags, options?: RuntimeMutationOwner): RuntimeOpenedFile;
    private openRoot;
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
    /** The absolute path a descriptor was opened at. */
    /** The name a descriptor's later lookups start from: a mounted description's own (HeldFile.name: as written past a `..` its backend walks), else its SQLite name. */
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
    fchown(handleId: number, uid: number | null, gid: number | null): void;
    futimes(handleId: number, atime: FsTime, mtime: FsTime): void;
}
/** A whole read's `maxBytes` (RuntimeReadFileOptions): a regular file of at most `maxBytes` bytes is read whole; a directory answers as a read does. */
export declare function fitsWholeRead(stat: {
    readonly type: string;
    readonly size: number;
    readonly mode?: number;
}, maxBytes: number): boolean;
/**
 * One page of every name `namespace` shows `cred`, in path order: its feed's
 * listing (CompositeFeed.list), SQLite's names less what a mount covers,
 * each fed mount's, the directories the namespace makes, and what `walk`
 * found on the mounts without a feed, cut to a page by SQLite's own bound
 * (listPageBudget), at the position read before it. A mounted directory
 * `cred` may not read and search is marked unreadable, as SQLite marks its
 * own.
 */
export declare function namespacePage(namespace: CompositeVFS, cred: VfsCred, after: string | null, limit: number | undefined, walk: MountWalk, options?: VfsListOptions): VfsListPage;
//# sourceMappingURL=sqlite-runtime-fs-bridge.d.ts.map