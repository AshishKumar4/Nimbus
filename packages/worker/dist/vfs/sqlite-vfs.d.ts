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
    private _peakRetainedWriteBytes;
    /**
     * N2 (memory accounting cleanup). Sum of bytes held by writeStream()
     * for files that have not yet reached their declared v1 chunk count.
     * A completed file releases its retained bytes immediately after its
     * pointer publish; finally releases the incomplete remainder on failure.
     */
    private _writeStreamSpoolBytes;
    private _peakWriteStreamSpoolBytes;
    /** In-memory liveness only; content_lifecycle remains durable ownership. */
    private readonly activeStagingContentIds;
    /** True only while durable GC work or a known abandoned staging row exists. */
    private maintenancePending;
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
    /** Read one chunk via cache → SQL, caching on miss. */
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
     * Shrinking drops trailing chunk rows and trims the new last chunk;
     * growing zero-fills like writeRange. Every mutation commits before return.
     */
    truncate(path: string, size: number): void;
    private updatedFileInode;
    private commitCurrentContentMutation;
    private generatedMutationChunk;
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
     * The complete mutation is preflighted against the Stage 2 transaction
     * limits, then executed in one transaction with 11-inode / 33-chunk SQL
     * grouping. Oversized strict calls fail with E2BIG before mutation.
     */
    writeBatch(payload: BatchWritePayload): {
        inodes: number;
        chunks: number;
    };
    private replaceFileWithStagedContent;
    /**
     * Copy-on-write replacement for an over-limit range/truncate mutation.
     * Chunks are produced and staged one at a time, so the operation never
     * assembles the file as one BLOB or exceeds a Stage 2 transaction bound.
     */
    private replaceFileWithGeneratedContent;
    private beginStagedContent;
    private executeStagedChunkPlan;
    private publishStagedFile;
    /**
     * W7 v1 streamed bulk write. Storage publication is
     * path-atomic/committed-prefix: every reported group is durable and
     * complete, while an unpublished failing group contributes no progress.
     * Full-file chunks are staged in bounded transactions and exposed by one
     * inode-pointer transaction. Stage 4 adds the v2 framing and global-credit
     * protocol; this v1 consumer infers file completion from the declared
     * chunk count.
     */
    writeStream(payload: {
        inodes: BatchInodeEntry[];
        chunkIter: AsyncIterable<BatchChunkEntry>;
        deletePaths?: string[];
        decodeDrainStartedAt?: number;
    }): Promise<WriteBatchStreamResult>;
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
    private updatePeakRetainedWriteBytes;
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