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

import { VfsEventEmitter, type VfsEventType } from './vfs-events.js';
import { CHUNK_SIZE, LRU_MAX_ENTRIES, BATCH_SIZE } from './constants.js';
import { recordFailure } from './oom-discriminator.js';
import { classifyError } from './oom-classify.js';
import { enc, dec } from './_shared/bytes.js';

// CHUNK_SIZE / LRU_MAX_ENTRIES / BATCH_SIZE are imported from ./constants.js
// (single source of truth). Facet-isolate code-strings duplicate the literal
// 65_536 by necessity — see the inline `CHUNK_SIZE = 65536` in
// generateGitNetworkFacetCode (git-network-facet.ts) and the parallel
// preamble (parallel/generated-workers.ts).

// ── Types ───────────────────────────────────────────────────────────────────

interface INode {
  path: string;
  parentPath: string;
  isDir: boolean;
  size: number;
  mtime: number;
  mode: number;
  /** Number of 64KB chunks (0 for dirs, 1+ for files) */
  chunkCount: number;
}

/** Entry for bulk inode creation via writeBatch(). */
export interface BatchInodeEntry {
  path: string;
  parentPath: string;
  isDir: boolean;
  size: number;
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

/** Cache entry: one 64KB chunk of file content */
interface CacheEntry {
  path: string;
  chunkId: number;
  data: Uint8Array;
  dirty: boolean;
}

// ── SqliteVFS ───────────────────────────────────────────────────────────────

export class SqliteVFS {
  private sql: SqlStorage;
  private ctx: DurableObjectState;
  public readonly events: VfsEventEmitter;

  // ── INode tree (always resident) ──────────────────────────────────────
  private inodes = new Map<string, INode>();
  /** Children index: parentPath → Set of child paths. O(1) readdir. */
  private children = new Map<string, Set<string>>();

  // ── Content cache (LRU, 512 × 64KB = 32MB) ───────────────────────────
  // Map iteration order = insertion order. Delete+re-insert to move to MRU.
  private cache = new Map<string, CacheEntry>();
  /** Actual bytes in cache (not all chunks are full 64KB) */
  private _cacheBytes = 0;

  // ── W5 Lever 8: runtime-mutable LRU cap + shrink refcount ─────────
  // Default seeded from LRU_MAX_ENTRIES (32 MiB). Heavy-alloc owners
  // (npm install, git clone, pre-bundle) call shrinkForInstall() to
  // drop the cap to ~8 MiB and free heap headroom for the in-flight
  // RPC payloads + pending-writes queue. Refcount-based: nested
  // acquires stack; only the OUTERMOST restoreAfterInstall() actually
  // raises the cap back to the default.
  //
  // Why instance-level (not module-level):
  //   - Tests need an in-memory VFS without polluting the constant.
  //   - Future per-DO tuning (e.g. set higher cap on a session running
  //     `vite build` vs `npm install`) becomes a one-call change.
  //
  // The eviction trigger at cacheSet() reads this field. Counter
  // accounting is unchanged.
  private _lruMaxEntries: number = LRU_MAX_ENTRIES;
  private _lruShrinkRefcount: number = 0;

  // ── Running counters for O(1) getStats() (B3 / AUDIT M10 / M-S8) ──
  // Replaces the triple scan of this.inodes on every /api/stats poll.
  // Bootstrapped in loadInodes(); maintained at every mutator entry:
  //   mkdir/rmdir/writeFile/unlink/writeBatch (rename is a no-op —
  //   same inode, new path). Invariant: these match a fresh O(N)
  //   walk of this.inodes. Unit-tested in the A5/B3 runtime tests.
  private _totalFiles = 0;
  private _totalDirs = 0;
  private _usedBytes = 0;

  // ── Deferred write queue (do86 pattern) ───────────────────────────────
  private pendingWrites = new Map<string, { path: string; chunkId: number; data: Uint8Array }>();
  private writeFlushScheduled = false;

  // ── Write-failure tracking (audit C1) ─────────────────────────────────
  // When a deferred flush fails, the entry lands here so (a) flushAll()
  // can throw with accurate context on the next forced flush, (b) the
  // supervisor can surface the error to the user's terminal via the
  // onWriteError subscription, and (c) flushAndWait() can report.
  //
  // Keys use cacheKey(path, chunkId). Retry count bounds backoff to one
  // additional attempt (per audit recommendation: "re-queue on transient
  // SQL errors once"); entries that fail twice are considered lost.
  //
  // NOTE: we intentionally do NOT keep the chunk bytes on this record.
  // The retry happens inline inside flushPendingWrites — nothing
  // re-reads the bytes after that. Storing them would turn a bad
  // session into a multi-MB leak (64 KB per chunk) inside a DO with
  // a ~128 MB isolate cap.
  private failedWrites = new Map<string, {
    path: string;
    chunkId: number;
    error: string;
    attempts: number;
  }>();
  private writeErrorHandlers = new Set<(err: {
    path: string; chunkId: number; error: string; attempts: number;
  }) => void>();
  private _writeFailures = 0;

  // ── Stats ─────────────────────────────────────────────────────────────
  private _cacheHits = 0;
  private _cacheMisses = 0;
  private _evictions = 0;
  private _sqlReads = 0;
  private _sqlWrites = 0;
  private _batchWrites = 0;
  private _batchWriteRows = 0;

  constructor(sql: SqlStorage, ctx?: DurableObjectState) {
    this.sql = sql;
    this.ctx = ctx!;
    this.events = new VfsEventEmitter();
    this.initSchema();
    this.loadInodes();
  }

  // ── Schema ────────────────────────────────────────────────────────────

  private initSchema(): void {
    // Migrate from legacy fs_objects table FIRST (before creating new tables)
    this.migrateFromLegacy();

    this.sql.exec(`CREATE TABLE IF NOT EXISTS inodes (
      path TEXT PRIMARY KEY,
      parent_path TEXT NOT NULL DEFAULT '',
      is_dir INTEGER NOT NULL DEFAULT 0,
      size INTEGER NOT NULL DEFAULT 0,
      mtime INTEGER NOT NULL DEFAULT 0,
      mode INTEGER NOT NULL DEFAULT 0,
      chunk_count INTEGER NOT NULL DEFAULT 0
    )`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_inodes_parent ON inodes(parent_path)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS file_chunks (
      path TEXT NOT NULL,
      chunk_id INTEGER NOT NULL,
      data BLOB NOT NULL,
      PRIMARY KEY (path, chunk_id)
    )`);

    // Ensure chunk_count column exists (handles upgrade from older schema)
    try {
      this.sql.exec("SELECT chunk_count FROM inodes LIMIT 0");
    } catch {
      try {
        this.sql.exec("ALTER TABLE inodes ADD COLUMN chunk_count INTEGER NOT NULL DEFAULT 0");
      } catch {}
    }
  }

  private migrateFromLegacy(): void {
    // Check if old fs_objects table exists
    const rows = [...this.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='fs_objects'")];
    if (rows.length === 0) return;

    console.log('[sqlite-vfs] Migrating from legacy fs_objects table...');
    const oldRows = [...this.sql.exec("SELECT path, chunk_index, parent_path, data, is_dir, size, mtime, mode FROM fs_objects ORDER BY path, chunk_index")];

    // Group by path, extract inodes and chunks
    const seenPaths = new Set<string>();
    for (const row of oldRows) {
      const path = String(row.path);
      const chunkIndex = Number(row.chunk_index);
      const parentPath = String(row.parent_path);
      const isDir = Number(row.is_dir) === 1;
      const size = Number(row.size);
      const mtime = Number(row.mtime);
      const mode = Number(row.mode);

      if (!seenPaths.has(path)) {
        seenPaths.add(path);
        const chunkCount = isDir ? 0 : Math.max(1, Math.ceil(size / CHUNK_SIZE));
        this.sql.exec(
          "INSERT OR REPLACE INTO inodes (path, parent_path, is_dir, size, mtime, mode, chunk_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
          path, parentPath, isDir ? 1 : 0, size, mtime, mode, chunkCount
        );
      }

      if (!isDir && row.data != null) {
        const data = this.blobToUint8Array(row.data);
        if (data.length > 0) {
          // Re-chunk: old CHUNK_SIZE was 1.8MB, new is 64KB
          if (chunkIndex === 0 && data.length <= CHUNK_SIZE) {
            // Small file, single chunk — direct insert
            this.sql.exec(
              "INSERT OR REPLACE INTO file_chunks (path, chunk_id, data) VALUES (?, ?, ?)",
              path, 0, data
            );
            this.sql.exec("UPDATE inodes SET chunk_count = 1 WHERE path = ?", path);
          } else {
            // Large file: re-chunk with 64KB chunks
            // For multi-chunk old files, accumulate data then re-chunk
            // This is simplified: we re-chunk the data we have
            const numNewChunks = Math.ceil(data.length / CHUNK_SIZE);
            for (let i = 0; i < numNewChunks; i++) {
              const chunk = data.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
              // Offset chunk IDs by the old chunk's position in the new scheme
              const oldStart = chunkIndex * 1_800_000; // old chunk size
              const newBaseChunk = Math.floor(oldStart / CHUNK_SIZE);
              this.sql.exec(
                "INSERT OR REPLACE INTO file_chunks (path, chunk_id, data) VALUES (?, ?, ?)",
                path, newBaseChunk + i, chunk
              );
            }
            // Update chunk count based on total file size
            const totalChunks = Math.ceil(size / CHUNK_SIZE);
            this.sql.exec("UPDATE inodes SET chunk_count = ? WHERE path = ?", totalChunks, path);
          }
        }
      }
    }

    // Drop old table
    this.sql.exec("DROP TABLE IF EXISTS fs_objects");
    console.log(`[sqlite-vfs] Migration complete: ${seenPaths.size} entries migrated.`);
  }

  // ── INode loading ─────────────────────────────────────────────────────

  private loadInodes(): void {
    this.inodes.clear();
    this.children.clear();
    // Reset counters before rescanning (B3).
    this._totalFiles = 0;
    this._totalDirs = 0;
    this._usedBytes = 0;
    const rows = [...this.sql.exec("SELECT path, parent_path, is_dir, size, mtime, mode, chunk_count FROM inodes")];
    for (const row of rows) {
      const inode: INode = {
        path: String(row.path),
        parentPath: String(row.parent_path),
        isDir: Number(row.is_dir) === 1,
        size: Number(row.size),
        mtime: Number(row.mtime),
        mode: Number(row.mode),
        chunkCount: Number(row.chunk_count),
      };
      this.inodes.set(inode.path, inode);
      this._addToChildrenIndex(inode.parentPath, inode.path);
      // Bootstrap the counters (B3).
      if (inode.isDir) this._totalDirs++;
      else { this._totalFiles++; this._usedBytes += inode.size; }
    }
  }

  private _addToChildrenIndex(parentPath: string, childPath: string): void {
    let set = this.children.get(parentPath);
    if (!set) { set = new Set(); this.children.set(parentPath, set); }
    set.add(childPath);
  }

  private _removeFromChildrenIndex(parentPath: string, childPath: string): void {
    const set = this.children.get(parentPath);
    if (set) {
      set.delete(childPath);
      if (set.size === 0) this.children.delete(parentPath);
    }
  }

  // ── Cache key ─────────────────────────────────────────────────────────

  private cacheKey(path: string, chunkId: number): string {
    return `${path}\0${chunkId}`;
  }

  // ── LRU Content Cache ─────────────────────────────────────────────────

  private cacheGet(path: string, chunkId: number): Uint8Array | null {
    const key = this.cacheKey(path, chunkId);
    const entry = this.cache.get(key);
    if (entry) {
      this._cacheHits++;
      // Move to MRU position
      this.cache.delete(key);
      this.cache.set(key, entry);
      return entry.data;
    }
    this._cacheMisses++;
    return null;
  }

  private cacheSet(path: string, chunkId: number, data: Uint8Array, dirty: boolean): void {
    const key = this.cacheKey(path, chunkId);

    // If already cached, update
    const existing = this.cache.get(key);
    if (existing) {
      this._cacheBytes -= existing.data.length;
      existing.data = data;
      existing.dirty = existing.dirty || dirty;
      this._cacheBytes += data.length;
      // Move to MRU
      this.cache.delete(key);
      this.cache.set(key, existing);
      return;
    }

    // Evict if at capacity. W5 Lever 8: read the runtime-mutable
    // _lruMaxEntries instead of the constant so shrinkForInstall()
    // takes effect for in-flight writes too.
    while (this.cache.size >= this._lruMaxEntries) {
      this.evictOne();
    }

    this._cacheBytes += data.length;
    this.cache.set(key, { path, chunkId, data, dirty });
  }

  private evictOne(): void {
    // Evict the LRU entry (first in Map iteration order)
    const firstKey = this.cache.keys().next().value;
    if (firstKey === undefined) return;

    const entry = this.cache.get(firstKey)!;
    this.cache.delete(firstKey);
    this._cacheBytes -= entry.data.length;
    this._evictions++;

    if (entry.dirty) {
      this.deferWrite(entry.path, entry.chunkId, entry.data);
    }
  }

  // ── W5 Lever 8: public LRU shrink / restore + evictAll ───────────────
  //
  // shrinkForInstall(targetEntries): tighten the cap so heavy-alloc
  // owners (npm install / git clone / pre-bundle) free heap headroom
  // for in-flight RPC payloads + pending-writes queue. Refcount-based
  // so nested heavy-alloc owners (e.g. concurrent install + clone)
  // don't race; only the OUTERMOST restoreAfterInstall() raises the
  // cap back to LRU_MAX_ENTRIES.
  //
  // Default target 128 entries × 64 KB = 8 MiB. Matches
  // CF-INTERNAL-OPTIMIZATION-RESEARCH.md J.1.2.
  //
  // Eviction during shrink flows through deferWrite → flushPendingWrites
  // (existing path), so no data loss. Cold-cache bounce for the next
  // reads of evicted pages is acceptable since install workloads
  // write-once-and-rarely-reread.
  shrinkForInstall(targetEntries: number = 128): void {
    const target = Math.max(1, Math.min(LRU_MAX_ENTRIES, targetEntries | 0));
    // Refcount: nested acquires stack. Take the smallest target across
    // owners — most aggressive shrinker wins.
    if (this._lruShrinkRefcount > 0) {
      if (target < this._lruMaxEntries) this._lruMaxEntries = target;
      this._lruShrinkRefcount++;
      return;
    }
    this._lruShrinkRefcount = 1;
    this._lruMaxEntries = target;
    // Evict down to the new cap. Each evictOne() flushes the dirty
    // entry (if any) via deferWrite; queueMicrotask schedules the
    // flush. Stays sync — preserves the sqlite-vfs invariant.
    while (this.cache.size > this._lruMaxEntries) {
      this.evictOne();
    }
  }

  /** Decrement the heavy-alloc refcount. When the count returns to
   *  zero, restore the cap to LRU_MAX_ENTRIES. No re-population —
   *  the cache warms naturally on next reads. */
  restoreAfterInstall(): void {
    if (this._lruShrinkRefcount <= 0) return;
    this._lruShrinkRefcount--;
    if (this._lruShrinkRefcount === 0) {
      this._lruMaxEntries = LRU_MAX_ENTRIES;
    }
  }

  /**
   * Drop EVERY cache entry, flushing dirty ones via deferWrite. Used
   * by the W5 Lever 9 SQLITE_NOMEM retry path to free pages owned by
   * us before retrying a smaller batch. Sync; safe inside the input
   * gate.
   */
  evictAll(): void {
    // Iterate a snapshot so concurrent mutation through deferWrite
    // doesn't disturb iteration.
    const keys = Array.from(this.cache.keys());
    for (const key of keys) {
      const entry = this.cache.get(key);
      if (!entry) continue;
      this.cache.delete(key);
      this._cacheBytes -= entry.data.length;
      this._evictions++;
      if (entry.dirty) {
        this.deferWrite(entry.path, entry.chunkId, entry.data);
      }
    }
  }

  /**
   * Invalidate all cache entries for a path.
   * @param discard If true, dirty entries are discarded (not flushed).
   *   Use discard=true when the file is about to be overwritten or deleted.
   */
  private cacheInvalidate(path: string, discard = false): void {
    const toDelete: string[] = [];
    for (const [key, entry] of this.cache) {
      if (entry.path === path) {
        if (entry.dirty && !discard) {
          this.deferWrite(entry.path, entry.chunkId, entry.data);
        }
        this._cacheBytes -= entry.data.length;
        toDelete.push(key);
      }
    }
    for (const key of toDelete) {
      this.cache.delete(key);
    }
  }

  /** Remove all pending writes for a path (prevents orphan chunks). */
  private clearPendingWritesForPath(path: string): void {
    const toRemove: string[] = [];
    for (const [key, entry] of this.pendingWrites) {
      if (entry.path === path) toRemove.push(key);
    }
    for (const key of toRemove) this.pendingWrites.delete(key);
  }

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
  private cacheInvalidateBatch(paths: Set<string>, discard = false): void {
    if (paths.size === 0) return;
    const toDelete: string[] = [];
    for (const [key, entry] of this.cache) {
      if (!paths.has(entry.path)) continue;
      if (entry.dirty && !discard) {
        this.deferWrite(entry.path, entry.chunkId, entry.data);
      }
      this._cacheBytes -= entry.data.length;
      toDelete.push(key);
    }
    for (const key of toDelete) {
      this.cache.delete(key);
    }
  }

  /** Batch version of clearPendingWritesForPath — one pass for N paths. */
  private clearPendingWritesForPaths(paths: Set<string>): void {
    if (paths.size === 0) return;
    const toRemove: string[] = [];
    for (const [key, entry] of this.pendingWrites) {
      if (paths.has(entry.path)) toRemove.push(key);
    }
    for (const key of toRemove) this.pendingWrites.delete(key);
  }

  // ── Deferred batch writes (do86 pattern) ──────────────────────────────

  private deferWrite(path: string, chunkId: number, data: Uint8Array): void {
    const key = this.cacheKey(path, chunkId);
    // Copy data since the cache entry may be reused
    const copy = new Uint8Array(data.length);
    copy.set(data);
    this.pendingWrites.set(key, { path, chunkId, data: copy });

    // Throttle: if too many writes pending, flush synchronously.
    // 500 threshold balances memory (500 × ~64KB = ~32MB max pending) vs throughput
    // (fewer flushes = faster git clone / npm install).
    if (this.pendingWrites.size >= 500) {
      this.flushPendingWrites();
      return;
    }

    if (!this.writeFlushScheduled) {
      this.writeFlushScheduled = true;
      queueMicrotask(() => this.flushPendingWrites());
    }
  }

  private flushPendingWrites(): void {
    this.writeFlushScheduled = false;
    if (this.pendingWrites.size === 0) return;

    const entries = Array.from(this.pendingWrites.values());
    this.pendingWrites.clear();
    this._batchWrites++;

    // First attempt: batch inside transactionSync. Inner per-row
    // try/catch captures row-level failures without aborting the
    // transaction — those rows go to retry.
    //
    // Counter accounting: we do NOT increment _sqlWrites / _batchWriteRows
    // inside the transaction block. If transactionSync later throws
    // (rollback), every row it "wrote" is reverted — but the counter
    // would already have been bumped. Instead, we count confirmed
    // writes after each path completes.
    const rowFailures: Array<{ entry: typeof entries[0]; error: string }> = [];
    let transactionFailed: string | null = null;
    let confirmedRows = 0;

    try {
      if (this.ctx?.storage?.transactionSync) {
        this.ctx.storage.transactionSync(() => {
          for (const entry of entries) {
            try {
              this.sql.exec(
                "INSERT OR REPLACE INTO file_chunks (path, chunk_id, data) VALUES (?, ?, ?)",
                entry.path, entry.chunkId, entry.data
              );
            } catch (e: any) {
              rowFailures.push({ entry, error: e?.message || String(e) });
            }
          }
        });
        // Transaction committed. Rows that didn't hit the inner catch
        // landed on disk.
        confirmedRows += entries.length - rowFailures.length;
      } else {
        // Fallback: individual writes without transaction (slower but safe).
        // Each successful exec() is its own commit, so counters are
        // safe to bump inline here.
        for (const entry of entries) {
          try {
            this.sql.exec(
              "INSERT OR REPLACE INTO file_chunks (path, chunk_id, data) VALUES (?, ?, ?)",
              entry.path, entry.chunkId, entry.data
            );
            confirmedRows++;
          } catch (e: any) {
            rowFailures.push({ entry, error: e?.message || String(e) });
          }
        }
      }
    } catch (e: any) {
      // transactionSync itself threw (rollback). Every entry in the
      // batch is now un-written — retry them individually so one bad
      // row doesn't poison the whole batch. rowFailures entries from
      // before the rollback are discarded; the retry covers them too.
      transactionFailed = e?.message || String(e);
      rowFailures.length = 0;
    }

    // Retry path (audit C1: "re-queue on transient SQL errors once").
    // If the transaction aborted, retry every entry individually without
    // a transaction wrapper. Row-level failures from the successful-
    // transaction path also get one retry here in case the failure was
    // transient (e.g. a transient constraint conflict resolved by a
    // concurrent write that completed between our attempts).
    if (transactionFailed !== null) {
      for (const entry of entries) {
        try {
          this.sql.exec(
            "INSERT OR REPLACE INTO file_chunks (path, chunk_id, data) VALUES (?, ?, ?)",
            entry.path, entry.chunkId, entry.data
          );
          confirmedRows++;
        } catch (e: any) {
          this._recordFailedWrite(entry, e?.message || String(e), 2);
        }
      }
    } else if (rowFailures.length > 0) {
      for (const { entry, error: firstError } of rowFailures) {
        try {
          this.sql.exec(
            "INSERT OR REPLACE INTO file_chunks (path, chunk_id, data) VALUES (?, ?, ?)",
            entry.path, entry.chunkId, entry.data
          );
          confirmedRows++;
        } catch (e: any) {
          this._recordFailedWrite(entry, `${firstError}; retry: ${e?.message || String(e)}`, 2);
        }
      }
    }

    // Single accounting update for the whole flush. Reflects rows that
    // actually committed (via either the first attempt or the retry).
    this._sqlWrites += confirmedRows;
    this._batchWriteRows += confirmedRows;
  }

  /**
   * Move an un-writable chunk into failedWrites and notify subscribers.
   * Called from the retry path of flushPendingWrites(). Entries recorded
   * here are the ones that failed BOTH the original attempt and the
   * one-shot retry; they are considered lost (we do not re-queue a
   * third time — the audit recommendation was a single retry). The
   * chunk bytes are NOT retained — see failedWrites comment above.
   */
  private _recordFailedWrite(
    entry: { path: string; chunkId: number; data: Uint8Array },
    error: string,
    attempts: number,
  ): void {
    const key = this.cacheKey(entry.path, entry.chunkId);
    // Defensive cap: a session that writes to a broken SQLite could
    // otherwise grow failedWrites without bound between flushAll calls.
    // 1000 entries × ~120 B = ~120 KB ceiling. The cumulative
    // _writeFailures counter still grows so observers can see drops.
    if (!this.failedWrites.has(key) && this.failedWrites.size >= 1000) {
      // Drop the oldest recorded failure to make room; a 1000-deep
      // failure queue already signals a serious problem.
      const oldest = this.failedWrites.keys().next().value;
      if (oldest !== undefined) this.failedWrites.delete(oldest);
    }
    this.failedWrites.set(key, {
      path: entry.path, chunkId: entry.chunkId,
      error, attempts,
    });
    this._writeFailures++;
    // Surface to subscribers so the supervisor can, e.g., write to the
    // user's terminal. Handler errors are swallowed — they mustn't
    // affect the flush path (called from a microtask).
    const payload = { path: entry.path, chunkId: entry.chunkId, error, attempts };
    for (const handler of this.writeErrorHandlers) {
      try { handler(payload); } catch { /* handler is last line of defense */ }
    }
    console.error('[sqlite-vfs] write permanently failed for', entry.path,
                  'chunk', entry.chunkId, 'after', attempts, 'attempts:', error);
  }

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
    path: string; chunkId: number; error: string; attempts: number;
  }) => void): () => void {
    this.writeErrorHandlers.add(handler);
    return () => { this.writeErrorHandlers.delete(handler); };
  }

  /**
   * Snapshot of currently-recorded write failures. Intended for
   * diagnostics (e.g. /api/stats). The underlying Map is not exposed
   * so external code can't accidentally mutate it.
   */
  getWriteFailures(): Array<{ path: string; chunkId: number; error: string; attempts: number }> {
    return Array.from(this.failedWrites.values()).map(f => ({
      path: f.path, chunkId: f.chunkId, error: f.error, attempts: f.attempts,
    }));
  }

  /**
   * Clear recorded failures. Callers that have recovered (e.g. retried
   * the user-facing operation, or logged the error and decided to move
   * on) can call this to reset the counter so flushAll() stops
   * throwing. Without this, a single poisoned chunk would make every
   * subsequent flushAll() throw forever.
   */
  clearWriteFailures(): number {
    const n = this.failedWrites.size;
    this.failedWrites.clear();
    return n;
  }

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
   * by the LIFO @lifo-sh/core MountProvider interface.
   */
  flushAll(): void {
    // Flush cache dirty entries
    for (const [, entry] of this.cache) {
      if (entry.dirty) {
        this.deferWrite(entry.path, entry.chunkId, entry.data);
        entry.dirty = false;
      }
    }
    // Flush pending writes synchronously
    this.flushPendingWrites();

    if (this.failedWrites.size > 0) {
      // Build a concise error message that names the first few paths
      // so the operator can triage. Full list is available via
      // getWriteFailures().
      const first = Array.from(this.failedWrites.values()).slice(0, 3);
      const preview = first.map(f => `${f.path}#${f.chunkId} (${f.error})`).join('; ');
      const remaining = this.failedWrites.size > first.length
        ? ` +${this.failedWrites.size - first.length} more`
        : '';
      throw new Error(
        `[sqlite-vfs] flushAll: ${this.failedWrites.size} write(s) failed permanently: ${preview}${remaining}`,
      );
    }
  }

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
  async flushAndWait(): Promise<void> {
    // queueMicrotask-scheduled flush may be in flight. Await a microtask
    // turn before checking + forcing a flush so we don't double-run.
    await Promise.resolve();
    this.flushAll(); // throws on failures
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private now(): number { return Date.now(); }

  private parentPath(path: string): string {
    return path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';
  }

  private blobToUint8Array(blob: unknown): Uint8Array {
    if (blob instanceof Uint8Array) return blob;
    if (blob instanceof ArrayBuffer) return new Uint8Array(blob);
    if (ArrayBuffer.isView(blob)) return new Uint8Array((blob as any).buffer, (blob as any).byteOffset, (blob as any).byteLength);
    return new Uint8Array(0);
  }

  private readChunkFromSql(path: string, chunkId: number): Uint8Array | null {
    // Check pending writes first (do86 pattern: avoid stale reads)
    const key = this.cacheKey(path, chunkId);
    const pending = this.pendingWrites.get(key);
    if (pending) return pending.data;

    this._sqlReads++;
    const rows = [...this.sql.exec("SELECT data FROM file_chunks WHERE path = ? AND chunk_id = ?", path, chunkId)];
    if (rows.length === 0) return null;
    return this.blobToUint8Array(rows[0].data);
  }

  // ── Filesystem operations ─────────────────────────────────────────────

  exists(path: string): boolean {
    return this.inodes.has(path);
  }

  isDirectory(path: string): boolean {
    const inode = this.inodes.get(path);
    return inode !== undefined && inode.isDir;
  }

  isFile(path: string): boolean {
    const inode = this.inodes.get(path);
    return inode !== undefined && !inode.isDir;
  }

  mkdir(path: string, options?: { recursive?: boolean }): void {
    if (this.exists(path)) return;

    if (options?.recursive) {
      const parts = path.split('/').filter(Boolean);
      let current = '';
      for (const part of parts) {
        current = current ? current + '/' + part : part;
        if (!this.exists(current)) {
          this._mkdirSingle(current);
        }
      }
    } else {
      this._mkdirSingle(path);
    }
  }

  private _mkdirSingle(path: string): void {
    const pp = this.parentPath(path);
    const mtime = this.now();
    this.sql.exec(
      "INSERT OR REPLACE INTO inodes (path, parent_path, is_dir, size, mtime, mode, chunk_count) VALUES (?, ?, 1, 0, ?, ?, 0)",
      path, pp, mtime, 0o755
    );
    const inode: INode = { path, parentPath: pp, isDir: true, size: 0, mtime, mode: 0o755, chunkCount: 0 };
    this.inodes.set(path, inode);
    this._addToChildrenIndex(pp, path);
    this._totalDirs++; // B3
    this.events.emit('addDir', path);
  }

  writeFile(path: string, content: string | Uint8Array): void {
    const data = typeof content === 'string' ? enc.encode(content) : content;
    const pp = this.parentPath(path);
    const mtime = this.now();
    const chunkCount = data.length === 0 ? 0 : Math.ceil(data.length / CHUNK_SIZE);
    // Capture prior state BEFORE mutating this.inodes (B3 delta tracking).
    const prior = this.inodes.get(path);
    const isNew = prior === undefined;

    // Invalidate old cache entries (discard=true: old data is being replaced)
    if (!isNew) {
      this.cacheInvalidate(path, true);
      this.clearPendingWritesForPath(path);
      // Delete old chunks from SQL (chunk count may differ)
      this.sql.exec("DELETE FROM file_chunks WHERE path = ?", path);
    }

    // Write inode
    this.sql.exec(
      "INSERT OR REPLACE INTO inodes (path, parent_path, is_dir, size, mtime, mode, chunk_count) VALUES (?, ?, 0, ?, ?, ?, ?)",
      path, pp, data.length, mtime, 0o644, chunkCount
    );
    const newInode: INode = { path, parentPath: pp, isDir: false, size: data.length, mtime, mode: 0o644, chunkCount };
    this.inodes.set(path, newInode);
    if (isNew) this._addToChildrenIndex(pp, path);

    // B3: update running counters. Handles new file, replace file,
    // and the edge case of writing a file path that previously
    // belonged to a directory (writeFile replacing an old dir — rare
    // but `INSERT OR REPLACE` + `this.inodes.set` would silently
    // convert it; handle the count flip defensively).
    if (isNew) {
      this._totalFiles++;
      this._usedBytes += data.length;
    } else if (prior!.isDir) {
      // Dir → file conversion.
      this._totalDirs--;
      this._totalFiles++;
      this._usedBytes += data.length; // prior size was 0
    } else {
      // File → file replace: delta on size, no count change.
      this._usedBytes += data.length - prior!.size;
    }

    // Write chunks to cache (clean, not dirty) and defer SQL write.
    // The deferred write handles persistence; cache entry stays clean
    // to avoid double-writing when the entry is eventually evicted.
    if (data.length === 0) {
      // Empty file: no chunks to write
    } else if (data.length <= CHUNK_SIZE) {
      this.cacheSet(path, 0, data, false);
      this.deferWrite(path, 0, data);
    } else {
      for (let i = 0; i < chunkCount; i++) {
        const chunk = data.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        this.cacheSet(path, i, chunk, false);
        this.deferWrite(path, i, chunk);
      }
    }

    this.events.emit(isNew ? 'add' : 'change', path);
  }

  readFile(path: string): Uint8Array {
    const inode = this.inodes.get(path);
    if (!inode) throw new Error("ENOENT: " + path);
    if (inode.isDir) throw new Error("EISDIR: " + path);
    if (inode.size === 0 || inode.chunkCount === 0) return new Uint8Array(0);

    if (inode.chunkCount === 1) {
      // Single chunk
      const cached = this.cacheGet(path, 0);
      if (cached) return cached;
      const data = this.readChunkFromSql(path, 0);
      if (!data) return new Uint8Array(0);
      this.cacheSet(path, 0, data, false);
      return data;
    }

    // Multi-chunk: reassemble
    const chunks: Uint8Array[] = [];
    let totalRead = 0;
    for (let i = 0; i < inode.chunkCount; i++) {
      let chunk = this.cacheGet(path, i);
      if (!chunk) {
        chunk = this.readChunkFromSql(path, i);
        if (chunk) {
          this.cacheSet(path, i, chunk, false);
        }
      }
      if (chunk) {
        chunks.push(chunk);
        totalRead += chunk.length;
      }
    }

    if (chunks.length === 1) return chunks[0];
    const result = new Uint8Array(totalRead);
    let offset = 0;
    for (const c of chunks) {
      result.set(c, offset);
      offset += c.length;
    }
    return result;
  }

  readFileString(path: string): string {
    return dec.decode(this.readFile(path));
  }

  stat(path: string): { type: string; size: number; ctime: number; mtime: number; mode: number } {
    const inode = this.inodes.get(path);
    if (!inode) throw new Error("ENOENT: " + path);
    return {
      type: inode.isDir ? 'directory' : 'file',
      size: inode.size,
      ctime: inode.mtime,
      mtime: inode.mtime,
      mode: inode.mode,
    };
  }

  readdir(path: string): { name: string; type: string }[] {
    const np = path.replace(/^\/+/, '').replace(/\/+$/, '');
    const kids = this.children.get(np);
    if (!kids) {
      // W2.5b diagnostic: empty children-set for a directory we expected
      // to be populated.
      if ((globalThis as any).process?.env?.NIMBUS_DIAG_INSTALL_PIPELINE === '1') {
        // eslint-disable-next-line no-console
        console.warn(
          '[sqlite-vfs/W2.5b] readdir miss path=' + np +
          ' kidsUndefined=true inodeExists=' + this.inodes.has(np),
        );
      }
      return [];
    }
    const results: { name: string; type: string }[] = [];
    for (const childPath of kids) {
      const inode = this.inodes.get(childPath);
      if (inode) {
        const name = inode.path.split('/').pop()!;
        results.push({ name, type: inode.isDir ? 'directory' : 'file' });
      }
    }
    // W2.5b diagnostic: if children-set has entries but readdir returns
    // fewer (some entries' inodes are missing from this.inodes), log it.
    // This distinguishes (a) "children index broken" from (b) "inodes
    // map lost entries".
    if (
      (globalThis as any).process?.env?.NIMBUS_DIAG_INSTALL_PIPELINE === '1' &&
      kids.size !== results.length
    ) {
      // eslint-disable-next-line no-console
      console.warn(
        '[sqlite-vfs/W2.5b] readdir size mismatch path=' + np +
        ' kidsSize=' + kids.size +
        ' resultsLength=' + results.length +
        ' missingInodes=' + (kids.size - results.length),
      );
    }
    // W2.6a: sort lexicographically. Set-insertion order tracks
    // writeBatch arrival order, which under concurrent npm install
    // (pLimit=3) is non-deterministic. Sorting here removes a class
    // of "works on Tuesday" bugs in any consumer that walks readdir
    // results — buildPrefetchBundle, buildManifest, the kernel-VFS
    // mount layer, etc. Cost is O(n log n) on dirs that already cost
    // O(n) to assemble; negligible for typical npm package depths.
    results.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    return results;
  }

  unlink(path: string): void {
    const inode = this.inodes.get(path);
    this.cacheInvalidate(path, true);
    this.clearPendingWritesForPath(path);

    this.sql.exec("DELETE FROM file_chunks WHERE path = ?", path);
    this.sql.exec("DELETE FROM inodes WHERE path = ?", path);
    if (inode) {
      this._removeFromChildrenIndex(inode.parentPath, path);
      // B3: running counters. unlink of a dir shouldn't happen (that's
      // rmdir's job) but guard defensively against the count flipping.
      if (inode.isDir) this._totalDirs--;
      else { this._totalFiles--; this._usedBytes -= inode.size; }
    }
    this.inodes.delete(path);
    this.events.emit('unlink', path);
  }

  rmdir(path: string): void {
    const np = path.replace(/^\/+/, '').replace(/\/+$/, '');
    // Check if empty using children index (O(1) instead of O(N))
    const kids = this.children.get(np);
    if (kids && kids.size > 0) {
      throw new Error("ENOTEMPTY: " + path);
    }
    const inode = this.inodes.get(np);
    this.sql.exec("DELETE FROM inodes WHERE path = ?", np);
    if (inode) {
      this._removeFromChildrenIndex(inode.parentPath, np);
      // B3: running counters. Rmdir targets a dir; a non-dir entry here
      // would be a caller bug. Still, match the actual inode state.
      if (inode.isDir) this._totalDirs--;
      else { this._totalFiles--; this._usedBytes -= inode.size; }
    }
    this.inodes.delete(np);
    this.children.delete(np); // Remove empty children set
    this.events.emit('unlinkDir', np);
  }

  rename(oldPath: string, newPath: string): void {
    // Flush pending writes for old path first to avoid orphans
    this.cacheInvalidate(oldPath, false); // flush dirty, not discard
    this.flushPendingWrites(); // synchronously flush so SQL paths are current
    this.clearPendingWritesForPath(oldPath);

    const newPp = this.parentPath(newPath);
    const oldPp = this.parentPath(oldPath);

    // Update inode
    const inode = this.inodes.get(oldPath);
    if (!inode) throw new Error("ENOENT: " + oldPath);

    this.sql.exec("UPDATE inodes SET path=?, parent_path=? WHERE path=?", newPath, newPp, oldPath);
    this.sql.exec("UPDATE file_chunks SET path=? WHERE path=?", newPath, oldPath);

    // Update in-memory state
    this._removeFromChildrenIndex(oldPp, oldPath);
    this.inodes.delete(oldPath);
    inode.path = newPath;
    inode.parentPath = newPp;
    this.inodes.set(newPath, inode);
    this._addToChildrenIndex(newPp, newPath);

    // Rename children if directory
    if (inode.isDir) {
      const childPaths: string[] = [];
      for (const [p] of this.inodes) {
        if (p.startsWith(oldPath + '/')) childPaths.push(p);
      }
      for (const cp of childPaths) {
        const ncp = newPath + cp.substring(oldPath.length);
        const ncpp = this.parentPath(ncp);

        this.cacheInvalidate(cp, false);
        this.clearPendingWritesForPath(cp);
        this.sql.exec("UPDATE inodes SET path=?, parent_path=? WHERE path=?", ncp, ncpp, cp);
        this.sql.exec("UPDATE file_chunks SET path=? WHERE path=?", ncp, cp);

        const childInode = this.inodes.get(cp)!;
        const oldCpp = childInode.parentPath;
        this._removeFromChildrenIndex(oldCpp, cp);
        this.inodes.delete(cp);
        childInode.path = ncp;
        childInode.parentPath = ncpp;
        this.inodes.set(ncp, childInode);
        this._addToChildrenIndex(ncpp, ncp);
      }
    }

    this.events.emit('rename', newPath, oldPath);
  }

  copyFile(src: string, dest: string): void {
    this.writeFile(dest, this.readFile(src));
  }

  // ── Batch write (npm install fast path) ───────────────────────────────

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
  writeBatch(payload: BatchWritePayload): { inodes: number; chunks: number } {
    // W5 Lever 9: top-level entry. Inner _writeBatchOnce throws on
    // SQLITE_NOMEM; this wrapper catches, classifies, drops the LRU,
    // and retries by halving — bounded depth 4. Other errors propagate
    // unchanged (loud failure preserves the W2.5 error contract for
    // constraint conflicts etc.).
    return this._writeBatchWithRetry(payload, 0);
  }

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
   * Future v2 (deferred — out of W7 scope, see W7-retro.md): chunk
   * the supervisor-side `transactionSync` calls into N segments
   * (e.g. every 8 MiB of streamed content) so the supervisor heap
   * peak also drops.
   *
   * Throws on SQLITE_NOMEM (with halve-retry per writeBatch); any
   * iterator-source error propagates unchanged. Atomicity guarantee
   * matches writeBatch: either ALL inodes + chunks land in SQLite or
   * NONE do.
   */
  async writeStream(payload: {
    inodes: BatchInodeEntry[];
    chunkIter: AsyncIterable<BatchChunkEntry>;
    deletePaths?: string[];
  }): Promise<{ inodes: number; chunks: number }> {
    // Drain the iterator. Iterator errors propagate unchanged.
    // We build the chunks array fully BEFORE entering transactionSync
    // because transactionSync is synchronous (cannot await mid-txn).
    const chunks: BatchChunkEntry[] = [];
    for await (const c of payload.chunkIter) {
      chunks.push(c);
    }
    return this.writeBatch({
      inodes: payload.inodes,
      chunks,
      deletePaths: payload.deletePaths,
    });
  }

  private _writeBatchWithRetry(
    payload: BatchWritePayload,
    depth: number,
  ): { inodes: number; chunks: number } {
    try {
      return this._writeBatchOnce(payload);
    } catch (e: any) {
      const cause = classifyError(e);
      // Classify before deciding to retry. Only the SQLITE_NOMEM family
      // is retryable; constraint conflicts / disk-full / clone-refused
      // / unknown all surface to the caller (fail loud).
      const lru = this._cacheBytes;
      const inFlight = this._estimateBatchBytes(payload);
      recordFailure({
        at: Date.now(),
        phase: 'install',
        cause,
        rssEstimateBytes: 0,
        heapUsedBytes: this._safeHeapUsed(),
        lruBytes: lru,
        inFlightBytes: inFlight,
        lastRpcFrame: null,
        lastFacetId: null,
        message: e?.message || String(e),
      });
      if (cause !== 'sqlite_nomem') throw e;

      // Bounded retry depth. 500-row batch → 250 → 125 → ~63 → ~32.
      // Beyond depth=4, give up: persistent OOM at 32 rows means we
      // are not the bottleneck.
      if (depth >= 4) throw e;

      // Free pages owned by us before re-attempting. evictAll() flushes
      // dirty entries via deferWrite (existing path) so no data loss.
      this.evictAll();

      // Halve the payload by partitioning ALL three lists (inodes,
      // chunks, deletePaths) by path-set so each half operates on
      // disjoint paths. Halving is on inodes (the primary index);
      // chunks and deletePaths are partitioned to match.
      const halves = this._halveBatchPayload(payload);
      const r1 = this._writeBatchWithRetry(halves[0], depth + 1);
      const r2 = this._writeBatchWithRetry(halves[1], depth + 1);
      return {
        inodes: r1.inodes + r2.inodes,
        chunks: r1.chunks + r2.chunks,
      };
    }
  }

  /**
   * Estimate the byte cost of a writeBatch payload. Used by the W5
   * recordFailure call so /api/_diag/memory can report inFlightBytes
   * at the moment of the SQLITE_NOMEM. Fast (no copy).
   */
  private _estimateBatchBytes(payload: BatchWritePayload): number {
    let n = 0;
    for (const c of payload.chunks) n += c.data.length;
    // Path strings + inode header overhead — rough estimate.
    for (const i of payload.inodes) n += 80 + i.path.length;
    return n;
  }

  /** Best-effort process.memoryUsage().heapUsed; 0 in DO contexts. */
  private _safeHeapUsed(): number {
    try {
      const mu = (globalThis as any).process?.memoryUsage?.();
      return Number(mu?.heapUsed) || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Partition a writeBatch payload into two halves with disjoint
   * path-sets. Preserves the W2.5 invariant: deletePaths and chunks
   * follow their owning inode into the same half. Used by the
   * SQLITE_NOMEM retry path.
   */
  private _halveBatchPayload(
    p: BatchWritePayload,
  ): [BatchWritePayload, BatchWritePayload] {
    // If there are inodes, halve by inode list and partition chunks +
    // deletePaths by path-set. If there are NO inodes (chunks-only
    // batch), halve chunks directly.
    const inodes = p.inodes ?? [];
    const chunks = p.chunks ?? [];
    const dels = p.deletePaths ?? [];

    if (inodes.length >= 2) {
      const mid = Math.ceil(inodes.length / 2);
      const i1 = inodes.slice(0, mid);
      const i2 = inodes.slice(mid);
      const set1 = new Set(i1.map(n => n.path));
      const set2 = new Set(i2.map(n => n.path));
      const c1: typeof chunks = [];
      const c2: typeof chunks = [];
      for (const c of chunks) {
        if (set1.has(c.path)) c1.push(c);
        else if (set2.has(c.path)) c2.push(c);
        // Chunks orphaned from inodes (defensive) go to half 1.
        else c1.push(c);
      }
      const d1: string[] = [];
      const d2: string[] = [];
      for (const d of dels) {
        if (set1.has(d)) d1.push(d);
        else if (set2.has(d)) d2.push(d);
        else d1.push(d);
      }
      return [
        { inodes: i1, chunks: c1, deletePaths: d1 },
        { inodes: i2, chunks: c2, deletePaths: d2 },
      ];
    }

    // No inodes — chunks-only or delete-only payload. Halve directly.
    if (chunks.length >= 2) {
      const mid = Math.ceil(chunks.length / 2);
      return [
        { inodes: [], chunks: chunks.slice(0, mid), deletePaths: dels },
        { inodes: [], chunks: chunks.slice(mid), deletePaths: [] },
      ];
    }

    if (dels.length >= 2) {
      const mid = Math.ceil(dels.length / 2);
      return [
        { inodes: [], chunks: [], deletePaths: dels.slice(0, mid) },
        { inodes: [], chunks: [], deletePaths: dels.slice(mid) },
      ];
    }

    // Single-item payload — can't halve further; return original + empty.
    return [p, { inodes: [], chunks: [], deletePaths: [] }];
  }

  private _writeBatchOnce(payload: BatchWritePayload): { inodes: number; chunks: number } {
    let inodeCount = 0;
    let chunkCount = 0;

    // Invalidate cache for all affected paths before writing.
    // Audit R2: the previous per-path loop was O(P × C) — each
    // cacheInvalidate/clearPendingWritesForPath did a full scan of
    // the 512-entry cache / pendingWrites map. For a 500-path wave
    // that was ~256K comparisons; a 30K-file git clone paid ~15M
    // total. The cacheInvalidateBatch / clearPendingWritesForPaths
    // helpers do a single pass each — O(P + C).
    const affectedPaths = new Set<string>();
    for (const inode of payload.inodes) {
      if (!inode.isDir) affectedPaths.add(inode.path);
    }
    for (const chunk of payload.chunks) {
      affectedPaths.add(chunk.path);
    }
    if (payload.deletePaths) {
      for (const p of payload.deletePaths) affectedPaths.add(p);
    }
    this.cacheInvalidateBatch(affectedPaths, true);
    this.clearPendingWritesForPaths(affectedPaths);

    try {
      const doTransaction = (fn: () => void) => {
        if (this.ctx?.storage?.transactionSync) {
          this.ctx.storage.transactionSync(fn);
        } else {
          fn();
        }
      };

      doTransaction(() => {
        // 1. Delete old paths
        if (payload.deletePaths?.length) {
          for (const path of payload.deletePaths!) {
            this.sql.exec("DELETE FROM file_chunks WHERE path = ?", path);
            this.sql.exec("DELETE FROM inodes WHERE path = ?", path);
          }
        }

        // 2. Batch insert inodes — multi-row VALUES.
        // DO SQLite has a low bind-parameter limit (~100 variables).
        // 7 columns per inode → max 14 rows per statement (14×7=98).
        const INODE_BATCH = 14;
        for (let i = 0; i < payload.inodes.length; i += INODE_BATCH) {
          const batch = payload.inodes.slice(i, i + INODE_BATCH);
          const placeholders = batch.map(() => '(?,?,?,?,?,?,?)').join(',');
          const values: any[] = [];
          for (const n of batch) {
            values.push(
              n.path, n.parentPath, n.isDir ? 1 : 0,
              n.size, n.mtime, n.mode, n.chunkCount,
            );
          }
          this.sql.exec(
            `INSERT OR REPLACE INTO inodes (path, parent_path, is_dir, size, mtime, mode, chunk_count) VALUES ${placeholders}`,
            ...values,
          );
          inodeCount += batch.length;
        }

        // 3. Batch insert chunks — multi-row VALUES.
        // 3 columns per chunk → max 33 rows per statement (33×3=99).
        const CHUNK_BATCH = 33;
        for (let i = 0; i < payload.chunks.length; i += CHUNK_BATCH) {
          const batch = payload.chunks.slice(i, i + CHUNK_BATCH);
          const placeholders = batch.map(() => '(?,?,?)').join(',');
          const values: any[] = [];
          for (const c of batch) {
            values.push(c.path, c.chunkId, c.data);
          }
          this.sql.exec(
            `INSERT OR REPLACE INTO file_chunks (path, chunk_id, data) VALUES ${placeholders}`,
            ...values,
          );
          chunkCount += batch.length;
        }
      });
    } catch (e: any) {
      console.error('[sqlite-vfs] writeBatch failed:', e?.message);
      throw e;
    }

    // 4. Update in-memory inode tree + children index (outside transaction — fast).
    //    B3: also maintain running counters in sync. For each payload entry,
    //    compute the delta against any pre-existing inode at that path.
    //
    // W2.5a (audit/sections/W2.5-plan.md): the children-index call is now
    // OUTSIDE the `prior === undefined` guard. Pre-W2.5a, ~37 of 46 packages
    // per `npm install fastify` accumulated inodes in SQL but never reached
    // the in-memory `this.children` index because some path's `prior` was
    // unexpectedly defined when the package's writeBatch arrived (root
    // cause unidentified — see §4.2 diagnostic plan in W2.5-plan.md).
    // `_addToChildrenIndex` uses Set.add so repeated calls are idempotent;
    // gating it on `prior === undefined` was the bug. Counters remain
    // gated correctly so they don't double-count.
    const __diag = ((globalThis as any).process?.env?.NIMBUS_DIAG_INSTALL_PIPELINE === '1');
    for (const entry of payload.inodes) {
      const prior = this.inodes.get(entry.path);
      const node: INode = {
        path: entry.path,
        parentPath: entry.parentPath,
        isDir: entry.isDir,
        size: entry.size,
        mtime: entry.mtime,
        mode: entry.mode,
        chunkCount: entry.chunkCount,
      };
      this.inodes.set(entry.path, node);

      // ALWAYS re-affirm the children-index entry. Idempotent.
      this._addToChildrenIndex(entry.parentPath, entry.path);

      // W2.5b diagnostic: log every "stale prior" case where we'd have
      // skipped the index call pre-W2.5a. Reveals which paths were
      // pre-populated in this.inodes by a code path other than the
      // current writeBatch — H5a / H8 candidate.
      if (__diag && prior !== undefined) {
        const indexed = this.children.get(entry.parentPath)?.has(entry.path) ?? false;
        // eslint-disable-next-line no-console
        console.warn(
          '[sqlite-vfs/W2.5b] stale-prior path=' + entry.path +
          ' parent=' + entry.parentPath +
          ' priorParent=' + prior.parentPath +
          ' priorIsDir=' + prior.isDir +
          ' entryIsDir=' + entry.isDir +
          ' indexedBefore=' + indexed,
        );
      }

      // Counter delta — gated on prior so we don't double-count.
      if (prior === undefined) {
        if (entry.isDir) this._totalDirs++;
        else { this._totalFiles++; this._usedBytes += entry.size; }
      } else {
        // Replace: handle dir↔file flip + size delta. (Identical to pre-W2.5a.)
        if (prior.isDir && !entry.isDir) {
          this._totalDirs--;
          this._totalFiles++;
          this._usedBytes += entry.size;
        } else if (!prior.isDir && entry.isDir) {
          this._totalFiles--;
          this._usedBytes -= prior.size;
          this._totalDirs++;
        } else if (!entry.isDir) {
          // File-replace: size delta only.
          this._usedBytes += entry.size - prior.size;
        }
        // Dir-replace (both dir): no counter change.
      }
    }
    // Note: payload.deletePaths only removes from SQL, not from
    // this.inodes (pre-existing behaviour — see writeBatch SQL section
    // around line 1020). Counters therefore track in-memory state,
    // which matches what getStats() observes. If the in-memory cleanup
    // of deletePaths is ever added, update the counters there too.

    // 5. Fire events for VFS-aware subscribers (HMR etc.)
    for (const entry of payload.inodes) {
      if (entry.isDir) {
        this.events.emit('addDir', entry.path);
      } else {
        this.events.emit('add', entry.path);
      }
    }

    this._sqlWrites += inodeCount + chunkCount;
    this._batchWrites++;
    this._batchWriteRows += inodeCount + chunkCount;

    return { inodes: inodeCount, chunks: chunkCount };
  }

  /**
   * Bulk mkdir: create all directories in a single transactionSync.
   * Pre-creates the full directory tree before file writes to avoid
   * per-file mkdir overhead.
   */
  mkdirBatch(paths: string[]): number {
    const mtime = Date.now();
    const toCreate: BatchInodeEntry[] = [];
    const seen = new Set<string>();

    for (const path of paths) {
      const parts = path.split('/').filter(Boolean);
      let current = '';
      for (const part of parts) {
        current = current ? current + '/' + part : part;
        if (!seen.has(current) && !this.exists(current)) {
          seen.add(current);
          toCreate.push({
            path: current,
            parentPath: this.parentPath(current),
            isDir: true,
            size: 0,
            mtime,
            mode: 0o755,
            chunkCount: 0,
          });
        }
      }
    }

    if (toCreate.length === 0) return 0;
    this.writeBatch({ inodes: toCreate, chunks: [] });
    return toCreate.length;
  }

  // ── Stats ─────────────────────────────────────────────────────────────

  /**
   * Debug-only: recompute counters from scratch and return any drift
   * against the running counters. Returns null if consistent. Used by
   * the B3 runtime test; production paths should never call this
   * (the whole point of B3 is avoiding the O(N) walk).
   */
  _verifyCounters(): null | { expected: { files: number; dirs: number; bytes: number }; actual: { files: number; dirs: number; bytes: number } } {
    let f = 0, d = 0, b = 0;
    for (const inode of this.inodes.values()) {
      if (inode.isDir) d++;
      else { f++; b += inode.size; }
    }
    if (f === this._totalFiles && d === this._totalDirs && b === this._usedBytes) return null;
    return {
      expected: { files: f, dirs: d, bytes: b },
      actual: { files: this._totalFiles, dirs: this._totalDirs, bytes: this._usedBytes },
    };
  }

  getStats() {
    // B3: O(1) — read the running counters. Previously three passes
    // over this.inodes (two filter + one for-of); at 50K inodes that
    // was 150K iterations per poll, every 5 s, serialising on the
    // input gate alongside shell keystrokes (AUDIT M10 / M-S8).
    const totalFiles = this._totalFiles;
    const totalDirs = this._totalDirs;
    const usedBytes = this._usedBytes;

    const totalAccesses = this._cacheHits + this._cacheMisses;
    const hitRate = totalAccesses > 0 ? (this._cacheHits / totalAccesses * 100) : 0;

    return {
      // Legacy compat
      files: totalFiles,
      directories: totalDirs,
      usedBytes,
      capacityBytes: 10 * 1024 * 1024 * 1024, // 10 GB
      backend: 'DO SQLite (demand-paged VFS)',

      // Cache stats. maxEntries / maxBytes are now W5-runtime-mutable —
      // shrinkForInstall() drops them, restoreAfterInstall() restores.
      // lruShrunk is the at-a-glance signal for /api/_diag/memory.
      cache: {
        entries: this.cache.size,
        maxEntries: this._lruMaxEntries,
        chunkSize: CHUNK_SIZE,
        hotBytes: this._cacheBytes,
        maxBytes: this._lruMaxEntries * CHUNK_SIZE,
        hits: this._cacheHits,
        misses: this._cacheMisses,
        hitRate: Math.round(hitRate * 100) / 100,
        evictions: this._evictions,
        lruShrunk: this._lruMaxEntries < LRU_MAX_ENTRIES,
      },

      // SQL I/O stats
      sql: {
        reads: this._sqlReads,
        writes: this._sqlWrites,
        batchWrites: this._batchWrites,
        batchWriteRows: this._batchWriteRows,
        pendingWrites: this.pendingWrites.size,
        failedWrites: this.failedWrites.size,
        totalWriteFailures: this._writeFailures,
      },

      // Event stats
      events: this.events.stats,

      // INode stats
      inodes: {
        total: this.inodes.size,
        files: totalFiles,
        directories: totalDirs,
        memoryEstimate: this.inodes.size * 200, // ~200 bytes per entry
      },
    };
  }
}

// ── SqliteVFSProvider (MountProvider for Nimbus Kernel VFS) ────────────────────

export class SqliteVFSProvider {
  private vfs: SqliteVFS;
  private prefix: string;

  constructor(vfs: SqliteVFS, prefix: string) {
    this.vfs = vfs;
    this.prefix = prefix.replace(/^\/+/, '').replace(/\/+$/, '');
  }

  private resolve(sub: string): string {
    const c = sub.replace(/^\/+/, '').replace(/\/+$/, '');
    return c ? this.prefix + '/' + c : this.prefix;
  }

  readFile(sub: string): Uint8Array { return this.vfs.readFile(this.resolve(sub)); }
  readFileString(sub: string): string { return this.vfs.readFileString(this.resolve(sub)); }

  writeFile(sub: string, content: string | Uint8Array): void {
    const fp = this.resolve(sub);
    const pp = fp.includes('/') ? fp.substring(0, fp.lastIndexOf('/')) : '';
    if (pp && !this.vfs.exists(pp)) this.vfs.mkdir(pp, { recursive: true });
    this.vfs.writeFile(fp, content);
  }

  exists(sub: string): boolean { return this.vfs.exists(this.resolve(sub)); }
  stat(sub: string) { return this.vfs.stat(this.resolve(sub)); }
  readdir(sub: string) { return this.vfs.readdir(this.resolve(sub)); }
  unlink(sub: string): void { this.vfs.unlink(this.resolve(sub)); }

  mkdir(sub: string, opts?: { recursive?: boolean }): void {
    this.vfs.mkdir(this.resolve(sub), opts);
  }

  rmdir(sub: string): void { this.vfs.rmdir(this.resolve(sub)); }
  rename(o: string, n: string): void { this.vfs.rename(this.resolve(o), this.resolve(n)); }
  copyFile(s: string, d: string): void { this.vfs.copyFile(this.resolve(s), this.resolve(d)); }
}
