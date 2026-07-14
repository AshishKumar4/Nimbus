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

import { VfsEventEmitter, type VfsEventType } from './events.js';
import { normalizeVfsPath } from './path.js';
import {
  CHUNK_SIZE,
  LRU_MAX_ENTRIES,
  BATCH_SIZE,
  MAX_TX_BLOB_BYTES,
  MAX_TX_LOGICAL_ROWS,
  MAX_TX_SQL_EXECS,
} from '../constants.js';
import { recordFailure } from '../observability/oom-discriminator.js';
import { classifyError } from '../observability/oom-classify.js';
import { enc, dec } from '../_shared/bytes.js';

const CONTENT_ID_ALLOCATION_ATTEMPTS = 8;

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
  atime: number;
  mtime: number;
  mode: number;
  /** Number of 64KB chunks (0 for dirs, 1+ for files) */
  chunkCount: number;
  /** Cached immutable content key. Null means the deterministic legacy key. */
  contentId: string | null;
}

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

export type WriteBatchStreamResult =
  | (WriteBatchStreamProgress & { ok: true })
  | (WriteBatchStreamProgress & {
      ok: false;
      error: {
        code: 'ERR_WRITE_BATCH_STREAM';
        phase: WriteBatchStreamFailurePhase;
        message: string;
      };
    });

const INODE_ROWS_PER_SQL_EXEC = 11;
const CHUNK_ROWS_PER_SQL_EXEC = 33;
const CONTENT_IDS_PER_SQL_EXEC = 50;
const TRANSACTION_DURATION_SAMPLE_COUNT = 128;
const CONTENT_SCHEMA_MIGRATION = 'content_generations_v1';

type TransactionLimit = 'blobBytes' | 'logicalRows' | 'sqlExecs';
type TransactionSource =
  | 'strict-batch'
  | 'range-mutation'
  | 'content-stage'
  | 'content-publish'
  | 'content-gc';
type TransactionLimitMode = 'bounded';

interface StoredInodeEntry extends BatchInodeEntry {
  contentId: string | null;
}

interface ContentChunkEntry extends BatchChunkEntry {
  contentId: string;
}

interface DeletedContentChunk {
  path: string;
  contentId: string;
  chunkId: number;
  byteLength: number;
}

interface TransactionPlanMetrics {
  blobBytes: number;
  logicalRows: number;
  sqlExecs: number;
  affectedPaths: number;
}

interface TransactionPlan {
  inodes: readonly StoredInodeEntry[];
  chunks: ContentChunkEntry[];
  deletedChunks: readonly DeletedContentChunk[];
  deletedPaths: readonly string[];
  stagingContentIds: readonly string[];
  publishedContentIds: readonly string[];
  gcContentIds: readonly string[];
  affectedPaths: ReadonlySet<string>;
  metrics: TransactionPlanMetrics;
}

interface PreparedBatchTransaction {
  payload: BatchWritePayload;
  plan: TransactionPlan;
  deletedInodes: readonly INode[];
}

interface TransactionExecution {
  source: TransactionSource;
  limitMode: TransactionLimitMode;
}

interface DurationSummary {
  count: number;
  totalMs: number;
  lastMs: number;
  maxMs: number;
}

export class SqliteVfsTransactionTooLargeError extends Error {
  readonly code = 'E2BIG' as const;

  constructor(
    readonly limit: TransactionLimit,
    readonly actual: number,
    readonly maximum: number,
    readonly metrics: Readonly<TransactionPlanMetrics>,
  ) {
    super(`[sqlite-vfs] transaction exceeds ${limit} limit: ${actual} > ${maximum}`);
    this.name = 'SqliteVfsTransactionTooLargeError';
  }
}

class TransactionPlanBuilder {
  private readonly inodes: StoredInodeEntry[] = [];
  private readonly chunks: ContentChunkEntry[] = [];
  private readonly deletedChunks: DeletedContentChunk[] = [];
  private readonly deletedPaths = new Set<string>();
  private readonly stagingContentIds = new Set<string>();
  private readonly publishedContentIds = new Set<string>();
  private readonly gcContentIds = new Set<string>();
  private readonly affectedPaths = new Set<string>();
  private readonly deletedInodePaths = new Set<string>();
  private blobBytes = 0;
  private deletedInodeRows = 0;

  addInode(entry: StoredInodeEntry): void {
    this.inodes.push(entry);
    this.affectedPaths.add(entry.path);
  }

  addChunk(entry: ContentChunkEntry): void {
    this.chunks.push(entry);
    this.blobBytes += entry.data.byteLength;
    this.affectedPaths.add(entry.path);
  }

  addChunkGroup(entries: readonly ContentChunkEntry[]): void {
    for (const entry of entries) this.addChunk(entry);
  }

  addDeletedChunk(entry: DeletedContentChunk): void {
    this.deletedChunks.push(entry);
    this.blobBytes += entry.byteLength;
    this.affectedPaths.add(entry.path);
  }

  addDeletedPath(path: string, inode: INode | undefined): void {
    this.deletedPaths.add(path);
    this.affectedPaths.add(path);
    if (inode && !this.deletedInodePaths.has(inode.path)) {
      this.deletedInodePaths.add(inode.path);
      this.deletedInodeRows++;
    }
  }

  addStagingContent(contentId: string): void {
    this.stagingContentIds.add(contentId);
  }

  addPublishedContent(contentId: string): void {
    this.publishedContentIds.add(contentId);
  }

  addGcContent(contentId: string): void {
    this.gcContentIds.add(contentId);
  }

  wouldExceedChunkGroup(entries: readonly ContentChunkEntry[]): TransactionLimit | null {
    let additionalBlobBytes = 0;
    for (const entry of entries) additionalBlobBytes += entry.data.byteLength;
    return exceededTransactionLimit({
      blobBytes: this.blobBytes + additionalBlobBytes,
      logicalRows: this.logicalRows + entries.length,
      sqlExecs: this.fixedSqlExecs
        + groupedSqlExecs(this.inodes.length, INODE_ROWS_PER_SQL_EXEC)
        + groupedSqlExecs(this.chunks.length + entries.length, CHUNK_ROWS_PER_SQL_EXEC),
      affectedPaths: this.affectedPaths.size,
    });
  }

  get empty(): boolean {
    return this.inodes.length === 0
      && this.chunks.length === 0
      && this.deletedChunks.length === 0
      && this.deletedPaths.size === 0
      && this.stagingContentIds.size === 0
      && this.publishedContentIds.size === 0
      && this.gcContentIds.size === 0;
  }

  build(): TransactionPlan {
    return {
      inodes: this.inodes,
      chunks: this.chunks,
      deletedChunks: this.deletedChunks,
      deletedPaths: [...this.deletedPaths],
      stagingContentIds: [...this.stagingContentIds],
      publishedContentIds: [...this.publishedContentIds],
      gcContentIds: [...this.gcContentIds],
      affectedPaths: this.affectedPaths,
      metrics: this.metrics,
    };
  }

  private get logicalRows(): number {
    return this.inodes.length
      + this.chunks.length
      + this.deletedChunks.length
      + this.deletedInodeRows
      + this.stagingContentIds.size
      + this.publishedContentIds.size
      + this.gcContentIds.size;
  }

  private get fixedSqlExecs(): number {
    return this.deletedPaths.size
      + groupedSqlExecs(this.stagingContentIds.size, CONTENT_IDS_PER_SQL_EXEC)
      + groupedSqlExecs(this.publishedContentIds.size, CONTENT_IDS_PER_SQL_EXEC)
      + groupedSqlExecs(this.gcContentIds.size, CONTENT_IDS_PER_SQL_EXEC);
  }

  private get deletedChunkSqlExecs(): number {
    const byContent = new Map<string, number>();
    for (const chunk of this.deletedChunks) {
      byContent.set(chunk.contentId, (byContent.get(chunk.contentId) ?? 0) + 1);
    }
    let sqlExecs = 0;
    for (const count of byContent.values()) {
      sqlExecs += groupedSqlExecs(count, CHUNK_ROWS_PER_SQL_EXEC);
    }
    return sqlExecs;
  }

  private get metrics(): TransactionPlanMetrics {
    return {
      blobBytes: this.blobBytes,
      logicalRows: this.logicalRows,
      sqlExecs: this.fixedSqlExecs
        + groupedSqlExecs(this.inodes.length, INODE_ROWS_PER_SQL_EXEC)
        + groupedSqlExecs(this.chunks.length, CHUNK_ROWS_PER_SQL_EXEC)
        + this.deletedChunkSqlExecs,
      affectedPaths: this.affectedPaths.size,
    };
  }
}

function groupedSqlExecs(rows: number, rowsPerExec: number): number {
  return rows === 0 ? 0 : Math.ceil(rows / rowsPerExec);
}

function exceededTransactionLimit(metrics: TransactionPlanMetrics): TransactionLimit | null {
  if (metrics.blobBytes > MAX_TX_BLOB_BYTES) return 'blobBytes';
  if (metrics.logicalRows > MAX_TX_LOGICAL_ROWS) return 'logicalRows';
  if (metrics.sqlExecs > MAX_TX_SQL_EXECS) return 'sqlExecs';
  return null;
}

/** Cache entry: one 64KB chunk of file content */
interface CacheEntry {
  path: string;
  chunkId: number;
  data: Uint8Array;
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
  // drop the cap to ~8 MiB and free heap headroom for in-flight RPC and
  // streamed-write payloads. Refcount-based: nested
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
  private _revision = 0;

  // ── Per-path revisions ────────────────────────────────────────────────
  // _revision is the monotonic mutation clock. Every mutation stamps the
  // mutated path AND each of its ancestors with the clock value, so
  // revision(dir) is a subtree watermark: it changes iff something under
  // dir changed. Consumers (runtime snapshot caches, page caches, handle
  // staleness checks) key on revision(path) instead of the global clock,
  // so unrelated writes no longer invalidate them. In-memory only — the
  // clock resets with the DO lifetime, exactly like the caches keyed on it.
  private _pathRevisions = new Map<string, number>();

  private _peakRetainedWriteBytes = 0;
  /**
   * N2 (memory accounting cleanup). Sum of bytes held by writeStream()
   * for files that have not yet reached their declared v1 chunk count.
   * A completed file releases its retained bytes immediately after its
   * pointer publish; finally releases the incomplete remainder on failure.
   */
  private _writeStreamSpoolBytes = 0;
  private _peakWriteStreamSpoolBytes = 0;
  /** In-memory liveness only; content_lifecycle remains durable ownership. */
  private readonly activeStagingContentIds = new Set<string>();
  /** True only while durable GC work or a known abandoned staging row exists. */
  private maintenancePending = false;

  // Stage 2 transaction/phase telemetry. Scalar writes stay cheap; the
  // percentile is computed from the fixed ring only when diagnostics read it.
  private _activeTransaction: {
    startedAt: number;
    plan: TransactionPlan;
    execution: TransactionExecution;
  } | null = null;
  private _transactionDuration: DurationSummary = emptyDurationSummary();
  private _postCommitDuration: DurationSummary = emptyDurationSummary();
  private _decodeDrainDuration: DurationSummary = emptyDurationSummary();
  private readonly _transactionDurationSamples = new Float64Array(TRANSACTION_DURATION_SAMPLE_COUNT);
  private _transactionDurationSampleCount = 0;
  private _transactionDurationSampleIndex = 0;
  private readonly _decodeDrainStarts = new Map<object, number>();
  private _transactionPeakBlobBytes = 0;
  private _transactionPeakLogicalRows = 0;
  private _transactionPeakSqlExecs = 0;
  private _transactionPeakAffectedPaths = 0;
  private _boundedTransactionPeakBlobBytes = 0;
  private _boundedTransactionPeakLogicalRows = 0;
  private _boundedTransactionPeakSqlExecs = 0;
  private _lastTransaction: {
    metrics: TransactionPlanMetrics;
    execution: TransactionExecution;
  } | null = null;
  private _overLimitFileCount = 0;
  private _lastOverLimitFile: (TransactionPlanMetrics & { path: string; limit: TransactionLimit }) | null = null;

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
    this.runContentMaintenanceSafely(2, true);
  }

  // ── Schema ────────────────────────────────────────────────────────────

  private initSchema(): void {
    this.transactionSync(() => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS vfs_schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )`);

      const contentMigrationApplied = [...this.sql.exec(
        'SELECT id FROM vfs_schema_migrations WHERE id = ?',
        CONTENT_SCHEMA_MIGRATION,
      )].length > 0;
      const existingInodeColumns = this.tableColumns('inodes');
      const existingChunkColumns = this.tableColumns('file_chunks');
      const existingLifecycleColumns = this.tableColumns('content_lifecycle');
      const chunksAreLegacy = existingChunkColumns.has('path')
        && existingChunkColumns.has('chunk_id')
        && existingChunkColumns.has('data')
        && !existingChunkColumns.has('content_id');
      const chunksAreCurrent = existingChunkColumns.has('content_id')
        && existingChunkColumns.has('chunk_id')
        && existingChunkColumns.has('data')
        && !existingChunkColumns.has('path');
      const lifecycleIsCurrent = existingLifecycleColumns.has('content_id')
        && existingLifecycleColumns.has('state')
        && existingLifecycleColumns.has('created_at');
      if (contentMigrationApplied && (
        !existingInodeColumns.has('content_id')
        || !chunksAreCurrent
        || !lifecycleIsCurrent
      )) {
        throw new Error('[sqlite-vfs] content generation marker does not match the durable schema');
      }
      if (existingChunkColumns.size > 0 && !chunksAreLegacy && !chunksAreCurrent) {
        throw new Error('[sqlite-vfs] unsupported file_chunks schema');
      }
      if (existingLifecycleColumns.size > 0 && !lifecycleIsCurrent) {
        throw new Error('[sqlite-vfs] unsupported content_lifecycle schema');
      }

      this.sql.exec(`CREATE TABLE IF NOT EXISTS inodes (
        path TEXT PRIMARY KEY,
        parent_path TEXT NOT NULL DEFAULT '',
        is_dir INTEGER NOT NULL DEFAULT 0,
        size INTEGER NOT NULL DEFAULT 0,
        atime INTEGER NOT NULL DEFAULT 0,
        mtime INTEGER NOT NULL DEFAULT 0,
        mode INTEGER NOT NULL DEFAULT 0,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        content_id TEXT NULL
      )`);

      const inodeColumns = this.tableColumns('inodes');
      if (!inodeColumns.has('chunk_count')) {
        this.sql.exec("ALTER TABLE inodes ADD COLUMN chunk_count INTEGER NOT NULL DEFAULT 0");
      }
      if (!inodeColumns.has('atime')) {
        this.sql.exec("ALTER TABLE inodes ADD COLUMN atime INTEGER NOT NULL DEFAULT 0");
      }
      if (!inodeColumns.has('content_id')) {
        this.sql.exec("ALTER TABLE inodes ADD COLUMN content_id TEXT NULL");
      }

      const chunkColumns = this.tableColumns('file_chunks');
      if (chunkColumns.size === 0) {
        this.sql.exec(`CREATE TABLE file_chunks (
          content_id TEXT NOT NULL,
          chunk_id INTEGER NOT NULL,
          data BLOB NOT NULL,
          PRIMARY KEY (content_id, chunk_id)
        )`);
      } else if (chunksAreLegacy) {
        // legacyContentId(path) is the path itself. Renaming the column is an
        // O(1), rollback-atomic schema migration: no unbounded row-copy txn.
        this.sql.exec("ALTER TABLE file_chunks RENAME COLUMN path TO content_id");
      } else if (!chunksAreCurrent) {
        throw new Error('[sqlite-vfs] unsupported file_chunks schema');
      }

      this.sql.exec(`CREATE TABLE IF NOT EXISTS content_lifecycle (
        content_id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN ('staging', 'gc')),
        created_at INTEGER NOT NULL
      )`);
      this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_inodes_parent ON inodes(parent_path)`);
      this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_inodes_content ON inodes(content_id)`);
      this.sql.exec(
        `CREATE INDEX IF NOT EXISTS idx_inodes_resolved_file_content
         ON inodes(COALESCE(content_id, path)) WHERE is_dir = 0`,
      );
      this.sql.exec(
        "INSERT OR IGNORE INTO vfs_schema_migrations (id, applied_at) VALUES (?, ?)",
        CONTENT_SCHEMA_MIGRATION,
        Date.now(),
      );
    });

    this.migrateFromLegacy();
  }

  private tableColumns(table: string): Set<string> {
    const rows = this.sql.exec(`PRAGMA table_info(${table})`);
    return new Set([...rows].map((row) => String(row.name)));
  }

  private migrateFromLegacy(): void {
    const rows = [...this.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='fs_objects'")];
    if (rows.length === 0) return;
    const marker = [...this.sql.exec(
      "SELECT id FROM vfs_schema_migrations WHERE id = 'legacy_fs_objects_v1'",
    )];
    if (marker.length > 0) return;

    console.log('[sqlite-vfs] Migrating from legacy fs_objects table...');
    const LEGACY_CHUNK_SIZE = 1_800_000;
    let migratedEntries = 0;
    const paths = [...this.sql.exec("SELECT DISTINCT path FROM fs_objects ORDER BY path")];
    for (const pathRow of paths) {
      const path = String(pathRow.path);
      const sourceRows = [...this.sql.exec(
        `SELECT chunk_index, parent_path, data, is_dir, size, mtime, mode
         FROM fs_objects WHERE path = ? ORDER BY chunk_index`,
        path,
      )];
      if (sourceRows.length === 0) continue;
      const first = sourceRows[0];
      const parentPath = String(first.parent_path);
      const isDir = Number(first.is_dir) === 1;
      const size = Number(first.size);
      const mtime = Number(first.mtime);
      const mode = Number(first.mode);
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new Error(`EIO: invalid legacy size for ${path}: ${size}`);
      }
      for (const row of sourceRows) {
        if (
          String(row.parent_path) !== parentPath
          || (Number(row.is_dir) === 1) !== isDir
          || Number(row.size) !== size
          || Number(row.mtime) !== mtime
          || Number(row.mode) !== mode
        ) {
          throw new Error(`EIO: inconsistent legacy metadata for ${path}`);
        }
      }

      const chunkCount = isDir || size === 0 ? 0 : Math.ceil(size / CHUNK_SIZE);
      if (!isDir) {
        const markerPlan = this.metricsOnlyPlan({
          blobBytes: 0, logicalRows: 1, sqlExecs: 1, affectedPaths: 1,
        });
        this.executeMeasuredTransaction(
          markerPlan,
          { source: 'content-stage', limitMode: 'bounded' },
          () => {
            this.sql.exec(
              "INSERT OR IGNORE INTO content_lifecycle (content_id, state, created_at) VALUES (?, 'staging', ?)",
              path,
              Date.now(),
            );
          },
        );

        let builder = new TransactionPlanBuilder();
        const flush = (): void => {
          if (builder.empty) return;
          const plan = builder.build();
          builder = new TransactionPlanBuilder();
          this.assertTransactionFits(plan.metrics);
          this.executeTransactionPlan(plan, { source: 'content-stage', limitMode: 'bounded' });
        };
        let tail = new Uint8Array(0);
        let nextChunkId = 0;
        let bytesRead = 0;
        for (let legacyIndex = 0; legacyIndex < sourceRows.length; legacyIndex++) {
          const row = sourceRows[legacyIndex];
          if (Number(row.chunk_index) !== legacyIndex) {
            throw new Error(`EIO: invalid legacy chunk index ${row.chunk_index} for ${path}`);
          }
          const offset = legacyIndex * LEGACY_CHUNK_SIZE;
          const expectedLength = Math.max(0, Math.min(LEGACY_CHUNK_SIZE, size - offset));
          const data = row.data == null ? new Uint8Array(0) : this.blobToUint8Array(row.data);
          if (offset > size || data.length !== expectedLength) {
            throw new Error(
              `EIO: invalid legacy chunk ${legacyIndex} for ${path}: expected ${expectedLength} bytes, got ${data.length}`,
            );
          }
          const combined = new Uint8Array(tail.length + data.length);
          combined.set(tail);
          combined.set(data, tail.length);
          let offsetInCombined = 0;
          while (combined.length - offsetInCombined >= CHUNK_SIZE) {
            const chunk: ContentChunkEntry = {
              path,
              contentId: path,
              chunkId: nextChunkId++,
              data: combined.slice(offsetInCombined, offsetInCombined + CHUNK_SIZE),
            };
            if (builder.wouldExceedChunkGroup([chunk]) !== null) flush();
            builder.addChunk(chunk);
            offsetInCombined += CHUNK_SIZE;
          }
          tail = combined.slice(offsetInCombined);
          bytesRead += data.length;
        }
        if (tail.length > 0) {
          const chunk: ContentChunkEntry = {
            path,
            contentId: path,
            chunkId: nextChunkId++,
            data: tail,
          };
          if (builder.wouldExceedChunkGroup([chunk]) !== null) flush();
          builder.addChunk(chunk);
        }
        flush();
        if (bytesRead !== size || nextChunkId !== chunkCount) {
          throw new Error(`EIO: migrated content mismatch for ${path}`);
        }
      }

      const publishBuilder = new TransactionPlanBuilder();
      publishBuilder.addInode({
        path,
        parentPath,
        isDir,
        size,
        atime: mtime,
        mtime,
        mode,
        chunkCount,
        contentId: null,
      });
      if (!isDir) publishBuilder.addPublishedContent(path);
      const publishPlan = publishBuilder.build();
      this.assertTransactionFits(publishPlan.metrics);
      this.executeTransactionPlan(publishPlan, { source: 'content-publish', limitMode: 'bounded' });
      migratedEntries++;
    }

    const finishPlan = this.metricsOnlyPlan({
      blobBytes: 0, logicalRows: 1, sqlExecs: 2, affectedPaths: 0,
    });
    this.executeMeasuredTransaction(
      finishPlan,
      { source: 'content-publish', limitMode: 'bounded' },
      () => {
        this.sql.exec(
          "INSERT INTO vfs_schema_migrations (id, applied_at) VALUES ('legacy_fs_objects_v1', ?)",
          Date.now(),
        );
        this.sql.exec("DROP TABLE fs_objects");
      },
    );
    console.log(`[sqlite-vfs] Migration complete: ${migratedEntries} entries migrated.`);
  }

  // ── INode loading ─────────────────────────────────────────────────────

  private loadInodes(): void {
    this.inodes.clear();
    this.children.clear();
    // Reset counters before rescanning (B3).
    this._totalFiles = 0;
    this._totalDirs = 0;
    this._usedBytes = 0;
    const rows = [...this.sql.exec("SELECT path, parent_path, is_dir, size, atime, mtime, mode, chunk_count, content_id FROM inodes")];
    for (const row of rows) {
      const mtime = Number(row.mtime);
      const atime = Number(row.atime) || mtime;
      const inode: INode = {
        path: String(row.path),
        parentPath: String(row.parent_path),
        isDir: Number(row.is_dir) === 1,
        size: Number(row.size),
        atime,
        mtime,
        mode: Number(row.mode),
        chunkCount: Number(row.chunk_count),
        contentId: row.content_id === null ? null : String(row.content_id),
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

  private cacheSet(path: string, chunkId: number, data: Uint8Array): void {
    const key = this.cacheKey(path, chunkId);
    const owned = this.copyBytes(data);

    // If already cached, update
    const existing = this.cache.get(key);
    if (existing) {
      this._cacheBytes -= existing.data.length;
      existing.data = owned;
      this._cacheBytes += owned.length;
      // Move to MRU
      this.cache.delete(key);
      this.cache.set(key, existing);
      this.enforceCacheLimit();
      return;
    }

    this._cacheBytes += owned.length;
    this.cache.set(key, { path, chunkId, data: owned });
    this.enforceCacheLimit();
  }

  private enforceCacheLimit(): void {
    while (this.cache.size > this._lruMaxEntries) this.evictOne();
  }

  private evictOne(): void {
    // Evict the LRU entry (first in Map iteration order)
    const firstKey = this.cache.keys().next().value;
    if (firstKey === undefined) return;

    const entry = this.cache.get(firstKey)!;
    this.cache.delete(firstKey);
    this._cacheBytes -= entry.data.length;
    this._evictions++;
  }

  // ── W5 Lever 8: public LRU shrink / restore + evictAll ───────────────
  //
  // shrinkForInstall(targetEntries): tighten the cap so heavy-alloc
  // owners (npm install / git clone / pre-bundle) free heap headroom
  // for in-flight RPC and streamed-write payloads. Refcount-based
  // so nested heavy-alloc owners (e.g. concurrent install + clone)
  // don't race; only the OUTERMOST restoreAfterInstall() raises the
  // cap back to LRU_MAX_ENTRIES.
  //
  // Default target 128 entries × 64 KB = 8 MiB. Matches
  // CF-INTERNAL-OPTIMIZATION-RESEARCH.md J.1.2.
  //
  // The cache is disposable. Cold-cache bounce is acceptable for install
  // workloads because accepted writes are already durable in SQLite.
  shrinkForInstall(targetEntries: number = 128): void {
    const target = Math.max(1, Math.min(LRU_MAX_ENTRIES, targetEntries | 0));
    // Refcount: nested acquires stack. Take the smallest target across
    // owners — most aggressive shrinker wins.
    if (this._lruShrinkRefcount > 0) {
      if (target < this._lruMaxEntries) this._lruMaxEntries = target;
      this._lruShrinkRefcount++;
      this.enforceCacheLimit();
      return;
    }
    this._lruShrinkRefcount = 1;
    this._lruMaxEntries = target;
    // Evict down to the new cap; cache eviction is always disposable.
    this.enforceCacheLimit();
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

  /** Drop every disposable cache entry before retrying a strict batch. */
  evictAll(): void {
    // Iterate a snapshot while deleting from the cache.
    const keys = Array.from(this.cache.keys());
    for (const key of keys) {
      const entry = this.cache.get(key);
      if (!entry) continue;
      this.cache.delete(key);
      this._cacheBytes -= entry.data.length;
      this._evictions++;
    }
  }

  /**
   * Batch version of cacheInvalidate — invalidate every cache entry
   * whose path is in `paths`. One pass over the cache instead of one
   * pass per path (audit R2: writeBatch was O(P × C) before this).
   *
   */
  private cacheInvalidateBatch(paths: ReadonlySet<string>): void {
    if (paths.size === 0) return;
    const toDelete: string[] = [];
    for (const [key, entry] of this.cache) {
      if (!paths.has(entry.path)) continue;
      this._cacheBytes -= entry.data.length;
      toDelete.push(key);
    }
    for (const key of toDelete) {
      this.cache.delete(key);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private now(): number { return Date.now(); }

  private parentPath(path: string): string {
    return path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';
  }

  /** The single content resolver for both legacy-null and generated inodes. */
  private contentIdForInode(inode: INode): string {
    return inode.contentId ?? this.legacyContentId(inode.path);
  }

  private legacyContentId(path: string): string {
    return path;
  }

  private createContentId(reservedContentIds?: Set<string>): string {
    // Canonical VFS keys never have a leading slash, so this namespace cannot
    // overlap legacy IDs, which are raw canonical paths. One combined indexed
    // guard also protects malformed legacy data, durable generations, and a
    // repeated random value; the local reservation protects IDs in one plan.
    for (let attempt = 0; attempt < CONTENT_ID_ALLOCATION_ATTEMPTS; attempt++) {
      const contentId = `/content:${crypto.randomUUID()}`;
      if (reservedContentIds?.has(contentId)) continue;
      const collision = [...this.sql.exec(
        `SELECT 1 AS collision FROM file_chunks WHERE content_id = ?
         UNION ALL
         SELECT 1 FROM content_lifecycle WHERE content_id = ?
         UNION ALL
         SELECT 1 FROM inodes
         WHERE is_dir = 0 AND COALESCE(content_id, path) = ?
         LIMIT 1`,
        contentId,
        contentId,
        contentId,
      )];
      if (collision.length === 0) {
        reservedContentIds?.add(contentId);
        return contentId;
      }
    }
    throw new Error('EIO: failed to allocate a unique VFS content generation');
  }

  private blobToUint8Array(blob: unknown): Uint8Array {
    if (blob instanceof Uint8Array) return blob;
    if (blob instanceof ArrayBuffer) return new Uint8Array(blob);
    if (ArrayBuffer.isView(blob)) return new Uint8Array((blob as any).buffer, (blob as any).byteOffset, (blob as any).byteLength);
    return new Uint8Array(0);
  }

  private copyBytes(data: Uint8Array): Uint8Array {
    const copy = new Uint8Array(data.length);
    copy.set(data);
    return copy;
  }

  private readChunkFromSql(inode: INode, chunkId: number): Uint8Array | null {
    this._sqlReads++;
    const rows = [...this.sql.exec(
      "SELECT data FROM file_chunks WHERE content_id = ? AND chunk_id = ?",
      this.contentIdForInode(inode),
      chunkId,
    )];
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

  /**
   * Without a path: the global mutation clock. With a path: the clock
   * value at the last mutation inside that path's subtree (0 if nothing
   * under it changed in this DO lifetime). `revision('')` equals the
   * global clock by construction (every mutation stamps all ancestors).
   */
  revision(path?: string): number {
    if (path === undefined) return this._revision;
    const p = normalizeVfsPath(path);
    if (p === '') return this._revision;
    return this._pathRevisions.get(p) ?? 0;
  }

  /** Advance the clock once and stamp every path + its ancestors. */
  private bumpRevision(paths: readonly string[]): void {
    const rev = ++this._revision;
    for (const path of paths) {
      let p = normalizeVfsPath(path);
      while (p !== '') {
        this._pathRevisions.set(p, rev);
        p = this.parentPath(p);
      }
    }
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
    const now = this.now();
    this.sql.exec(
      "INSERT OR REPLACE INTO inodes (path, parent_path, is_dir, size, atime, mtime, mode, chunk_count, content_id) VALUES (?, ?, 1, 0, ?, ?, ?, 0, NULL)",
      path, pp, now, now, 0o755
    );
    const inode: INode = {
      path,
      parentPath: pp,
      isDir: true,
      size: 0,
      atime: now,
      mtime: now,
      mode: 0o755,
      chunkCount: 0,
      contentId: null,
    };
    this.inodes.set(path, inode);
    this._addToChildrenIndex(pp, path);
    this._totalDirs++; // B3
    this.bumpRevision([path]);
    this.events.emit('addDir', path);
  }

  writeFile(path: string, content: string | Uint8Array): void {
    const data = typeof content === 'string' ? enc.encode(content) : content;
    const pp = this.parentPath(path);
    const now = this.now();
    const chunkCount = data.length === 0 ? 0 : Math.ceil(data.length / CHUNK_SIZE);
    const chunks: BatchChunkEntry[] = [];
    for (let chunkId = 0; chunkId < chunkCount; chunkId++) {
      chunks.push({
        path,
        chunkId,
        data: data.subarray(chunkId * CHUNK_SIZE, (chunkId + 1) * CHUNK_SIZE),
      });
    }
    const inode: BatchInodeEntry = {
      path,
      parentPath: pp,
      isDir: false,
      size: data.length,
      atime: now,
      mtime: now,
      mode: 0o644,
      chunkCount,
    };
    try {
      this.writeBatch({ inodes: [inode], chunks });
    } catch (error) {
      if (!(error instanceof SqliteVfsTransactionTooLargeError)) throw error;
      this.replaceFileWithStagedContent(inode, chunks);
    }
  }

  /** Read one chunk via cache → SQL, caching on miss. */
  private readChunk(inode: INode, chunkId: number): Uint8Array | null {
    const path = inode.path;
    const cached = this.cacheGet(path, chunkId);
    if (cached) return cached;
    const data = this.readChunkFromSql(inode, chunkId);
    if (data) this.cacheSet(path, chunkId, data);
    return data;
  }

  readFile(path: string): Uint8Array {
    const inode = this.inodes.get(path);
    if (!inode) throw new Error("ENOENT: " + path);
    if (inode.isDir) throw new Error("EISDIR: " + path);
    if (inode.size === 0 || inode.chunkCount === 0) return new Uint8Array(0);

    if (inode.chunkCount === 1) {
      return this.requireChunk(path, inode, 0).slice(0, inode.size);
    }

    // Multi-chunk: reassemble
    const chunks: Uint8Array[] = [];
    let totalRead = 0;
    for (let i = 0; i < inode.chunkCount; i++) {
      const chunk = this.requireChunk(path, inode, i);
      chunks.push(chunk);
      totalRead += chunk.length;
    }

    if (totalRead < inode.size) {
      throw new Error(`EIO: ${path}: declared size ${inode.size} exceeds chunk bytes ${totalRead}`);
    }
    const result = new Uint8Array(inode.size);
    let offset = 0;
    for (const c of chunks) {
      const length = Math.min(c.length, result.length - offset);
      if (length <= 0) break;
      result.set(c.subarray(0, length), offset);
      offset += length;
    }
    return result;
  }

  private requireChunk(path: string, inode: INode, chunkId: number): Uint8Array {
    const chunk = this.readChunk(inode, chunkId);
    if (chunk) return chunk;
    throw new Error(
      `EIO: ${path}: missing declared chunk ${chunkId} of ${inode.chunkCount} (size ${inode.size})`,
    );
  }

  /**
   * Read `length` bytes at `offset` without assembling the whole file —
   * only the chunks overlapping the range are touched. Reads past EOF
   * are clamped; missing spans retain the existing zero-fill range semantics.
   */
  readRange(path: string, offset: number, length: number): Uint8Array {
    const inode = this.inodes.get(path);
    if (!inode) throw new Error("ENOENT: " + path);
    if (inode.isDir) throw new Error("EISDIR: " + path);
    const start = clampNonNegativeInt(offset);
    const end = Math.min(inode.size, start + clampNonNegativeInt(length));
    if (start >= end) return new Uint8Array(0);

    const out = new Uint8Array(end - start);
    const firstChunk = Math.floor(start / CHUNK_SIZE);
    const lastChunk = Math.floor((end - 1) / CHUNK_SIZE);
    for (let i = firstChunk; i <= lastChunk; i++) {
      const chunk = this.readChunk(inode, i);
      if (!chunk) continue;
      const chunkStart = i * CHUNK_SIZE;
      const copyFrom = Math.max(start, chunkStart);
      const copyTo = Math.min(end, chunkStart + chunk.length);
      if (copyFrom >= copyTo) continue;
      out.set(chunk.subarray(copyFrom - chunkStart, copyTo - chunkStart), copyFrom - start);
    }
    return out;
  }

  /**
   * Overwrite `bytes` at `offset`, rewriting only the chunks the range
   * (plus any EOF extension) touches — file-handle and page writers must
   * not pay a whole-file rewrite. Writing past EOF zero-fills the gap so
   * every chunk row up to the new EOF stays materialized at its
   * positional length (readFile reassembles by plain concatenation).
   * Creates the file when missing; callers own parent-dir creation
   * (same contract as writeFile).
   */
  writeRange(path: string, offset: number, bytes: Uint8Array): void {
    const prior = this.inodes.get(path);
    if (prior && prior.isDir) throw new Error("EISDIR: " + path);
    const isNew = prior === undefined;
    const start = clampNonNegativeInt(offset);
    const end = start + bytes.length;
    if (isNew) {
      const initial = new Uint8Array(end);
      initial.set(bytes, start);
      this.writeFile(path, initial);
      return;
    }
    // POSIX pwrite of zero bytes never extends or dirties an existing file.
    if (bytes.length === 0) return;

    const oldSize = prior.size;
    const oldChunkCount = prior.chunkCount;
    const newSize = Math.max(oldSize, end);
    const now = this.now();
    const changedChunks = new Map<number, Uint8Array>();

    if (newSize > 0) {
      // Contiguous chunk span: the written range, plus the stretch from
      // the old EOF when extending (gap chunks zero-fill; a partial old
      // last chunk is re-materialized at its grown length).
      const extending = end > oldSize;
      const fromChunk = Math.floor((extending ? Math.min(start, oldSize) : start) / CHUNK_SIZE);
      const toChunk = Math.floor(((extending ? newSize : end) - 1) / CHUNK_SIZE);
      for (let i = fromChunk; i <= toChunk; i++) {
        const chunkStart = i * CHUNK_SIZE;
        const chunkLen = Math.min(CHUNK_SIZE, newSize - chunkStart);
        const overlayFrom = Math.max(start, chunkStart);
        const overlayTo = Math.min(end, chunkStart + chunkLen);
        const chunk = new Uint8Array(chunkLen);
        const fullyCovered = overlayFrom <= chunkStart && overlayTo >= chunkStart + chunkLen;
        if (!fullyCovered && i < oldChunkCount) {
          const existing = this.requireChunk(path, prior, i);
          chunk.set(existing.subarray(0, Math.min(existing.length, chunkLen)), 0);
        }
        if (overlayFrom < overlayTo) {
          chunk.set(bytes.subarray(overlayFrom - start, overlayTo - start), overlayFrom - chunkStart);
        }
        changedChunks.set(i, chunk);
      }
    }

    const newChunkCount = newSize === 0 ? 0 : Math.ceil(newSize / CHUNK_SIZE);
    const next = this.updatedFileInode(prior, newSize, newChunkCount, now);
    if (this.commitCurrentContentMutation(prior, next, changedChunks, [])) return;
    this.replaceFileWithGeneratedContent(
      next,
      (chunkId) => this.generatedMutationChunk(prior, next, changedChunks, chunkId),
    );
  }

  /**
   * Truncate or zero-extend to `size`, touching only the boundary chunk.
   * Shrinking drops trailing chunk rows and trims the new last chunk;
   * growing zero-fills like writeRange. Every mutation commits before return.
   */
  truncate(path: string, size: number): void {
    const inode = this.inodes.get(path);
    if (!inode) throw new Error("ENOENT: " + path);
    if (inode.isDir) throw new Error("EISDIR: " + path);
    const newSize = clampNonNegativeInt(size);
    const oldSize = inode.size;
    if (newSize === oldSize) return;
    const newChunkCount = newSize === 0 ? 0 : Math.ceil(newSize / CHUNK_SIZE);
    const now = this.now();
    const changedChunks = new Map<number, Uint8Array>();

    if (newSize > oldSize) {
      // Zero-extend from the old EOF. A full old last chunk is skipped;
      // a partial one is re-materialized at its grown length.
      const fromChunk = oldSize % CHUNK_SIZE === 0 ? oldSize / CHUNK_SIZE : Math.floor(oldSize / CHUNK_SIZE);
      for (let i = fromChunk; i < newChunkCount; i++) {
        const chunkStart = i * CHUNK_SIZE;
        const chunkLen = Math.min(CHUNK_SIZE, newSize - chunkStart);
        const chunk = new Uint8Array(chunkLen);
        if (i < inode.chunkCount) {
          const existing = this.requireChunk(path, inode, i);
          chunk.set(existing.subarray(0, Math.min(existing.length, chunkLen)), 0);
        }
        changedChunks.set(i, chunk);
      }
    } else {
      if (newChunkCount > 0) {
        const lastId = newChunkCount - 1;
        const lastLen = newSize - lastId * CHUNK_SIZE;
        if (lastLen < CHUNK_SIZE) {
          const existing = this.requireChunk(path, inode, lastId);
          if (existing.length > lastLen) {
            const trimmed = existing.slice(0, lastLen);
            changedChunks.set(lastId, trimmed);
          }
        }
      }
    }

    const deletedChunks: DeletedContentChunk[] = [];
    if (newSize < oldSize) {
      const contentId = this.contentIdForInode(inode);
      const rows = [...this.sql.exec(
        `SELECT chunk_id, length(data) AS byte_length
         FROM file_chunks
         WHERE content_id = ? AND chunk_id >= ?
         ORDER BY chunk_id
         LIMIT ?`,
        contentId,
        newChunkCount,
        MAX_TX_LOGICAL_ROWS + 1,
      )];
      for (const row of rows) {
        deletedChunks.push({
          path,
          contentId,
          chunkId: clampNonNegativeInt(Number(row.chunk_id)),
          byteLength: clampNonNegativeInt(Number(row.byte_length)),
        });
      }
    }

    const next = this.updatedFileInode(inode, newSize, newChunkCount, now);
    if (this.commitCurrentContentMutation(inode, next, changedChunks, deletedChunks)) return;
    this.replaceFileWithGeneratedContent(
      next,
      (chunkId) => this.generatedMutationChunk(inode, next, changedChunks, chunkId),
    );
  }

  private updatedFileInode(
    inode: INode,
    size: number,
    chunkCount: number,
    mtime: number,
  ): BatchInodeEntry {
    return {
      path: inode.path,
      parentPath: inode.parentPath,
      isDir: false,
      size,
      atime: inode.atime,
      mtime,
      mode: inode.mode,
      chunkCount,
    };
  }

  private commitCurrentContentMutation(
    prior: INode,
    inode: BatchInodeEntry,
    changedChunks: ReadonlyMap<number, Uint8Array>,
    deletedChunks: readonly DeletedContentChunk[],
  ): boolean {
    const contentId = this.contentIdForInode(prior);
    const builder = new TransactionPlanBuilder();
    builder.addInode({ ...inode, contentId });
    for (const [chunkId, data] of changedChunks) {
      builder.addChunk({ path: inode.path, contentId, chunkId, data });
    }
    for (const chunk of deletedChunks) builder.addDeletedChunk(chunk);
    const plan = builder.build();
    if (exceededTransactionLimit(plan.metrics) !== null) return false;
    this._writeBatchOnce(
      {
        payload: { inodes: [inode], chunks: [] },
        plan,
        deletedInodes: [],
      },
      { source: 'range-mutation', limitMode: 'bounded' },
      changedChunks.size,
    );
    return true;
  }

  private generatedMutationChunk(
    prior: INode,
    inode: BatchInodeEntry,
    changedChunks: ReadonlyMap<number, Uint8Array>,
    chunkId: number,
  ): Uint8Array {
    const changed = changedChunks.get(chunkId);
    if (changed) return changed;
    const existing = this.requireChunk(prior.path, prior, chunkId);
    const expected = Math.min(CHUNK_SIZE, inode.size - (chunkId * CHUNK_SIZE));
    if (existing.byteLength !== expected) {
      throw new Error(
        `EIO: ${prior.path}: chunk ${chunkId} has ${existing.byteLength} bytes; expected ${expected}`,
      );
    }
    return existing;
  }

  readFileString(path: string): string {
    return dec.decode(this.readFile(path));
  }

  stat(path: string): { type: string; size: number; atime: number; ctime: number; mtime: number; mode: number } {
    const inode = this.inodes.get(path);
    if (!inode) throw new Error("ENOENT: " + path);
    return {
      type: inode.isDir ? 'directory' : 'file',
      size: inode.size,
      atime: inode.atime || inode.mtime,
      ctime: inode.mtime,
      mtime: inode.mtime,
      mode: inode.mode,
    };
  }

  utimes(path: string, atimeMs: number, mtimeMs: number): void {
    const inode = this.inodes.get(path);
    if (!inode) throw new Error("ENOENT: " + path);
    const atime = Number.isFinite(atimeMs) ? Math.trunc(atimeMs) : this.now();
    const mtime = Number.isFinite(mtimeMs) ? Math.trunc(mtimeMs) : this.now();
    inode.atime = atime;
    inode.mtime = mtime;
    this.sql.exec("UPDATE inodes SET atime = ?, mtime = ? WHERE path = ?", atime, mtime, path);
    this.bumpRevision([path]);
    this.events.emit('change', path);
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
    if (!inode) return;
    if (inode.isDir) throw new Error('EISDIR: ' + path);
    this.writeBatch({ inodes: [], chunks: [], deletePaths: [path] });
  }

  rmdir(path: string): void {
    const np = path.replace(/^\/+/, '').replace(/\/+$/, '');
    // Check if empty using children index (O(1) instead of O(N))
    const kids = this.children.get(np);
    if (kids && kids.size > 0) {
      throw new Error("ENOTEMPTY: " + path);
    }
    const inode = this.inodes.get(np);
    if (!inode) return;
    if (!inode.isDir) throw new Error('ENOTDIR: ' + path);
    this.writeBatch({ inodes: [], chunks: [], deletePaths: [np] });
  }

  rename(oldPath: string, newPath: string): void {
    if (oldPath === newPath) return;
    if (newPath.startsWith(`${oldPath}/`)) {
      throw new Error(`EINVAL: cannot move ${oldPath} inside itself`);
    }
    const inode = this.inodes.get(oldPath);
    if (!inode) throw new Error("ENOENT: " + oldPath);

    // W-3 (WASI filesystem WASI): if newPath already exists, unlink it first so the
    // SQL UPDATE doesn't conflict on inodes.path uniqueness. POSIX rename(2)
    // overwrites the destination atomically; clang's atomic-write pattern
    // (write tmp + rename → final) depends on this. Without this branch,
    // a 2nd `make` after a prior successful build throws on UPDATE
    // failure. Pre-unlink covers both file-over-file and file-over-dir
    // (the latter is rare but POSIX permits it for empty dirs).
    const destInode = this.inodes.get(newPath);
    if (destInode) {
      if (destInode.isDir) {
        // POSIX semantics: rename onto a non-empty dir is an error
        // (ENOTEMPTY); rename onto an empty dir is allowed. We surface
        // both as a thrown error since the WASI shim treats every
        // unexpected exception as ENOSYS → caller diagnostics.
        // Conservative: refuse dir overwrite entirely; the WASI fixture
        // we care about (file → file) is the high-value case.
        if (inode.isDir) {
          throw new Error("ENOTDIR-or-EISDIR: rename onto existing dir not supported");
        }
        throw new Error("EISDIR: cannot rename file onto existing directory");
      }
    }

    const moving = [...this.inodes.values()]
      .filter((entry) => entry.path === oldPath || entry.path.startsWith(`${oldPath}/`))
      .sort((a, b) => a.path.length - b.path.length);
    const movingPaths = new Set(moving.map((entry) => entry.path));
    const targetPaths = new Set(
      moving.map((entry) => newPath + entry.path.substring(oldPath.length)),
    );
    for (const existing of this.inodes.values()) {
      if (movingPaths.has(existing.path) || existing === destInode) continue;
      if (targetPaths.has(existing.path) || existing.path.startsWith(`${newPath}/`)) {
        throw new Error(`ENOTEMPTY: rename target subtree conflicts at ${existing.path}`);
      }
    }
    const builder = new TransactionPlanBuilder();
    if (destInode) {
      builder.addDeletedPath(newPath, destInode);
      builder.addGcContent(this.contentIdForInode(destInode));
    }
    const renamed = moving.map((entry) => {
      const path = newPath + entry.path.substring(oldPath.length);
      const stored: StoredInodeEntry = {
        path,
        parentPath: this.parentPath(path),
        isDir: entry.isDir,
        size: entry.size,
        atime: entry.atime,
        mtime: entry.mtime,
        mode: entry.mode,
        chunkCount: entry.chunkCount,
        // Materialize the old legacy key before changing the logical path.
        contentId: entry.isDir ? null : this.contentIdForInode(entry),
      };
      builder.addDeletedPath(entry.path, entry);
      builder.addInode(stored);
      return { entry, stored };
    });
    const plan = builder.build();
    this.assertTransactionFits(plan.metrics);
    this.executeTransactionPlan(plan, { source: 'content-publish', limitMode: 'bounded' });

    const touchedPaths = new Set(plan.affectedPaths);
    this.cacheInvalidateBatch(touchedPaths);
    if (destInode) {
      this._removeFromChildrenIndex(destInode.parentPath, destInode.path);
      this.inodes.delete(destInode.path);
      this._totalFiles--;
      this._usedBytes -= destInode.size;
    }
    for (const { entry } of renamed) {
      this._removeFromChildrenIndex(entry.parentPath, entry.path);
      this.inodes.delete(entry.path);
    }
    for (const { entry, stored } of renamed) {
      entry.path = stored.path;
      entry.parentPath = stored.parentPath;
      entry.contentId = stored.contentId;
      this.inodes.set(entry.path, entry);
      this._addToChildrenIndex(entry.parentPath, entry.path);
    }
    this._sqlWrites += plan.inodes.length + plan.deletedPaths.length;
    this._batchWrites++;
    this._batchWriteRows += plan.inodes.length + plan.deletedPaths.length;
    this.bumpRevision([...touchedPaths]);
    this.events.emit('rename', newPath, oldPath);
    this.runContentMaintenanceSafely(1);
  }

  copyFile(src: string, dest: string): void {
    this.writeFile(dest, this.readFile(src));
  }

  // ── Batch write (npm install fast path) ───────────────────────────────

  /**
   * Atomic bulk write: ALL inodes + chunks in ONE transactionSync().
   *
   * The complete mutation is preflighted against the Stage 2 transaction
   * limits, then executed in one transaction with 11-inode / 33-chunk SQL
   * grouping. Oversized strict calls fail with E2BIG before mutation.
   */
  writeBatch(payload: BatchWritePayload): { inodes: number; chunks: number } {
    const result = this._writeBatchWithRetry(
      payload,
      { source: 'strict-batch', limitMode: 'bounded' },
      true,
    );
    this.runContentMaintenanceSafely(1);
    return result;
  }

  private replaceFileWithStagedContent(
    inode: BatchInodeEntry,
    chunks: readonly BatchChunkEntry[],
    onPhase?: (phase: 'stage' | 'publish') => void,
  ): { inodes: number; chunks: number } {
    this.validateFileChunks(inode, chunks);
    onPhase?.('stage');
    const contentId = this.beginStagedContent();

    let builder = new TransactionPlanBuilder();
    const flushChunks = (): void => {
      if (builder.empty) return;
      const plan = builder.build();
      builder = new TransactionPlanBuilder();
      this.executeStagedChunkPlan(plan);
    };
    try {
      for (const chunk of chunks) {
        const stored = { ...chunk, contentId };
        if (builder.wouldExceedChunkGroup([stored]) !== null) flushChunks();
        builder.addChunk(stored);
      }
      flushChunks();

      onPhase?.('publish');
      const result = this.publishStagedFile(inode, contentId, chunks.length);
      this.runContentMaintenanceSafely(1);
      return result;
    } catch (error) {
      this.activeStagingContentIds.delete(contentId);
      this.maintenancePending = true;
      this.runContentMaintenanceSafely(1);
      throw error;
    }
  }

  /**
   * Copy-on-write replacement for an over-limit range/truncate mutation.
   * Chunks are produced and staged one at a time, so the operation never
   * assembles the file as one BLOB or exceeds a Stage 2 transaction bound.
   */
  private replaceFileWithGeneratedContent(
    inode: BatchInodeEntry,
    chunkAt: (chunkId: number) => Uint8Array,
  ): { inodes: number; chunks: number } {
    this.validateInodeContentShape(inode);
    const contentId = this.beginStagedContent();
    let builder = new TransactionPlanBuilder();
    const flushChunks = (): void => {
      if (builder.empty) return;
      const plan = builder.build();
      builder = new TransactionPlanBuilder();
      this.executeStagedChunkPlan(plan);
    };
    try {
      for (let chunkId = 0; chunkId < inode.chunkCount; chunkId++) {
        const data = chunkAt(chunkId);
        const expected = Math.min(CHUNK_SIZE, inode.size - (chunkId * CHUNK_SIZE));
        if (data.byteLength !== expected) {
          throw new Error(
            `EIO: ${inode.path}: generated chunk ${chunkId} has ${data.byteLength} bytes; expected ${expected}`,
          );
        }
        const chunk: ContentChunkEntry = { path: inode.path, contentId, chunkId, data };
        if (builder.wouldExceedChunkGroup([chunk]) !== null) flushChunks();
        builder.addChunk(chunk);
      }
      flushChunks();
      const result = this.publishStagedFile(inode, contentId, inode.chunkCount);
      this.runContentMaintenanceSafely(1);
      return result;
    } catch (error) {
      this.activeStagingContentIds.delete(contentId);
      this.maintenancePending = true;
      this.runContentMaintenanceSafely(1);
      throw error;
    }
  }

  private beginStagedContent(): string {
    const contentId = this.createContentId();
    const builder = new TransactionPlanBuilder();
    builder.addStagingContent(contentId);
    const plan = builder.build();
    this.assertTransactionFits(plan.metrics);
    this.executeTransactionPlan(plan, { source: 'content-stage', limitMode: 'bounded' });
    this.activeStagingContentIds.add(contentId);
    return contentId;
  }

  private executeStagedChunkPlan(plan: TransactionPlan): void {
    this.assertTransactionFits(plan.metrics);
    this.executeTransactionPlan(plan, { source: 'content-stage', limitMode: 'bounded' });
  }

  private publishStagedFile(
    inode: BatchInodeEntry,
    contentId: string,
    publishedChunkCount: number,
  ): { inodes: number; chunks: number } {
    const prior = this.inodes.get(inode.path);
    const builder = new TransactionPlanBuilder();
    builder.addInode({ ...inode, contentId });
    builder.addPublishedContent(contentId);
    if (prior && !prior.isDir) builder.addGcContent(this.contentIdForInode(prior));
    const plan = builder.build();
    this.assertTransactionFits(plan.metrics);
    const result = this._writeBatchOnce(
      { payload: { inodes: [inode], chunks: [] }, plan, deletedInodes: [] },
      { source: 'content-publish', limitMode: 'bounded' },
      publishedChunkCount,
    );
    this.activeStagingContentIds.delete(contentId);
    return result;
  }

  /**
   * W7 v1 streamed bulk write. Storage publication is
   * path-atomic/committed-prefix: every reported group is durable and
   * complete, while an unpublished failing group contributes no progress.
   * Full-file chunks are staged in bounded transactions and exposed by one
   * inode-pointer transaction. Stage 4 adds the v2 framing and global-credit
   * protocol; this v1 consumer infers file completion from the declared
   * chunk count.
   */
  async writeStream(payload: {
    inodes: BatchInodeEntry[];
    chunkIter: AsyncIterable<BatchChunkEntry>;
    deletePaths?: string[];
    decodeDrainStartedAt?: number;
  }): Promise<WriteBatchStreamResult> {
    const decodeDrainStartedAt = payload.decodeDrainStartedAt ?? performance.now();
    const decodeDrainToken = {};
    this._decodeDrainStarts.set(decodeDrainToken, decodeDrainStartedAt);
    let decodeDrainFinished = false;
    let decodeDrainWaitMs = Math.max(0, performance.now() - decodeDrainStartedAt);
    let retainedSpoolBytes = 0;
    let chunkIterator: AsyncIterator<BatchChunkEntry> | null = null;
    let chunkIteratorFinished = false;
    const ownedStagingContentIds = new Set<string>();
    const progress: WriteBatchStreamProgress = {
      committedGroupSequence: 0,
      committedPathCount: 0,
      inodes: 0,
      chunks: 0,
    };
    let phase: WriteBatchStreamFailurePhase = 'decode';
    try {
      phase = 'validation';

      const normalizedInodes = new Map<string, BatchInodeEntry>();
      for (const inode of payload.inodes) {
        if (normalizedInodes.has(inode.path)) {
          throw new Error(`EINVAL: duplicate streamed inode path: ${inode.path}`);
        }
        normalizedInodes.set(inode.path, inode);
      }
      const files = new Map<string, {
        inode: BatchInodeEntry;
        contentId: string | null;
        receivedChunkIds: Set<number>;
        receivedBytes: number;
      }>();
      const publishedFiles = new Set<string>();
      for (const inode of normalizedInodes.values()) {
        this.validateInodeContentShape(inode);
        if (!inode.isDir && inode.chunkCount > 0) {
          files.set(inode.path, {
            inode,
            contentId: null,
            receivedChunkIds: new Set(),
            receivedBytes: 0,
          });
        }
      }

      let stageBuilder = new TransactionPlanBuilder();
      const beginStreamContent = (): string => {
        const contentId = this.beginStagedContent();
        ownedStagingContentIds.add(contentId);
        return contentId;
      };
      const flushStagedChunks = (): void => {
        if (stageBuilder.empty) return;
        const plan = stageBuilder.build();
        stageBuilder = new TransactionPlanBuilder();
        this.executeStagedChunkPlan(plan);
        this._writeStreamSpoolBytes -= plan.metrics.blobBytes;
        retainedSpoolBytes -= plan.metrics.blobBytes;
        this.updatePeakRetainedWriteBytes();
      };

      for (const path of payload.deletePaths ?? []) {
        phase = 'publish';
        const affected = Math.max(1, this.collectBatchDeletions([path]).length);
        this.writeBatch({ inodes: [], chunks: [], deletePaths: [path] });
        progress.committedGroupSequence++;
        progress.committedPathCount += affected;
      }
      for (const inode of normalizedInodes.values()) {
        if (!inode.isDir && inode.chunkCount !== 0) continue;
        phase = 'validation';
        this.validateFileChunks(inode, []);
        phase = inode.isDir ? 'publish' : 'stage';
        let result: { inodes: number; chunks: number };
        if (inode.isDir) {
          result = this.writeBatch({ inodes: [inode], chunks: [] });
        } else {
          const contentId = beginStreamContent();
          phase = 'publish';
          result = this.publishStagedFile(inode, contentId, 0);
        }
        progress.committedGroupSequence++;
        progress.committedPathCount++;
        progress.inodes += result.inodes;
        progress.chunks += result.chunks;
        if (!inode.isDir) publishedFiles.add(inode.path);
      }

      chunkIterator = payload.chunkIter[Symbol.asyncIterator]();
      while (true) {
        phase = 'decode';
        const waitStartedAt = performance.now();
        let next: IteratorResult<BatchChunkEntry>;
        try {
          next = await chunkIterator.next();
        } finally {
          decodeDrainWaitMs += performance.now() - waitStartedAt;
        }
        if (next.done) {
          chunkIteratorFinished = true;
          break;
        }
        const chunk = next.value;
        this._writeStreamSpoolBytes += chunk.data.byteLength;
        retainedSpoolBytes += chunk.data.byteLength;
        this._peakWriteStreamSpoolBytes = Math.max(
          this._peakWriteStreamSpoolBytes,
          this._writeStreamSpoolBytes,
        );
        this.updatePeakRetainedWriteBytes();

        phase = 'validation';
        const inode = normalizedInodes.get(chunk.path);
        if (!inode) throw new Error(`EINVAL: streamed chunk has no inode: ${chunk.path}`);
        if (inode.isDir) throw new Error(`EINVAL: directory stream entry has chunks: ${chunk.path}`);
        if (publishedFiles.has(chunk.path)) {
          throw new Error(`EINVAL: streamed file has chunks after publication: ${chunk.path}`);
        }
        if (!Number.isSafeInteger(chunk.chunkId)
          || chunk.chunkId < 0
          || chunk.chunkId >= inode.chunkCount) {
          throw new Error(`EINVAL: ${chunk.path}: chunk id ${chunk.chunkId} is out of range`);
        }
        const expectedBytes = Math.min(
          CHUNK_SIZE,
          inode.size - (chunk.chunkId * CHUNK_SIZE),
        );
        if (chunk.data.byteLength !== expectedBytes) {
          throw new Error(
            `EINVAL: ${chunk.path}: chunk ${chunk.chunkId} has ${chunk.data.byteLength} bytes; expected ${expectedBytes}`,
          );
        }
        const file = files.get(chunk.path);
        if (!file) {
          throw new Error(`EINVAL: streamed file has no pending content: ${chunk.path}`);
        }
        if (file.receivedChunkIds.has(chunk.chunkId)) {
          throw new Error(`EINVAL: ${chunk.path}: duplicate chunk ${chunk.chunkId}`);
        }
        phase = 'stage';
        if (file.contentId === null) file.contentId = beginStreamContent();
        const stored: ContentChunkEntry = { ...chunk, contentId: file.contentId };
        if (stageBuilder.wouldExceedChunkGroup([stored]) !== null) flushStagedChunks();
        stageBuilder.addChunk(stored);
        file.receivedChunkIds.add(chunk.chunkId);
        file.receivedBytes += chunk.data.byteLength;
        if (file.receivedChunkIds.size !== inode.chunkCount) {
          phase = 'decode';
          continue;
        }

        if (file.receivedBytes !== inode.size) {
          throw new Error(
            `EINVAL: ${inode.path}: chunk bytes ${file.receivedBytes} do not match size ${inode.size}`,
          );
        }
        flushStagedChunks();
        phase = 'publish';
        const result = this.publishStagedFile(inode, file.contentId, inode.chunkCount);
        publishedFiles.add(inode.path);
        files.delete(inode.path);
        progress.committedGroupSequence++;
        progress.committedPathCount++;
        progress.inodes += result.inodes;
        progress.chunks += result.chunks;
      }
      this._decodeDrainStarts.delete(decodeDrainToken);
      this.recordDuration(this._decodeDrainDuration, decodeDrainWaitMs);
      decodeDrainFinished = true;

      phase = 'validation';
      for (const [path, file] of files) {
        throw new Error(
          `EINVAL: ${path}: expected ${file.inode.chunkCount} chunks, got ${file.receivedChunkIds.size}`,
        );
      }
      return { ok: true, ...progress };
    } catch (error) {
      return {
        ok: false,
        ...progress,
        error: {
          code: 'ERR_WRITE_BATCH_STREAM',
          phase,
          message: this.errorMessage(error),
        },
      };
    } finally {
      if (!chunkIteratorFinished && chunkIterator?.return) {
        try { await chunkIterator.return(); } catch { /* preserve the primary stream result */ }
      }
      this._writeStreamSpoolBytes -= retainedSpoolBytes;
      if (this._writeStreamSpoolBytes < 0) this._writeStreamSpoolBytes = 0;
      if (!decodeDrainFinished) {
        this._decodeDrainStarts.delete(decodeDrainToken);
        this.recordDuration(this._decodeDrainDuration, decodeDrainWaitMs);
      }
      this.updatePeakRetainedWriteBytes();
      for (const contentId of ownedStagingContentIds) {
        if (this.activeStagingContentIds.has(contentId)) this.maintenancePending = true;
        this.activeStagingContentIds.delete(contentId);
      }
      this.runContentMaintenanceSafely(2);
    }
  }

  private _writeBatchWithRetry(
    payload: BatchWritePayload,
    execution: TransactionExecution,
    enforceLimits: boolean,
  ): { inodes: number; chunks: number } {
    if (enforceLimits) {
      const preflight = this.prepareBatchTransaction(payload, false);
      if (preflight.plan.metrics.sqlExecs === 0) return { inodes: 0, chunks: 0 };
      this.assertTransactionFits(preflight.plan.metrics);
    }
    const prepared = this.prepareBatchTransaction(payload, true);
    if (prepared.plan.metrics.sqlExecs === 0) return { inodes: 0, chunks: 0 };
    try {
      return this._writeBatchOnce(prepared, execution);
    } catch (error) {
      const cause = classifyError(error);
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
        message: this.errorMessage(error),
      });
      if (!this.isSqliteNoMem(error)) throw error;

      // Free clean cache pages, then retry the exact same indivisible
      // transaction once. Splitting a strict batch would publish a prefix
      // if a later half failed and would advance its revision more than once.
      this.evictAll();
      return this._writeBatchOnce(prepared, execution);
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

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private isSqliteNoMem(error: unknown): boolean {
    if (typeof error === 'object' && error !== null) {
      const code = (error as { code?: unknown }).code;
      if (code === 'SQLITE_NOMEM' || code === 7) return true;
    }
    return this.errorMessage(error).toUpperCase().includes('SQLITE_NOMEM');
  }

  private transactionSync(callback: () => void): void {
    if (!this.ctx?.storage?.transactionSync) {
      throw new Error('[sqlite-vfs] atomic storage operation requires transactionSync');
    }
    this.ctx.storage.transactionSync(callback);
  }

  private executeTransactionPlan(plan: TransactionPlan, execution: TransactionExecution): void {
    this.executeMeasuredTransaction(plan, execution, () => {
      for (const path of plan.deletedPaths) {
        this.sql.exec("DELETE FROM inodes WHERE path = ?", path);
      }

      for (let i = 0; i < plan.stagingContentIds.length; i += CONTENT_IDS_PER_SQL_EXEC) {
        const batch = plan.stagingContentIds.slice(i, i + CONTENT_IDS_PER_SQL_EXEC);
        const placeholders = batch.map(() => "(?, 'staging', ?)").join(',');
        const values: unknown[] = [];
        const createdAt = Date.now();
        for (const contentId of batch) values.push(contentId, createdAt);
        this.sql.exec(
          `INSERT INTO content_lifecycle (content_id, state, created_at) VALUES ${placeholders}`,
          ...values,
        );
      }

      for (let i = 0; i < plan.inodes.length; i += INODE_ROWS_PER_SQL_EXEC) {
        const batch = plan.inodes.slice(i, i + INODE_ROWS_PER_SQL_EXEC);
        const placeholders = batch.map(() => '(?,?,?,?,?,?,?,?,?)').join(',');
        const values: unknown[] = [];
        for (const inode of batch) {
          const atime = inode.atime !== undefined && Number.isFinite(inode.atime)
            ? inode.atime
            : inode.mtime;
          values.push(
            inode.path,
            inode.parentPath,
            inode.isDir ? 1 : 0,
            inode.size,
            atime,
            inode.mtime,
            inode.mode,
            inode.chunkCount,
            inode.contentId,
          );
        }
        this.sql.exec(
          `INSERT OR REPLACE INTO inodes (path, parent_path, is_dir, size, atime, mtime, mode, chunk_count, content_id) VALUES ${placeholders}`,
          ...values,
        );
      }

      for (let i = 0; i < plan.chunks.length; i += CHUNK_ROWS_PER_SQL_EXEC) {
        const batch = plan.chunks.slice(i, i + CHUNK_ROWS_PER_SQL_EXEC);
        const placeholders = batch.map(() => '(?,?,?)').join(',');
        const values: unknown[] = [];
        for (const chunk of batch) values.push(chunk.contentId, chunk.chunkId, chunk.data);
        this.sql.exec(
          `INSERT OR REPLACE INTO file_chunks (content_id, chunk_id, data) VALUES ${placeholders}`,
          ...values,
        );
      }

      const deletedChunksByContent = new Map<string, DeletedContentChunk[]>();
      for (const chunk of plan.deletedChunks) {
        const entries = deletedChunksByContent.get(chunk.contentId);
        if (entries) entries.push(chunk);
        else deletedChunksByContent.set(chunk.contentId, [chunk]);
      }
      for (const [contentId, chunks] of deletedChunksByContent) {
        for (let i = 0; i < chunks.length; i += CHUNK_ROWS_PER_SQL_EXEC) {
          const batch = chunks.slice(i, i + CHUNK_ROWS_PER_SQL_EXEC);
          const placeholders = batch.map(() => '?').join(',');
          this.sql.exec(
            `DELETE FROM file_chunks WHERE content_id = ? AND chunk_id IN (${placeholders})`,
            contentId,
            ...batch.map((chunk) => chunk.chunkId),
          );
        }
      }

      for (let i = 0; i < plan.publishedContentIds.length; i += CONTENT_IDS_PER_SQL_EXEC) {
        const batch = plan.publishedContentIds.slice(i, i + CONTENT_IDS_PER_SQL_EXEC);
        const placeholders = batch.map(() => '?').join(',');
        this.sql.exec(
          `DELETE FROM content_lifecycle WHERE content_id IN (${placeholders}) AND state = 'staging'`,
          ...batch,
        );
      }

      for (let i = 0; i < plan.gcContentIds.length; i += CONTENT_IDS_PER_SQL_EXEC) {
        const batch = plan.gcContentIds.slice(i, i + CONTENT_IDS_PER_SQL_EXEC);
        const placeholders = batch.map(() => "(?, 'gc', ?)").join(',');
        const values: unknown[] = [];
        const createdAt = Date.now();
        for (const contentId of batch) values.push(contentId, createdAt);
        this.sql.exec(
          `INSERT INTO content_lifecycle (content_id, state, created_at) VALUES ${placeholders}
           ON CONFLICT(content_id) DO UPDATE SET state = 'gc'`,
          ...values,
        );
      }
    });
    if (plan.gcContentIds.length > 0) this.maintenancePending = true;
  }

  private executeMeasuredTransaction(
    plan: TransactionPlan,
    execution: TransactionExecution,
    callback: () => void,
  ): void {
    if (this._activeTransaction !== null) {
      throw new Error('[sqlite-vfs] nested transaction plan execution is not supported');
    }
    const startedAt = performance.now();
    this._activeTransaction = { startedAt, plan, execution };
    try {
      this.transactionSync(callback);
    } finally {
      const durationMs = performance.now() - startedAt;
      this.recordDuration(this._transactionDuration, durationMs);
      this._transactionDurationSamples[this._transactionDurationSampleIndex] = durationMs;
      this._transactionDurationSampleIndex = (
        this._transactionDurationSampleIndex + 1
      ) % TRANSACTION_DURATION_SAMPLE_COUNT;
      this._transactionDurationSampleCount = Math.min(
        this._transactionDurationSampleCount + 1,
        TRANSACTION_DURATION_SAMPLE_COUNT,
      );
      this._transactionPeakBlobBytes = Math.max(
        this._transactionPeakBlobBytes,
        plan.metrics.blobBytes,
      );
      this._transactionPeakLogicalRows = Math.max(
        this._transactionPeakLogicalRows,
        plan.metrics.logicalRows,
      );
      this._transactionPeakSqlExecs = Math.max(
        this._transactionPeakSqlExecs,
        plan.metrics.sqlExecs,
      );
      this._transactionPeakAffectedPaths = Math.max(
        this._transactionPeakAffectedPaths,
        plan.metrics.affectedPaths,
      );
      if (execution.limitMode === 'bounded') {
        this._boundedTransactionPeakBlobBytes = Math.max(
          this._boundedTransactionPeakBlobBytes,
          plan.metrics.blobBytes,
        );
        this._boundedTransactionPeakLogicalRows = Math.max(
          this._boundedTransactionPeakLogicalRows,
          plan.metrics.logicalRows,
        );
        this._boundedTransactionPeakSqlExecs = Math.max(
          this._boundedTransactionPeakSqlExecs,
          plan.metrics.sqlExecs,
        );
      }
      this._lastTransaction = { metrics: plan.metrics, execution };
      this._activeTransaction = null;
    }
  }

  /**
   * Bounded, idempotent content maintenance. Age only orders work; durable
   * reference checks in each mutation transaction are the deletion authority.
   */
  runContentMaintenance(maxTransactions = 4): { transactions: number } {
    let transactions = 0;
    const maximum = clampNonNegativeInt(maxTransactions);
    let orphanScanComplete = true;
    let stagingScanComplete = true;

    if (transactions < maximum) {
      const orphanRows = [...this.sql.exec(
        `SELECT chunks.content_id
         FROM file_chunks AS chunks
         WHERE NOT EXISTS (
             SELECT 1 FROM content_lifecycle AS lifecycle
             WHERE lifecycle.content_id = chunks.content_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM inodes
             WHERE inodes.is_dir = 0
               AND COALESCE(inodes.content_id, inodes.path) = chunks.content_id
           )
         GROUP BY chunks.content_id
         ORDER BY chunks.content_id
         LIMIT ?`,
        CONTENT_IDS_PER_SQL_EXEC,
      )];
      orphanScanComplete = orphanRows.length < CONTENT_IDS_PER_SQL_EXEC;
      const contentIds = orphanRows.map((row) => String(row.content_id));
      if (contentIds.length > 0) {
        const candidates = contentIds
          .map((_, index) => index === 0 ? 'SELECT ? AS content_id' : 'SELECT ?')
          .join(' UNION ALL ');
        const plan = this.metricsOnlyPlan({
          blobBytes: 0,
          logicalRows: contentIds.length,
          sqlExecs: 1,
          affectedPaths: 0,
        });
        this.executeMeasuredTransaction(
          plan,
          { source: 'content-gc', limitMode: 'bounded' },
          () => {
            this.sql.exec(
              `INSERT OR IGNORE INTO content_lifecycle (content_id, state, created_at)
               SELECT candidate.content_id, 'gc', ?
               FROM (${candidates}) AS candidate
               WHERE EXISTS (
                   SELECT 1 FROM file_chunks
                   WHERE file_chunks.content_id = candidate.content_id
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM inodes
                   WHERE inodes.is_dir = 0
                     AND COALESCE(inodes.content_id, inodes.path) = candidate.content_id
                 )`,
              Date.now(),
              ...contentIds,
            );
          },
        );
        transactions++;
      }
    }

    if (transactions < maximum) {
      const stagingRows = [...this.sql.exec(
        `SELECT lifecycle.content_id
         FROM content_lifecycle AS lifecycle
         WHERE lifecycle.state = 'staging'
           AND NOT EXISTS (
             SELECT 1 FROM inodes
             WHERE inodes.is_dir = 0
               AND COALESCE(inodes.content_id, inodes.path) = lifecycle.content_id
           )
         ORDER BY lifecycle.created_at, lifecycle.content_id
         LIMIT ?`,
        CONTENT_IDS_PER_SQL_EXEC,
      )];
      stagingScanComplete = stagingRows.length < CONTENT_IDS_PER_SQL_EXEC;
      const contentIds = stagingRows
        .map((row) => String(row.content_id))
        .filter((contentId) => !this.activeStagingContentIds.has(contentId));
      if (contentIds.length > 0) {
        const placeholders = contentIds.map(() => '?').join(',');
        const plan = this.metricsOnlyPlan({
          blobBytes: 0,
          logicalRows: contentIds.length,
          sqlExecs: 1,
          affectedPaths: 0,
        });
        this.executeMeasuredTransaction(
          plan,
          { source: 'content-gc', limitMode: 'bounded' },
          () => {
            this.sql.exec(
              `UPDATE content_lifecycle AS lifecycle
               SET state = 'gc'
               WHERE lifecycle.state = 'staging'
                 AND lifecycle.content_id IN (${placeholders})
                 AND NOT EXISTS (
                   SELECT 1 FROM inodes
                   WHERE inodes.is_dir = 0
                     AND COALESCE(inodes.content_id, inodes.path) = lifecycle.content_id
                 )`,
              ...contentIds,
            );
          },
        );
        transactions++;
      }
    }

    while (transactions < maximum) {
      const lifecycle = [...this.sql.exec(
        `SELECT lifecycle.content_id
         FROM content_lifecycle AS lifecycle
         WHERE lifecycle.state = 'gc'
           AND NOT EXISTS (
             SELECT 1 FROM inodes
             WHERE inodes.is_dir = 0
               AND COALESCE(inodes.content_id, inodes.path) = lifecycle.content_id
           )
         ORDER BY lifecycle.created_at, lifecycle.content_id
         LIMIT 1`,
      )];
      if (lifecycle.length === 0) break;
      const contentId = String(lifecycle[0].content_id);
      const candidates = [...this.sql.exec(
        `SELECT chunk_id, length(data) AS byte_length
         FROM file_chunks
         WHERE content_id = ?
         ORDER BY chunk_id
         LIMIT ?`,
        contentId,
        Math.min(MAX_TX_LOGICAL_ROWS - 1, CHUNK_ROWS_PER_SQL_EXEC),
      )];
      const chunkIds: number[] = [];
      let blobBytes = 0;
      for (const row of candidates) {
        const byteLength = clampNonNegativeInt(Number(row.byte_length));
        if (chunkIds.length > 0 && blobBytes + byteLength > MAX_TX_BLOB_BYTES) break;
        chunkIds.push(clampNonNegativeInt(Number(row.chunk_id)));
        blobBytes += byteLength;
      }
      const plan = this.metricsOnlyPlan({
        blobBytes,
        logicalRows: chunkIds.length + 1,
        sqlExecs: chunkIds.length === 0 ? 1 : 2,
        affectedPaths: 0,
      });
      this.assertTransactionFits(plan.metrics);
      this.executeMeasuredTransaction(
        plan,
        { source: 'content-gc', limitMode: 'bounded' },
        () => {
          if (chunkIds.length > 0) {
            const placeholders = chunkIds.map(() => '?').join(',');
            this.sql.exec(
              `DELETE FROM file_chunks
               WHERE content_id = ?
                 AND chunk_id IN (${placeholders})
                 AND EXISTS (
                   SELECT 1 FROM content_lifecycle
                   WHERE content_lifecycle.content_id = ?
                     AND content_lifecycle.state = 'gc'
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM inodes
                   WHERE inodes.is_dir = 0
                     AND COALESCE(inodes.content_id, inodes.path) = ?
                 )`,
              contentId,
              ...chunkIds,
              contentId,
              contentId,
            );
          }
          this.sql.exec(
            `DELETE FROM content_lifecycle AS lifecycle
             WHERE lifecycle.content_id = ?
               AND lifecycle.state = 'gc'
               AND NOT EXISTS (
                 SELECT 1 FROM inodes
                 WHERE inodes.is_dir = 0
                   AND COALESCE(inodes.content_id, inodes.path) = lifecycle.content_id
               )
               AND NOT EXISTS (
                 SELECT 1 FROM file_chunks
                 WHERE file_chunks.content_id = lifecycle.content_id
               )`,
            contentId,
          );
        },
      );
      transactions++;
    }
    if (maximum > 0) {
      const hasGcBacklog = transactions >= maximum && [...this.sql.exec(
        `SELECT 1
         FROM content_lifecycle AS lifecycle
         WHERE lifecycle.state = 'gc'
           AND NOT EXISTS (
             SELECT 1 FROM inodes
             WHERE inodes.is_dir = 0
               AND COALESCE(inodes.content_id, inodes.path) = lifecycle.content_id
           )
         LIMIT 1`,
      )].length > 0;
      this.maintenancePending = !orphanScanComplete || !stagingScanComplete || hasGcBacklog;
    }
    return { transactions };
  }

  private runContentMaintenanceSafely(maxTransactions: number, force = false): void {
    if (!force && !this.maintenancePending) return;
    try {
      this.runContentMaintenance(maxTransactions);
    } catch (error) {
      this.maintenancePending = true;
      console.error('[sqlite-vfs] content maintenance failed:', this.errorMessage(error));
    }
  }

  private metricsOnlyPlan(metrics: TransactionPlanMetrics): TransactionPlan {
    return {
      inodes: [],
      chunks: [],
      deletedChunks: [],
      deletedPaths: [],
      stagingContentIds: [],
      publishedContentIds: [],
      gcContentIds: [],
      affectedPaths: new Set(),
      metrics,
    };
  }

  private recordOverLimitFile(
    path: string,
    limit: TransactionLimit,
    metrics: TransactionPlanMetrics,
  ): void {
    this._overLimitFileCount++;
    this._lastOverLimitFile = { path, limit, ...metrics };
  }

  private recordDuration(summary: DurationSummary, durationMs: number): void {
    summary.count++;
    summary.totalMs += durationMs;
    summary.lastMs = durationMs;
    summary.maxMs = Math.max(summary.maxMs, durationMs);
  }

  private updatePeakRetainedWriteBytes(): void {
    this._peakRetainedWriteBytes = Math.max(
      this._peakRetainedWriteBytes,
      this.currentRetainedWriteBytes(),
    );
  }

  private currentRetainedWriteBytes(): number {
    return this._writeStreamSpoolBytes;
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

  private prepareBatchTransaction(
    payload: BatchWritePayload,
    allocateContentIds: boolean,
  ): PreparedBatchTransaction {
    const deletedInodes = this.collectBatchDeletions(payload.deletePaths ?? []);
    const deletedInodesByPath = new Map(deletedInodes.map((inode) => [inode.path, inode]));
    const builder = new TransactionPlanBuilder();
    const deletedPaths = new Set(payload.deletePaths ?? []);
    for (const inode of deletedInodes) deletedPaths.add(inode.path);
    for (const path of deletedPaths) {
      const inode = deletedInodesByPath.get(path);
      builder.addDeletedPath(path, inode);
      if (inode && !inode.isDir) builder.addGcContent(this.contentIdForInode(inode));
    }

    const normalizedInodes = new Map<string, BatchInodeEntry>();
    for (const entry of payload.inodes) normalizedInodes.set(entry.path, entry);
    const chunksByPath = new Map<string, BatchChunkEntry[]>();
    for (const chunk of payload.chunks) {
      const entries = chunksByPath.get(chunk.path);
      if (entries) entries.push(chunk);
      else chunksByPath.set(chunk.path, [chunk]);
    }

    const contentIds = new Map<string, string>();
    const reservedContentIds = allocateContentIds ? new Set<string>() : undefined;
    let preflightContentIndex = 0;
    for (const entry of normalizedInodes.values()) {
      const prior = this.inodes.get(entry.path);
      this.validateInodeContentShape(entry);
      if (entry.isDir) {
        if ((chunksByPath.get(entry.path)?.length ?? 0) > 0) {
          throw new Error(`EINVAL: directory batch entry has chunks: ${entry.path}`);
        }
        builder.addInode({ ...entry, contentId: null });
      } else {
        const fileChunks = chunksByPath.get(entry.path) ?? [];
        this.validateFileChunks(entry, fileChunks);
        const contentId = allocateContentIds
          ? this.createContentId(reservedContentIds)
          : `preflight:${preflightContentIndex++}`;
        contentIds.set(entry.path, contentId);
        builder.addStagingContent(contentId);
        builder.addInode({ ...entry, contentId });
        builder.addPublishedContent(contentId);
      }
      if (prior && !prior.isDir) builder.addGcContent(this.contentIdForInode(prior));
    }

    for (const entry of payload.chunks) {
      const contentId = contentIds.get(entry.path)
        ?? (() => {
          const inode = this.inodes.get(entry.path);
          if (!inode || inode.isDir) throw new Error(`EINVAL: chunk has no file inode: ${entry.path}`);
          return this.contentIdForInode(inode);
        })();
      builder.addChunk({ ...entry, contentId });
    }
    return { payload, plan: builder.build(), deletedInodes };
  }

  private validateFileChunks(inode: BatchInodeEntry, chunks: readonly BatchChunkEntry[]): void {
    this.validateInodeContentShape(inode);
    if (inode.chunkCount !== chunks.length) {
      throw new Error(
        `EINVAL: ${inode.path}: expected ${inode.chunkCount} chunks, got ${chunks.length}`,
      );
    }
    let total = 0;
    const ordered = [...chunks].sort((a, b) => a.chunkId - b.chunkId);
    for (let index = 0; index < ordered.length; index++) {
      const chunk = ordered[index];
      if (chunk.chunkId !== index) {
        throw new Error(`EINVAL: ${inode.path}: expected chunk ${index}, got ${chunk.chunkId}`);
      }
      const expected = Math.min(CHUNK_SIZE, inode.size - (index * CHUNK_SIZE));
      if (chunk.data.byteLength !== expected) {
        throw new Error(
          `EINVAL: ${inode.path}: chunk ${index} has ${chunk.data.byteLength} bytes; expected ${expected}`,
        );
      }
      total += chunk.data.byteLength;
    }
    if (total !== inode.size) {
      throw new Error(`EINVAL: ${inode.path}: chunk bytes ${total} do not match size ${inode.size}`);
    }
  }

  private validateInodeContentShape(inode: BatchInodeEntry): void {
    if (!Number.isSafeInteger(inode.size) || inode.size < 0) {
      throw new Error(`EINVAL: ${inode.path}: invalid size ${inode.size}`);
    }
    if (!Number.isSafeInteger(inode.chunkCount) || inode.chunkCount < 0) {
      throw new Error(`EINVAL: ${inode.path}: invalid chunk count ${inode.chunkCount}`);
    }
    if (inode.isDir && inode.size !== 0) {
      throw new Error(`EINVAL: ${inode.path}: directory size must be zero`);
    }
    const expectedChunkCount = inode.isDir || inode.size === 0
      ? 0
      : Math.ceil(inode.size / CHUNK_SIZE);
    if (inode.chunkCount !== expectedChunkCount) {
      throw new Error(
        `EINVAL: ${inode.path}: expected ${expectedChunkCount} chunks for ${inode.size} bytes, got ${inode.chunkCount}`,
      );
    }
  }

  private assertTransactionFits(metrics: TransactionPlanMetrics): void {
    const limit = exceededTransactionLimit(metrics);
    if (limit === null) return;
    const maximum = limit === 'blobBytes'
      ? MAX_TX_BLOB_BYTES
      : limit === 'logicalRows'
        ? MAX_TX_LOGICAL_ROWS
        : MAX_TX_SQL_EXECS;
    throw new SqliteVfsTransactionTooLargeError(limit, metrics[limit], maximum, metrics);
  }

  private _writeBatchOnce(
    prepared: PreparedBatchTransaction,
    execution: TransactionExecution,
    publishedChunkCount?: number,
  ): { inodes: number; chunks: number } {
    const { payload, plan, deletedInodes } = prepared;
    try {
      this.executeTransactionPlan(plan, execution);
    } catch (error) {
      console.error('[sqlite-vfs] writeBatch failed:', this.errorMessage(error));
      throw error;
    }

    const postCommitStartedAt = performance.now();
    // Durable commit succeeded. Only now may this operation supersede cached
    // data on the same paths.
    this.cacheInvalidateBatch(plan.affectedPaths);

    // 4. Publish the recursive deletions, then inode replacements.
    for (const inode of deletedInodes) {
      this._removeFromChildrenIndex(inode.parentPath, inode.path);
      this.children.delete(inode.path);
      this.inodes.delete(inode.path);
      if (inode.isDir) {
        this._totalDirs--;
      } else {
        this._totalFiles--;
        this._usedBytes -= inode.size;
      }
    }

    // Update in-memory inode tree + children index (outside transaction — fast).
    //    B3: also maintain running counters in sync. For each payload entry,
    //    compute the delta against any pre-existing inode at that path.
    //
    // OUTSIDE the `prior === undefined` guard. Pre-W2.5a, ~37 of 46 packages
    // per `npm install fastify` accumulated inodes in SQL but never reached
    // the in-memory `this.children` index because some path's `prior` was
    // unexpectedly defined when the package's writeBatch arrived (root
    // cause unidentified — see §4.2 diagnostic plan in W2.5-plan.md).
    // `_addToChildrenIndex` uses Set.add so repeated calls are idempotent;
    // gating it on `prior === undefined` was the bug. Counters remain
    // gated correctly so they don't double-count.
    const __diag = ((globalThis as any).process?.env?.NIMBUS_DIAG_INSTALL_PIPELINE === '1');
    const replacedPaths = new Set<string>();
    for (const entry of plan.inodes) {
      const prior = this.inodes.get(entry.path);
      if (prior !== undefined) replacedPaths.add(entry.path);
      const atime = entry.atime !== undefined && Number.isFinite(entry.atime) ? entry.atime : entry.mtime;
      const node: INode = {
        path: entry.path,
        parentPath: entry.parentPath,
        isDir: entry.isDir,
        size: entry.size,
        atime,
        mtime: entry.mtime,
        mode: entry.mode,
        chunkCount: entry.chunkCount,
        contentId: entry.contentId,
      };
      if (prior && prior.parentPath !== entry.parentPath) {
        this._removeFromChildrenIndex(prior.parentPath, entry.path);
      }
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
    const inodeCount = plan.inodes.length;
    const chunkCount = publishedChunkCount ?? plan.chunks.length;
    this._sqlWrites += inodeCount + chunkCount;
    this._batchWrites++;
    this._batchWriteRows += inodeCount + chunkCount;
    if (inodeCount > 0 || chunkCount > 0 || plan.deletedPaths.length > 0) {
      // One clock tick for the whole batch; stamp every touched path
      // (affectedPaths covers files/chunks/deletes; add dir inodes too).
      const touched = new Set<string>(plan.affectedPaths);
      for (const entry of plan.inodes) touched.add(entry.path);
      this.bumpRevision(Array.from(touched));
    }

    // 5. Events observe the already-published metadata and revision.
    for (const inode of deletedInodes) {
      this.events.emit(inode.isDir ? 'unlinkDir' : 'unlink', inode.path);
    }
    for (const entry of plan.inodes) {
      this.events.emit(entry.isDir ? 'addDir' : replacedPaths.has(entry.path) ? 'change' : 'add', entry.path);
    }

    this.recordDuration(this._postCommitDuration, performance.now() - postCommitStartedAt);
    this.updatePeakRetainedWriteBytes();

    return { inodes: inodeCount, chunks: chunkCount };
  }

  private collectBatchDeletions(deletePaths: readonly string[]): INode[] {
    if (deletePaths.length === 0) return [];
    const roots = new Set(deletePaths);
    const deleted: INode[] = [];
    for (const inode of this.inodes.values()) {
      for (const root of roots) {
        if (inode.path === root || inode.path.startsWith(`${root}/`)) {
          deleted.push(inode);
          break;
        }
      }
    }
    return deleted.sort((a, b) => b.path.length - a.path.length);
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
    const now = performance.now();
    const activeTransactionDuration = this._activeTransaction === null
      ? 0
      : now - this._activeTransaction.startedAt;
    let activeDecodeDrainDuration = 0;
    for (const startedAt of this._decodeDrainStarts.values()) {
      activeDecodeDrainDuration += now - startedAt;
    }
    const activeMetrics = this._activeTransaction?.plan.metrics ?? null;

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
        // Live bytes retained by writeStream() for files that have not yet
        // reached their declared v1 chunk count. Stage 4 adds explicit v2
        // file framing and cross-stream global-credit backpressure.
        writeStreamSpoolBytes: this._writeStreamSpoolBytes,
        retainedWriteBytes: {
          current: this.currentRetainedWriteBytes(),
          peak: this._peakRetainedWriteBytes,
        },
        decoderRetainedBytes: {
          current: this._writeStreamSpoolBytes,
          peak: this._peakWriteStreamSpoolBytes,
        },
        creditRetainedBytes: { current: 0, peak: 0 },
        stagedBytes: { current: 0, peak: 0 },
        gcBytes: { current: 0, peak: 0 },
        phases: {
          decodeDrainWaitMs: durationSnapshot(
            this._decodeDrainDuration,
            activeDecodeDrainDuration,
          ),
          creditWaitMs: durationSnapshot(emptyDurationSummary(), 0),
        },
        transactions: {
          limits: {
            blobBytes: MAX_TX_BLOB_BYTES,
            logicalRows: MAX_TX_LOGICAL_ROWS,
            sqlExecs: MAX_TX_SQL_EXECS,
          },
          active: this._activeTransaction !== null,
          durationMs: {
            ...durationSnapshot(this._transactionDuration, activeTransactionDuration),
            p95: recentPercentile(
              this._transactionDurationSamples,
              this._transactionDurationSampleCount,
              0.95,
            ),
          },
          postCommitDurationMs: durationSnapshot(this._postCommitDuration, 0),
          blobBytes: {
            current: activeMetrics?.blobBytes ?? 0,
            last: this._lastTransaction?.metrics.blobBytes ?? 0,
            peak: this._transactionPeakBlobBytes,
          },
          logicalRows: {
            current: activeMetrics?.logicalRows ?? 0,
            last: this._lastTransaction?.metrics.logicalRows ?? 0,
            peak: this._transactionPeakLogicalRows,
          },
          sqlExecs: {
            current: activeMetrics?.sqlExecs ?? 0,
            last: this._lastTransaction?.metrics.sqlExecs ?? 0,
            peak: this._transactionPeakSqlExecs,
          },
          affectedPaths: {
            current: activeMetrics?.affectedPaths ?? 0,
            last: this._lastTransaction?.metrics.affectedPaths ?? 0,
            peak: this._transactionPeakAffectedPaths,
          },
          boundedPeak: {
            blobBytes: this._boundedTransactionPeakBlobBytes,
            logicalRows: this._boundedTransactionPeakLogicalRows,
            sqlExecs: this._boundedTransactionPeakSqlExecs,
          },
          last: this._lastTransaction === null
            ? null
            : {
                ...this._lastTransaction.metrics,
                ...this._lastTransaction.execution,
              },
          overLimitFiles: {
            count: this._overLimitFileCount,
            last: this._lastOverLimitFile,
          },
        },
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

function emptyDurationSummary(): DurationSummary {
  return { count: 0, totalMs: 0, lastMs: 0, maxMs: 0 };
}

function durationSnapshot(summary: DurationSummary, current: number) {
  return {
    current,
    count: summary.count,
    total: summary.totalMs,
    last: summary.lastMs,
    max: summary.maxMs,
  };
}

function recentPercentile(samples: Float64Array, count: number, percentile: number): number {
  if (count === 0) return 0;
  const sorted = Array.from(samples.subarray(0, count)).sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * percentile) - 1);
  return sorted[index] ?? 0;
}

function clampNonNegativeInt(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
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
