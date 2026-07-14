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
 * │  Pending writes own durability bytes     │
 * │  On npm install → batch SQLite writes    │
 * └─────────────────────────────────────────┘
 *          │                    │
 *          ▼                    ▼
 * ┌─────────────────┐  ┌─────────────────────┐
 * │  file_chunks     │  │  inodes              │
 * │  (path, chunk_id,│  │  (path, type, mode,  │
 * │   data BLOB)     │  │   size, mtime, ...)  │
 * │  64KB chunks     │  │                      │
 * └─────────────────┘  └─────────────────────┘
 *            DO SQLite (10 GB)
 *
 * Key design from do86's SqlPageStore:
 * - Disposable read cache; pending writes own unflushed bytes
 * - Microtask-deferred batch writes (64 rows per INSERT)
 * - All operations SYNCHRONOUS (DO sql.exec() is sync)
 *
 * Durability (audit C1):
 * - writeFile() returns void (sync) — preserved to match LIFO's
 *   MountProvider.writeFile(subpath, content): void contract.
 * - Deferred-flush failures retry the same complete transaction once.
 *   Entries that fail both attempts remain pending and are also surfaced
 *   through failedWrites/onWriteError(). flushAll() throws until the
 *   retained snapshot is durably retried or failures are acknowledged.
 * - Callers that need a hard guarantee can use flushAndWait() (async)
 *   at explicit persistence boundaries.
 *
 * Key design decisions:
 * - 64KB chunks (not 4KB): file access is sequential, fewer rows
 * - INode metadata always in memory (small: ~200B per file)
 * - File content demand-paged through LRU cache
 */
import { VfsEventEmitter } from './events.js';
/** Entry for bulk inode creation via writeBatch(). */
export interface BatchInodeEntry {
    path: string;
    parentPath: string;
    isDir: boolean;
    size: number;
    atime?: number;
    mtime: number;
    mode: number;
    chunkCount: number;
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
type TransactionLimit = 'blobBytes' | 'logicalRows' | 'sqlExecs';
type TransactionSource = 'strict-batch' | 'pending-flush' | 'stream-v1';
type TransactionLimitMode = 'bounded' | 'pending-over-limit-file' | 'stage2-stream-unbounded';
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
    private pendingWrites;
    /**
     * Sum of `data.length` across pendingWrites entries. Maintained
     * in lockstep with the Map by every code path that mutates it
     * (deferWrite/clearPendingWritesForPath/flushPendingWrites/
     * cleanupAfterDelete). Read by getStats() so /api/_diag/memory's
     * `heap.breakdown.vfsInFlightBytes` is no longer a hardcoded 0.
     * (N3, memory accounting cleanup.)
     */
    private _pendingWriteBytes;
    private _peakPendingWriteBytes;
    private _pendingFlushInFlightBytes;
    private _peakPendingFlushInFlightBytes;
    private _peakRetainedWriteBytes;
    /**
     * N2 (memory accounting cleanup). Sum of bytes currently held in the
     * `chunks: []` spool inside writeStream(). Maintained per-chunk so
     * a long-running drain shows live, not the steady-state 0.
     * Reset (or decremented to the drained amount) inside writeStream's
     * finally block, after transactionSync has either consumed the
     * bytes or thrown.
     *
     * Sums into `heap.breakdown.vfsInFlightBytes` alongside
     * _pendingWriteBytes so a single value reflects ALL transient
     * write-bytes the supervisor is holding.
     */
    private _writeStreamSpoolBytes;
    private _peakWriteStreamSpoolBytes;
    private writeFlushScheduled;
    private _activeTransaction;
    private _transactionDuration;
    private _postCommitDuration;
    private _decodeDrainDuration;
    private readonly _transactionDurationSamples;
    private _transactionDurationSampleCount;
    private _transactionDurationSampleIndex;
    private readonly _decodeDrainStarts;
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
    private failedWrites;
    private writeErrorHandlers;
    private _writeFailures;
    private _cacheHits;
    private _cacheMisses;
    private _evictions;
    private _sqlReads;
    private _sqlWrites;
    private _batchWrites;
    private _batchWriteRows;
    constructor(sql: SqlStorage, ctx?: DurableObjectState);
    private initSchema;
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
    /**
     * Drop every disposable cache entry. Pending writes separately own all
     * bytes that have not reached SQLite. Used by the SQLITE_NOMEM path to
     * free pages before retrying the same strict batch. Sync; safe inside the
     * input gate.
     */
    evictAll(): void;
    /** Invalidate all cache entries for a path. */
    private cacheInvalidate;
    /** Remove all pending writes for a path (prevents orphan chunks). */
    private clearPendingWritesForPath;
    /**
     * Batch version of cacheInvalidate — invalidate every cache entry
     * whose path is in `paths`. One pass over the cache instead of one
     * pass per path (audit R2: writeBatch was O(P × C) before this).
     *
     */
    private cacheInvalidateBatch;
    /** Batch version of clearPendingWritesForPath — one pass for N paths. */
    private clearPendingWritesForPaths;
    private clearWriteFailuresForPaths;
    private clearWriteFailuresForPath;
    private deferWrite;
    /**
     * Preserve synchronous producer backpressure at a complete-path boundary.
     * Calling this from deferWrite would allow a large file to flush halfway
     * through its chunk loop. The pending transaction builder remains the
     * authority for the exact byte/row/SQL grouping.
     */
    private flushPendingWritesAtLimit;
    private flushPendingWrites;
    private flushPendingPlan;
    /**
     * Move an un-writable chunk into failedWrites and notify subscribers.
     * Called from the retry path of flushPendingWrites(). Entries recorded
     * here are the ones that failed BOTH the original attempt and the
     * one-shot retry. The matching pending entries remain the durability
     * owner so a later explicit boundary can retry the whole snapshot.
     */
    private _recordFailedWrite;
    /**
     * Subscribe to write failures. Fires once per chunk that failed both
     * its first attempt AND the one-shot retry. Returns an unsubscribe
     * function. Multiple subscribers are permitted.
     *
     * Handlers run synchronously inside the flush microtask. Keep them
     * cheap and non-throwing; errors thrown by a handler are caught and
     * discarded so one bad subscriber can't break the flush path.
     */
    onWriteError(handler: (err: {
        path: string;
        chunkId: number;
        error: string;
        attempts: number;
    }) => void): () => void;
    /**
     * Snapshot of currently-recorded write failures. Intended for
     * diagnostics (e.g. /api/stats). The underlying Map is not exposed
     * so external code can't accidentally mutate it.
     */
    getWriteFailures(): Array<{
        path: string;
        chunkId: number;
        error: string;
        attempts: number;
    }>;
    /**
     * Clear recorded failures. Callers that have recovered (e.g. retried
     * the user-facing operation, or logged the error and decided to move
     * on) can call this to reset the counter so flushAll() stops
     * throwing. Without this, a single poisoned chunk would make every
     * subsequent flushAll() throw forever.
     */
    clearWriteFailures(): number;
    /**
     * Force flush all pending writes to SQLite.
     *
     * Throws if any chunk failed both its first attempt AND the one-shot
     * retry during this or any previous flush in this DO's lifetime.
     * Callers that invoke flushAll() on a critical boundary (e.g.
     * webSocketClose) get a synchronous error signal; callers that don't
     * want to assert cleanliness should use flushAndWait() instead.
     *
     * Staying synchronous preserves the sqlite-vfs invariant that all
     * file ops are sync (documented at the top of this file) — required
     * by the vendored MountProvider interface.
     */
    flushAll(): void;
    /**
     * Force-flush and resolve only after the flush completes with no
     * recorded failures. Rejects with the same error shape as flushAll()
     * when one or more chunks are un-writable after retry.
     *
     * Use this at explicit persistence boundaries (e.g. end of
     * `npm install`, end of `git clone`, seed-filesystem completion) to
     * guarantee data landed. Synchronous `writeFile()` callers that
     * don't opt in continue to get best-effort semantics — the audit's
     * alternative fix path (keep void API, surface errors through
     * onWriteError + throwing flushAll).
     */
    flushAndWait(): Promise<void>;
    private now;
    private parentPath;
    private blobToUint8Array;
    private copyBytes;
    private readChunkFromSql;
    exists(path: string): boolean;
    isDirectory(path: string): boolean;
    isFile(path: string): boolean;
    /**
     * Without a path: the global mutation clock. With a path: the clock
     * value at the last mutation inside that path's subtree (0 if nothing
     * under it changed in this DO lifetime). `revision('')` equals the
     * global clock by construction (every mutation stamps all ancestors).
     */
    revision(path?: string): number;
    /** Advance the clock once and stamp every path + its ancestors. */
    private bumpRevision;
    mkdir(path: string, options?: {
        recursive?: boolean;
    }): void;
    private _mkdirSingle;
    writeFile(path: string, content: string | Uint8Array): void;
    /** Read one chunk via cache → pending writes → SQL, caching on miss. */
    private readChunk;
    readFile(path: string): Uint8Array;
    private requireChunk;
    /**
     * Read `length` bytes at `offset` without assembling the whole file —
     * only the chunks overlapping the range are touched. Reads past EOF
     * are clamped; missing spans retain the existing zero-fill range semantics.
     */
    readRange(path: string, offset: number, length: number): Uint8Array;
    /**
     * Overwrite `bytes` at `offset`, rewriting only the chunks the range
     * (plus any EOF extension) touches — file-handle and page writers must
     * not pay a whole-file rewrite. Writing past EOF zero-fills the gap so
     * every chunk row up to the new EOF stays materialized at its
     * positional length (readFile reassembles by plain concatenation).
     * Creates the file when missing; callers own parent-dir creation
     * (same contract as writeFile).
     */
    writeRange(path: string, offset: number, bytes: Uint8Array): void;
    /**
     * Truncate or zero-extend to `size`, touching only the boundary chunk.
     * Shrinking drops trailing chunk rows (and any cache/pending entries
     * for them, so a deferred flush cannot resurrect deleted rows) and
     * trims the new last chunk; growing zero-fills like writeRange.
     */
    truncate(path: string, size: number): void;
    /** Drop cache + pending-write entries for chunks >= fromChunkId. */
    private dropChunksFrom;
    readFileString(path: string): string;
    stat(path: string): {
        type: string;
        size: number;
        atime: number;
        ctime: number;
        mtime: number;
        mode: number;
    };
    utimes(path: string, atimeMs: number, mtimeMs: number): void;
    readdir(path: string): {
        name: string;
        type: string;
    }[];
    unlink(path: string): void;
    rmdir(path: string): void;
    rename(oldPath: string, newPath: string): void;
    copyFile(src: string, dest: string): void;
    /**
     * Atomic bulk write: ALL inodes + chunks in ONE transactionSync().
     *
     * Why this exists:
     *   writeFile() does 1 DELETE + 1 INSERT per inode (each auto-committed)
     *   plus deferred chunks flushed in bounded complete-path groups.
     *   For 30K files: ~60K sync SQL ops → 30-60s, often crashes DO.
     *
     * The complete mutation is preflighted against the Stage 2 transaction
     * limits, then executed in one transaction with 12-inode / 33-chunk SQL
     * grouping. Oversized strict calls fail with E2BIG before mutation.
     */
    writeBatch(payload: BatchWritePayload): {
        inodes: number;
        chunks: number;
    };
    /**
     * W7 — streaming bulk-write. Same atomic transaction semantics as
     * writeBatch() but
     * accepts the chunks list as an `AsyncIterable<BatchChunkEntry>`
     * rather than a fully-realised array.
     *
     * v1 (this wave) is "spool-then-commit": we drain the iterator into
     * an in-memory Array<BatchChunkEntry>, then execute the shared plan in
     * the explicit Stage 2 stream-unbounded mode.
     * The HEAP-savings claim of W7 lives on the FACET side — by the
     * time chunks reach this method (post-RPC), they've already
     * traversed the byte-stream boundary without hitting the 32 MiB
     * structured-clone cap.
     *
     * Stage 2 intentionally preserves the existing eager drain and one
     * transaction for callers that already selected writeBatchStream. The
     * transaction is planned and measured, but its hard bounding and global
     * stream credit are deferred to Stages 3-4. `_writeStreamSpoolBytes`
     * truthfully reports the retained decoder payload throughout the drain.
     *
     * On SQLITE_NOMEM, the VFS evicts clean cache and retries the exact
     * transaction once. Any
     * iterator-source error propagates unchanged. Atomicity guarantee
     * matches writeBatch: either ALL inodes + chunks land in SQLite or
     * NONE do.
     */
    writeStream(payload: {
        inodes: BatchInodeEntry[];
        chunkIter: AsyncIterable<BatchChunkEntry>;
        deletePaths?: string[];
        decodeDrainStartedAt?: number;
    }): Promise<{
        inodes: number;
        chunks: number;
    }>;
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
    private recordOverLimitFile;
    private recordDuration;
    private updatePeakRetainedWriteBytes;
    private currentRetainedWriteBytes;
    /** Best-effort process.memoryUsage().heapUsed; 0 in DO contexts. */
    private _safeHeapUsed;
    private prepareBatchTransaction;
    private assertTransactionFits;
    private _writeBatchOnce;
    private collectBatchDeletions;
    /**
     * Bulk mkdir: create all directories in a single transactionSync.
     * Pre-creates the full directory tree before file writes to avoid
     * per-file mkdir overhead.
     */
    mkdirBatch(paths: string[]): number;
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
            pendingWrites: number;
            pendingWriteBytes: number;
            writeStreamSpoolBytes: number;
            queuedWriteBytes: {
                current: number;
                peak: number;
            };
            inFlightWriteBytes: {
                current: number;
                peak: number;
            };
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
            failedWrites: number;
            totalWriteFailures: number;
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
    private vfs;
    private prefix;
    constructor(vfs: SqliteVFS, prefix: string);
    private resolve;
    readFile(sub: string): Uint8Array;
    readFileString(sub: string): string;
    writeFile(sub: string, content: string | Uint8Array): void;
    exists(sub: string): boolean;
    stat(sub: string): {
        type: string;
        size: number;
        atime: number;
        ctime: number;
        mtime: number;
        mode: number;
    };
    readdir(sub: string): {
        name: string;
        type: string;
    }[];
    unlink(sub: string): void;
    mkdir(sub: string, opts?: {
        recursive?: boolean;
    }): void;
    rmdir(sub: string): void;
    rename(o: string, n: string): void;
    copyFile(s: string, d: string): void;
}
export {};
//# sourceMappingURL=sqlite-vfs.d.ts.map