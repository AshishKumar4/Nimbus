/**
 * SqliteVFS — Demand-paged, content-addressed virtual filesystem on DO SQLite.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │ in memory: inode cache (bounded view of vfs_inodes)              │
 * │            chunk cache (LRU keyed by immutable chunk id)         │
 * └──────────────────────────────────────────────────────────────────┘
 *        │ miss → one indexed read            │ miss → one PK read
 *        ▼                                    ▼
 *  vfs_inodes (path PK, WITHOUT ROWID)   vfs_chunks (id PK, sha256 UNIQUE)
 *    chunk_id   → file ≤ 64 KiB: one chunk
 *    content_id → file > 64 KiB: vfs_contents + vfs_content_chunks
 *                 (FastCDC 16/32/64 KiB manifest keyed (content_id, off))
 *
 * Every chunk is stored once per database, by sha256. A file ≤ 64 KiB names
 * its chunk from the inode; a larger file names a manifest. Copies copy rows.
 *
 * Every committing transaction advances `vfs_state.gen` once and stamps every
 * inode row it writes with it. A snapshot pins a generation; the first write
 * after it to a row it can see keeps a before-image in vfs_inode_history.
 * Every dereference (an overwritten or deleted row's chunk/content, a dropped
 * history row's) is queued in vfs_gc_queue in the same transaction, and GC
 * deletes a queued id only when a probe of every reference finds none.
 *
 * All operations are synchronous (DO sql.exec is); every write returns after
 * its transaction commits. Large writes stage bounded transactions into a
 * state-0 content and publish it atomically.
 */
import { VfsEventEmitter, type VfsEvent } from './events.js';
import { type BatchWritePayload, type VfsInodeKind } from '@nimbus-sh/platform/w7-frame.js';
import { StorageLedger, type StorageLedgerView } from '../runtime/storage-ledger.js';
import { type VfsAcquireOptions, type VfsAcquireResult, type VfsCred, type VfsListPage, type SqlDatabase, type TransactionHost } from '../runtime/os-contracts.js';
/** The root directory has no row; this is what it is. */
export declare const ROOT_DIRECTORY_MODE = 16877;
/** The root's inode number, reserved: the allocator starts at 2. */
export declare const ROOT_INODE = 1;
export type { BatchChunkEntry, BatchInodeEntry, BatchWritePayload, VfsInodeKind, } from '@nimbus-sh/platform/w7-frame.js';
export interface ExclusiveMutationLease {
    readonly root: string;
    readonly owner: string;
}
export interface ExclusiveMutationOptions {
    readonly includeMissingAncestors?: boolean;
}
export interface VfsOpenDescription {
    /** Inode number the description currently resolves; 0 is never issued. */
    readonly ino: number;
    path(): string;
    stat(): VfsStat;
    read(offset: number, length: number): Uint8Array;
    write(offset: number, bytes: Uint8Array): number;
    truncate(size: number): void;
    readdir(): {
        name: string;
        type: VfsInodeKind;
    }[];
    chmod(mode: number): void;
    chown(uid: number, gid: number): void;
    utimes(atime: number, mtime: number): void;
    close(): void;
    /**
     * A description whose backend cannot write in place buffers its writes
     * (VFS-PF-001): an append goes at the end as it stands at the flush,
     * `flush` applies what is pending, and `pendingBytes` is what a process
     * killed now would lose. Absent: every write is in place and durable.
     */
    writeAppend?(bytes: Uint8Array): number;
    flush?(): void;
    pendingBytes?(): number;
}
export interface VfsStat {
    dev: number;
    ino: number;
    nlink: number;
    type: VfsInodeKind;
    size: number;
    atime: number;
    ctime: number;
    mtime: number;
    mode: number;
    uid: number;
    gid: number;
    /** Generation that last wrote this inode; absent for a stat from a non-SQLite mount. */
    gen?: number;
}
export interface CredentialedVfs {
    readonly cred: VfsCred;
    exists(path: string): boolean;
    isDirectory(path: string): boolean;
    isFile(path: string): boolean;
    isSymlink(path: string): boolean;
    access(path: string, mode: number): void;
    mkdir(path: string, options?: {
        recursive?: boolean;
        mode?: number;
    }): void;
    writeFile(path: string, content: string | Uint8Array, options?: {
        mode?: number;
    }): void;
    symlink(target: string, path: string): void;
    readlink(path: string): string;
    resolveSymlink(path: string): string | null;
    readFile(path: string): Uint8Array;
    /** Whole-file read that bypasses the LRU content cache (see SqliteVFS.readFileUncached). */
    readFileUncached(path: string): Uint8Array;
    readRange(path: string, offset: number, length: number): Uint8Array;
    /** Ranged read that bypasses the LRU content cache (see SqliteVFS.readRange). */
    readRangeUncached(path: string, offset: number, length: number): Uint8Array;
    writeRange(path: string, offset: number, bytes: Uint8Array): void;
    appendOnce(path: string, pid: number, writerId: string, moduleId: string, operationId: number, digest: string, bytes: Uint8Array): number;
    acknowledgeAppend(pid: number, writerId: string, moduleId: string, operationId: number): void;
    truncate(path: string, size: number): void;
    readFileString(path: string): string;
    stat(path: string): VfsStat;
    lstat(path: string): VfsStat;
    /**
     * utimensat(2): null is UTIME_NOW, undefined UTIME_OMIT (that time kept).
     * Only now/omit needs no more than write permission or ownership; an
     * explicit time needs ownership. `followSymlinks: false` sets a link's own.
     */
    utimes(path: string, atimeMs: number | null | undefined, mtimeMs: number | null | undefined, options?: {
        followSymlinks?: boolean;
    }): void;
    chmod(path: string, mode: number): void;
    /**
     * A directory's default ACL base entries (`setfacl -d -m u::,g::,o::`), as
     * nine permission bits, or null to remove it (`setfacl -k`). The owner or
     * root only.
     */
    setDefaultAcl(path: string, perms: number | null): void;
    /** The directory's default ACL base entries, or null (`getfacl`). */
    getDefaultAcl(path: string): number | null;
    chown(path: string, uid: number | null, gid: number | null, options?: {
        followSymlinks?: boolean;
    }): void;
    readdir(path: string): {
        name: string;
        type: VfsInodeKind;
    }[];
    /**
     * Enumerate every path this credential can see, in path order, one bounded
     * page at a time. `after` resumes past a previous page's `next`.
     */
    list(after?: string | null, limit?: number): VfsListPage;
    /**
     * The coherence barrier in this credential's path space: `invalidatedSince`
     * with each entry's current stat when `options.namespace` asks for it.
     */
    acquire(epoch: string | null, cursor: number, options?: VfsAcquireOptions): VfsAcquireResult;
    unlink(path: string): void;
    rmdir(path: string): void;
    /**
     * Remove a path and everything beneath it, in bounded transactions.
     * Returns the number of entries removed.
     */
    removeRecursive(path: string): number;
    rename(oldPath: string, newPath: string): void;
    copyFile(src: string, dest: string): void;
    /**
     * Copy a tree to a new path by reference (`cp -r`; `preserve` is `-p`).
     * Returns the entries copied. See SqliteVFS.copyTree.
     */
    copyTree(src: string, dest: string, options?: {
        preserve?: boolean;
        at?: string;
    }): number;
    /**
     * copyTree in slices of JOB_SLICE_PAGES transactions with a yield between,
     * for trees too large for one synchronous turn (workerd resets an object
     * whose storage writes do not settle for tens of seconds). A live source
     * may change between slices: each page is consistent, the whole copy is
     * point-in-time only with `at`.
     */
    /**
     * copyTree in slices. `mutationOwner`: the live exclusive lease this copy
     * runs under (its holder awaits it), so it writes inside the lease and a
     * quiescing snapshot never holds it.
     */
    copyTreeAsync(src: string, dest: string, options?: {
        preserve?: boolean;
        at?: string;
        mutationOwner?: string;
    }): Promise<number>;
    writeBatch(payload: BatchWritePayload): {
        inodes: number;
        chunks: number;
    };
    writeStream(stream: ReadableStream<Uint8Array>, options?: {
        decodeDrainStartedAt?: number;
        signal?: AbortSignal;
        mutationOwner?: string;
    }): Promise<WriteBatchStreamResult>;
    mkdirBatch(paths: string[]): number;
    revision(path?: string): number;
    /**
     * The file's content key: sha256 of its bytes up to CHUNK_SIZE, else the
     * digest of its chunk manifest. An equal key proves equal bytes.
     */
    contentKey(path: string): string;
    /**
     * The paths mutated since `cursor`, each under this credential's own name
     * for it, and without the paths it has no name for (see
     * SqliteVFS.invalidatedSince).
     */
    invalidatedSince(epoch: string | null, cursor: number): VfsAcquireResult;
    /**
     * The key storage holds `path` under for this credential: a confined
     * caller's /tmp/x is var/agents/<p>/tmp/x. For state kept by storage key
     * rather than by name, such as the legacy symlink registry. It is not a
     * name the caller uses, so it is never reported back to one.
     */
    storageKey(path: string): string;
    /**
     * Watch `path` and everything under it, in this credential's view: the
     * watch is on the file its name means (a confined caller's /tmp/x is its
     * own), and an event is delivered under the caller's name for its path,
     * only if the caller could list that path (see SqliteVFS.invalidatedSince).
     */
    subscribe(path: string, listener: (event: VfsEvent) => void): () => void;
    /**
     * This VFS incarnation's identity. Paired with `revision()` it is the
     * cache-coherence cursor a facet is stamped with when its bundle is built,
     * so the facet's first ACQUIRE is an ordinary delta. Without the pairing a
     * bare revision is meaningless across a supervisor restart, since the
     * revision clock is in memory and restarts at zero.
     */
    readonly epoch: string;
}
export interface WriteBatchStreamProgress {
    /** 1-based sequence of the last durable publish group; zero means none. */
    committedGroupSequence: number;
    committedPathCount: number;
    inodes: number;
    chunks: number;
}
export type WriteBatchStreamFailurePhase = 'decode' | 'stage' | 'validation' | 'publish';
export type WriteBatchStreamResult = (WriteBatchStreamProgress & {
    ok: true;
}) | (WriteBatchStreamProgress & {
    ok: false;
    error: {
        code: 'ERR_WRITE_BATCH_STREAM';
        phase: WriteBatchStreamFailurePhase;
        message: string;
    };
});
export declare const INODE_ROWS_PER_SQL_EXEC: number;
export declare const VFS_APPEND_RECEIPT_LIMIT = 2048;
type TransactionLimit = 'blobBytes' | 'logicalRows' | 'sqlExecs';
type TransactionSource = 'strict-batch' | 'range-mutation' | 'content-stage' | 'content-publish' | 'content-gc';
type TransactionLimitMode = 'bounded';
interface TransactionPlanMetrics {
    blobBytes: number;
    logicalRows: number;
    sqlExecs: number;
    affectedPaths: number;
}
export declare class SqliteVfsTransactionTooLargeError extends Error {
    readonly limit: TransactionLimit;
    readonly actual: number;
    readonly maximum: number;
    readonly metrics: Readonly<TransactionPlanMetrics>;
    readonly code: "E2BIG";
    constructor(limit: TransactionLimit, actual: number, maximum: number, metrics: Readonly<TransactionPlanMetrics>);
}
/** The export format's version: rows naming chunks by sha256. */
export declare const VFS_EXPORT_SCHEMA = 2;
/** One entry of an exported tree, relative to the export's root ('' is the root). */
export interface VfsExportRow {
    path: string;
    kind: VfsInodeKind;
    size: number;
    mode: number;
    uid: number;
    gid: number;
    atime: number;
    mtime: number;
    /** False for content in one chunk (<= CHUNK_SIZE bytes). */
    manifest: boolean;
    /** Chunk sha256 (hex) and size, in content order. */
    pieces: [string, number][];
}
export interface VfsExportPage {
    schema: number;
    root: string;
    /** The cursor this page follows (null: the first page). */
    after: string | null;
    rows: VfsExportRow[];
    next: string | null;
}
export interface VfsExportChunk {
    hash: string;
    data: Uint8Array;
}
export interface SnapshotInfo {
    name: string;
    /** The generation it pins: the tree as that transaction left it. */
    gen: number;
    createdAt: number;
}
export interface VfsDiffEntry {
    path: string;
    change: 'added' | 'removed' | 'modified';
    type: VfsInodeKind;
}
export interface SqliteVfsOptions {
    /**
     * Inodes held in memory; defaults to INODE_CACHE_MAX_ENTRIES. SQLite holds
     * every inode, so this bounds the heap, not the filesystem.
     */
    readonly inodeCacheEntries?: number;
    /**
     * Bytes of per-path revisions held; defaults to 16 MiB. Past it the oldest
     * are dropped, and a path without one reports the newest revision dropped.
     */
    readonly pathRevisionBytes?: number;
    /**
     * Tombstones kept for answering old invalidation cursors from SQL;
     * defaults to TOMBSTONE_RETAIN_ROWS. A cursor older than the oldest kept
     * poisons (the reader reconciles against list()).
     */
    readonly tombstoneRows?: number;
    /** The session's storage limit (N18); defaults to DO_STORAGE_LIMIT_BYTES. */
    readonly storageLimit?: number;
    /** Bytes below it only uid 0 may fill (N18); defaults to 1% of the limit, at least 16 MiB. */
    readonly storageKernelReserve?: number;
    /**
     * Where chunks only snapshots reference may be moved (P6): an R2 bucket
     * or anything with its get/put/delete. Without it nothing is tiered.
     */
    readonly coldStore?: VfsColdStore;
}
/** An object store keyed by chunk hash (hex), such as an R2 bucket binding. */
export interface VfsColdStore {
    put(key: string, bytes: Uint8Array): Promise<unknown>;
    get(key: string): Promise<{
        arrayBuffer(): Promise<ArrayBuffer>;
    } | null>;
    delete(keys: string[]): Promise<unknown>;
}
export declare class SqliteVFS {
    private readonly openNodes;
    private sql;
    /** N18: the session's storage ledger, over this database (the session DO's). */
    readonly ledger: StorageLedger;
    /** The reservation the running synchronous operation draws from (N18). */
    private activeReservation;
    /** Whether the running synchronous call is uid 0's (it may use the kernel reserve). */
    private privileged;
    /** Interrupted copies resumed in this incarnation, each holding its reservation. */
    private readonly resumedCopies;
    private ctx;
    readonly events: VfsEventEmitter;
    private readonly inodes;
    private cache;
    /** Actual bytes in cache (not all chunks are full 64KB) */
    private _cacheBytes;
    private _lruMaxEntries;
    private _lruShrinkRefcount;
    private _countersLoaded;
    private _totalFiles;
    private _totalDirs;
    private _usedBytes;
    private _revision;
    private _pathRevisions;
    private _pathRevisionBytes;
    private _revisionFloor;
    private readonly pathRevisionBudget;
    private static readonly PATH_REVISIONS_MAX_BYTES;
    private transactionPublication;
    private _epoch;
    /** invalidatedSince answers from SQL only above this: the newest pruned tombstone. */
    private _tombstoneFloor;
    private _tombstoneRows;
    private readonly tombstoneRetain;
    private readonly coldStore;
    /** Generations of snapshots prepareSnapshot hydrated: tiering leaves their chunks alone. */
    private readonly hotSnapshotGens;
    /** Where the next tier pass resumes its walk of vfs_chunks. */
    private tierCursor;
    private _invalidations;
    private _invalidationBytes;
    /**
     * The log holds every publication after this revision: the clock at open,
     * then the newest revision an entry was dropped from. A cursor below it
     * cannot be served completely.
     */
    private _invalidationFloor;
    private static readonly INVALIDATION_LOG_MAX_BYTES;
    private removedForEvents;
    /** Names the revision clock: this database's incarnation, stable across restarts. */
    get epoch(): string;
    /**
     * Start a new clock epoch: every cursor held against the old one poisons.
     * For a storage restore to an earlier point in time, which takes the
     * generations back under cursors facets still hold.
     */
    rotateIncarnation(): string;
    private readonly exclusiveMutationLeases;
    private activeMutationOwner;
    /** Shared by every concurrent stream targeting this session's VFS. */
    private readonly writeStreamCredits;
    private _stagedStreamBytes;
    private _peakStagedStreamBytes;
    /**
     * Staging contents a live operation is still assembling. Durable state 0
     * alone does not protect them from GC: after a restart nothing is live, and
     * every state-0 content is garbage.
     */
    private readonly activeStagingContentIds;
    /** True only while vfs_gc_queue may hold work or a janitor has rows left. */
    private maintenancePending;
    /** Resume points of the GC queue walk, per kind; pinned ids are stepped over. */
    private gcCursor;
    /** Keyset cursor of the reference audit (chunks, then contents); null once done this lifetime. */
    private auditCursor;
    /** Legacy tables still holding rows, until the janitor drops them. */
    private legacyTables;
    private _legacyReset;
    /** Last committed generation: every committed VFS transaction advances it. */
    private _gen;
    /** MAX(vfs_snapshots.gen), 0 without a snapshot. */
    private _pinGen;
    /** Whole manifests of recently read files up to MANIFEST_KEPT_BYTES, by content id (LRU). */
    private readonly manifestWindows;
    /** The staging content holding each import's chunks, by destination. */
    private readonly importStagings;
    /** Page digests by (generation, root, cursor, limit): a snapshot's pages never change. */
    private readonly pageDigests;
    /** Snapshot generations by name, loaded on first use. */
    private snapshotGens;
    /** writeStreams in flight, for snapshot's quiesce. */
    /**
     * Work that spans awaits and changes the tree across them (writeStream,
     * restoreAsync, sliced copyTree), for snapshot's quiesce.
     */
    private readonly activeWork;
    /** Set while a quiesced snapshot waits: new spanning work starts after it. */
    private quiesceGate;
    /** Content keys computed for manifests whose digest could not be stored. */
    private readonly contentKeyMemo;
    private _activeTransaction;
    private _transactionDuration;
    private _postCommitDuration;
    private _decodeDrainDuration;
    private _creditWaitDuration;
    /** Whole content-maintenance runs, including the raw scans that execute
     * outside executeMeasuredTransaction; count doubles as the run counter. */
    private _maintenanceDuration;
    private readonly _transactionDurationSamples;
    private _transactionDurationSampleCount;
    private _transactionDurationSampleIndex;
    private readonly _decodeDrainStarts;
    private readonly _creditWaitStarts;
    private _transactionPeakBlobBytes;
    private _transactionPeakLogicalRows;
    private _transactionPeakSqlExecs;
    private _transactionPeakAffectedPaths;
    private _boundedTransactionPeakBlobBytes;
    private _boundedTransactionPeakLogicalRows;
    private _boundedTransactionPeakSqlExecs;
    private _lastTransaction;
    private _overLimitFileCount;
    private _lastOverLimitFile;
    private _cacheHits;
    private _cacheMisses;
    private _evictions;
    private _sqlReads;
    private _sqlWrites;
    private _batchWrites;
    private _batchWriteRows;
    readonly namespace: string;
    readonly deviceId: number;
    /**
     * Construction writes only what is absent. A store whose schema and
     * identity rows are already current is opened without a single write
     * statement, so an embedder may hand us a readonly handle (a replica, a
     * snapshot, a host whose SQLite is shared with us) and read. Every
     * `CREATE ... IF NOT EXISTS` is a no-op on an existing object; every row
     * seed is preceded by the read that decides it; the migration markers
     * are written only when the migration runs.
     *
     * Nor does it read the tree: no inode is loaded until a path asks for it,
     * so opening costs the same at ten files and at a million.
     */
    constructor(sql: SqlDatabase, ctx?: TransactionHost, namespace?: string, options?: SqliteVfsOptions);
    /**
     * An older schema's store is not read: its tables go, so the open below
     * builds the current ones empty, and the loss is recorded to be told.
     * True when it reset one.
     */
    private resetOlderStore;
    private initSchema;
    /** Tables a pre-v2 Nimbus filesystem left here, recognised by their columns. */
    private presentLegacyTables;
    /**
     * True while a pre-v2 filesystem this database held has not been told
     * about: schema v2 does not read it, so the session starts empty, and a
     * host should say so (and drop state that pointed into it) before
     * calling acknowledgeLegacyReset(). Survives restarts until then.
     */
    get legacyReset(): boolean;
    acknowledgeLegacyReset(): void;
    /**
     * After a restart no operation is assembling anything, so every state-0
     * content is an abandoned write: queue them all. Read first, so a store
     * with none opens without a write.
     */
    private queueAbandonedStaging;
    private tableColumns;
    /** The cache's loader: the inode at `path`, read from SQLite. */
    private loadInode;
    private inodeFromRow;
    /**
     * Load the running counters with one aggregate over `vfs_inodes`, the first
     * time anything reads them. Opening does not pay for it; the first stats
     * read does, once.
     */
    private ensureCounters;
    /** Every non-directory counts as a file, symlinks included, as it always has. */
    private aggregateCounters;
    private cacheGet;
    private cacheSet;
    private cacheEvict;
    private enforceCacheLimit;
    private evictOne;
    shrinkForInstall(targetEntries?: number): void;
    /** Decrement the heavy-alloc refcount. When the count returns to
     *  zero, restore the cap to LRU_MAX_ENTRIES. No re-population —
     *  the cache warms naturally on next reads. */
    restoreAfterInstall(): void;
    /** Drop every disposable cache entry before retrying a strict batch. */
    evictAll(): void;
    openDescription(path: string, cred: VfsCred, rights: {
        read: boolean;
        write: boolean;
    }): VfsOpenDescription;
    private now;
    private parentPath;
    private blobToUint8Array;
    private copyBytes;
    /**
     * Principals whose `/tmp` is private, keyed by uid, valued by the storage
     * root their `/tmp` resolves to.
     *
     * `/tmp` keeps its path in every view and only the bytes behind it differ,
     * so nothing has to be told which principal it is. The credential is the
     * only per-process state visible where paths are RESOLVED — there is no pid
     * and no cwd down here — so it is what the private view is keyed on.
     *
     * Resolution rather than a mount, because a mount diverges the two planes:
     * the shell writing `/tmp/a` and the file API writing `/tmp/b` landed in
     * different trees under the same name. `resolvePath` already takes `cred`,
     * and every plane goes through it.
     *
     * Registration is also what makes a principal CONFINED for `chmod`. The two
     * properties travel together because they answer one question: is this
     * principal a guest in this filesystem. Nothing here applies to an
     * unregistered credential, so the ordinary session user is untouched.
     */
    private confinedTmpRoots;
    /**
     * Confine a principal. `tmpRoot` is a storage key, not a logical path — the
     * caller owns creating and chowning it, because a per-principal `chown` is
     * uid-0 only and a guest cannot provision its own.
     */
    confinePrincipal(uid: number, tmpRoot: string): void;
    /**
     * A confined principal owns its own triad and nothing else. Refusing chmod
     * outright would be simpler and wrong: execution is gated on the x bit, so
     * a guest that writes build.sh and cannot chmod it cannot run it. What
     * must not happen is WIDENING past its own principal: the group and other
     * triads and setuid/setgid may only lose bits, and sticky, which restricts
     * others, may only gain one, while the owner triad moves freely. `u+x`,
     * `700`, `600` and `go-w` work; `+x` and `777` do not.
     *
     * Refused, never clamped. Quietly narrowing a mutation to the part that
     * was allowed reports success for something other than what was asked, so
     * the refusal names the spelling that works instead. Every chmod, by path
     * or by descriptor, goes through here with the caller's own credential.
     */
    private assertConfinedModeChange;
    /**
     * Permission bits a new inode is created with. umask never masks 07000, so
     * a confined principal's creation drops setuid/setgid here, the one grant
     * its umask cannot refuse. Sticky only restricts others and is kept.
     */
    private creationMode;
    /**
     * What a new entry at storage key `key` is made with, from its parent (a
     * row, or one staged earlier in the same batch):
     * - a parent with a default ACL gives the requested permissions ANDed with
     *   its base entries, no umask, and a new directory inherits the ACL;
     * - a setgid parent gives its group, and a new directory is setgid too
     *   (Linux; Kinu N26). Otherwise the caller's umask and primary group.
     */
    private creationAttrs;
    private isConfined;
    /** Drop a confinement. A principal's `/tmp` dies with it; its home does not. */
    releasePrincipal(uid: number): void;
    /**
     * Logical path -> storage key, for one credential.
     *
     * Everything under `/tmp` belongs to the caller's own private root, which is
     * what makes the same path mean different bytes per principal. Idempotent: a
     * key already inside that root is returned untouched, so the several methods
     * that derive a key before handing it on cannot stack the rewrite.
     */
    private storageKey;
    /** {@link storageKey} of a name already normalized, under a principal's private root. */
    private keyOfName;
    /**
     * The name a credential uses for `path`, whichever spelling it came in: a
     * confined caller's own root is `/tmp`, whether it wrote /tmp/x or the
     * root's storage key. One name per file is what lets resolution walk the
     * caller's view rather than storage.
     */
    private nameOf;
    /**
     * Storage key -> the name this credential knows it by, or `null` when it has
     * none. The inverse of {@link storageKey}, for the surfaces that report
     * paths they were not asked about: {@link list}, {@link invalidatedSince}
     * and watches.
     *
     * A confined caller has no name for the shared scratch tree: `/tmp` is its
     * own root. Another principal's private root does have a name, its storage
     * path, and what keeps what is inside it out of those reports is its mode,
     * which the caller cannot traverse (hiddenBehind, watchedName). An
     * unconfined caller sees storage as it is, which is what the kernel and the
     * session user need.
     */
    private logicalPath;
    /**
     * uid 0's view: its writes may use the storage the ledger keeps back from
     * everyone else (N18's kernel reserve, as ext4 reserves blocks for root).
     * Covers each call's synchronous part; the kernel's bookkeeping is that.
     */
    private privilegedView;
    as(cred: VfsCred): CredentialedVfs;
    private accessInode;
    private accessMode;
    /**
     * Walk `path` to its inode, following links, in the caller's own names.
     *
     * Every prefix is a name the caller could have written, and only its lookup
     * goes to storage. A link's target is read the way the caller reads it: a
     * relative one against the link's directory as the caller names it, an
     * absolute one as a path of the caller's own. So whatever a link says, it
     * lands where the caller naming that path directly would.
     *
     * Walking storage keys instead read a relative target against the key: a
     * confined caller's `/tmp/out -> ../../../../tmp/x` climbed out of its
     * private root (var/agents/<p>/tmp) and reached the SHARED tmp/x, and a link
     * to `/` let the rest of any path continue into the shared tree.
     *
     * `path` is the storage key the walk ends at, `name` the caller's name for it.
     * `tree` looks inodes up by key: the live tree, or a snapshot's (SnapshotVfs).
     */
    private resolvePath;
    private checkAccess;
    /**
     * `/` has no row: it is 0755 root:root by definition, and adding or
     * removing a name in it needs write and search there like any directory.
     */
    private checkRootWritable;
    private checkParentAccess;
    /**
     * POSIX sticky-bit restriction on a shared directory.
     *
     * Write permission on a directory is normally enough to remove or rename
     * anything inside it, which is why `/tmp` is `1777` and not `0777`: the
     * sticky bit narrows that to the entry's owner, the directory's owner, and
     * root. Nothing enforced it here, so a world-writable shared directory gave
     * every principal the ability to delete every other principal's files —
     * the mode said one thing and the filesystem did another.
     */
    private checkStickyParentMutation;
    /**
     * Shared resolver for the boolean probes (exists/isDirectory/isFile/
     * isSymlink). Resolution-structure failures — a missing or non-directory
     * path component — answer `undefined` (fs.existsSync semantics: module
     * resolvers probe paths through files, e.g. `entry.js/index.js`, and
     * expect false, not a throw). Permission denials still propagate so
     * traverse-x enforcement cannot be masked into a quiet false.
     */
    private probeInode;
    private exists;
    private isDirectory;
    private isFile;
    private isSymlink;
    /**
     * Without a path: the global mutation clock, which is the last committed
     * generation (`vfs_state.gen`) as of the last publication. With a path:
     * the clock value at the last mutation inside that path's subtree, or the
     * revision floor if that is older than the revisions still held (0 if
     * nothing under it changed in this lifetime and nothing has been dropped).
     * Never less than the last mutation. `revision('')` equals the global clock
     * by construction (every mutation stamps all ancestors).
     */
    revision(path?: string, cred?: VfsCred): number;
    /**
     * A storage key's revision: its own stamp; else, for a file or symlink,
     * its row's generation, which its last mutation wrote and which survives
     * restarts, so an untouched file keeps its revision across incarnations;
     * else the floor. Never more than the global clock, so a row written by a
     * transaction not yet published reports the clock.
     */
    private pathRevision;
    /**
     * Advance the clock to the committed generation, stamp every path + its
     * ancestors, and record the mutation in the invalidation log. Every
     * mutation commits at least one generation before it gets here, so the
     * clock is strictly monotonic and equals `vfs_state.gen` after each
     * publication; an operation of several transactions ticks it once, to its
     * last generation.
     *
     * This is the single mutation chokepoint for coherence purposes. `rename`
     * bypasses the `_writeBatchOnce` funnel but reaches here, so a hook sited
     * anywhere else silently misses renames, which is the mutation most likely
     * to break a build tool.
     *
     * The log records the mutated path AND its parent. A facet's content
     * cells key on the exact path; its directory-shape view keys on the
     * parent. Recording only the path would let a facet observe a file's
     * bytes coherently while still believing the file does not exist.
     * Recording every ancestor would cost O(depth) entries per write for no
     * additional coverage, since no facet view keys on a grandparent.
     */
    private bumpRevision;
    /** Commit a generation that writes nothing, so a publication has a tick of its own. */
    private advanceGeneration;
    /**
     * Drop every per-path revision at or below the oldest quarter's newest,
     * and raise the floor to it. A quarter at a time, so the sort is paid once
     * per quarter of the budget, not once per mutation.
     *
     * Everything at or below one revision goes together, and a directory is
     * stamped whenever anything under it is, so it is never older than what it
     * holds: a dropped directory takes everything under it along, and
     * revision(dir) stays at or above the revision of every path under it.
     */
    private dropOldestPathRevisions;
    /** UTF-16 payload plus a flat allowance for the entry object itself. */
    private static entryBytes;
    private _record;
    /**
     * The paths mutated since `cursor`, for a facet holding a cache stamped
     * at `(epoch, cursor)`.
     *
     * Returns `poison` — meaning "drop the whole resident set" — when the
     * caller's view cannot be repaired incrementally: a different supervisor
     * incarnation (its revisions are unrelated to ours), or a cursor older
     * than the retained log (entries it needed have been dropped). Both
     * degrade to a cold cache, never to a stale byte.
     *
     * Each path carries the revision it was last mutated at inside the window,
     * not just its name. That is what lets a caller keep a cell it wrote
     * itself: it holds the revision its own write produced, so a report at
     * that same revision is its own mutation coming back, while a peer's
     * later write to the same path reports a HIGHER revision and still
     * invalidates. A name alone cannot separate those two, and the difference
     * between them is a whole resident set thrown away on every flush.
     *
     * A directory that was removed, renamed away, or given another mode, owner
     * or group is reported `structural`: what a reader holds under it may be
     * stale, or no longer the reader's to be served, so it evicts everything at
     * or under it. That is also what stops a store serving the rows under a
     * directory its reader has just been locked out of.
     *
     * With a credential, each path is the caller's own name for it, the one
     * `list()` reports it under: a confined caller's private /tmp/x is tmp/x.
     * A path it has no name for, such as the shared tmp/x, is outside its view
     * and left out. A path it has a name for but may not see is never left
     * out: it is reported as the nearest directory above it that the caller
     * may see, `subtree`-scoped (hiddenBehind), and the reader evicts
     * everything at or under that directory. So no name is reported that the
     * caller could not list now, and no change to a row it could have filled
     * goes unreported. Entries naming one path are merged, so a hidden
     * `rm -rf` costs one entry.
     */
    invalidatedSince(epoch: string | null, cursor: number, cred?: VfsCred): VfsAcquireResult;
    /**
     * The directory above `name` that stands between the caller and it, if
     * any: the highest that the caller may not enter now, or whose place went
     * at or after `rev` (removed or renamed away, so the entry names a path
     * that is no longer there, whatever stands at that name now). Null when
     * there is none: the caller may see `name` itself. The caller may see
     * whatever is returned, since every directory above it passed.
     */
    private hiddenBehind;
    /** The highest directory at or above `dir` that the caller may not enter now, or null. */
    private closedAbove;
    /**
     * A watch in `cred`'s view (CredentialedVfs.subscribe). A watch is not a
     * cache, so an event it may not see is simply not delivered.
     */
    private subscribe;
    /**
     * The caller's name for an event's path, if it may see it: every
     * directory above it enterable. A directory the same mutation removed is
     * judged as it was, so a removed tree the caller could see into is heard
     * entry by entry, and one it could not, only at its top.
     */
    private watchedName;
    /**
     * The delta for a cursor older than the log, from the rows themselves:
     * every row written in (cursor, rev] and every path deleted in it (its
     * tombstone), each with its parent, at the generation that wrote it. As
     * complete as the log, since every mutation writes a row or a tombstone.
     * Null (poison) below the tombstone floor, or past SQL_DELTA_MAX_PATHS,
     * where a reconcile against list() is cheaper than the delta.
     */
    private invalidatedFromSql;
    acquireExclusiveMutation(path: string, options?: ExclusiveMutationOptions): ExclusiveMutationLease;
    acquireGlobalExclusiveMutation(): ExclusiveMutationLease;
    releaseExclusiveMutation(owner: string): void;
    hasExclusiveMutation(): boolean;
    private withMutationOwner;
    assertMutationAllowed(path: string): void;
    private assertMutationsAllowed;
    private mkdir;
    private _mkdirSingle;
    private writeFile;
    private symlink;
    private readlink;
    /** Where `path` leads, in the caller's names, or null for a loop. */
    private resolveSymlink;
    private readFile;
    private readInodeBytes;
    /**
     * Read a whole file straight from SQL, bypassing the LRU content cache
     * entirely (neither consulted nor populated). For one-shot bulk reads
     * of large runtime binaries (e.g. the 31 MiB clang.wasm at facet
     * warm-up) that would otherwise evict the user's hot working set and
     * pin the file's chunks — the full 32 MiB LRU — resident in the DO heap
     * for the whole session. Demand-paging cache semantics are wrong for a
     * blob read once and handed to a Worker Loader module map.
     */
    private readFileUncached;
    /**
     * Read `length` bytes at `offset` without assembling the whole file —
     * only the chunks overlapping the range are touched. Reads past EOF are
     * clamped.
     *
     * `cached: false` reads the range straight from SQL, neither consulting nor
     * populating the LRU — the ranged counterpart of `readFileUncached`, and it
     * exists for the same reason. A boot spec's by-path members are the largest
     * files a session holds (a ruby interpreter image is 34.3 MiB against a
     * 32 MiB LRU) and each is read once and handed to a Worker Loader module
     * map, so demand-paging semantics are simply wrong for them: caching one
     * evicts the user's whole hot working set and pins the blob in this DO's
     * heap for the rest of the session. Ranged rather than whole-file because a
     * host that is not this DO reads them in slices that fit an RPC value, and
     * re-reading the whole file per slice would multiply the SQL work by the
     * slice count.
     */
    private readRange;
    /** Bytes [start, end) of the content an inode (or a snapshot's row) names. */
    private readContent;
    private copyManifestRow;
    /**
     * The manifest rows of `contentId` overlapping [start, end), in order.
     *
     * A manifest of a file up to MANIFEST_KEPT_BYTES (at most 256 rows) is read
     * whole once and kept (manifestWindows), so a run of small reads in it costs
     * its chunk reads alone, as it did when chunks were positional. A larger one
     * is read per range: one descending seek for the row holding `start`, and a
     * range scan only past its end. A kept manifest is dropped when it is edited.
     */
    private manifestRange;
    /** One chunk's bytes, through the LRU when `cached`. */
    private readChunk;
    /**
     * The content key of an inode's bytes: sha256 of them up to CHUNK_SIZE,
     * else the digest of the manifest's ordered chunk hashes. An in-place edit
     * clears a manifest's digest; it is recomputed here and stored unless
     * another content already holds it.
     */
    private contentKeyOf;
    /** contentKeyOf from a list row's joined chunk hash or digest, so a page costs no lookup per file. */
    private listedContentKey;
    private contentKey;
    /**
     * Overwrite `bytes` at `offset`. Only the chunks around the range are
     * re-cut and rewritten (rewriteFile); writing past EOF zero-fills the gap.
     * Creates the file when missing; callers own parent-dir creation (same
     * contract as writeFile).
     */
    private writeRange;
    /**
     * Publish an append and its dedupe receipt in the same SQLite transaction.
     * Large content may stage privately first, but its inode publication and
     * receipt still share the final transaction. Receipts are removed only by
     * explicit client acknowledgement after that client relinquishes retries.
     */
    private appendOnce;
    activateAppendWriter(pid: number, writerId: string): void;
    private acknowledgeAppend;
    revokeAppendWriter(pid: number, writerId: string): void;
    revokeAppendWriters(pid: number): void;
    revokeAppendWritersThrough(maxPid: number): void;
    private finishAppendPidRevocation;
    private deleteAppendRowsBounded;
    private resumeAppendMaintenance;
    /**
     * Truncate or zero-extend to `size`. Only the chunk at the new end is
     * re-cut; rows past it go. Every mutation commits before return.
     */
    private truncate;
    /**
     * Publish `node` resized to `newSize`, with `change` written over it and
     * any growth zero-filled. `path` null is a detached description (unlinked,
     * still open): its content is always copied, never edited in place.
     *
     * A file up to CHUNK_SIZE is one chunk, rewritten in place when nothing
     * else can see it. A larger file is re-cut from the start of the old chunk
     * holding the first changed byte until a new cut lands on an old boundary
     * past the change (FastCDC resynchronises there, so every later chunk is
     * what cutting the whole file would give) or the end. An unshared manifest
     * is then edited in place over that span in one transaction; a shared or
     * oversized one is rebuilt as a new staged content, the untouched rows
     * copied by reference. The manifest always equals FastCDC of the bytes.
     */
    private rewriteFile;
    /** Publish a rewrite in one transaction when it fits; false when it does not. */
    private tryPublishRewrite;
    private publishRewrite;
    private rewrittenEntry;
    private commitRewrite;
    /** The start offsets of a manifest's rows after `after`, read a page at a time on demand. */
    private manifestOffsets;
    /**
     * True when nothing but the live row at `path` can observe `node`'s chunk,
     * so the chunk may be rewritten in place: no other inode, manifest or
     * history row names it, no snapshot can see the row (the write would
     * preserve it), and no detached description holds it.
     */
    private chunkUnshared;
    /** The manifest counterpart of chunkUnshared: the CoW guard for large files. */
    private contentUnshared;
    private newPlan;
    /** Create a state-0 content in its own transaction and hold it live. */
    private beginStaging;
    /**
     * Copy `source`'s manifest rows over [lo, hi) into `staging` by reference,
     * a bounded page per transaction. The copied chunks' hashes are not read,
     * so the published content's digest is left for contentKey to fill.
     */
    private stageManifestCopy;
    /** A staging content that will never publish: queue it now. */
    private abandonStaging;
    private readFileString;
    private stat;
    /** A linked inode's stat, for `stat` and for the entries `list` reports. */
    private statOf;
    /**
     * Rewrite an inode's metadata in its own generation. The row is rewritten
     * whole so a snapshot that can see it keeps its before-image, and the
     * content it names carries over by reference.
     */
    private publishMetadata;
    private utimes;
    /**
     * Set the permission bits durably. Follows symlinks (POSIX chmod).
     *
     * The stored value is a full POSIX st_mode: S_IF* filetype bits ORed
     * with the permission bits. Filetype bits double as the "mode was
     * explicitly set" marker: rows written before chmod existed carry
     * bare permission values (0o644/0o755), and the exec-dispatch
     * grandfather rule (see shell/exec-dispatch.ts) keeps wasm-magic
     * files with such untouched modes executable. No migration — legacy
     * rows upgrade the first time they are chmod'ed.
     */
    private chmod;
    private setDefaultAcl;
    private getDefaultAcl;
    private chown;
    /**
     * Enumerate the filesystem, one bounded page at a time.
     *
     * This is the answer to a question no facet could previously ask. A process
     * is shipped a prefetch bundle plus the ancestors of what is in it, so every
     * map it holds describes what it was GIVEN, never what EXISTS — a resident
     * store that enumerated from those maps could only ever re-cache the bundle,
     * which is the admission problem it exists to delete.
     *
     * Ordered by path so `after` is a stable resume key across pages. Ordering
     * by anything else would let an insert during pagination shift entries
     * across the page boundary and drop them. The order is the path index's
     * own, so a page is one range read of it: nothing is sorted, and nothing
     * beyond the page is read.
     *
     * Access is checked per path against the caller's credential, and a path it
     * cannot reach is OMITTED rather than reported. Omission is the safe
     * direction: a filler that never learns of a path simply misses it, and the
     * miss falls through to the supervisor, which denies it in its own right.
     * Reporting the path instead would leak the existence of files the process
     * has no permission to see.
     */
    private list;
    private acquire;
    private readdir;
    private unlink;
    private rmdir;
    /**
     * Remove a path and everything beneath it, in bounded transactions.
     *
     * Walking the tree and issuing one transaction per entry cost a commit and
     * a content-maintenance pass apiece — 19,429 of each for a single npm
     * install's tree, on top of the whole-filesystem scan every one of them
     * paid. That took long enough on the object's only thread to exceed its
     * per-request CPU budget: the removal committed, the object was reset, and
     * every WebSocket it held closed 1006. A bounded group of entries commits
     * together instead, closed on the entry before the one that would overflow
     * it, and the removal owes one maintenance pass rather than one per group.
     *
     * Removal is group-atomic rather than path-atomic. Because every entry goes
     * before the directory holding it, every committed prefix is a consistent
     * smaller tree — exactly the state an interrupted per-entry walk left
     * behind. The subtree is read a page at a time, never held whole.
     */
    private removeRecursive;
    /**
     * The inodes under `root`, then `root` itself, in descending path order, a
     * bounded page at a time. A path under a directory extends the directory's
     * path, so it sorts after it: every entry comes before the directory that
     * holds it. Each page starts below the last path read, so removing what
     * was already yielded does not disturb the walk.
     */
    private subtreeDescending;
    private rename;
    /**
     * Unwind the destination inodes a failed move had already published.
     *
     * These rows name content the source still owns, so removing them collects
     * nothing — the point is only that a retry sees an empty destination rather
     * than a subtree conflict. Deepest-first in bounded groups, like any other
     * removal. A failure here is swallowed: the caller is already unwinding, and
     * the source tree — which is what the data lives in — is untouched either
     * way.
     */
    private unpublishRenameDestination;
    /**
     * Copy a file by reference: one inode row naming the source's chunk or
     * manifest. No byte is read or written; a later write to either side
     * copies on write (rewriteFile's sharing probes).
     */
    private copyFile;
    /**
     * Copy the tree at `src` to a new path `dst` by reference (`cp -r`): one
     * inode row per entry naming the source's chunk or manifest, no byte read
     * or written, `INSERT … SELECT` pages of COPY_PAGE_ROWS rows per
     * transaction. Returns the entries copied.
     *
     * Without `preserve` a copy is a new file of the caller's (cp without -p):
     * the caller owns it, the umask and setuid/setgid clearing apply, and its
     * times are now. With it, mode and times carry over, and ownership too
     * when the caller is root.
     *
     * Symlinks are copied as links. Every entry must be readable by the
     * caller, and every directory searchable, before the first page commits.
     * A `vfs_jobs` row records the cursor, so a reset mid-copy resumes to the
     * complete tree at the next open.
     *
     * `at` copies from a snapshot instead of the live tree: lock-free, since
     * the snapshot's rows never change while writers keep writing the source,
     * and a snapshot a job reads from cannot be dropped.
     */
    private planCopyTree;
    private copyTreeInSlices;
    /** A whole copy in one turn: its reservation is drawn and then released. */
    private copyTreeNow;
    /** Reserve a planned copy's rows in the ledger (N18); its slices draw from it. */
    private reserveCopy;
    /** Every entry strictly under `root` as of generation `g`, a page at a time. */
    private subtreeAt;
    /**
     * Run a copyTree job to completion: the root row and the job row in the
     * first transaction, then one page per transaction, the cursor moving in
     * the transaction that copies the page. `id` resumes a recorded job.
     */
    private runCopyTree;
    /**
     * Continue every job a reset interrupted, from its cursor: one slice now,
     * at open, and the rest in slices with a yield between, so a job of any
     * size never holds one synchronous turn.
     */
    private resumeJobs;
    /**
     * One slice of an interrupted copy (N18). Its first slice after an open
     * reserves what is left to copy, as a copy does when it starts, so no
     * writer between the slices can leave it without room. Refused, the job
     * ends: what it had copied is removed (a pure removal, never refused) and
     * its row goes, so it is never half-applied.
     */
    private resumeCopySlice;
    /** Rows a copy job has left: the source's rows past its cursor, and each page's two. */
    private remainingCopyRows;
    /** One slice of job `id`; true once it is done (or gone, or failed). */
    private resumeSlice;
    /** Every snapshot, oldest first. */
    snapshots(): SnapshotInfo[];
    /**
     * Pin the current tree under `name`: one row and pin_gen, in one
     * transaction, whatever the tree's size. Every synchronous operation runs
     * inside one turn, so it cannot interleave with one; a `writeStream` spans
     * awaits, and without `quiesce` the snapshot holds its committed groups, the
     * state a reset would leave. `quiesce` waits for every stream first.
     */
    snapshot(name: string): SnapshotInfo;
    snapshot(name: string, options: {
        quiesce: true;
    }): Promise<SnapshotInfo>;
    /**
     * Run `pin` once nothing spans awaits and no exclusive lease is held: the
     * check and `pin` run in one turn, so nothing can start between them. New
     * spanning work waits behind the gate until then (Kinu N14: await, never
     * EBUSY). A lease is synchronous and cannot wait, so one taken meanwhile
     * is waited out too.
     */
    private quiesced;
    /**
     * Spanning work: held behind a quiescing snapshot, and awaited by the next
     * one. Work under a live exclusive lease (`owner`) is part of what the
     * snapshot already waits for, the lease, so it is never held: holding it
     * would hold the lease forever (a clone streaming its batches).
     */
    private spanning;
    private pinSnapshot;
    private snapshotGen;
    private requireSnapshot;
    /** The inode at `path` as of generation `g`: its live row if unchanged since, else the history row covering `g`. */
    private inodeAt;
    /** The children of `dir` as of generation `g`, in UTF-16 name order (readdir's). */
    private childrenAt;
    /** One keyset page of the tree as of `g`, in path order: live and history merged. */
    private pageAt;
    /**
     * A read-only view of snapshot `name` for `cred`: the same methods, the
     * same permission checks and symlink resolution, over the tree the
     * snapshot pinned. Mutators throw EROFS; every call after the snapshot is
     * dropped throws ESTALE (its history may already be collected).
     */
    at(name: string, cred?: VfsCred): CredentialedVfs;
    /**
     * Restore the live tree (or `subtree`) to snapshot `name`, in bounded
     * transactions of RESTORE_PAGE_ROWS paths. Every path changed since the
     * snapshot is replaced by the row the snapshot saw, or removed if the
     * snapshot did not have it; every path the snapshot had and the live tree
     * lost comes back. It is an ordinary write: new generations, revisions,
     * events, before-images for any other snapshot. O(changes since the
     * snapshot), not O(tree). A `vfs_jobs` row makes it resumable: a reset
     * mid-restore finishes at the next open. Returns the paths it changed.
     */
    restore(name: string, options?: {
        subtree?: string;
    }): {
        restored: number;
    };
    /**
     * restore in slices with a yield between, for a restore of any size in
     * workerd. `mutationOwner`: the live exclusive lease it runs under (its
     * holder awaits it), so it restores inside the lease and a quiescing
     * snapshot never holds it.
     */
    restoreAsync(name: string, options?: {
        subtree?: string;
        mutationOwner?: string;
    }): Promise<{
        restored: number;
    }>;
    private restoreInSlices;
    /** The restore job for (name, subtree): the one a reset or a cold chunk stopped, or a new one. */
    private restoreJob;
    private runRestore;
    /** The history row covering generation `g` at `path`, if any. */
    private historyAt;
    /**
     * Drop snapshot `name`: its row and pin_gen in one transaction, then the
     * history rows no remaining snapshot covers, a page per transaction, each
     * page queuing the references it drops. Refused while a restore or a
     * copy reads from it. Returns the history rows removed.
     */
    dropSnapshot(name: string): {
        dropped: number;
    };
    /** dropSnapshot in slices with a yield between. */
    dropSnapshotAsync(name: string): Promise<{
        dropped: number;
    }>;
    private dropJob;
    private runDrop;
    /**
     * What changed between two trees of this filesystem: snapshots by name, or
     * `null` for the live tree. Only paths some generation between the two
     * wrote are examined — O(changes), not O(tree) — and content is compared by
     * key, so an equal key proves equal bytes. One page in path order.
     */
    diff(from: string | null, to: string | null, options?: {
        after?: string;
        limit?: number;
    }): {
        entries: VfsDiffEntry[];
        next: string | null;
    };
    /** Jobs in flight: what a reset would resume at the next open. */
    jobs(): {
        id: number;
        kind: string;
        args: unknown;
        cursor: string;
    }[];
    /**
     * The storage ledger (N18): what the store holds and what snapshots pin.
     * Counts scan indexes, so this is for diagnostics and admission decisions,
     * not a per-request poll (getStats stays O(1)).
     */
    storeStats(): {
        chunks: number;
        chunkBytes: number;
        contents: number;
        historyRows: number;
        gcQueued: number;
        snapshots: number;
        jobs: number;
        databaseBytes: number;
        /** The session's storage ledger (N18): used, the limit, and its parts. */
        ledger: StorageLedgerView;
    };
    /**
     * One page of snapshot `at`'s tree under `root`, after the relative path
     * `after` (null: from the start), in path order. Rows carry their chunk
     * hashes and sizes, never bytes; a page stops at `limit` rows or
     * EXPORT_PAGE_PIECES chunk references. `next` is the cursor for the
     * following page, null after the last.
     */
    exportPage(options: {
        at: string;
        root?: string;
        after?: string | null;
        limit?: number;
    }): VfsExportPage;
    private exportRow;
    /**
     * sha256 over a page's rows (path, metadata, chunk hashes): equal digests
     * mean equal trees for that page, so two databases compare page by page
     * and only a differing page is compared row by row. Memoized by snapshot
     * generation, since a snapshot's rows never change.
     */
    pageDigest(options: {
        at: string;
        root?: string;
        after?: string | null;
        limit?: number;
    }): {
        digest: string;
        next: string | null;
    };
    /** The chunk hashes a page names that this database does not hold. */
    wantChunks(page: VfsExportPage): string[];
    private absentChunks;
    /**
     * The bytes of chunks by hash, up to `maxBytes` (at least one chunk);
     * `rest` is what did not fit. ENOENT for a hash this database lacks.
     */
    exportChunks(hashes: readonly string[], maxBytes?: number): {
        chunks: VfsExportChunk[];
        rest: string[];
    };
    /**
     * Where an import into `dst` stands: the relative path of the last row
     * committed (resume with exportPage({ after })), '' when only the root
     * is, null when nothing is. Rows commit in path order, so this is exact
     * after a reset.
     */
    importCursor(dst: string): string | null;
    /**
     * Write one exported page under `dst`. The first page of an import needs
     * `dst` absent or an empty directory, and records a vfs_jobs row; later
     * pages continue it, and rows at or before importCursor(dst) are skipped,
     * so a page replayed after a reset is harmless. Every chunk given is
     * re-hashed before anything is written; if the page names a chunk neither
     * given nor stored, nothing is written and `want` lists what to send.
     * Files too large for one transaction stage across several.
     */
    importPage(dst: string, page: VfsExportPage, chunks?: Iterable<VfsExportChunk>, options?: {
        lazy?: boolean;
    }): {
        imported: number;
        want: string[];
        done: boolean;
        pending: string[];
    };
    private importPageNow;
    /**
     * Rows for chunks a lazy import names without bytes (N17): hash and size,
     * no data, state pending. Each is queued for collection too, so one that
     * no committed row comes to name is not kept.
     */
    private insertPendingChunks;
    /**
     * Store the bytes of pending chunks (N17), each re-hashed first. A chunk
     * whose bytes do not hash to its name is not stored and is reported in
     * `invalid`; the rest of the batch is stored. A chunk that is not pending
     * (stored already, or collected) is skipped.
     */
    hydrateChunks(chunks: Iterable<VfsExportChunk>): {
        stored: string[];
        invalid: string[];
    };
    /** Which of `hashes` (hex) are pending chunks (N17). */
    pendingOf(hashes: readonly string[]): string[];
    /**
     * The pending chunks (N17) `path`'s bytes name, in the file's order (a
     * hash once per file), as hex; none for a path with none, or no file.
     */
    pendingChunksOf(path: string): string[];
    /**
     * Store chunks for an import into `dst` ahead of its pages, a bounded
     * transaction at a time, so no page has to carry bytes and a file of any
     * size imports in frames. Each chunk is re-hashed first. They are held by
     * a staging content the import owns until its last page; after a reset
     * GC may take them, and importPage then names them in `want` again.
     */
    importChunks(dst: string, chunks: Iterable<VfsExportChunk>): {
        stored: number;
    };
    private importJob;
    /** An import starts into an absent path or an empty directory under an existing one. */
    private assertImportTarget;
    private beginImport;
    private hasChildren;
    private importedEntry;
    /**
     * Move up to `maxChunks` snapshot-only chunks to the cold store, and
     * delete the cold objects GC released. One pass walks the chunk table from
     * where the last stopped. Returns what it moved.
     */
    tierColdChunks(maxChunks?: number): Promise<{
        tiered: number;
        bytes: number;
        deleted: number;
        done: boolean;
    }>;
    /** Delete from the cold store what GC released, a page at a time. */
    private drainColdTrash;
    /**
     * Bring back every cold chunk snapshot `name` references under `root`,
     * and keep them local until releaseSnapshot(name): after this, at(name),
     * restore(name) and copyTree(..., { at: name }) read synchronously.
     * O(history rows covering the snapshot), since only those can be cold.
     */
    prepareSnapshot(name: string, options?: {
        root?: string;
    }): Promise<{
        hydrated: number;
        bytes: number;
    }>;
    /** Let tiering move snapshot `name`'s chunks again. */
    releaseSnapshot(name: string): void;
    /** Hashes of cold chunks the history rows covering `g` under `root` reference. */
    private coldChunksAt;
    /** Fetch cold chunks by hash, re-hash them, and store them local again. */
    private hydrate;
    /** Throw ENODATA if a restore or copy from generation `g` under `root` would publish a cold chunk. */
    private assertSnapshotLocal;
    private requireColdStore;
    /**
     * Where a new entry at storage key `key` goes: its parent as it resolves
     * (links followed) plus its own name, as writeFile/unlink/rename place
     * theirs. A parent that does not exist yet (made in the same batch or
     * mkdir -p) is placed the same way, recursively. `memo` shares that work
     * across one operation.
     */
    private createdPath;
    private normalizeBatchInode;
    private authorizeBatch;
    /**
     * Atomic bulk write: ALL inodes + chunks in ONE transactionSync().
     *
     * The complete mutation is preflighted against the Stage 2 transaction
     * limits, then executed in one transaction with 9-inode / 33-chunk SQL
     * grouping. Oversized strict calls fail with E2BIG before mutation.
     */
    private writeBatch;
    /**
     * Authorise and commit one batch, without the maintenance pass. A standalone
     * mutation owes that pass; an operation built from several transactions owes
     * exactly one when it is finished. Charging it per transaction made removing
     * a tree run the orphan scan — which reads the chunk table — once for every
     * bounded group of the removal.
     */
    private commitBatch;
    /**
     * Write a file too large for one transaction: its FastCDC chunks stage into
     * a state-0 content over bounded transactions, and one more publishes it.
     * Until then no inode names the content and GC steps over it (active).
     */
    private replaceFileWithStagedContent;
    /**
     * The inode row publishing `inode` with `content`. Ownership is inherited
     * from what the path already holds; the reference it replaces is queued by
     * the transaction that commits it.
     */
    private fileEntry;
    private publishStagedFile;
    /**
     * Incremental W7 v3 consumer. Chunk payload is admitted through one
     * per-VFS weighted credit pool and committed in bounded synchronous
     * transactions, which release their credit before the decoder pulls
     * another record.
     *
     * Publication is group-atomic with a committed prefix: a bounded group of
     * whole files commits in one transaction, and either every file in it is
     * durable or none is. A file never publishes partially — a group is closed
     * on the record boundary before the file that would overflow it, so a file
     * too large for one transaction stages across several and publishes on the
     * last. Chunks staged for a file still in flight may ride along in a group
     * that publishes other files; they belong to a state-0 content no inode
     * references yet, so nothing observes them.
     *
     * The wire's 64 KiB positional chunks are re-cut by FastCDC as they arrive
     * (ContentCutter holds at most one chunk of carry), so a streamed file is
     * stored exactly as the same bytes written any other way.
     */
    private writeStream;
    private consumeStream;
    private _writeBatchWithRetry;
    /**
     * Estimate the byte cost of a writeBatch payload. Used by the W5
     * recordFailure call so /api/_diag/memory can report inFlightBytes
     * at the moment of the SQLITE_NOMEM. Fast (no copy).
     */
    private _estimateBatchBytes;
    private errorMessage;
    private isSqliteNoMem;
    /**
     * Participate in an embedder's synchronous transaction: VFS writes and SQL
     * issued by callback commit together; on rollback the in-memory mirror
     * returns to the committed state before the error is rethrown with cause.
     *
     * This method MUST own the outermost transaction on this VFS's SQL host;
     * use it instead of wrapping VFS calls in storage.transactionSync. Do not
     * nest it, return a Promise/thenable, or start asynchronous work inside it.
     * The callback may read its writes. Revisions and events publish only on
     * commit, once for the combined mutation. Existing credential checks apply.
     *
     * Rollback discards the cached chunks and inodes and unloads the counters,
     * so every later read answers from SQLite, which is back at the committed
     * state; open descriptions return to the rows they described before.
     * No inode snapshot or undo log is retained. Recovery failure is surfaced
     * with both errors; the embedder must discard this VFS in that case.
     */
    withTransaction<T>(callback: () => T): T;
    /**
     * Deliver a mutation's events while the directories it removed are still
     * known by their modes (watchedName). Inside an embedder transaction the
     * events wait for its publication, and so do the directories.
     */
    private deliverEvents;
    private emitMutation;
    private transactionSync;
    /**
     * Commit one plan as one transaction and one generation.
     *
     * `priors`, when the caller has them, holds what stood at each of
     * `plan.inodes`' paths before this transaction, in the same order.
     *
     * Order inside the transaction: advance the generation; keep before-images
     * of rows a snapshot can see; remove deleted rows; create staging rows;
     * resolve every chunk by hash (hits reuse, misses insert with ids from
     * next_chunk); resolve whole large files by manifest digest; publish or
     * edit manifests; upsert inodes; queue every reference a replaced or
     * removed row held and no row now holds; store the counters.
     */
    private executeTransactionPlan;
    /** Multi-row INSERT of `values`, `columns` per row, in statements under the bound-parameter limit. */
    /**
     * Chunk rows as (id, hash, data) triples; size is length(data), so a row
     * binds three parameters, not four: 33 rows a statement instead of 25.
     * The statement count is what an unshared large write pays per
     * transaction (measured in workerd, where it dominated).
     */
    private insertChunkRows;
    /**
     * Manifest rows as (content_id, off, len, chunk_id) quadruples, a run of
     * one content binding its id once: 33 rows a statement for one file's
     * manifest, and never fewer than 25.
     */
    private insertManifestRows;
    private insertRows;
    /**
     * N18: a transaction that can grow the database is admitted by the
     * session's ledger before it runs (ENOSPC, nothing written, when it would
     * cross the storage limit). Collection and pure removals only free, and are
     * never refused.
     */
    private admitTransaction;
    /**
     * Run `fn` (synchronous, so nothing interleaves) as the operation that
     * holds reservation `id`: its transactions draw from it.
     */
    private withReservation;
    /** The bytes this database occupies on the host (workerd's databaseSize; SQLite's pages elsewhere). */
    databaseBytes(): number;
    private executeMeasuredTransaction;
    /**
     * Bounded, idempotent content maintenance: at most `maxTransactions`
     * transactions of, in order, the legacy janitor, content GC, chunk GC and
     * one page of the reference audit.
     *
     * GC deletes only what vfs_gc_queue names, and only after probing every
     * reference in the deleting statement, so a stale or duplicate queue row
     * costs a probe, never data; the queue is the work list, the probe is the
     * authority. Ids a live description or staging holds are stepped over and
     * stay queued. Each kind is popped in key order from a cursor, which is
     * what keeps a page a range read of the queue's primary key.
     */
    runContentMaintenance(maxTransactions?: number): {
        transactions: number;
    };
    /** Tombstones held, counted once and then kept by the writers (an overcount only prunes early). */
    private tombstoneRows;
    /** Drop the oldest page of tombstones and raise the floor to the newest dropped. */
    private pruneTombstones;
    /**
     * The next page of queued ids of `kind` past the cursor, pinned ones
     * stepped over (the cursor moves past them; they stay queued). Null when
     * the queue has nothing past the cursor.
     */
    private gcPage;
    /**
     * Collect queued contents that no inode or history row names. A content
     * found dead is marked dying (state 2, digest cleared) in the same
     * transaction, so digest dedup can never adopt it again; its manifest then
     * drains a bounded page per transaction, and the row goes when the manifest
     * is empty. The drained rows' chunks are collected in the same transaction
     * when nothing else names them, and queued when something might.
     */
    private collectContents;
    /** Delete queued chunks that no inode, manifest or history row names. */
    private collectChunks;
    /**
     * One page of the reference audit: queue every chunk and content in the
     * page that nothing names: chunks first, then contents. It finds only what
     * a bug leaked, so it walks once per lifetime, a page per maintenance run,
     * and stops.
     */
    private auditPage;
    /** Queue rows (kind, id pairs) for the chunks and contents given that nothing names. */
    private unreferenced;
    /**
     * Debug-only: walk every chunk and content and report what nothing names
     * and the queue does not hold. Zero after GC means no leak. O(store); tests
     * and diagnostics only.
     */
    _auditContentStore(): {
        chunks: number;
        contents: number;
    };
    /** Delete one page of the first legacy table's rows; drop it once empty. */
    private legacyJanitorPage;
    private runContentMaintenanceSafely;
    private metricsOnlyPlan;
    private recordOverLimitFile;
    private recordDuration;
    private currentRetainedWriteBytes;
    /** Best-effort process.memoryUsage().heapUsed; 0 in DO contexts. */
    private _safeHeapUsed;
    /**
     * The plan of one strict batch. Every file's positional wire chunks are
     * joined, cut and hashed here, before the transaction; the hashes resolve
     * to chunk ids inside it.
     */
    private prepareBatchTransaction;
    private validateFileChunks;
    private validateInodeContentShape;
    private assertTransactionFits;
    private _writeBatchOnce;
    /**
     * Every inode at or under each root, deepest first.
     *
     * The path index answers "what is under this prefix?" in the size of the
     * subtree (subtreeRange). The scan it replaces answered it in the size of
     * the whole filesystem, and every mutation resolved its deletions twice —
     * once to preflight the plan, once to commit it — so removing a tree of N
     * entries one path at a time cost N(N+1) comparisons: ~4.8 × 10^8 for a
     * 19,429-file tree, on the object's only thread.
     *
     * The subtree is held whole, so only callers that commit it whole use this:
     * a batch's deletions and a rename. A removal pages (subtreeDescending).
     */
    private collectSubtreeInodes;
    /**
     * Bulk mkdir: create all directories in a single transactionSync.
     * Pre-creates the full directory tree before file writes to avoid
     * per-file mkdir overhead.
     */
    private mkdirBatch;
    /**
     * Debug-only: aggregate the counters from the durable rows and return any
     * drift against the running counters. Returns null if consistent. Used by
     * the B3 runtime test; production paths should never call this (the whole
     * point of B3 is avoiding the O(N) read). Counters no read has loaded yet
     * are loaded from the same aggregate, so they cannot drift.
     */
    _verifyCounters(): null | {
        expected: {
            files: number;
            dirs: number;
            bytes: number;
        };
        actual: {
            files: number;
            dirs: number;
            bytes: number;
        };
    };
    /**
     * The root mount's df numbers. `size` is the Durable Object storage limit
     * this store is built to fit; `used` the bytes of file content stored;
     * `available` what the host can still take: the limit less the whole
     * database (content plus metadata, indexes and free pages) where the host
     * reports its size, else less the stored bytes.
     */
    storageUsage(): {
        size: number;
        used: number;
        available: number;
    };
    getStats(): {
        files: number;
        directories: number;
        usedBytes: number;
        capacityBytes: number;
        backend: string;
        cache: {
            entries: number;
            maxEntries: number;
            chunkSize: number;
            hotBytes: number;
            maxBytes: number;
            hits: number;
            misses: number;
            hitRate: number;
            evictions: number;
            lruShrunk: boolean;
        };
        sql: {
            reads: number;
            writes: number;
            batchWrites: number;
            batchWriteRows: number;
            writeStreamSpoolBytes: number;
            retainedWriteBytes: {
                current: number;
                peak: number;
            };
            decoderRetainedBytes: {
                current: number;
                peak: number;
            };
            creditRetainedBytes: {
                current: number;
                peak: number;
                limit: number;
                queued: number;
            };
            stagedBytes: {
                current: number;
                peak: number;
            };
            gcBytes: {
                current: number;
                peak: number;
            };
            phases: {
                decodeDrainWaitMs: {
                    current: number;
                    count: number;
                    total: number;
                    last: number;
                    max: number;
                };
                creditWaitMs: {
                    current: number;
                    count: number;
                    total: number;
                    last: number;
                    max: number;
                };
                maintenanceMs: {
                    current: number;
                    count: number;
                    total: number;
                    last: number;
                    max: number;
                };
            };
            transactions: {
                limits: {
                    blobBytes: number;
                    logicalRows: number;
                    sqlExecs: number;
                };
                active: boolean;
                durationMs: {
                    p95: number;
                    current: number;
                    count: number;
                    total: number;
                    last: number;
                    max: number;
                };
                postCommitDurationMs: {
                    current: number;
                    count: number;
                    total: number;
                    last: number;
                    max: number;
                };
                blobBytes: {
                    current: number;
                    last: number;
                    peak: number;
                };
                logicalRows: {
                    current: number;
                    last: number;
                    peak: number;
                };
                sqlExecs: {
                    current: number;
                    last: number;
                    peak: number;
                };
                affectedPaths: {
                    current: number;
                    last: number;
                    peak: number;
                };
                boundedPeak: {
                    blobBytes: number;
                    logicalRows: number;
                    sqlExecs: number;
                };
                last: {
                    source: TransactionSource;
                    limitMode: TransactionLimitMode;
                    blobBytes: number;
                    logicalRows: number;
                    sqlExecs: number;
                    affectedPaths: number;
                } | null;
                overLimitFiles: {
                    count: number;
                    last: (TransactionPlanMetrics & {
                        path: string;
                        limit: TransactionLimit;
                    }) | null;
                };
            };
        };
        events: {
            totalEmitted: number;
            totalBatches: number;
            globalListeners: number;
            pathListeners: number;
            pending: number;
        };
        inodes: {
            total: number;
            files: number;
            directories: number;
            resident: number;
            cacheCapacity: number;
            memoryEstimate: number;
        };
        pathRevisions: {
            paths: number;
            bytes: number;
            maxBytes: number;
            floor: number;
        };
    };
}
/**
 * A read of bytes a lazy import has not brought yet (N17): EIO naming the
 * path, and marked, so an asynchronous caller can wait for them instead.
 */
export declare function pendingChunkError(path: string): Error & {
    code: string;
    nimbusPending: true;
    path: string;
};
/** Whether `error` is a read of bytes still being imported. */
export declare function isPendingChunkError(error: unknown): error is Error & {
    path: string;
};
//# sourceMappingURL=sqlite-vfs.d.ts.map