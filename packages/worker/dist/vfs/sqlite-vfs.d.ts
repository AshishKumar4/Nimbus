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
 * │  On eviction → SQLite write (if dirty)   │
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
 * - LRU eviction with dirty-write-back
 * - Microtask-deferred batch writes (64 rows per INSERT)
 * - All operations SYNCHRONOUS (DO sql.exec() is sync)
 *
 * Durability (audit C1):
 * - writeFile() returns void (sync) — preserved to match LIFO's
 *   MountProvider.writeFile(subpath, content): void contract.
 * - Deferred-flush failures (from transactionSync or individual row
 *   inserts) are retried ONCE without a transaction wrapper. Entries
 *   that fail both attempts land in failedWrites and are surfaced to
 *   subscribers via onWriteError(). flushAll() throws if any failed
 *   writes accumulated since last clearWriteFailures().
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
    private writeFlushScheduled;
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
    private evictOne;
    shrinkForInstall(targetEntries?: number): void;
    /** Decrement the heavy-alloc refcount. When the count returns to
     *  zero, restore the cap to LRU_MAX_ENTRIES. No re-population —
     *  the cache warms naturally on next reads. */
    restoreAfterInstall(): void;
    /**
     * Drop EVERY cache entry, flushing dirty ones via deferWrite. Used
     * by the W5 Lever 9 SQLITE_NOMEM retry path to free pages owned by
     * us before retrying a smaller batch. Sync; safe inside the input
     * gate.
     */
    evictAll(): void;
    /**
     * Invalidate all cache entries for a path.
     * @param discard If true, dirty entries are discarded (not flushed).
     *   Use discard=true when the file is about to be overwritten or deleted.
     */
    private cacheInvalidate;
    /** Remove all pending writes for a path (prevents orphan chunks). */
    private clearPendingWritesForPath;
    /**
     * Batch version of cacheInvalidate — invalidate every cache entry
     * whose path is in `paths`. One pass over the cache instead of one
     * pass per path (audit R2: writeBatch was O(P × C) before this).
     *
     * `discard` semantics match cacheInvalidate(path, discard): when
     * false, dirty entries are re-queued for persistence before being
     * dropped from the cache; when true (the writeBatch case — the row
     * is about to be overwritten), dirty data is abandoned.
     */
    private cacheInvalidateBatch;
    /** Batch version of clearPendingWritesForPath — one pass for N paths. */
    private clearPendingWritesForPaths;
    private deferWrite;
    private flushPendingWrites;
    /**
     * Move an un-writable chunk into failedWrites and notify subscribers.
     * Called from the retry path of flushPendingWrites(). Entries recorded
     * here are the ones that failed BOTH the original attempt and the
     * one-shot retry; they are considered lost (we do not re-queue a
     * third time — the audit recommendation was a single retry). The
     * chunk bytes are NOT retained — see failedWrites comment above.
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
     * Force flush all dirty cache entries and pending writes to SQLite.
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
    /**
     * Read `length` bytes at `offset` without assembling the whole file —
     * only the chunks overlapping the range are touched. Reads past EOF
     * are clamped; chunks missing their SQL row read as zeroes.
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
     *   plus deferWrite() which flushes at 500-threshold.
     *   For 30K files: ~60K sync SQL ops → 30-60s, often crashes DO.
     *
     * writeBatch() does:
     *   1 transactionSync() containing:
     *     - N DELETE for old paths (if any)
     *     - Multi-row INSERT for inodes (up to 4000/statement)
     *     - Multi-row INSERT for chunks (up to 200/statement, blob-heavy)
     *   Total: 1 transactionSync() per wave of ~300-500 files.
     *
     * Speedup: 60K ops → ~60 ops (1000x fewer transaction commits).
     */
    writeBatch(payload: BatchWritePayload): {
        inodes: number;
        chunks: number;
    };
    /**
     * W7 — streaming bulk-write. Same semantics as writeBatch() but
     * accepts the chunks list as an `AsyncIterable<BatchChunkEntry>`
     * rather than a fully-realised array.
     *
     * v1 (this wave) is "spool-then-commit": we drain the iterator into
     * an in-memory Array<BatchChunkEntry>, then delegate to writeBatch.
     * The HEAP-savings claim of W7 lives on the FACET side — by the
     * time chunks reach this method (post-RPC), they've already
     * traversed the byte-stream boundary without hitting the 32 MiB
     * structured-clone cap.
     *
     * Heap-correctness wave (N2): the spool is bounded by the peer's
     * SHARED_RPC_FLUSH_THRESHOLD (4 MiB; see install-batch-facet.ts:196)
     * — a peer never sends more than ~4 MiB of chunk-bytes per
     * writeBatchStream RPC, AND workerd's input gate serialises
     * concurrent RPCs on the same DO. So the supervisor's `chunks: []`
     * spool peak is ≤ 4 MiB + path-overhead per call.
     *
     * What this method DID lack: the spool bytes were invisible to the
     * heap estimator. We now maintain `_writeStreamSpoolBytes` that
     * tracks the live spool contents during the drain; the diag's
     * vfsInFlightBytes contributor now sums pendingWriteBytes +
     * writeStreamSpoolBytes. The N2 failing probe asserts on this sum.
     *
     * Throws on SQLITE_NOMEM (with halve-retry per writeBatch); any
     * iterator-source error propagates unchanged. Atomicity guarantee
     * matches writeBatch: either ALL inodes + chunks land in SQLite or
     * NONE do.
     */
    writeStream(payload: {
        inodes: BatchInodeEntry[];
        chunkIter: AsyncIterable<BatchChunkEntry>;
        deletePaths?: string[];
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
    /** Best-effort process.memoryUsage().heapUsed; 0 in DO contexts. */
    private _safeHeapUsed;
    /**
     * Partition a writeBatch payload into two halves with disjoint
     * path-sets. Preserves the W2.5 invariant: deletePaths and chunks
     * follow their owning inode into the same half. Used by the
     * SQLITE_NOMEM retry path.
     */
    private _halveBatchPayload;
    private _writeBatchOnce;
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
//# sourceMappingURL=sqlite-vfs.d.ts.map