/**
 * SqliteVFS — Demand-paged virtual filesystem on DO SQLite.
 *
 * Architecture (from webcontainer-v2-feasibility.md §4):
 *
 * ┌─────────────────────────────────────────┐
 * │           Nimbus VFS (in-memory)           │
 * │  INode cache: bounded view of `inodes`   │  64k entries ≈ 14 MB (V8)
 * │  ContentCache: LRU file content cache    │  ~32 MB (512 × 64KB)
 * │  ─────────────────────────────────────── │
 * │  On cache miss → SQLite read             │
 * │  Writes commit synchronously to SQLite   │
 * │  On npm install → batch SQLite writes    │
 * └─────────────────────────────────────────┘
 *          │                    │
 *          ▼                    ▼
 * ┌─────────────────┐  ┌─────────────────────┐
 * │  file_chunks     │  │  inodes              │
 * │  (content_id,    │  │  (path, type, mode,  │
 * │   chunk_id, data)│  │   size, content_id)  │
 * │  64KB chunks     │  │                      │
 * └─────────────────┘  └─────────────────────┘
 *            DO SQLite (10 GB)
 *
 * Key design from do86's SqlPageStore:
 * - Disposable read cache; SQLite owns every accepted write durably
 * - Bounded batch writes (33 chunk rows per INSERT)
 * - All operations SYNCHRONOUS (DO sql.exec() is sync)
 *
 * Durability:
 * - writeFile() returns void (sync) — preserved to match LIFO's
 *   MountProvider.writeFile(subpath, content): void contract.
 * - Every write returns only after its SQLite transaction commits. Large
 *   replacements stage bounded chunk groups and atomically publish the new
 *   content generation before returning.
 *
 * Key design decisions:
 * - 64KB chunks (not 4KB): file access is sequential, fewer rows
 * - INode metadata demand-loaded by path through a bounded cache; SQLite
 *   indexes it by path and by parent, so no walk needs the whole tree
 * - File content demand-paged through LRU cache
 */
import { VfsEventEmitter, type VfsEvent } from './events.js';
import { type BatchWritePayload, type VfsInodeKind } from '@nimbus-sh/platform/w7-frame.js';
import { type VfsCred, type VfsAcquireResult, type VfsListPage, type SqlDatabase, type TransactionHost } from '../runtime/os-contracts.js';
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
    utimes(path: string, atimeMs: number | null, mtimeMs: number | null): void;
    chmod(path: string, mode: number): void;
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
    unlink(path: string): void;
    rmdir(path: string): void;
    /**
     * Remove a path and everything beneath it, in bounded transactions.
     * Returns the number of entries removed.
     */
    removeRecursive(path: string): number;
    rename(oldPath: string, newPath: string): void;
    copyFile(src: string, dest: string): void;
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
}
export declare class SqliteVFS {
    private readonly openNodes;
    private sql;
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
    private readonly _epoch;
    private _invalidations;
    private _invalidationBytes;
    private static readonly INVALIDATION_LOG_MAX_BYTES;
    private removedForEvents;
    /** Identifies this supervisor incarnation. Never reused across restarts. */
    get epoch(): string;
    private readonly exclusiveMutationLeases;
    private activeMutationOwner;
    /** Shared by every concurrent stream targeting this session's VFS. */
    private readonly writeStreamCredits;
    private _stagedStreamBytes;
    private _peakStagedStreamBytes;
    /** In-memory liveness only; content_lifecycle remains durable ownership. */
    private readonly activeStagingContentIds;
    /** True only while durable GC work or a known abandoned staging row exists. */
    private maintenancePending;
    private orphanScanCursor;
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
    private initSchema;
    /**
     * Allocate the next inode number. The counter row and the inode insert that
     * consumes the value always share one transaction, so rollback discards the
     * bump together with the publication it funded.
     */
    private nextIno;
    /**
     * Give every durable inode row a stable ino. Rows that already carry one
     * keep it; rows published by the retired vfs_inode_identity side table
     * inherit that ino so existing stat().ino values do not change across the
     * upgrade; anything else takes its rowid, which matches what the shadow
     * table would have allocated for it anyway. The allocator is then seeded
     * past the largest ino in use.
     */
    private backfillInoColumn;
    /**
     * Fold legacy append-control tables into the namespace-scoped v2 schema.
     * Three layouts exist: pre-namespace tables (rows get the empty namespace,
     * which is what the rewrite effectively gave them since a namespace-less
     * deployment had exactly one scope), hex-suffixed tables produced by the
     * table-name rewrite (rows decode back to their real namespace), and the
     * v2 tables themselves. Legacy tables are renamed to vfs_append_legacy_*
     * rather than dropped so the data stays recoverable.
     */
    /** Decode a hex scope suffix back to its namespace; null when malformed. */
    private tableColumns;
    private migrateFromLegacy;
    /** The cache's loader: the inode at `path`, read from SQLite. */
    private loadInode;
    private inodeFromRow;
    /**
     * Number a row that has no ino. Every writer since the column existed
     * assigns one, and the backfill numbered every row older than the column,
     * so only code from before the column, run against this database after a
     * newer one had opened it, leaves one behind. The number comes from the
     * allocator, which is past every ino in use, so it cannot collide.
     */
    private repairIno;
    /**
     * Load the running counters with one aggregate over `inodes`, the first
     * time anything reads them. Opening does not pay for it; the first stats
     * read does, once.
     */
    private ensureCounters;
    /** Every non-directory counts as a file, symlinks included, as it always has. */
    private aggregateCounters;
    private cacheKey;
    private cacheGet;
    private cacheSet;
    private enforceCacheLimit;
    private evictOne;
    shrinkForInstall(targetEntries?: number): void;
    /** Decrement the heavy-alloc refcount. When the count returns to
     *  zero, restore the cap to LRU_MAX_ENTRIES. No re-population —
     *  the cache warms naturally on next reads. */
    restoreAfterInstall(): void;
    /** Drop every disposable cache entry before retrying a strict batch. */
    evictAll(): void;
    /**
     * Batch version of cacheInvalidate — invalidate every cache entry
     * whose path is in `paths`. One pass over the cache instead of one
     * pass per path (audit R2: writeBatch was O(P × C) before this).
     *
     */
    private cacheInvalidateBatch;
    openDescription(path: string, cred: VfsCred, rights: {
        read: boolean;
        write: boolean;
    }): VfsOpenDescription;
    private now;
    private parentPath;
    /** The single content resolver for both legacy-null and generated inodes. */
    private contentIdForInode;
    private legacyContentId;
    private createContentId;
    private blobToUint8Array;
    private copyBytes;
    private readChunkFromSql;
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
     */
    private resolvePath;
    private checkAccess;
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
     * Without a path: the global mutation clock. With a path: the clock
     * value at the last mutation inside that path's subtree, or the revision
     * floor if that is older than the revisions still held (0 if nothing under
     * it changed in this DO lifetime and nothing has been dropped). Never less
     * than the last mutation. `revision('')` equals the global clock by
     * construction (every mutation stamps all ancestors).
     */
    revision(path?: string, cred?: VfsCred): number;
    /** A storage key's revision: its own, or the floor once it was dropped. */
    private pathRevision;
    /**
     * Advance the clock once, stamp every path + its ancestors, and record
     * the mutation in the invalidation log.
     *
     * This is the single mutation chokepoint for coherence purposes. Five
     * mutation paths bypass the `_writeBatchOnce` funnel — `_mkdirSingle`,
     * `utimes`, `chmod`, `chown`, `rename` — but all of them reach here, so
     * a hook sited anywhere else silently misses renames, which is the
     * mutation most likely to break a build tool.
     *
     * The log records the mutated path AND its parent. A facet's content
     * cells key on the exact path; its directory-shape view keys on the
     * parent. Recording only the path would let a facet observe a file's
     * bytes coherently while still believing the file does not exist.
     * Recording every ancestor would cost O(depth) entries per write for no
     * additional coverage, since no facet view keys on a grandparent.
     */
    private bumpRevision;
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
    /** Read one chunk via cache → SQL, caching on miss. */
    private readChunk;
    private readFile;
    private readInodeBytes;
    private requireChunk;
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
     * only the chunks overlapping the range are touched. Reads past EOF
     * are clamped; missing spans retain the existing zero-fill range semantics.
     */
    /**
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
    /**
     * Overwrite `bytes` at `offset`, rewriting only the chunks the range
     * (plus any EOF extension) touches — file-handle and page writers must
     * not pay a whole-file rewrite. Writing past EOF zero-fills the gap so
     * every chunk row up to the new EOF stays materialized at its
     * positional length (readFile reassembles by plain concatenation).
     * Creates the file when missing; callers own parent-dir creation
     * (same contract as writeFile).
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
     * Truncate or zero-extend to `size`, touching only the boundary chunk.
     * Shrinking drops trailing chunk rows and trims the new last chunk;
     * growing zero-fills like writeRange. Every mutation commits before return.
     */
    private truncate;
    private updatedFileInode;
    private commitCurrentContentMutation;
    private generatedMutationChunk;
    private readFileString;
    private stat;
    /** A linked inode's stat, for `stat` and for the entries `list` reports. */
    private statOf;
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
    private copyFile;
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
    private replaceFileWithStagedContent;
    /**
     * Copy-on-write replacement for an over-limit range/truncate mutation.
     * Chunks are produced and staged one at a time, so the operation never
     * assembles the file as one BLOB or exceeds a Stage 2 transaction bound.
     */
    private replaceFileWithGeneratedContent;
    private beginStagedContent;
    private executeStagedChunkPlan;
    /**
     * The rows that publishing `inode` from `contentId` writes: the inode
     * itself, the lifecycle transition, and the content it supersedes. The
     * single definition of a file's publication — ownership inheritance and
     * the GC of the replaced content are the same whether the file publishes
     * alone or as one member of a batched group.
     */
    private addFilePublication;
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
     * last, exactly as the per-file path did. Chunks staged for a file still
     * in flight may ride along in a group that publishes other files; they
     * carry a content id no inode references yet, so nothing observes them.
     *
     * Publishing per file cost three transactions each (stage the content
     * row, flush the chunks, publish), which at ~0.9 ms of commit apiece made
     * writing 19,429 files the dominant term of an npm install and stalled
     * every download shard behind the one Durable Object's storage queue.
     */
    private writeStream;
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
     * `priors`, when the caller has them, holds what stood at each of
     * `plan.inodes`' paths before this transaction, in the same order.
     */
    private executeTransactionPlan;
    private executeMeasuredTransaction;
    /**
     * Bounded, idempotent content maintenance. Age only orders work; durable
     * reference checks in each mutation transaction are the deletion authority.
     */
    runContentMaintenance(maxTransactions?: number): {
        transactions: number;
    };
    private runContentMaintenanceSafely;
    private metricsOnlyPlan;
    private recordOverLimitFile;
    private recordDuration;
    private currentRetainedWriteBytes;
    /** Best-effort process.memoryUsage().heapUsed; 0 in DO contexts. */
    private _safeHeapUsed;
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
export declare class SqliteVFSProvider {
    private raw;
    private vfs;
    private prefix;
    constructor(vfs: SqliteVFS, prefix: string, cred?: VfsCred);
    as(cred: VfsCred): SqliteVFSProvider;
    private resolve;
    readFile(sub: string): Uint8Array;
    readFileString(sub: string): string;
    lstat(sub: string): VfsStat;
    readlink(sub: string): string;
    symlink(target: string, sub: string): void;
    utimes(sub: string, atimeMs: number, mtimeMs: number): void;
    readRange(sub: string, offset: number, length: number): Uint8Array;
    writeFile(sub: string, content: string | Uint8Array): void;
    writeRange(sub: string, offset: number, bytes: Uint8Array): void;
    truncate(sub: string, size: number): void;
    exists(sub: string): boolean;
    access(sub: string, mode: number): void;
    stat(sub: string): VfsStat;
    readdir(sub: string): {
        name: string;
        type: VfsInodeKind;
    }[];
    unlink(sub: string): void;
    mkdir(sub: string, opts?: {
        recursive?: boolean;
    }): void;
    rmdir(sub: string): void;
    rename(o: string, n: string): void;
    copyFile(s: string, d: string): void;
    chmod(sub: string, mode: number): void;
    chown(sub: string, uid: number | null, gid: number | null): void;
}
//# sourceMappingURL=sqlite-vfs.d.ts.map