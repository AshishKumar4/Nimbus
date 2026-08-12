/**
 * SqliteVFS — Demand-paged virtual filesystem on DO SQLite.
 *
 * Architecture (from webcontainer-v2-feasibility.md §4):
 *
 * ┌─────────────────────────────────────────┐
 * │           Nimbus VFS (in-memory)           │
 * │  INode tree: always-resident metadata    │  ~10-20 MB for 50K files
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
 * - INode metadata always in memory (small: ~200B per file)
 * - File content demand-paged through LRU cache
 */
import { VfsEventEmitter } from './events.js';
import { type VfsCred, type VfsInvalidatedPath, type VfsListPage } from '../runtime/os-contracts.js';
export type VfsInodeKind = 'file' | 'directory' | 'symlink';
export interface ExclusiveMutationLease {
    readonly root: string;
    readonly owner: string;
}
export interface ExclusiveMutationOptions {
    readonly includeMissingAncestors?: boolean;
}
/** Entry for bulk inode creation via writeBatch(). */
export interface BatchInodeEntry {
    path: string;
    parentPath: string;
    /** Defaults to isDir ? directory : file for legacy/non-symlink producers. */
    kind?: VfsInodeKind;
    isDir: boolean;
    size: number;
    atime?: number;
    mtime: number;
    mode: number;
    uid?: number;
    gid?: number;
    chunkCount: number;
}
export interface VfsStat {
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
     * This VFS incarnation's identity. Paired with `revision()` it is the
     * cache-coherence cursor a facet is stamped with when its bundle is built,
     * so the facet's first ACQUIRE is an ordinary delta. Without the pairing a
     * bare revision is meaningless across a supervisor restart, since the
     * revision clock is in memory and restarts at zero.
     */
    readonly epoch: string;
}
/** Entry for bulk chunk creation via writeBatch(). */
export interface BatchChunkEntry {
    path: string;
    chunkId: number;
    data: Uint8Array;
}
/** Payload for writeBatch() — all inodes + chunks written in ONE transactionSync(). */
export interface BatchWritePayload {
    inodes: BatchInodeEntry[];
    chunks: BatchChunkEntry[];
    /** Paths to delete before writing (for clean reinstall). */
    deletePaths?: string[];
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
export declare class SqliteVFS {
    private sql;
    private ctx;
    readonly events: VfsEventEmitter;
    private inodes;
    /** Children index: parentPath → Set of child paths. O(1) readdir. */
    private children;
    private cache;
    /** Actual bytes in cache (not all chunks are full 64KB) */
    private _cacheBytes;
    private _lruMaxEntries;
    private _lruShrinkRefcount;
    private _totalFiles;
    private _totalDirs;
    private _usedBytes;
    private _revision;
    private _pathRevisions;
    private readonly _epoch;
    private _invalidations;
    private _invalidationBytes;
    private static readonly INVALIDATION_LOG_MAX_BYTES;
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
    constructor(sql: SqlStorage, ctx?: DurableObjectState);
    private initSchema;
    private tableColumns;
    private migrateFromLegacy;
    private loadInodes;
    private _addToChildrenIndex;
    private _removeFromChildrenIndex;
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
    private now;
    private parentPath;
    /** The single content resolver for both legacy-null and generated inodes. */
    private contentIdForInode;
    private legacyContentId;
    private createContentId;
    private blobToUint8Array;
    private copyBytes;
    private readChunkFromSql;
    as(cred: VfsCred): CredentialedVfs;
    private accessInode;
    private accessMode;
    private resolvePath;
    private checkAccess;
    private checkParentAccess;
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
     * value at the last mutation inside that path's subtree (0 if nothing
     * under it changed in this DO lifetime). `revision('')` equals the
     * global clock by construction (every mutation stamps all ancestors).
     */
    revision(path?: string): number;
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
     */
    invalidatedSince(epoch: string | null, cursor: number): {
        epoch: string;
        rev: number;
        paths: VfsInvalidatedPath[];
        poison: boolean;
    };
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
     * across the page boundary and drop them.
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
    private rename;
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
    private transactionSync;
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
    private collectBatchDeletions;
    /**
     * Bulk mkdir: create all directories in a single transactionSync.
     * Pre-creates the full directory tree before file writes to avoid
     * per-file mkdir overhead.
     */
    private mkdirBatch;
    /**
     * Debug-only: recompute counters from scratch and return any drift
     * against the running counters. Returns null if consistent. Used by
     * the B3 runtime test; production paths should never call this
     * (the whole point of B3 is avoiding the O(N) walk).
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
            memoryEstimate: number;
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
export {};
//# sourceMappingURL=sqlite-vfs.d.ts.map