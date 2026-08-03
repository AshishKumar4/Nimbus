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
import { normalizeVfsPath } from './path.js';
import { CHUNK_SIZE, LRU_MAX_ENTRIES, MAX_TX_BLOB_BYTES, MAX_TX_LOGICAL_ROWS, MAX_TX_SQL_EXECS, MAX_GLOBAL_WRITE_STREAM_CREDIT_BYTES, } from '../constants.js';
import { recordFailure } from '../observability/oom-discriminator.js';
import { classifyError } from '../observability/oom-classify.js';
import { acquireSupervisorAllocation } from '../observability/heavy-alloc-coord.js';
import { enc, dec } from '../_shared/bytes.js';
import { decodeWriteBatchStream, } from '../_shared/w7-frame.js';
import { WeightedCreditPool, } from '../_shared/weighted-credit-pool.js';
import { LEGACY_SYMLINK_REGISTRY_PATH } from './symlink-registry.js';
import { CRED_KERNEL } from '../runtime/os-contracts.js';
const CONTENT_ID_ALLOCATION_ATTEMPTS = 8;
const INODE_ROWS_PER_SQL_EXEC = 9;
const CHUNK_ROWS_PER_SQL_EXEC = 33;
const CONTENT_IDS_PER_SQL_EXEC = 50;
const TRANSACTION_DURATION_SAMPLE_COUNT = 128;
const CONTENT_SCHEMA_MIGRATION = 'content_generations_v1';
export const VFS_APPEND_RECEIPT_LIMIT = 2048;
const INODE_KIND_FILE = 0;
const INODE_KIND_DIRECTORY = 1;
const INODE_KIND_SYMLINK = 2;
function withCommitRowMetrics(metrics) {
    return {
        ...metrics,
        logicalRows: metrics.logicalRows + 1,
        sqlExecs: metrics.sqlExecs + 1,
    };
}
const VFS_APPEND_INCARNATION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function assertAppendIncarnation(value, kind) {
    if (!VFS_APPEND_INCARNATION_PATTERN.test(value)) {
        throw vfsError('EINVAL', `invalid append ${kind} incarnation`);
    }
}
export class SqliteVfsTransactionTooLargeError extends Error {
    limit;
    actual;
    maximum;
    metrics;
    code = 'E2BIG';
    constructor(limit, actual, maximum, metrics) {
        super(`[sqlite-vfs] transaction exceeds ${limit} limit: ${actual} > ${maximum}`);
        this.limit = limit;
        this.actual = actual;
        this.maximum = maximum;
        this.metrics = metrics;
        this.name = 'SqliteVfsTransactionTooLargeError';
    }
}
class TransactionPlanBuilder {
    inodes = [];
    chunks = [];
    deletedChunks = [];
    deletedPaths = new Set();
    stagingContentIds = new Set();
    publishedContentIds = new Set();
    gcContentIds = new Set();
    affectedPaths = new Set();
    deletedInodePaths = new Set();
    blobBytes = 0;
    deletedInodeRows = 0;
    addInode(entry) {
        this.inodes.push(entry);
        this.affectedPaths.add(entry.path);
    }
    addChunk(entry) {
        this.chunks.push(entry);
        this.blobBytes += entry.data.byteLength;
        this.affectedPaths.add(entry.path);
    }
    addChunkGroup(entries) {
        for (const entry of entries)
            this.addChunk(entry);
    }
    addDeletedChunk(entry) {
        this.deletedChunks.push(entry);
        this.blobBytes += entry.byteLength;
        this.affectedPaths.add(entry.path);
    }
    addDeletedPath(path, inode) {
        this.deletedPaths.add(path);
        this.affectedPaths.add(path);
        if (inode && !this.deletedInodePaths.has(inode.path)) {
            this.deletedInodePaths.add(inode.path);
            this.deletedInodeRows++;
        }
    }
    addStagingContent(contentId) {
        this.stagingContentIds.add(contentId);
    }
    addPublishedContent(contentId) {
        this.publishedContentIds.add(contentId);
    }
    addGcContent(contentId) {
        this.gcContentIds.add(contentId);
    }
    wouldExceedChunkGroup(entries) {
        let additionalBlobBytes = 0;
        for (const entry of entries)
            additionalBlobBytes += entry.data.byteLength;
        return this.wouldExceedChunks(additionalBlobBytes, entries.length);
    }
    wouldExceedChunks(additionalBlobBytes, additionalRows = 1) {
        return exceededTransactionLimit({
            blobBytes: this.blobBytes + additionalBlobBytes,
            logicalRows: this.logicalRows + additionalRows,
            sqlExecs: this.fixedSqlExecs
                + groupedSqlExecs(this.inodes.length, INODE_ROWS_PER_SQL_EXEC)
                + groupedSqlExecs(this.chunks.length + additionalRows, CHUNK_ROWS_PER_SQL_EXEC),
            affectedPaths: this.affectedPaths.size,
        });
    }
    get empty() {
        return this.inodes.length === 0
            && this.chunks.length === 0
            && this.deletedChunks.length === 0
            && this.deletedPaths.size === 0
            && this.stagingContentIds.size === 0
            && this.publishedContentIds.size === 0
            && this.gcContentIds.size === 0;
    }
    build() {
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
    get logicalRows() {
        return this.inodes.length
            + this.chunks.length
            + this.deletedChunks.length
            + this.deletedInodeRows
            + this.stagingContentIds.size
            + this.publishedContentIds.size
            + this.gcContentIds.size;
    }
    get fixedSqlExecs() {
        return this.deletedPaths.size
            + groupedSqlExecs(this.stagingContentIds.size, CONTENT_IDS_PER_SQL_EXEC)
            + groupedSqlExecs(this.publishedContentIds.size, CONTENT_IDS_PER_SQL_EXEC)
            + groupedSqlExecs(this.gcContentIds.size, CONTENT_IDS_PER_SQL_EXEC);
    }
    get deletedChunkSqlExecs() {
        const byContent = new Map();
        for (const chunk of this.deletedChunks) {
            byContent.set(chunk.contentId, (byContent.get(chunk.contentId) ?? 0) + 1);
        }
        let sqlExecs = 0;
        for (const count of byContent.values()) {
            sqlExecs += groupedSqlExecs(count, CHUNK_ROWS_PER_SQL_EXEC);
        }
        return sqlExecs;
    }
    get metrics() {
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
function groupedSqlExecs(rows, rowsPerExec) {
    return rows === 0 ? 0 : Math.ceil(rows / rowsPerExec);
}
function exceededTransactionLimit(metrics) {
    if (metrics.blobBytes > MAX_TX_BLOB_BYTES)
        return 'blobBytes';
    if (metrics.logicalRows > MAX_TX_LOGICAL_ROWS)
        return 'logicalRows';
    if (metrics.sqlExecs > MAX_TX_SQL_EXECS)
        return 'sqlExecs';
    return null;
}
// ── SqliteVFS ───────────────────────────────────────────────────────────────
export class SqliteVFS {
    sql;
    ctx;
    events;
    // ── INode tree (always resident) ──────────────────────────────────────
    inodes = new Map();
    /** Children index: parentPath → Set of child paths. O(1) readdir. */
    children = new Map();
    // ── Content cache (LRU, 512 × 64KB = 32MB) ───────────────────────────
    // Map iteration order = insertion order. Delete+re-insert to move to MRU.
    cache = new Map();
    /** Actual bytes in cache (not all chunks are full 64KB) */
    _cacheBytes = 0;
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
    _lruMaxEntries = LRU_MAX_ENTRIES;
    _lruShrinkRefcount = 0;
    // ── Running counters for O(1) getStats() (B3 / AUDIT M10 / M-S8) ──
    // Replaces the triple scan of this.inodes on every /api/stats poll.
    // Bootstrapped in loadInodes(); maintained at every mutator entry:
    //   mkdir/rmdir/writeFile/unlink/writeBatch (rename is a no-op —
    //   same inode, new path). Invariant: these match a fresh O(N)
    //   walk of this.inodes. Unit-tested in the A5/B3 runtime tests.
    _totalFiles = 0;
    _totalDirs = 0;
    _usedBytes = 0;
    _revision = 0;
    // ── Per-path revisions ────────────────────────────────────────────────
    // _revision is the monotonic mutation clock. Every mutation stamps the
    // mutated path AND each of its ancestors with the clock value, so
    // revision(dir) is a subtree watermark: it changes iff something under
    // dir changed. Consumers (runtime snapshot caches, page caches, handle
    // staleness checks) key on revision(path) instead of the global clock,
    // so unrelated writes no longer invalidate them. In-memory only — the
    // clock resets with the DO lifetime, exactly like the caches keyed on it.
    _pathRevisions = new Map();
    // ── Invalidation log (facet cache coherence) ──────────────────────────
    // A facet's resident set is a cache of this VFS, and it learns what to
    // drop by asking `invalidatedSince(cursor)` for the delta. _pathRevisions
    // cannot serve that: it answers "what is the watermark under here", not
    // "what changed since when".
    //
    // _epoch exists because _revision is in-memory and restarts at 0 with the
    // DO, while a facet outlives supervisor restarts. A bare revision compare
    // fails OPEN across one: a facet holding cursor N sees the clock reset,
    // N further writes land, and `rev === cursor` reads as "nothing changed"
    // while every byte it holds is stale. Classic ABA, in the one direction
    // this protocol may never fail in. An epoch never recurs, so the pair is
    // globally monotonic. Supervisor DO resets are an observed event here,
    // not a hypothetical.
    _epoch = crypto.randomUUID();
    _invalidations = [];
    static INVALIDATION_LOG_MAX = 8192;
    /** Identifies this supervisor incarnation. Never reused across restarts. */
    get epoch() { return this._epoch; }
    exclusiveMutationLeases = new Map();
    activeMutationOwner = null;
    /** Shared by every concurrent stream targeting this session's VFS. */
    writeStreamCredits = new WeightedCreditPool(MAX_GLOBAL_WRITE_STREAM_CREDIT_BYTES);
    _stagedStreamBytes = 0;
    _peakStagedStreamBytes = 0;
    /** In-memory liveness only; content_lifecycle remains durable ownership. */
    activeStagingContentIds = new Set();
    /** True only while durable GC work or a known abandoned staging row exists. */
    maintenancePending = false;
    // Stage 2 transaction/phase telemetry. Scalar writes stay cheap; the
    // percentile is computed from the fixed ring only when diagnostics read it.
    _activeTransaction = null;
    _transactionDuration = emptyDurationSummary();
    _postCommitDuration = emptyDurationSummary();
    _decodeDrainDuration = emptyDurationSummary();
    _creditWaitDuration = emptyDurationSummary();
    /** Whole content-maintenance runs, including the raw scans that execute
     * outside executeMeasuredTransaction; count doubles as the run counter. */
    _maintenanceDuration = emptyDurationSummary();
    _transactionDurationSamples = new Float64Array(TRANSACTION_DURATION_SAMPLE_COUNT);
    _transactionDurationSampleCount = 0;
    _transactionDurationSampleIndex = 0;
    _decodeDrainStarts = new Map();
    _creditWaitStarts = new Map();
    _transactionPeakBlobBytes = 0;
    _transactionPeakLogicalRows = 0;
    _transactionPeakSqlExecs = 0;
    _transactionPeakAffectedPaths = 0;
    _boundedTransactionPeakBlobBytes = 0;
    _boundedTransactionPeakLogicalRows = 0;
    _boundedTransactionPeakSqlExecs = 0;
    _lastTransaction = null;
    _overLimitFileCount = 0;
    _lastOverLimitFile = null;
    // ── Stats ─────────────────────────────────────────────────────────────
    _cacheHits = 0;
    _cacheMisses = 0;
    _evictions = 0;
    _sqlReads = 0;
    _sqlWrites = 0;
    _batchWrites = 0;
    _batchWriteRows = 0;
    constructor(sql, ctx) {
        this.sql = sql;
        this.ctx = ctx;
        this.events = new VfsEventEmitter();
        this.initSchema();
        this.resumeAppendMaintenance();
        this.loadInodes();
        this.runContentMaintenanceSafely(2, true);
    }
    // ── Schema ────────────────────────────────────────────────────────────
    initSchema() {
        this.transactionSync(() => {
            this.sql.exec(`CREATE TABLE IF NOT EXISTS vfs_schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )`);
            this.sql.exec(`CREATE TABLE IF NOT EXISTS vfs_append_receipts (
        pid INTEGER NOT NULL,
        writer_id TEXT NOT NULL,
        module_id TEXT NOT NULL,
        operation_id INTEGER NOT NULL,
        path TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        digest TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (pid, writer_id, module_id, operation_id)
      )`);
            this.sql.exec(`CREATE TABLE IF NOT EXISTS vfs_append_writer_state (
        pid INTEGER NOT NULL,
        writer_id TEXT NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0,
        retired_at INTEGER,
        PRIMARY KEY (pid, writer_id)
      )`);
            this.sql.exec(`CREATE TABLE IF NOT EXISTS vfs_append_module_state (
        pid INTEGER NOT NULL,
        writer_id TEXT NOT NULL,
        module_id TEXT NOT NULL,
        acked_through INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (pid, writer_id, module_id)
      )`);
            this.sql.exec(`CREATE TABLE IF NOT EXISTS vfs_append_pid_revocations (
        pid INTEGER PRIMARY KEY,
        retired_at INTEGER NOT NULL
      )`);
            this.sql.exec(`CREATE TABLE IF NOT EXISTS vfs_append_acked_gaps (
        pid INTEGER NOT NULL,
        writer_id TEXT NOT NULL,
        module_id TEXT NOT NULL,
        operation_id INTEGER NOT NULL,
        path TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        digest TEXT NOT NULL,
        PRIMARY KEY (pid, writer_id, module_id, operation_id)
      )`);
            const contentMigrationApplied = [...this.sql.exec('SELECT id FROM vfs_schema_migrations WHERE id = ?', CONTENT_SCHEMA_MIGRATION)].length > 0;
            let existingInodeColumns = this.tableColumns('inodes');
            if (existingInodeColumns.has('is_dir') && !existingInodeColumns.has('kind')) {
                const invalidLegacyKinds = [...this.sql.exec('SELECT path, is_dir FROM inodes WHERE is_dir NOT IN (0, 1) LIMIT 1')];
                if (invalidLegacyKinds.length > 0) {
                    throw new Error(`[sqlite-vfs] invalid legacy inode kind ${String(invalidLegacyKinds[0].is_dir)} ` +
                        `at ${String(invalidLegacyKinds[0].path)}`);
                }
                this.sql.exec('ALTER TABLE inodes RENAME COLUMN is_dir TO kind');
                existingInodeColumns = this.tableColumns('inodes');
            }
            if (existingInodeColumns.has('is_dir') || (existingInodeColumns.size > 0 && !existingInodeColumns.has('kind'))) {
                throw new Error('[sqlite-vfs] unsupported inode kind schema');
            }
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
            if (contentMigrationApplied && (!existingInodeColumns.has('content_id')
                || !chunksAreCurrent
                || !lifecycleIsCurrent)) {
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
        kind INTEGER NOT NULL DEFAULT 0 CHECK (kind IN (0, 1, 2)),
        size INTEGER NOT NULL DEFAULT 0,
        atime INTEGER NOT NULL DEFAULT 0,
        mtime INTEGER NOT NULL DEFAULT 0,
        mode INTEGER NOT NULL DEFAULT 0,
        uid INTEGER NOT NULL DEFAULT 1000,
        gid INTEGER NOT NULL DEFAULT 1000,
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
            if (!inodeColumns.has('uid')) {
                this.sql.exec("ALTER TABLE inodes ADD COLUMN uid INTEGER NOT NULL DEFAULT 1000");
            }
            if (!inodeColumns.has('gid')) {
                this.sql.exec("ALTER TABLE inodes ADD COLUMN gid INTEGER NOT NULL DEFAULT 1000");
            }
            const invalidKinds = [...this.sql.exec('SELECT path, kind FROM inodes WHERE kind NOT IN (0, 1, 2) LIMIT 1')];
            if (invalidKinds.length > 0) {
                throw new Error(`[sqlite-vfs] invalid durable inode kind ${String(invalidKinds[0].kind)} ` +
                    `at ${String(invalidKinds[0].path)}`);
            }
            this.sql.exec(`CREATE TRIGGER IF NOT EXISTS trg_inodes_kind_insert
        BEFORE INSERT ON inodes WHEN NEW.kind NOT IN (0, 1, 2)
        BEGIN SELECT RAISE(ABORT, 'invalid inode kind'); END`);
            this.sql.exec(`CREATE TRIGGER IF NOT EXISTS trg_inodes_kind_update
        BEFORE UPDATE OF kind ON inodes WHEN NEW.kind NOT IN (0, 1, 2)
        BEGIN SELECT RAISE(ABORT, 'invalid inode kind'); END`);
            const chunkColumns = this.tableColumns('file_chunks');
            if (chunkColumns.size === 0) {
                this.sql.exec(`CREATE TABLE file_chunks (
          content_id TEXT NOT NULL,
          chunk_id INTEGER NOT NULL,
          data BLOB NOT NULL,
          PRIMARY KEY (content_id, chunk_id)
        )`);
            }
            else if (chunksAreLegacy) {
                // legacyContentId(path) is the path itself. Renaming the column is an
                // O(1), rollback-atomic schema migration: no unbounded row-copy txn.
                this.sql.exec("ALTER TABLE file_chunks RENAME COLUMN path TO content_id");
            }
            else if (!chunksAreCurrent) {
                throw new Error('[sqlite-vfs] unsupported file_chunks schema');
            }
            this.sql.exec(`CREATE TABLE IF NOT EXISTS content_lifecycle (
        content_id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN ('staging', 'gc')),
        created_at INTEGER NOT NULL
      )`);
            this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_inodes_parent ON inodes(parent_path)`);
            this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_inodes_content ON inodes(content_id)`);
            this.sql.exec('DROP INDEX IF EXISTS idx_inodes_resolved_file_content');
            // The COALESCE expression index is unusable by the reference probes:
            // SQLite cannot seek an expression index from a correlated subquery, so
            // every probe now seeks idx_inodes_content or the path primary key
            // (see sqlNoInodeContentReference). Keeping it would only tax writes.
            this.sql.exec('DROP INDEX IF EXISTS idx_inodes_resolved_kind_content');
            this.sql.exec("INSERT OR IGNORE INTO vfs_schema_migrations (id, applied_at) VALUES (?, ?)", CONTENT_SCHEMA_MIGRATION, Date.now());
        });
        this.migrateFromLegacy();
    }
    tableColumns(table) {
        const rows = this.sql.exec(`PRAGMA table_info(${table})`);
        return new Set([...rows].map((row) => String(row.name)));
    }
    migrateFromLegacy() {
        const rows = [...this.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='fs_objects'")];
        if (rows.length === 0)
            return;
        const marker = [...this.sql.exec("SELECT id FROM vfs_schema_migrations WHERE id = 'legacy_fs_objects_v1'")];
        if (marker.length > 0)
            return;
        console.log('[sqlite-vfs] Migrating from legacy fs_objects table...');
        const LEGACY_CHUNK_SIZE = 1_800_000;
        let migratedEntries = 0;
        const paths = [...this.sql.exec("SELECT DISTINCT path FROM fs_objects ORDER BY path")];
        for (const pathRow of paths) {
            const path = String(pathRow.path);
            const sourceRows = [...this.sql.exec(`SELECT chunk_index, parent_path, data, is_dir, size, mtime, mode
         FROM fs_objects WHERE path = ? ORDER BY chunk_index`, path)];
            if (sourceRows.length === 0)
                continue;
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
                if (String(row.parent_path) !== parentPath
                    || (Number(row.is_dir) === 1) !== isDir
                    || Number(row.size) !== size
                    || Number(row.mtime) !== mtime
                    || Number(row.mode) !== mode) {
                    throw new Error(`EIO: inconsistent legacy metadata for ${path}`);
                }
            }
            const chunkCount = isDir || size === 0 ? 0 : Math.ceil(size / CHUNK_SIZE);
            if (!isDir) {
                const markerPlan = this.metricsOnlyPlan({
                    blobBytes: 0, logicalRows: 1, sqlExecs: 1, affectedPaths: 1,
                });
                this.executeMeasuredTransaction(markerPlan, { source: 'content-stage', limitMode: 'bounded' }, () => {
                    this.sql.exec("INSERT OR IGNORE INTO content_lifecycle (content_id, state, created_at) VALUES (?, 'staging', ?)", path, Date.now());
                });
                let builder = new TransactionPlanBuilder();
                const flush = () => {
                    if (builder.empty)
                        return;
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
                        throw new Error(`EIO: invalid legacy chunk ${legacyIndex} for ${path}: expected ${expectedLength} bytes, got ${data.length}`);
                    }
                    const combined = new Uint8Array(tail.length + data.length);
                    combined.set(tail);
                    combined.set(data, tail.length);
                    let offsetInCombined = 0;
                    while (combined.length - offsetInCombined >= CHUNK_SIZE) {
                        const chunk = {
                            path,
                            contentId: path,
                            chunkId: nextChunkId++,
                            data: combined.slice(offsetInCombined, offsetInCombined + CHUNK_SIZE),
                        };
                        if (builder.wouldExceedChunkGroup([chunk]) !== null)
                            flush();
                        builder.addChunk(chunk);
                        offsetInCombined += CHUNK_SIZE;
                    }
                    tail = combined.slice(offsetInCombined);
                    bytesRead += data.length;
                }
                if (tail.length > 0) {
                    const chunk = {
                        path,
                        contentId: path,
                        chunkId: nextChunkId++,
                        data: tail,
                    };
                    if (builder.wouldExceedChunkGroup([chunk]) !== null)
                        flush();
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
                kind: isDir ? 'directory' : 'file',
                isDir,
                size,
                atime: mtime,
                mtime,
                mode,
                uid: 1000,
                gid: 1000,
                chunkCount,
                contentId: null,
            });
            if (!isDir)
                publishBuilder.addPublishedContent(path);
            const publishPlan = publishBuilder.build();
            this.assertTransactionFits(publishPlan.metrics);
            this.executeTransactionPlan(publishPlan, { source: 'content-publish', limitMode: 'bounded' });
            migratedEntries++;
        }
        const finishPlan = this.metricsOnlyPlan({
            blobBytes: 0, logicalRows: 1, sqlExecs: 2, affectedPaths: 0,
        });
        this.executeMeasuredTransaction(finishPlan, { source: 'content-publish', limitMode: 'bounded' }, () => {
            this.sql.exec("INSERT INTO vfs_schema_migrations (id, applied_at) VALUES ('legacy_fs_objects_v1', ?)", Date.now());
            this.sql.exec("DROP TABLE fs_objects");
        });
        console.log(`[sqlite-vfs] Migration complete: ${migratedEntries} entries migrated.`);
    }
    // ── INode loading ─────────────────────────────────────────────────────
    loadInodes() {
        this.inodes.clear();
        this.children.clear();
        // Reset counters before rescanning (B3).
        this._totalFiles = 0;
        this._totalDirs = 0;
        this._usedBytes = 0;
        const rows = [...this.sql.exec("SELECT path, parent_path, kind, size, atime, mtime, mode, uid, gid, chunk_count, content_id FROM inodes")];
        for (const row of rows) {
            const mtime = Number(row.mtime);
            const atime = Number(row.atime) || mtime;
            const kind = inodeKindFromCode(Number(row.kind));
            const inode = {
                path: String(row.path),
                parentPath: String(row.parent_path),
                kind,
                isDir: kind === 'directory',
                size: Number(row.size),
                atime,
                mtime,
                mode: Number(row.mode),
                uid: Number(row.uid),
                gid: Number(row.gid),
                chunkCount: Number(row.chunk_count),
                contentId: row.content_id === null ? null : String(row.content_id),
            };
            this.inodes.set(inode.path, inode);
            this._addToChildrenIndex(inode.parentPath, inode.path);
            // Bootstrap the counters (B3).
            if (inode.isDir)
                this._totalDirs++;
            else {
                this._totalFiles++;
                this._usedBytes += inode.size;
            }
        }
    }
    _addToChildrenIndex(parentPath, childPath) {
        let set = this.children.get(parentPath);
        if (!set) {
            set = new Set();
            this.children.set(parentPath, set);
        }
        set.add(childPath);
    }
    _removeFromChildrenIndex(parentPath, childPath) {
        const set = this.children.get(parentPath);
        if (set) {
            set.delete(childPath);
            if (set.size === 0)
                this.children.delete(parentPath);
        }
    }
    // ── Cache key ─────────────────────────────────────────────────────────
    cacheKey(path, chunkId) {
        return `${path}\0${chunkId}`;
    }
    // ── LRU Content Cache ─────────────────────────────────────────────────
    cacheGet(path, chunkId) {
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
    cacheSet(path, chunkId, data) {
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
    enforceCacheLimit() {
        while (this.cache.size > this._lruMaxEntries)
            this.evictOne();
    }
    evictOne() {
        // Evict the LRU entry (first in Map iteration order)
        const firstKey = this.cache.keys().next().value;
        if (firstKey === undefined)
            return;
        const entry = this.cache.get(firstKey);
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
    // Reduce hot cache pressure while a memory-heavy install is active.
    //
    // The cache is disposable. Cold-cache bounce is acceptable for install
    // workloads because accepted writes are already durable in SQLite.
    shrinkForInstall(targetEntries = 128) {
        const target = Math.max(1, Math.min(LRU_MAX_ENTRIES, targetEntries | 0));
        // Refcount: nested acquires stack. Take the smallest target across
        // owners — most aggressive shrinker wins.
        if (this._lruShrinkRefcount > 0) {
            if (target < this._lruMaxEntries)
                this._lruMaxEntries = target;
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
    restoreAfterInstall() {
        if (this._lruShrinkRefcount <= 0)
            return;
        this._lruShrinkRefcount--;
        if (this._lruShrinkRefcount === 0) {
            this._lruMaxEntries = LRU_MAX_ENTRIES;
        }
    }
    /** Drop every disposable cache entry before retrying a strict batch. */
    evictAll() {
        // Iterate a snapshot while deleting from the cache.
        const keys = Array.from(this.cache.keys());
        for (const key of keys) {
            const entry = this.cache.get(key);
            if (!entry)
                continue;
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
    cacheInvalidateBatch(paths) {
        if (paths.size === 0)
            return;
        const toDelete = [];
        for (const [key, entry] of this.cache) {
            if (!paths.has(entry.path))
                continue;
            this._cacheBytes -= entry.data.length;
            toDelete.push(key);
        }
        for (const key of toDelete) {
            this.cache.delete(key);
        }
    }
    // ── Helpers ───────────────────────────────────────────────────────────
    now() { return Date.now(); }
    parentPath(path) {
        return path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';
    }
    /** The single content resolver for both legacy-null and generated inodes. */
    contentIdForInode(inode) {
        return inode.contentId ?? this.legacyContentId(inode.path);
    }
    legacyContentId(path) {
        return path;
    }
    createContentId(reservedContentIds) {
        // Canonical VFS keys never have a leading slash, so this namespace cannot
        // overlap legacy IDs, which are raw canonical paths. One combined indexed
        // guard also protects malformed legacy data, durable generations, and a
        // repeated random value; the local reservation protects IDs in one plan.
        // The inode arms mirror sqlNoInodeContentReference: generated and legacy
        // path-keyed references are probed separately so both seek plain indexes.
        for (let attempt = 0; attempt < CONTENT_ID_ALLOCATION_ATTEMPTS; attempt++) {
            const contentId = `/content:${crypto.randomUUID()}`;
            if (reservedContentIds?.has(contentId))
                continue;
            const collision = [...this.sql.exec(`SELECT 1 AS collision FROM file_chunks WHERE content_id = ?
         UNION ALL
         SELECT 1 FROM content_lifecycle WHERE content_id = ?
         UNION ALL
         SELECT 1 FROM inodes WHERE kind != 1 AND content_id = ?
         UNION ALL
         SELECT 1 FROM inodes WHERE kind != 1 AND content_id IS NULL AND path = ?
         LIMIT 1`, contentId, contentId, contentId, contentId)];
            if (collision.length === 0) {
                reservedContentIds?.add(contentId);
                return contentId;
            }
        }
        throw new Error('EIO: failed to allocate a unique VFS content generation');
    }
    blobToUint8Array(blob) {
        if (blob instanceof Uint8Array)
            return blob;
        if (blob instanceof ArrayBuffer)
            return new Uint8Array(blob);
        if (ArrayBuffer.isView(blob))
            return new Uint8Array(blob.buffer, blob.byteOffset, blob.byteLength);
        return new Uint8Array(0);
    }
    copyBytes(data) {
        const copy = new Uint8Array(data.length);
        copy.set(data);
        return copy;
    }
    readChunkFromSql(inode, chunkId) {
        this._sqlReads++;
        const rows = [...this.sql.exec("SELECT data FROM file_chunks WHERE content_id = ? AND chunk_id = ?", this.contentIdForInode(inode), chunkId)];
        if (rows.length === 0)
            return null;
        return this.blobToUint8Array(rows[0].data);
    }
    // ── Filesystem operations ─────────────────────────────────────────────
    as(cred) {
        const bound = Object.freeze({
            uid: cred.uid,
            gid: cred.gid,
            groups: Object.freeze([...cred.groups]),
            umask: cred.umask & 0o777,
        });
        return {
            cred: bound,
            exists: (path) => this.exists(path, bound),
            isDirectory: (path) => this.isDirectory(path, bound),
            isFile: (path) => this.isFile(path, bound),
            isSymlink: (path) => this.isSymlink(path, bound),
            access: (path, mode) => { this.checkAccess(path, mode, bound); },
            mkdir: (path, options) => this.mkdir(path, options, bound),
            writeFile: (path, content, options) => this.writeFile(path, content, options, bound),
            symlink: (target, path) => this.symlink(target, path, bound),
            readlink: (path) => this.readlink(path, bound),
            resolveSymlink: (path) => this.resolveSymlink(path, bound),
            readFile: (path) => this.readFile(path, bound),
            readFileUncached: (path) => this.readFileUncached(path, bound),
            readRange: (path, offset, length) => this.readRange(path, offset, length, bound),
            writeRange: (path, offset, bytes) => this.writeRange(path, offset, bytes, bound),
            appendOnce: (path, pid, writerId, moduleId, operationId, digest, bytes) => (this.appendOnce(path, pid, writerId, moduleId, operationId, digest, bytes, bound)),
            acknowledgeAppend: (pid, writerId, moduleId, operationId) => (this.acknowledgeAppend(pid, writerId, moduleId, operationId)),
            truncate: (path, size) => this.truncate(path, size, bound),
            readFileString: (path) => this.readFileString(path, bound),
            stat: (path) => this.stat(path, bound, true),
            lstat: (path) => this.stat(path, bound, false),
            utimes: (path, atimeMs, mtimeMs) => this.utimes(path, atimeMs, mtimeMs, bound),
            chmod: (path, mode) => this.chmod(path, mode, bound),
            chown: (path, uid, gid, options) => this.chown(path, uid, gid, bound, options?.followSymlinks !== false),
            readdir: (path) => this.readdir(path, bound),
            unlink: (path) => this.unlink(path, bound),
            rmdir: (path) => this.rmdir(path, bound),
            rename: (oldPath, newPath) => this.rename(oldPath, newPath, bound),
            copyFile: (src, dest) => this.copyFile(src, dest, bound),
            writeBatch: (payload) => this.writeBatch(payload, bound),
            writeStream: (stream, options) => this.writeStream(stream, options, bound),
            mkdirBatch: (paths) => this.mkdirBatch(paths, bound),
            revision: (path) => this.revision(path),
        };
    }
    accessInode(inode, want, cred) {
        return this.accessMode(inode.mode, inode.uid, inode.gid, want, cred);
    }
    accessMode(mode, uid, gid, want, cred) {
        const requested = want & 0o7;
        if (requested === 0)
            return true;
        const permissions = mode & 0o777;
        if (cred.uid === 0) {
            return (requested & 0o1) === 0 || (permissions & 0o111) !== 0;
        }
        const shift = cred.uid === uid
            ? 6
            : cred.gid === gid || cred.groups.includes(gid)
                ? 3
                : 0;
        const granted = (permissions >> shift) & 0o7;
        return (granted & requested) === requested;
    }
    resolvePath(path, cred, followLeaf, allowMissing) {
        let current = normalizeVfsPath(path);
        const seen = new Set();
        for (let hops = 0; hops <= 40; hops++) {
            const parts = current.split('/').filter(Boolean);
            let prefix = '';
            let restarted = false;
            for (let index = 0; index < parts.length; index++) {
                prefix = prefix ? `${prefix}/${parts[index]}` : parts[index];
                const inode = this.inodes.get(prefix);
                const leaf = index === parts.length - 1;
                if (!inode) {
                    if (leaf || allowMissing)
                        return { path: current, inode: undefined };
                    throw vfsError('ENOENT', prefix);
                }
                if (inode.kind === 'symlink' && (!leaf || followLeaf)) {
                    if (seen.has(prefix) || hops === 40)
                        throw vfsError('ELOOP', path);
                    seen.add(prefix);
                    const target = dec.decode(this.readInodeBytes(prefix, inode));
                    const suffix = parts.slice(index + 1).join('/');
                    const resolvedTarget = target.startsWith('/')
                        ? normalizeVfsPath(target)
                        : normalizeVfsPath(`${this.parentPath(prefix)}/${target}`);
                    current = suffix ? normalizeVfsPath(`${resolvedTarget}/${suffix}`) : resolvedTarget;
                    restarted = true;
                    break;
                }
                if (!leaf) {
                    if (inode.kind !== 'directory')
                        throw vfsError('ENOTDIR', prefix);
                    if (!this.accessInode(inode, 0o1, cred))
                        throw vfsError('EACCES', prefix);
                }
            }
            if (restarted)
                continue;
            return { path: current, inode: this.inodes.get(current) };
        }
        throw vfsError('ELOOP', path);
    }
    checkAccess(path, want, cred, options = {}) {
        const resolved = this.resolvePath(path, cred, options.followLeaf ?? true, options.allowMissingLeaf ?? false);
        if (!resolved.inode) {
            if (options.allowMissingLeaf)
                return resolved;
            throw vfsError('ENOENT', normalizeVfsPath(path));
        }
        if (!this.accessInode(resolved.inode, want, cred)) {
            throw vfsError('EACCES', resolved.path);
        }
        return resolved;
    }
    checkParentAccess(path, cred) {
        const parent = this.parentPath(normalizeVfsPath(path));
        if (parent === '')
            return;
        const resolved = this.checkAccess(parent, 0o3, cred);
        if (resolved.inode?.kind !== 'directory')
            throw vfsError('ENOTDIR', parent);
    }
    /**
     * Shared resolver for the boolean probes (exists/isDirectory/isFile/
     * isSymlink). Resolution-structure failures — a missing or non-directory
     * path component — answer `undefined` (fs.existsSync semantics: module
     * resolvers probe paths through files, e.g. `entry.js/index.js`, and
     * expect false, not a throw). Permission denials still propagate so
     * traverse-x enforcement cannot be masked into a quiet false.
     */
    probeInode(path, cred) {
        try {
            return this.checkAccess(path, 0, cred, { followLeaf: false, allowMissingLeaf: true }).inode;
        }
        catch (error) {
            const code = error.code;
            if (code === 'ENOENT' || code === 'ENOTDIR')
                return undefined;
            throw error;
        }
    }
    exists(path, cred) {
        return this.probeInode(path, cred) !== undefined;
    }
    isDirectory(path, cred) {
        return this.probeInode(path, cred)?.kind === 'directory';
    }
    isFile(path, cred) {
        return this.probeInode(path, cred)?.kind === 'file';
    }
    isSymlink(path, cred) {
        return this.probeInode(path, cred)?.kind === 'symlink';
    }
    /**
     * Without a path: the global mutation clock. With a path: the clock
     * value at the last mutation inside that path's subtree (0 if nothing
     * under it changed in this DO lifetime). `revision('')` equals the
     * global clock by construction (every mutation stamps all ancestors).
     */
    revision(path) {
        if (path === undefined)
            return this._revision;
        const p = normalizeVfsPath(path);
        if (p === '')
            return this._revision;
        return this._pathRevisions.get(p) ?? 0;
    }
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
    bumpRevision(paths) {
        const rev = ++this._revision;
        for (const path of paths) {
            let p = normalizeVfsPath(path);
            const mutated = p;
            while (p !== '') {
                this._pathRevisions.set(p, rev);
                p = this.parentPath(p);
            }
            if (mutated === '')
                continue;
            this._invalidations.push({ rev, path: mutated });
            const parent = this.parentPath(mutated);
            if (parent !== '')
                this._invalidations.push({ rev, path: parent });
        }
        const max = SqliteVFS.INVALIDATION_LOG_MAX;
        if (this._invalidations.length > max) {
            this._invalidations = this._invalidations.slice(-max);
        }
    }
    /**
     * The paths mutated since `cursor`, for a facet holding a cache stamped
     * at `(epoch, cursor)`.
     *
     * Returns `poison` — meaning "drop the whole resident set" — when the
     * caller's view cannot be repaired incrementally: a different supervisor
     * incarnation (its revisions are unrelated to ours), or a cursor older
     * than the retained log (entries it needed have been dropped). Both
     * degrade to a cold cache, never to a stale byte.
     */
    invalidatedSince(epoch, cursor) {
        const rev = this._revision;
        if (epoch !== this._epoch || cursor > rev) {
            return { epoch: this._epoch, rev, paths: [], poison: true };
        }
        if (cursor === rev)
            return { epoch: this._epoch, rev, paths: [], poison: false };
        const oldest = this._invalidations.length > 0 ? this._invalidations[0].rev : rev + 1;
        // The log starts at rev 1; a cursor at or above the oldest retained
        // entry minus one can still be served completely.
        if (cursor < oldest - 1) {
            return { epoch: this._epoch, rev, paths: [], poison: true };
        }
        const paths = new Set();
        for (const entry of this._invalidations) {
            if (entry.rev > cursor)
                paths.add(entry.path);
        }
        return { epoch: this._epoch, rev, paths: [...paths], poison: false };
    }
    acquireExclusiveMutation(path, options = {}) {
        let root = normalizeVfsPath(path);
        if (!root)
            throw vfsError('EINVAL', 'exclusive mutation root cannot be empty');
        if (options.includeMissingAncestors) {
            const parts = root.split('/');
            for (let index = 0; index < parts.length; index++) {
                const candidate = parts.slice(0, index + 1).join('/');
                const inode = this.inodes.get(candidate);
                if (!inode) {
                    root = candidate;
                    break;
                }
                if (inode.kind !== 'directory')
                    break;
            }
        }
        for (const lockedRoot of this.exclusiveMutationLeases.values()) {
            if (pathsOverlap(root, lockedRoot)) {
                throw vfsError('EBUSY', `${root} overlaps exclusive mutation at ${lockedRoot || '/'}`);
            }
        }
        const owner = crypto.randomUUID();
        this.exclusiveMutationLeases.set(owner, root);
        return { root, owner };
    }
    acquireGlobalExclusiveMutation() {
        if (this.exclusiveMutationLeases.size > 0) {
            throw vfsError('EBUSY', 'session has an active exclusive filesystem mutation');
        }
        const owner = crypto.randomUUID();
        this.exclusiveMutationLeases.set(owner, '');
        return { root: '', owner };
    }
    releaseExclusiveMutation(owner) {
        this.exclusiveMutationLeases.delete(owner);
    }
    hasExclusiveMutation() {
        return this.exclusiveMutationLeases.size > 0;
    }
    withMutationOwner(owner, callback) {
        if (!owner || !this.exclusiveMutationLeases.has(owner)) {
            if (owner)
                throw vfsError('ESTALE', 'exclusive mutation lease is no longer active');
            return callback();
        }
        if (this.activeMutationOwner !== null) {
            throw new Error('[sqlite-vfs] nested mutation owner scope is not supported');
        }
        this.activeMutationOwner = owner;
        try {
            return callback();
        }
        finally {
            this.activeMutationOwner = null;
        }
    }
    assertMutationAllowed(path) {
        this.assertMutationsAllowed([path]);
    }
    assertMutationsAllowed(paths) {
        for (const path of paths) {
            const normalized = normalizeVfsPath(path);
            if (this.activeMutationOwner !== null) {
                const ownedRoot = this.exclusiveMutationLeases.get(this.activeMutationOwner);
                if (!ownedRoot || (normalized !== ownedRoot && !normalized.startsWith(`${ownedRoot}/`))) {
                    throw vfsError('EPERM', `${normalized} is outside exclusive mutation root ${ownedRoot ?? ''}`);
                }
            }
            if (this.activeMutationOwner === null &&
                normalized === LEGACY_SYMLINK_REGISTRY_PATH &&
                this.exclusiveMutationLeases.size > 0) {
                throw vfsError('EBUSY', `${normalized} is locked while an exclusive mutation is active`);
            }
            for (const [owner, root] of this.exclusiveMutationLeases) {
                if (!pathsOverlap(normalized, root) || owner === this.activeMutationOwner)
                    continue;
                throw vfsError('EBUSY', `${normalized} is locked by exclusive mutation at ${root || '/'}`);
            }
        }
    }
    mkdir(path, options, cred) {
        const normalized = normalizeVfsPath(path);
        this.assertMutationsAllowed([normalized]);
        if (this.exists(normalized, cred))
            return;
        if (options?.recursive) {
            const parts = normalized.split('/').filter(Boolean);
            let current = '';
            for (const part of parts) {
                current = current ? current + '/' + part : part;
                if (!this.exists(current, cred)) {
                    this.checkParentAccess(current, cred);
                    this._mkdirSingle(current, options.mode, cred);
                }
            }
        }
        else {
            this.checkParentAccess(normalized, cred);
            this._mkdirSingle(normalized, options?.mode, cred);
        }
    }
    _mkdirSingle(path, requestedMode, cred) {
        const pp = this.parentPath(path);
        const now = this.now();
        const mode = (requestedMode ?? 0o777) & ~cred.umask & 0o7777;
        this.sql.exec("INSERT OR REPLACE INTO inodes (path, parent_path, kind, size, atime, mtime, mode, uid, gid, chunk_count, content_id) VALUES (?, ?, 1, 0, ?, ?, ?, ?, ?, 0, NULL)", path, pp, now, now, mode, cred.uid, cred.gid);
        const inode = {
            path,
            parentPath: pp,
            kind: 'directory',
            isDir: true,
            size: 0,
            atime: now,
            mtime: now,
            mode,
            uid: cred.uid,
            gid: cred.gid,
            chunkCount: 0,
            contentId: null,
        };
        this.inodes.set(path, inode);
        this._addToChildrenIndex(pp, path);
        this._totalDirs++; // B3
        this.bumpRevision([path]);
        this.events.emit('addDir', path);
    }
    writeFile(path, content, options, cred, onCommit) {
        this.assertMutationsAllowed([path]);
        const resolved = this.checkAccess(path, 0, cred, { allowMissingLeaf: true });
        const effectivePath = resolved.path;
        if (resolved.inode) {
            if (resolved.inode.kind === 'directory')
                throw vfsError('EISDIR', effectivePath);
            if (resolved.inode.kind !== 'file')
                throw vfsError('EINVAL', `${effectivePath} is not a regular file`);
            if (!this.accessInode(resolved.inode, 0o2, cred))
                throw vfsError('EACCES', effectivePath);
        }
        else {
            this.checkParentAccess(effectivePath, cred);
        }
        const data = typeof content === 'string' ? enc.encode(content) : content;
        const pp = this.parentPath(effectivePath);
        const now = this.now();
        const chunkCount = data.length === 0 ? 0 : Math.ceil(data.length / CHUNK_SIZE);
        const chunks = [];
        for (let chunkId = 0; chunkId < chunkCount; chunkId++) {
            chunks.push({
                path: effectivePath,
                chunkId,
                data: data.subarray(chunkId * CHUNK_SIZE, (chunkId + 1) * CHUNK_SIZE),
            });
        }
        // POSIX: rewriting an existing file never changes its mode; the mode
        // is chosen only at creation (open(2) O_CREAT).
        const prior = this.inodes.get(effectivePath);
        const inode = {
            path: effectivePath,
            parentPath: pp,
            kind: 'file',
            isDir: false,
            size: data.length,
            atime: now,
            mtime: now,
            mode: prior?.kind === 'file'
                ? prior.mode
                : (options?.mode ?? 0o666) & ~cred.umask & 0o7777,
            uid: prior?.uid ?? cred.uid,
            gid: prior?.gid ?? cred.gid,
            chunkCount,
        };
        try {
            this.writeBatch({ inodes: [inode], chunks }, cred, onCommit);
        }
        catch (error) {
            if (!(error instanceof SqliteVfsTransactionTooLargeError))
                throw error;
            this.replaceFileWithStagedContent(inode, chunks, undefined, onCommit);
        }
    }
    symlink(target, path, cred) {
        this.assertMutationsAllowed([path]);
        const normalized = normalizeVfsPath(path);
        const prior = this.checkAccess(normalized, 0, cred, { followLeaf: false, allowMissingLeaf: true });
        if (prior.inode)
            throw vfsError('EEXIST', normalized);
        this.checkParentAccess(normalized, cred);
        const data = enc.encode(target);
        const now = this.now();
        const chunkCount = data.length === 0 ? 0 : Math.ceil(data.length / CHUNK_SIZE);
        const inode = {
            path: normalized,
            parentPath: this.parentPath(normalized),
            kind: 'symlink',
            isDir: false,
            size: data.length,
            atime: now,
            mtime: now,
            mode: inodeTypeBits('symlink') | 0o777,
            uid: cred.uid,
            gid: cred.gid,
            chunkCount,
        };
        const chunks = Array.from({ length: chunkCount }, (_, chunkId) => ({
            path: normalized,
            chunkId,
            data: data.subarray(chunkId * CHUNK_SIZE, (chunkId + 1) * CHUNK_SIZE),
        }));
        this.writeBatch({ inodes: [inode], chunks }, cred);
    }
    readlink(path, cred) {
        const resolved = this.checkAccess(path, 0, cred, { followLeaf: false });
        if (resolved.inode?.kind !== 'symlink')
            throw vfsError('EINVAL', `${path} is not a symlink`);
        return dec.decode(this.readInodeBytes(resolved.path, resolved.inode));
    }
    resolveSymlink(path, cred) {
        try {
            return this.resolvePath(path, cred, true, false).path;
        }
        catch (error) {
            if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ELOOP') {
                return null;
            }
            throw error;
        }
    }
    /** Read one chunk via cache → SQL, caching on miss. */
    readChunk(inode, chunkId) {
        const path = inode.path;
        const cached = this.cacheGet(path, chunkId);
        if (cached)
            return cached;
        const data = this.readChunkFromSql(inode, chunkId);
        if (data)
            this.cacheSet(path, chunkId, data);
        return data;
    }
    readFile(path, cred) {
        const resolved = this.checkAccess(path, 0o4, cred);
        const inode = resolved.inode;
        if (!inode)
            throw vfsError('ENOENT', path);
        if (inode.kind === 'directory')
            throw vfsError('EISDIR', resolved.path);
        if (inode.kind !== 'file')
            throw vfsError('EINVAL', `${resolved.path} is not a regular file`);
        return this.readInodeBytes(resolved.path, inode);
    }
    readInodeBytes(path, inode) {
        if (inode.size === 0 || inode.chunkCount === 0)
            return new Uint8Array(0);
        if (inode.chunkCount === 1) {
            return this.requireChunk(path, inode, 0).slice(0, inode.size);
        }
        // Multi-chunk: reassemble
        const chunks = [];
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
            if (length <= 0)
                break;
            result.set(c.subarray(0, length), offset);
            offset += length;
        }
        return result;
    }
    requireChunk(path, inode, chunkId) {
        const chunk = this.readChunk(inode, chunkId);
        if (chunk)
            return chunk;
        throw new Error(`EIO: ${path}: missing declared chunk ${chunkId} of ${inode.chunkCount} (size ${inode.size})`);
    }
    /**
     * Read a whole file straight from SQL, bypassing the LRU content cache
     * entirely (neither consulted nor populated). For one-shot bulk reads
     * of large runtime binaries (e.g. the 31 MiB clang.wasm at facet
     * warm-up) that would otherwise evict the user's hot working set and
     * pin the file's chunks — the full 32 MiB LRU — resident in the DO heap
     * for the whole session. Demand-paging cache semantics are wrong for a
     * blob read once and handed to a Worker Loader module map.
     */
    readFileUncached(path, cred) {
        const resolved = this.checkAccess(path, 0o4, cred);
        const inode = resolved.inode;
        if (!inode)
            throw vfsError('ENOENT', path);
        if (inode.kind === 'directory')
            throw vfsError('EISDIR', resolved.path);
        if (inode.kind !== 'file')
            throw vfsError('EINVAL', `${resolved.path} is not a regular file`);
        if (inode.size === 0 || inode.chunkCount === 0)
            return new Uint8Array(0);
        const result = new Uint8Array(inode.size);
        let offset = 0;
        for (let i = 0; i < inode.chunkCount; i++) {
            const chunk = this.readChunkFromSql(inode, i);
            if (!chunk) {
                throw new Error(`EIO: ${resolved.path}: missing declared chunk ${i} of ${inode.chunkCount} (size ${inode.size})`);
            }
            const length = Math.min(chunk.length, result.length - offset);
            if (length <= 0)
                break;
            result.set(chunk.subarray(0, length), offset);
            offset += length;
        }
        if (offset < inode.size) {
            throw new Error(`EIO: ${resolved.path}: declared size ${inode.size} exceeds chunk bytes ${offset}`);
        }
        return result;
    }
    /**
     * Read `length` bytes at `offset` without assembling the whole file —
     * only the chunks overlapping the range are touched. Reads past EOF
     * are clamped; missing spans retain the existing zero-fill range semantics.
     */
    readRange(path, offset, length, cred) {
        const resolved = this.checkAccess(path, 0o4, cred);
        const inode = resolved.inode;
        if (!inode)
            throw vfsError('ENOENT', path);
        if (inode.kind === 'directory')
            throw vfsError('EISDIR', resolved.path);
        if (inode.kind !== 'file')
            throw vfsError('EINVAL', `${resolved.path} is not a regular file`);
        const start = clampNonNegativeInt(offset);
        const end = Math.min(inode.size, start + clampNonNegativeInt(length));
        if (start >= end)
            return new Uint8Array(0);
        const out = new Uint8Array(end - start);
        const firstChunk = Math.floor(start / CHUNK_SIZE);
        const lastChunk = Math.floor((end - 1) / CHUNK_SIZE);
        for (let i = firstChunk; i <= lastChunk; i++) {
            const chunk = this.readChunk(inode, i);
            if (!chunk)
                continue;
            const chunkStart = i * CHUNK_SIZE;
            const copyFrom = Math.max(start, chunkStart);
            const copyTo = Math.min(end, chunkStart + chunk.length);
            if (copyFrom >= copyTo)
                continue;
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
    writeRange(path, offset, bytes, cred, onCommit) {
        this.assertMutationsAllowed([path]);
        const resolved = this.checkAccess(path, 0, cred, { allowMissingLeaf: true });
        const effectivePath = resolved.path;
        const prior = resolved.inode;
        if (prior?.kind === 'directory')
            throw vfsError('EISDIR', effectivePath);
        if (prior && prior.kind !== 'file')
            throw vfsError('EINVAL', `${effectivePath} is not a regular file`);
        if (prior && !this.accessInode(prior, 0o2, cred))
            throw vfsError('EACCES', effectivePath);
        if (!prior)
            this.checkParentAccess(effectivePath, cred);
        const isNew = prior === undefined;
        const start = clampNonNegativeInt(offset);
        const end = start + bytes.length;
        if (isNew) {
            const initial = new Uint8Array(end);
            initial.set(bytes, start);
            this.writeFile(effectivePath, initial, undefined, cred, onCommit);
            return;
        }
        // POSIX pwrite of zero bytes never extends or dirties an existing file.
        if (bytes.length === 0) {
            if (onCommit)
                this.transactionSync(onCommit);
            return;
        }
        const oldSize = prior.size;
        const oldChunkCount = prior.chunkCount;
        const newSize = Math.max(oldSize, end);
        const now = this.now();
        const changedChunks = new Map();
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
                    const existing = this.requireChunk(effectivePath, prior, i);
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
        if (this.commitCurrentContentMutation(prior, next, changedChunks, [], onCommit))
            return;
        this.replaceFileWithGeneratedContent(next, (chunkId) => this.generatedMutationChunk(prior, next, changedChunks, chunkId), onCommit);
    }
    /**
     * Publish an append and its dedupe receipt in the same SQLite transaction.
     * Large content may stage privately first, but its inode publication and
     * receipt still share the final transaction. Receipts are removed only by
     * explicit client acknowledgement after that client relinquishes retries.
     */
    appendOnce(path, pid, writerId, moduleId, operationId, digest, bytes, cred) {
        if (!Number.isSafeInteger(pid) || pid <= 0)
            throw vfsError('EINVAL', `invalid append pid ${pid}`);
        assertAppendIncarnation(writerId, 'writer');
        assertAppendIncarnation(moduleId, 'module');
        if (!Number.isSafeInteger(operationId) || operationId <= 0) {
            throw vfsError('EINVAL', `invalid append operation ${operationId}`);
        }
        const normalized = normalizeVfsPath(path);
        const pidRevoked = [...this.sql.exec('SELECT 1 AS revoked FROM vfs_append_pid_revocations WHERE pid = ?', pid)].length > 0;
        if (pidRevoked)
            throw vfsError('ESTALE', `append process ${pid} is being retired`);
        const writer = [...this.sql.exec(`SELECT revoked FROM vfs_append_writer_state
       WHERE pid = ? AND writer_id = ?`, pid, writerId)][0];
        if (!writer || Number(writer.revoked) !== 0) {
            throw vfsError('ESTALE', `append writer ${pid}/${writerId} is unavailable`);
        }
        let moduleState = [...this.sql.exec(`SELECT acked_through FROM vfs_append_module_state
       WHERE pid = ? AND writer_id = ? AND module_id = ?`, pid, writerId, moduleId)][0];
        const ackedThrough = Number(moduleState?.acked_through ?? 0);
        if (operationId <= ackedThrough)
            return bytes.byteLength;
        const acknowledgedGap = [...this.sql.exec(`SELECT path, byte_length, digest
       FROM vfs_append_acked_gaps
       WHERE pid = ? AND writer_id = ? AND module_id = ? AND operation_id = ?`, pid, writerId, moduleId, operationId)][0];
        if (acknowledgedGap) {
            if (acknowledgedGap.path !== normalized
                || Number(acknowledgedGap.byte_length) !== bytes.byteLength
                || acknowledgedGap.digest !== digest) {
                throw vfsError('EINVAL', `append acknowledgement collision for ${pid}/${operationId}`);
            }
            return bytes.byteLength;
        }
        const existing = [...this.sql.exec(`SELECT path, byte_length, digest
       FROM vfs_append_receipts
       WHERE pid = ? AND writer_id = ? AND module_id = ? AND operation_id = ?`, pid, writerId, moduleId, operationId)][0];
        if (existing) {
            if (existing.path !== normalized
                || Number(existing.byte_length) !== bytes.byteLength
                || existing.digest !== digest) {
                throw vfsError('EINVAL', `append receipt collision for ${pid}/${writerId}/${operationId}`);
            }
            return bytes.byteLength;
        }
        const highestKnown = Number([...this.sql.exec(`SELECT MAX(operation_id) AS operation_id
         FROM (
           SELECT operation_id FROM vfs_append_receipts
             WHERE pid = ? AND writer_id = ? AND module_id = ?
           UNION ALL
           SELECT operation_id FROM vfs_append_acked_gaps
             WHERE pid = ? AND writer_id = ? AND module_id = ?
         )`, pid, writerId, moduleId, pid, writerId, moduleId)][0]?.operation_id
            ?? ackedThrough);
        if (operationId > Math.max(ackedThrough, highestKnown) + VFS_APPEND_RECEIPT_LIMIT) {
            throw vfsError('EINVAL', `append operation gap exceeds ${VFS_APPEND_RECEIPT_LIMIT}`);
        }
        const retainedCount = Number([...this.sql.exec(`SELECT
           (SELECT COUNT(*) FROM vfs_append_writer_state WHERE revoked = 0)
           + (SELECT COUNT(*) FROM vfs_append_module_state)
           + (SELECT COUNT(*) FROM vfs_append_receipts)
           + (SELECT COUNT(*) FROM vfs_append_acked_gaps) AS count`)][0]?.count ?? 0);
        const requiredRows = 1 + (moduleState ? 0 : 1);
        if (retainedCount > VFS_APPEND_RECEIPT_LIMIT - requiredRows) {
            throw vfsError('ENOSPC', 'append receipt journal is full');
        }
        if (!moduleState) {
            this.sql.exec(`INSERT INTO vfs_append_module_state
         (pid, writer_id, module_id, acked_through) VALUES (?, ?, ?, 0)`, pid, writerId, moduleId);
            moduleState = { acked_through: 0 };
        }
        const resolved = this.checkAccess(normalized, 0, cred, { allowMissingLeaf: true });
        const effectivePath = resolved.path;
        const inode = resolved.inode;
        if (inode?.kind === 'directory')
            throw vfsError('EISDIR', effectivePath);
        if (inode && inode.kind !== 'file') {
            throw vfsError('EINVAL', `${effectivePath} is not a regular file`);
        }
        const offset = inode?.size ?? 0;
        const recordReceipt = () => {
            this.sql.exec(`INSERT INTO vfs_append_receipts
         (pid, writer_id, module_id, operation_id, path, byte_length, digest, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, pid, writerId, moduleId, operationId, normalized, bytes.byteLength, digest, Date.now());
        };
        this.writeRange(effectivePath, offset, bytes, cred, recordReceipt);
        return bytes.byteLength;
    }
    activateAppendWriter(pid, writerId) {
        if (!Number.isSafeInteger(pid) || pid <= 0)
            throw vfsError('EINVAL', `invalid append pid ${pid}`);
        assertAppendIncarnation(writerId, 'writer');
        if ([...this.sql.exec('SELECT 1 AS revoked FROM vfs_append_pid_revocations WHERE pid = ?', pid)].length > 0) {
            throw vfsError('ESTALE', `append process ${pid} is being retired`);
        }
        const writers = [...this.sql.exec(`SELECT writer_id, revoked FROM vfs_append_writer_state
       WHERE pid = ?`, pid)];
        const writer = writers.find((candidate) => candidate.writer_id === writerId);
        if (writer && Number(writer.revoked) === 0) {
            return;
        }
        if (writers.length > 0) {
            throw vfsError('ESTALE', `append process ${pid} already has a different writer`);
        }
        const retainedCount = Number([...this.sql.exec(`SELECT
           (SELECT COUNT(*) FROM vfs_append_writer_state WHERE revoked = 0)
           + (SELECT COUNT(*) FROM vfs_append_module_state)
           + (SELECT COUNT(*) FROM vfs_append_receipts)
           + (SELECT COUNT(*) FROM vfs_append_acked_gaps) AS count`)][0]?.count ?? 0);
        if (retainedCount >= VFS_APPEND_RECEIPT_LIMIT) {
            throw vfsError('ENOSPC', 'append receipt journal is full');
        }
        this.transactionSync(() => {
            this.sql.exec(`INSERT INTO vfs_append_writer_state
         (pid, writer_id, revoked, retired_at) VALUES (?, ?, 0, NULL)`, pid, writerId);
        });
    }
    acknowledgeAppend(pid, writerId, moduleId, operationId) {
        if (!Number.isSafeInteger(pid) || pid <= 0)
            throw vfsError('EINVAL', `invalid append pid ${pid}`);
        assertAppendIncarnation(writerId, 'writer');
        assertAppendIncarnation(moduleId, 'module');
        if (!Number.isSafeInteger(operationId) || operationId <= 0) {
            throw vfsError('EINVAL', `invalid append operation ${operationId}`);
        }
        const writer = [...this.sql.exec(`SELECT revoked FROM vfs_append_writer_state
       WHERE pid = ? AND writer_id = ?`, pid, writerId)][0];
        if (!writer || Number(writer.revoked) !== 0) {
            throw vfsError('ESTALE', `append writer ${pid} is unavailable`);
        }
        const moduleState = [...this.sql.exec(`SELECT acked_through FROM vfs_append_module_state
       WHERE pid = ? AND writer_id = ? AND module_id = ?`, pid, writerId, moduleId)][0];
        if (!moduleState) {
            throw vfsError('ESTALE', `append module ${pid}/${writerId}/${moduleId} is unavailable`);
        }
        let ackedThrough = Number(moduleState.acked_through);
        if (operationId <= ackedThrough)
            return;
        const existingGap = [...this.sql.exec(`SELECT 1 AS present FROM vfs_append_acked_gaps
       WHERE pid = ? AND writer_id = ? AND module_id = ? AND operation_id = ?`, pid, writerId, moduleId, operationId)].length > 0;
        let receipt;
        if (!existingGap) {
            receipt = [...this.sql.exec(`SELECT path, byte_length, digest
         FROM vfs_append_receipts
         WHERE pid = ? AND writer_id = ? AND module_id = ? AND operation_id = ?`, pid, writerId, moduleId, operationId)][0];
            if (!receipt) {
                throw vfsError('EINVAL', `append operation ${pid}/${operationId} has not completed`);
            }
        }
        const acknowledged = [...this.sql.exec(`SELECT operation_id FROM vfs_append_acked_gaps
       WHERE pid = ? AND writer_id = ? AND module_id = ? AND operation_id > ?
       ORDER BY operation_id`, pid, writerId, moduleId, ackedThrough)];
        if (!existingGap)
            acknowledged.push({ operation_id: operationId });
        acknowledged.sort((left, right) => Number(left.operation_id) - Number(right.operation_id));
        for (const row of acknowledged) {
            const sequence = Number(row.operation_id);
            if (sequence <= ackedThrough)
                continue;
            if (sequence !== ackedThrough + 1)
                break;
            ackedThrough = sequence;
        }
        const priorAckedThrough = Number(moduleState.acked_through);
        if (!existingGap || ackedThrough > priorAckedThrough) {
            this.transactionSync(() => {
                if (!existingGap) {
                    const completed = receipt;
                    this.sql.exec(`INSERT INTO vfs_append_acked_gaps
             (pid, writer_id, module_id, operation_id, path, byte_length, digest)
             VALUES (?, ?, ?, ?, ?, ?, ?)`, pid, writerId, moduleId, operationId, completed.path, completed.byte_length, completed.digest);
                    this.sql.exec(`DELETE FROM vfs_append_receipts
             WHERE pid = ? AND writer_id = ? AND module_id = ? AND operation_id = ?`, pid, writerId, moduleId, operationId);
                }
                if (ackedThrough > priorAckedThrough) {
                    this.sql.exec(`UPDATE vfs_append_module_state SET acked_through = ?
             WHERE pid = ? AND writer_id = ? AND module_id = ?`, ackedThrough, pid, writerId, moduleId);
                }
            });
        }
        if (ackedThrough > priorAckedThrough) {
            this.deleteAppendRowsBounded('vfs_append_acked_gaps', 'pid = ? AND writer_id = ? AND module_id = ? AND operation_id <= ?', [pid, writerId, moduleId, ackedThrough]);
        }
    }
    revokeAppendWriter(pid, writerId) {
        if (!Number.isSafeInteger(pid) || pid <= 0)
            throw vfsError('EINVAL', `invalid append pid ${pid}`);
        assertAppendIncarnation(writerId, 'writer');
        this.transactionSync(() => {
            this.sql.exec(`UPDATE vfs_append_writer_state
         SET revoked = 1, retired_at = ?
         WHERE pid = ? AND writer_id = ?`, Date.now(), pid, writerId);
        });
        this.deleteAppendRowsBounded('vfs_append_receipts', 'pid = ? AND writer_id = ?', [pid, writerId]);
        this.deleteAppendRowsBounded('vfs_append_acked_gaps', 'pid = ? AND writer_id = ?', [pid, writerId]);
        this.deleteAppendRowsBounded('vfs_append_module_state', 'pid = ? AND writer_id = ?', [pid, writerId]);
        this.deleteAppendRowsBounded('vfs_append_writer_state', 'pid = ? AND writer_id = ? AND revoked = 1', [pid, writerId]);
    }
    revokeAppendWriters(pid) {
        if (!Number.isSafeInteger(pid) || pid <= 0)
            throw vfsError('EINVAL', `invalid append pid ${pid}`);
        this.transactionSync(() => {
            this.sql.exec(`INSERT INTO vfs_append_pid_revocations (pid, retired_at) VALUES (?, ?)
         ON CONFLICT(pid) DO UPDATE SET retired_at = excluded.retired_at`, pid, Date.now());
        });
        this.finishAppendPidRevocation(pid);
    }
    revokeAppendWritersThrough(maxPid) {
        if (!Number.isSafeInteger(maxPid) || maxPid < 0) {
            throw vfsError('EINVAL', `invalid append pid ceiling ${maxPid}`);
        }
        for (;;) {
            const pids = [...this.sql.exec(`SELECT DISTINCT pid FROM vfs_append_writer_state
         WHERE pid <= ?
         ORDER BY pid
         LIMIT ?`, maxPid, MAX_TX_LOGICAL_ROWS)];
            if (pids.length === 0)
                return;
            for (const row of pids)
                this.revokeAppendWriters(Number(row.pid));
        }
    }
    finishAppendPidRevocation(pid) {
        for (;;) {
            const writers = [...this.sql.exec(`SELECT writer_id FROM vfs_append_writer_state
         WHERE pid = ? AND revoked = 0
         ORDER BY rowid
         LIMIT ?`, pid, MAX_TX_LOGICAL_ROWS)];
            if (writers.length === 0)
                break;
            const placeholders = writers.map(() => '?').join(',');
            this.transactionSync(() => {
                this.sql.exec(`UPDATE vfs_append_writer_state
           SET revoked = 1, retired_at = ?
           WHERE pid = ? AND writer_id IN (${placeholders})`, Date.now(), pid, ...writers.map((writer) => writer.writer_id));
            });
        }
        this.deleteAppendRowsBounded('vfs_append_receipts', 'pid = ?', [pid]);
        this.deleteAppendRowsBounded('vfs_append_acked_gaps', 'pid = ?', [pid]);
        this.deleteAppendRowsBounded('vfs_append_module_state', 'pid = ?', [pid]);
        this.deleteAppendRowsBounded('vfs_append_writer_state', 'pid = ? AND revoked = 1', [pid]);
        this.transactionSync(() => {
            this.sql.exec('DELETE FROM vfs_append_pid_revocations WHERE pid = ?', pid);
        });
    }
    deleteAppendRowsBounded(table, predicate, params) {
        for (;;) {
            const rows = [...this.sql.exec(`SELECT rowid FROM ${table} WHERE ${predicate} ORDER BY rowid LIMIT ?`, ...params, MAX_TX_LOGICAL_ROWS)];
            if (rows.length === 0)
                return;
            const placeholders = rows.map(() => '?').join(',');
            this.transactionSync(() => {
                this.sql.exec(`DELETE FROM ${table} WHERE rowid IN (${placeholders})`, ...rows.map((row) => row.rowid));
            });
        }
    }
    resumeAppendMaintenance() {
        for (;;) {
            const revocations = [...this.sql.exec(`SELECT pid FROM vfs_append_pid_revocations
         ORDER BY pid
         LIMIT ?`, MAX_TX_LOGICAL_ROWS)];
            if (revocations.length === 0)
                break;
            for (const row of revocations) {
                this.finishAppendPidRevocation(Number(row.pid));
            }
        }
        for (const table of [
            'vfs_append_receipts',
            'vfs_append_acked_gaps',
            'vfs_append_module_state',
        ]) {
            this.deleteAppendRowsBounded(table, `EXISTS (
          SELECT 1 FROM vfs_append_writer_state AS writer
          WHERE writer.pid = ${table}.pid
            AND writer.writer_id = ${table}.writer_id
            AND writer.revoked = 1
        )`, []);
        }
        this.deleteAppendRowsBounded('vfs_append_writer_state', 'revoked = 1', []);
        this.deleteAppendRowsBounded('vfs_append_acked_gaps', `EXISTS (
        SELECT 1 FROM vfs_append_module_state AS module
        WHERE module.pid = vfs_append_acked_gaps.pid
          AND module.writer_id = vfs_append_acked_gaps.writer_id
          AND module.module_id = vfs_append_acked_gaps.module_id
          AND module.acked_through >= vfs_append_acked_gaps.operation_id
      )`, []);
    }
    /**
     * Truncate or zero-extend to `size`, touching only the boundary chunk.
     * Shrinking drops trailing chunk rows and trims the new last chunk;
     * growing zero-fills like writeRange. Every mutation commits before return.
     */
    truncate(path, size, cred) {
        this.assertMutationsAllowed([path]);
        const resolved = this.checkAccess(path, 0o2, cred);
        const inode = resolved.inode;
        if (!inode)
            throw vfsError('ENOENT', path);
        if (inode.kind === 'directory')
            throw vfsError('EISDIR', resolved.path);
        if (inode.kind !== 'file')
            throw vfsError('EINVAL', `${resolved.path} is not a regular file`);
        const newSize = clampNonNegativeInt(size);
        const oldSize = inode.size;
        if (newSize === oldSize)
            return;
        const newChunkCount = newSize === 0 ? 0 : Math.ceil(newSize / CHUNK_SIZE);
        const now = this.now();
        const changedChunks = new Map();
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
        }
        else {
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
        const deletedChunks = [];
        if (newSize < oldSize) {
            const contentId = this.contentIdForInode(inode);
            const rows = [...this.sql.exec(`SELECT chunk_id, length(data) AS byte_length
         FROM file_chunks
         WHERE content_id = ? AND chunk_id >= ?
         ORDER BY chunk_id
         LIMIT ?`, contentId, newChunkCount, MAX_TX_LOGICAL_ROWS + 1)];
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
        if (this.commitCurrentContentMutation(inode, next, changedChunks, deletedChunks))
            return;
        this.replaceFileWithGeneratedContent(next, (chunkId) => this.generatedMutationChunk(inode, next, changedChunks, chunkId));
    }
    updatedFileInode(inode, size, chunkCount, mtime) {
        return {
            path: inode.path,
            parentPath: inode.parentPath,
            kind: 'file',
            isDir: false,
            size,
            atime: inode.atime,
            mtime,
            mode: inode.mode,
            uid: inode.uid,
            gid: inode.gid,
            chunkCount,
        };
    }
    commitCurrentContentMutation(prior, inode, changedChunks, deletedChunks, onCommit) {
        const contentId = this.contentIdForInode(prior);
        const builder = new TransactionPlanBuilder();
        builder.addInode({
            ...inode,
            kind: inodeKind(inode),
            uid: inode.uid ?? prior.uid,
            gid: inode.gid ?? prior.gid,
            contentId,
        });
        for (const [chunkId, data] of changedChunks) {
            builder.addChunk({ path: inode.path, contentId, chunkId, data });
        }
        for (const chunk of deletedChunks)
            builder.addDeletedChunk(chunk);
        const plan = builder.build();
        const metrics = onCommit ? withCommitRowMetrics(plan.metrics) : plan.metrics;
        if (exceededTransactionLimit(metrics) !== null)
            return false;
        this._writeBatchOnce({
            payload: { inodes: [inode], chunks: [] },
            plan,
            deletedInodes: [],
        }, { source: 'range-mutation', limitMode: 'bounded' }, changedChunks.size, onCommit);
        return true;
    }
    generatedMutationChunk(prior, inode, changedChunks, chunkId) {
        const changed = changedChunks.get(chunkId);
        if (changed)
            return changed;
        const existing = this.requireChunk(prior.path, prior, chunkId);
        const expected = Math.min(CHUNK_SIZE, inode.size - (chunkId * CHUNK_SIZE));
        if (existing.byteLength !== expected) {
            throw new Error(`EIO: ${prior.path}: chunk ${chunkId} has ${existing.byteLength} bytes; expected ${expected}`);
        }
        return existing;
    }
    readFileString(path, cred) {
        return dec.decode(this.readFile(path, cred));
    }
    stat(path, cred, followLeaf) {
        const resolved = this.checkAccess(path, 0, cred, { followLeaf });
        const inode = resolved.inode;
        if (!inode)
            throw vfsError('ENOENT', path);
        return {
            type: inode.kind,
            size: inode.size,
            atime: inode.atime || inode.mtime,
            ctime: inode.mtime,
            mtime: inode.mtime,
            mode: inode.mode,
            uid: inode.uid,
            gid: inode.gid,
        };
    }
    utimes(path, atimeMs, mtimeMs, cred) {
        const resolved = this.checkAccess(path, 0, cred);
        const inode = resolved.inode;
        if (!inode)
            throw vfsError('ENOENT', path);
        this.assertMutationsAllowed([inode.path]);
        const useNow = atimeMs === null && mtimeMs === null;
        if (useNow) {
            if (!this.accessInode(inode, 0o2, cred))
                throw vfsError('EACCES', resolved.path);
        }
        else if (cred.uid !== 0 && cred.uid !== inode.uid) {
            throw vfsError('EPERM', resolved.path);
        }
        const atime = atimeMs !== null && Number.isFinite(atimeMs) ? Math.trunc(atimeMs) : this.now();
        const mtime = mtimeMs !== null && Number.isFinite(mtimeMs) ? Math.trunc(mtimeMs) : this.now();
        inode.atime = atime;
        inode.mtime = mtime;
        this.sql.exec("UPDATE inodes SET atime = ?, mtime = ? WHERE path = ?", atime, mtime, inode.path);
        this.bumpRevision([inode.path]);
        this.events.emit('change', inode.path);
    }
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
    chmod(path, mode, cred) {
        const resolved = this.checkAccess(path, 0, cred);
        const inode = resolved.inode;
        if (!inode)
            throw vfsError('ENOENT', path);
        if (cred.uid !== 0 && cred.uid !== inode.uid)
            throw vfsError('EPERM', resolved.path);
        this.assertMutationsAllowed([inode.path]);
        const full = inodeTypeBits(inode.kind) | (mode & 0o7777);
        inode.mode = full;
        this.sql.exec("UPDATE inodes SET mode = ? WHERE path = ?", full, inode.path);
        this.bumpRevision([inode.path]);
        this.events.emit('change', inode.path);
    }
    chown(path, uid, gid, cred, followLeaf) {
        const resolved = this.checkAccess(path, 0, cred, { followLeaf });
        const inode = resolved.inode;
        if (!inode)
            throw vfsError('ENOENT', path);
        if (uid !== null && (!Number.isSafeInteger(uid) || uid < 0))
            throw vfsError('EINVAL', `invalid uid ${uid}`);
        if (gid !== null && (!Number.isSafeInteger(gid) || gid < 0))
            throw vfsError('EINVAL', `invalid gid ${gid}`);
        const owner = cred.uid === inode.uid;
        if (uid !== null && uid !== inode.uid && cred.uid !== 0)
            throw vfsError('EPERM', resolved.path);
        if (uid !== null && uid === inode.uid && cred.uid !== 0 && !owner)
            throw vfsError('EPERM', resolved.path);
        if (gid !== null && gid !== inode.gid && cred.uid !== 0 && (!owner || !cred.groups.includes(gid))) {
            throw vfsError('EPERM', resolved.path);
        }
        if (gid !== null && gid === inode.gid && cred.uid !== 0 && !owner)
            throw vfsError('EPERM', resolved.path);
        this.assertMutationsAllowed([inode.path]);
        inode.uid = uid ?? inode.uid;
        inode.gid = gid ?? inode.gid;
        if (cred.uid !== 0)
            inode.mode &= ~0o6000;
        this.sql.exec('UPDATE inodes SET uid = ?, gid = ?, mode = ? WHERE path = ?', inode.uid, inode.gid, inode.mode, inode.path);
        this.bumpRevision([inode.path]);
        this.events.emit('change', inode.path);
    }
    readdir(path, cred) {
        const np = path.replace(/^\/+/, '').replace(/\/+$/, '');
        const resolved = np ? this.checkAccess(np, 0o4, cred) : { path: '', inode: undefined };
        const inode = resolved.inode;
        if (inode && inode.kind !== 'directory')
            throw vfsError('ENOTDIR', path);
        const kids = this.children.get(np);
        if (!kids) {
            // W2.5b diagnostic: empty children-set for a directory we expected
            // to be populated.
            if (globalThis.process?.env?.NIMBUS_DIAG_INSTALL_PIPELINE === '1') {
                // eslint-disable-next-line no-console
                console.warn('[sqlite-vfs/W2.5b] readdir miss path=' + np +
                    ' kidsUndefined=true inodeExists=' + this.inodes.has(np));
            }
            return [];
        }
        const results = [];
        for (const childPath of kids) {
            const inode = this.inodes.get(childPath);
            if (inode) {
                const name = inode.path.split('/').pop();
                results.push({ name, type: inode.kind });
            }
        }
        // W2.5b diagnostic: if children-set has entries but readdir returns
        // fewer (some entries' inodes are missing from this.inodes), log it.
        // This distinguishes (a) "children index broken" from (b) "inodes
        // map lost entries".
        if (globalThis.process?.env?.NIMBUS_DIAG_INSTALL_PIPELINE === '1' &&
            kids.size !== results.length) {
            // eslint-disable-next-line no-console
            console.warn('[sqlite-vfs/W2.5b] readdir size mismatch path=' + np +
                ' kidsSize=' + kids.size +
                ' resultsLength=' + results.length +
                ' missingInodes=' + (kids.size - results.length));
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
    unlink(path, cred) {
        this.assertMutationsAllowed([path]);
        const resolved = this.checkAccess(path, 0, cred, { followLeaf: false });
        const inode = resolved.inode;
        if (!inode)
            throw vfsError('ENOENT', path);
        this.checkParentAccess(resolved.path, cred);
        if (inode.isDir)
            throw vfsError('EISDIR', resolved.path);
        this.writeBatch({ inodes: [], chunks: [], deletePaths: [resolved.path] }, cred);
    }
    rmdir(path, cred) {
        this.assertMutationsAllowed([path]);
        const np = path.replace(/^\/+/, '').replace(/\/+$/, '');
        const resolved = this.checkAccess(np, 0, cred, { followLeaf: false });
        this.checkParentAccess(resolved.path, cred);
        // Check if empty using children index (O(1) instead of O(N))
        const kids = this.children.get(np);
        if (kids && kids.size > 0) {
            throw vfsError('ENOTEMPTY', path);
        }
        const inode = this.inodes.get(np);
        if (!inode)
            throw vfsError('ENOENT', path);
        if (!inode.isDir)
            throw vfsError('ENOTDIR', path);
        this.writeBatch({ inodes: [], chunks: [], deletePaths: [np] }, cred);
    }
    rename(oldPath, newPath, cred) {
        this.assertMutationsAllowed([oldPath, newPath]);
        this.checkAccess(oldPath, 0, cred, { followLeaf: false });
        this.checkParentAccess(oldPath, cred);
        this.checkParentAccess(newPath, cred);
        if (oldPath === newPath)
            return;
        if (newPath.startsWith(`${oldPath}/`)) {
            throw new Error(`EINVAL: cannot move ${oldPath} inside itself`);
        }
        const inode = this.inodes.get(oldPath);
        if (!inode)
            throw new Error("ENOENT: " + oldPath);
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
        const targetPaths = new Set(moving.map((entry) => newPath + entry.path.substring(oldPath.length)));
        for (const existing of this.inodes.values()) {
            if (movingPaths.has(existing.path) || existing === destInode)
                continue;
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
            const stored = {
                path,
                parentPath: this.parentPath(path),
                kind: entry.kind,
                isDir: entry.isDir,
                size: entry.size,
                atime: entry.atime,
                mtime: entry.mtime,
                mode: entry.mode,
                uid: entry.uid,
                gid: entry.gid,
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
    copyFile(src, dest, cred) {
        this.writeFile(dest, this.readFile(src, cred), undefined, cred);
    }
    // ── Batch write (npm install fast path) ───────────────────────────────
    normalizeBatchInode(entry, cred) {
        const path = normalizeVfsPath(entry.path);
        const prior = this.inodes.get(path);
        const newUid = cred.uid === 0 ? (entry.uid ?? 1000) : cred.uid;
        const newGid = cred.uid === 0 ? (entry.gid ?? 1000) : cred.gid;
        return {
            ...entry,
            path,
            parentPath: normalizeVfsPath(entry.parentPath),
            mode: prior
                ? prior.mode
                : inodeKind(entry) === 'symlink'
                    ? inodeTypeBits('symlink') | 0o777
                    : entry.mode & ~cred.umask & 0o7777,
            uid: prior?.uid ?? newUid,
            gid: prior?.gid ?? newGid,
        };
    }
    authorizeBatch(payload, cred) {
        const inodes = payload.inodes.map((entry) => this.normalizeBatchInode(entry, cred));
        const pending = new Map(inodes.map((entry) => [entry.path, entry]));
        const checkedParents = new Set();
        const checkParent = (path) => {
            const parent = this.parentPath(path);
            if (parent === '')
                return;
            if (checkedParents.has(parent))
                return;
            checkedParents.add(parent);
            const existing = this.inodes.get(parent);
            if (existing) {
                this.checkAccess(parent, 0o3, cred);
                return;
            }
            const staged = pending.get(parent);
            if (!staged || !staged.isDir)
                throw vfsError('ENOENT', parent);
            checkParent(parent);
            if (!this.accessMode(staged.mode, staged.uid ?? 1000, staged.gid ?? 1000, 0o3, cred)) {
                throw vfsError('EACCES', parent);
            }
        };
        for (const path of payload.deletePaths ?? []) {
            const normalized = normalizeVfsPath(path);
            const existing = this.checkAccess(normalized, 0, cred, {
                followLeaf: false,
                allowMissingLeaf: true,
            }).inode;
            if (existing)
                checkParent(normalized);
        }
        for (const entry of inodes) {
            const prior = this.inodes.get(entry.path);
            if (prior)
                this.checkAccess(entry.path, 0o2, cred, { followLeaf: false });
            else
                checkParent(entry.path);
        }
        for (const chunk of payload.chunks) {
            const path = normalizeVfsPath(chunk.path);
            if (!pending.has(path))
                this.checkAccess(path, 0o2, cred, { followLeaf: false });
        }
        return {
            ...payload,
            inodes,
            deletePaths: payload.deletePaths?.map(normalizeVfsPath),
        };
    }
    /**
     * Atomic bulk write: ALL inodes + chunks in ONE transactionSync().
     *
     * The complete mutation is preflighted against the Stage 2 transaction
     * limits, then executed in one transaction with 9-inode / 33-chunk SQL
     * grouping. Oversized strict calls fail with E2BIG before mutation.
     */
    writeBatch(payload, cred, onCommit) {
        const normalized = this.authorizeBatch(payload, cred);
        this.assertMutationsAllowed(batchMutationPaths(normalized));
        const result = this._writeBatchWithRetry(normalized, { source: 'strict-batch', limitMode: 'bounded' }, true, onCommit);
        this.runContentMaintenanceSafely(1);
        return result;
    }
    replaceFileWithStagedContent(inode, chunks, onPhase, onCommit) {
        this.validateFileChunks(inode, chunks);
        onPhase?.('stage');
        const contentId = this.beginStagedContent();
        let builder = new TransactionPlanBuilder();
        const flushChunks = () => {
            if (builder.empty)
                return;
            const plan = builder.build();
            builder = new TransactionPlanBuilder();
            this.executeStagedChunkPlan(plan);
        };
        try {
            for (const chunk of chunks) {
                const stored = { ...chunk, contentId };
                if (builder.wouldExceedChunkGroup([stored]) !== null)
                    flushChunks();
                builder.addChunk(stored);
            }
            flushChunks();
            onPhase?.('publish');
            const result = this.publishStagedFile(inode, contentId, chunks.length, onCommit);
            this.runContentMaintenanceSafely(1);
            return result;
        }
        catch (error) {
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
    replaceFileWithGeneratedContent(inode, chunkAt, onCommit) {
        this.validateInodeContentShape(inode);
        const contentId = this.beginStagedContent();
        let builder = new TransactionPlanBuilder();
        const flushChunks = () => {
            if (builder.empty)
                return;
            const plan = builder.build();
            builder = new TransactionPlanBuilder();
            this.executeStagedChunkPlan(plan);
        };
        try {
            for (let chunkId = 0; chunkId < inode.chunkCount; chunkId++) {
                const data = chunkAt(chunkId);
                const expected = Math.min(CHUNK_SIZE, inode.size - (chunkId * CHUNK_SIZE));
                if (data.byteLength !== expected) {
                    throw new Error(`EIO: ${inode.path}: generated chunk ${chunkId} has ${data.byteLength} bytes; expected ${expected}`);
                }
                const chunk = { path: inode.path, contentId, chunkId, data };
                if (builder.wouldExceedChunkGroup([chunk]) !== null)
                    flushChunks();
                builder.addChunk(chunk);
            }
            flushChunks();
            const result = this.publishStagedFile(inode, contentId, inode.chunkCount, onCommit);
            this.runContentMaintenanceSafely(1);
            return result;
        }
        catch (error) {
            this.activeStagingContentIds.delete(contentId);
            this.maintenancePending = true;
            this.runContentMaintenanceSafely(1);
            throw error;
        }
    }
    beginStagedContent() {
        const contentId = this.createContentId();
        const builder = new TransactionPlanBuilder();
        builder.addStagingContent(contentId);
        const plan = builder.build();
        this.assertTransactionFits(plan.metrics);
        this.executeTransactionPlan(plan, { source: 'content-stage', limitMode: 'bounded' });
        this.activeStagingContentIds.add(contentId);
        return contentId;
    }
    executeStagedChunkPlan(plan) {
        this.assertTransactionFits(plan.metrics);
        this.executeTransactionPlan(plan, { source: 'content-stage', limitMode: 'bounded' });
    }
    publishStagedFile(inode, contentId, publishedChunkCount, onCommit) {
        this.assertMutationsAllowed([inode.path]);
        const prior = this.inodes.get(inode.path);
        const builder = new TransactionPlanBuilder();
        builder.addInode({
            ...inode,
            kind: inodeKind(inode),
            uid: inode.uid ?? prior?.uid ?? 1000,
            gid: inode.gid ?? prior?.gid ?? 1000,
            contentId,
        });
        builder.addPublishedContent(contentId);
        if (prior && !prior.isDir)
            builder.addGcContent(this.contentIdForInode(prior));
        const plan = builder.build();
        this.assertTransactionFits(onCommit ? withCommitRowMetrics(plan.metrics) : plan.metrics);
        const result = this._writeBatchOnce({ payload: { inodes: [inode], chunks: [] }, plan, deletedInodes: [] }, { source: 'content-publish', limitMode: 'bounded' }, publishedChunkCount, onCommit);
        this.activeStagingContentIds.delete(contentId);
        return result;
    }
    /**
     * Incremental W7 v3 consumer. Publication is path-atomic with a committed
     * prefix. Chunk payload is admitted through one per-VFS weighted credit
     * pool, staged in bounded synchronous transactions, then released before
     * the decoder pulls another record.
     */
    async writeStream(stream, options = {}, cred) {
        const decodeDrainStartedAt = options.decodeDrainStartedAt ?? performance.now();
        const decodeDrainToken = {};
        this._decodeDrainStarts.set(decodeDrainToken, decodeDrainStartedAt);
        let decodeDrainFinished = false;
        let decodeDrainWaitMs = Math.max(0, performance.now() - decodeDrainStartedAt);
        let recordIterator = null;
        let recordIteratorFinished = false;
        let decodedRecordLease = null;
        const ownedStagingContentIds = new Set();
        let activeFile = null;
        const progress = {
            committedGroupSequence: 0,
            committedPathCount: 0,
            inodes: 0,
            chunks: 0,
        };
        let phase = 'decode';
        let stageBuilder = new TransactionPlanBuilder();
        let stageLeases = [];
        const flushStagedChunks = () => {
            if (stageBuilder.empty)
                return;
            const plan = stageBuilder.build();
            const leases = stageLeases;
            stageBuilder = new TransactionPlanBuilder();
            stageLeases = [];
            try {
                this.executeStagedChunkPlan(plan);
                this._stagedStreamBytes += plan.metrics.blobBytes;
                this._peakStagedStreamBytes = Math.max(this._peakStagedStreamBytes, this._stagedStreamBytes);
                if (activeFile)
                    activeFile.stagedBytes += plan.metrics.blobBytes;
            }
            finally {
                for (const lease of leases)
                    lease.release();
            }
        };
        const retainChunk = async (byteLength, signal) => {
            if (stageBuilder.wouldExceedChunks(byteLength) !== null)
                flushStagedChunks();
            let writeLease = this.writeStreamCredits.tryAcquire(byteLength);
            if (!writeLease && !stageBuilder.empty) {
                flushStagedChunks();
                writeLease = this.writeStreamCredits.tryAcquire(byteLength);
            }
            if (!writeLease) {
                const waitToken = {};
                const waitStartedAt = performance.now();
                this._creditWaitStarts.set(waitToken, waitStartedAt);
                try {
                    writeLease = await this.writeStreamCredits.acquire(byteLength, signal);
                }
                finally {
                    this._creditWaitStarts.delete(waitToken);
                    this.recordDuration(this._creditWaitDuration, performance.now() - waitStartedAt);
                }
            }
            let supervisorLease;
            const waitToken = {};
            const waitStartedAt = performance.now();
            this._creditWaitStarts.set(waitToken, waitStartedAt);
            try {
                supervisorLease = await acquireSupervisorAllocation(byteLength, signal);
            }
            catch (error) {
                writeLease.release();
                throw error;
            }
            finally {
                this._creditWaitStarts.delete(waitToken);
                this.recordDuration(this._creditWaitDuration, performance.now() - waitStartedAt);
            }
            let released = false;
            return {
                bytes: byteLength,
                release: () => {
                    if (released)
                        return;
                    released = true;
                    writeLease.release();
                    supervisorLease.release();
                },
            };
        };
        try {
            const decoded = await decodeWriteBatchStream(stream, {
                signal: options.signal,
                retainChunk,
            });
            recordIterator = decoded.records[Symbol.asyncIterator]();
            while (true) {
                phase = 'decode';
                const waitStartedAt = performance.now();
                let next;
                try {
                    next = await recordIterator.next();
                }
                finally {
                    decodeDrainWaitMs += performance.now() - waitStartedAt;
                }
                if (next.done) {
                    recordIteratorFinished = true;
                    throw new Error('w7-frame: stream ended without batch-end');
                }
                const record = next.value;
                switch (record.type) {
                    case 'delete': {
                        phase = 'publish';
                        const affected = Math.max(1, this.collectBatchDeletions([record.path]).length);
                        this.withMutationOwner(options.mutationOwner, () => {
                            this.writeBatch({ inodes: [], chunks: [], deletePaths: [record.path] }, cred);
                        });
                        progress.committedGroupSequence++;
                        progress.committedPathCount += affected;
                        break;
                    }
                    case 'directory': {
                        phase = 'validation';
                        this.validateFileChunks(record.inode, []);
                        phase = 'publish';
                        const result = this.withMutationOwner(options.mutationOwner, () => (this.writeBatch({ inodes: [record.inode], chunks: [] }, cred)));
                        progress.committedGroupSequence++;
                        progress.committedPathCount++;
                        progress.inodes += result.inodes;
                        break;
                    }
                    case 'file-begin': {
                        if (activeFile)
                            throw new Error(`EINVAL: nested streamed file ${record.inode.path}`);
                        phase = 'validation';
                        this.validateInodeContentShape(record.inode);
                        this.withMutationOwner(options.mutationOwner, () => {
                            this.authorizeBatch({ inodes: [record.inode], chunks: [] }, cred);
                            this.assertMutationsAllowed([record.inode.path]);
                        });
                        phase = 'stage';
                        const durableContentId = this.beginStagedContent();
                        ownedStagingContentIds.add(durableContentId);
                        activeFile = {
                            streamContentId: record.streamContentId,
                            durableContentId,
                            inode: record.inode,
                            stagedBytes: 0,
                        };
                        break;
                    }
                    case 'file-chunk': {
                        decodedRecordLease = record.retention;
                        phase = 'validation';
                        if (!activeFile
                            || record.streamContentId !== activeFile.streamContentId
                            || record.path !== activeFile.inode.path) {
                            throw new Error(`EINVAL: streamed chunk ownership mismatch: ${record.path}`);
                        }
                        phase = 'stage';
                        stageBuilder.addChunk({
                            path: record.path,
                            contentId: activeFile.durableContentId,
                            chunkId: record.chunkId,
                            data: record.data,
                        });
                        stageLeases.push(record.retention);
                        decodedRecordLease = null;
                        break;
                    }
                    case 'file-end': {
                        phase = 'validation';
                        if (!activeFile || record.streamContentId !== activeFile.streamContentId) {
                            throw new Error(`EINVAL: streamed file-end ownership mismatch: ${record.path}`);
                        }
                        flushStagedChunks();
                        phase = 'publish';
                        const completed = activeFile;
                        const result = this.withMutationOwner(options.mutationOwner, () => (this.publishStagedFile(this.normalizeBatchInode(completed.inode, cred), completed.durableContentId, record.chunkCount)));
                        ownedStagingContentIds.delete(completed.durableContentId);
                        this._stagedStreamBytes -= completed.stagedBytes;
                        activeFile = null;
                        progress.committedGroupSequence++;
                        progress.committedPathCount++;
                        progress.inodes += result.inodes;
                        progress.chunks += result.chunks;
                        break;
                    }
                    case 'batch-end':
                        if (recordIterator.return)
                            await recordIterator.return();
                        recordIteratorFinished = true;
                        this._decodeDrainStarts.delete(decodeDrainToken);
                        this.recordDuration(this._decodeDrainDuration, decodeDrainWaitMs);
                        decodeDrainFinished = true;
                        return { ok: true, ...progress };
                }
            }
        }
        catch (error) {
            return {
                ok: false,
                ...progress,
                error: {
                    code: 'ERR_WRITE_BATCH_STREAM',
                    phase,
                    message: this.errorMessage(error),
                },
            };
        }
        finally {
            decodedRecordLease?.release();
            for (const lease of stageLeases)
                lease.release();
            stageLeases = [];
            if (!recordIteratorFinished && recordIterator?.return) {
                try {
                    await recordIterator.return();
                }
                catch { /* preserve the primary stream result */ }
            }
            if (!decodeDrainFinished) {
                this._decodeDrainStarts.delete(decodeDrainToken);
                this.recordDuration(this._decodeDrainDuration, decodeDrainWaitMs);
            }
            if (activeFile) {
                this._stagedStreamBytes -= activeFile.stagedBytes;
                if (this._stagedStreamBytes < 0)
                    this._stagedStreamBytes = 0;
            }
            for (const contentId of ownedStagingContentIds) {
                if (this.activeStagingContentIds.has(contentId))
                    this.maintenancePending = true;
                this.activeStagingContentIds.delete(contentId);
            }
            this.runContentMaintenanceSafely(2);
        }
    }
    _writeBatchWithRetry(payload, execution, enforceLimits, onCommit) {
        if (enforceLimits) {
            const preflight = this.prepareBatchTransaction(payload, false);
            if (preflight.plan.metrics.sqlExecs === 0)
                return { inodes: 0, chunks: 0 };
            this.assertTransactionFits(onCommit ? withCommitRowMetrics(preflight.plan.metrics) : preflight.plan.metrics);
        }
        const prepared = this.prepareBatchTransaction(payload, true);
        if (prepared.plan.metrics.sqlExecs === 0)
            return { inodes: 0, chunks: 0 };
        try {
            return this._writeBatchOnce(prepared, execution, undefined, onCommit);
        }
        catch (error) {
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
            if (!this.isSqliteNoMem(error))
                throw error;
            // Free clean cache pages, then retry the exact same indivisible
            // transaction once. Splitting a strict batch would publish a prefix
            // if a later half failed and would advance its revision more than once.
            this.evictAll();
            return this._writeBatchOnce(prepared, execution, undefined, onCommit);
        }
    }
    /**
     * Estimate the byte cost of a writeBatch payload. Used by the W5
     * recordFailure call so /api/_diag/memory can report inFlightBytes
     * at the moment of the SQLITE_NOMEM. Fast (no copy).
     */
    _estimateBatchBytes(payload) {
        let n = 0;
        for (const c of payload.chunks)
            n += c.data.length;
        // Path strings + inode header overhead — rough estimate.
        for (const i of payload.inodes)
            n += 80 + i.path.length;
        return n;
    }
    errorMessage(error) {
        return error instanceof Error ? error.message : String(error);
    }
    isSqliteNoMem(error) {
        if (typeof error === 'object' && error !== null) {
            const code = error.code;
            if (code === 'SQLITE_NOMEM' || code === 7)
                return true;
        }
        return this.errorMessage(error).toUpperCase().includes('SQLITE_NOMEM');
    }
    transactionSync(callback) {
        if (!this.ctx?.storage?.transactionSync) {
            throw new Error('[sqlite-vfs] atomic storage operation requires transactionSync');
        }
        this.ctx.storage.transactionSync(callback);
    }
    executeTransactionPlan(plan, execution, onCommit) {
        this.executeMeasuredTransaction(plan, execution, () => {
            for (const path of plan.deletedPaths) {
                this.sql.exec("DELETE FROM inodes WHERE path = ?", path);
            }
            for (let i = 0; i < plan.stagingContentIds.length; i += CONTENT_IDS_PER_SQL_EXEC) {
                const batch = plan.stagingContentIds.slice(i, i + CONTENT_IDS_PER_SQL_EXEC);
                const placeholders = batch.map(() => "(?, 'staging', ?)").join(',');
                const values = [];
                const createdAt = Date.now();
                for (const contentId of batch)
                    values.push(contentId, createdAt);
                this.sql.exec(`INSERT INTO content_lifecycle (content_id, state, created_at) VALUES ${placeholders}`, ...values);
            }
            for (let i = 0; i < plan.inodes.length; i += INODE_ROWS_PER_SQL_EXEC) {
                const batch = plan.inodes.slice(i, i + INODE_ROWS_PER_SQL_EXEC);
                const placeholders = batch.map(() => '(?,?,?,?,?,?,?,?,?,?,?)').join(',');
                const values = [];
                for (const inode of batch) {
                    const atime = inode.atime !== undefined && Number.isFinite(inode.atime)
                        ? inode.atime
                        : inode.mtime;
                    values.push(inode.path, inode.parentPath, inodeKindCode(inode.kind), inode.size, atime, inode.mtime, inode.mode, inode.uid, inode.gid, inode.chunkCount, inode.contentId);
                }
                this.sql.exec(`INSERT OR REPLACE INTO inodes (path, parent_path, kind, size, atime, mtime, mode, uid, gid, chunk_count, content_id) VALUES ${placeholders}`, ...values);
            }
            for (let i = 0; i < plan.chunks.length; i += CHUNK_ROWS_PER_SQL_EXEC) {
                const batch = plan.chunks.slice(i, i + CHUNK_ROWS_PER_SQL_EXEC);
                const placeholders = batch.map(() => '(?,?,?)').join(',');
                const values = [];
                for (const chunk of batch)
                    values.push(chunk.contentId, chunk.chunkId, chunk.data);
                this.sql.exec(`INSERT OR REPLACE INTO file_chunks (content_id, chunk_id, data) VALUES ${placeholders}`, ...values);
            }
            const deletedChunksByContent = new Map();
            for (const chunk of plan.deletedChunks) {
                const entries = deletedChunksByContent.get(chunk.contentId);
                if (entries)
                    entries.push(chunk);
                else
                    deletedChunksByContent.set(chunk.contentId, [chunk]);
            }
            for (const [contentId, chunks] of deletedChunksByContent) {
                for (let i = 0; i < chunks.length; i += CHUNK_ROWS_PER_SQL_EXEC) {
                    const batch = chunks.slice(i, i + CHUNK_ROWS_PER_SQL_EXEC);
                    const placeholders = batch.map(() => '?').join(',');
                    this.sql.exec(`DELETE FROM file_chunks WHERE content_id = ? AND chunk_id IN (${placeholders})`, contentId, ...batch.map((chunk) => chunk.chunkId));
                }
            }
            for (let i = 0; i < plan.publishedContentIds.length; i += CONTENT_IDS_PER_SQL_EXEC) {
                const batch = plan.publishedContentIds.slice(i, i + CONTENT_IDS_PER_SQL_EXEC);
                const placeholders = batch.map(() => '?').join(',');
                this.sql.exec(`DELETE FROM content_lifecycle WHERE content_id IN (${placeholders}) AND state = 'staging'`, ...batch);
            }
            for (let i = 0; i < plan.gcContentIds.length; i += CONTENT_IDS_PER_SQL_EXEC) {
                const batch = plan.gcContentIds.slice(i, i + CONTENT_IDS_PER_SQL_EXEC);
                const placeholders = batch.map(() => "(?, 'gc', ?)").join(',');
                const values = [];
                const createdAt = Date.now();
                for (const contentId of batch)
                    values.push(contentId, createdAt);
                this.sql.exec(`INSERT INTO content_lifecycle (content_id, state, created_at) VALUES ${placeholders}
           ON CONFLICT(content_id) DO UPDATE SET state = 'gc'`, ...values);
            }
            onCommit?.();
        });
        if (plan.gcContentIds.length > 0)
            this.maintenancePending = true;
    }
    executeMeasuredTransaction(plan, execution, callback) {
        if (this._activeTransaction !== null) {
            throw new Error('[sqlite-vfs] nested transaction plan execution is not supported');
        }
        const startedAt = performance.now();
        this._activeTransaction = { startedAt, plan, execution };
        try {
            this.transactionSync(callback);
        }
        finally {
            const durationMs = performance.now() - startedAt;
            this.recordDuration(this._transactionDuration, durationMs);
            this._transactionDurationSamples[this._transactionDurationSampleIndex] = durationMs;
            this._transactionDurationSampleIndex = (this._transactionDurationSampleIndex + 1) % TRANSACTION_DURATION_SAMPLE_COUNT;
            this._transactionDurationSampleCount = Math.min(this._transactionDurationSampleCount + 1, TRANSACTION_DURATION_SAMPLE_COUNT);
            this._transactionPeakBlobBytes = Math.max(this._transactionPeakBlobBytes, plan.metrics.blobBytes);
            this._transactionPeakLogicalRows = Math.max(this._transactionPeakLogicalRows, plan.metrics.logicalRows);
            this._transactionPeakSqlExecs = Math.max(this._transactionPeakSqlExecs, plan.metrics.sqlExecs);
            this._transactionPeakAffectedPaths = Math.max(this._transactionPeakAffectedPaths, plan.metrics.affectedPaths);
            if (execution.limitMode === 'bounded') {
                this._boundedTransactionPeakBlobBytes = Math.max(this._boundedTransactionPeakBlobBytes, plan.metrics.blobBytes);
                this._boundedTransactionPeakLogicalRows = Math.max(this._boundedTransactionPeakLogicalRows, plan.metrics.logicalRows);
                this._boundedTransactionPeakSqlExecs = Math.max(this._boundedTransactionPeakSqlExecs, plan.metrics.sqlExecs);
            }
            this._lastTransaction = { metrics: plan.metrics, execution };
            this._activeTransaction = null;
        }
    }
    /**
     * Bounded, idempotent content maintenance. Age only orders work; durable
     * reference checks in each mutation transaction are the deletion authority.
     */
    runContentMaintenance(maxTransactions = 4) {
        let transactions = 0;
        const maximum = clampNonNegativeInt(maxTransactions);
        let orphanScanComplete = true;
        let stagingScanComplete = true;
        if (transactions < maximum) {
            const orphanRows = [...this.sql.exec(`SELECT chunks.content_id
         FROM file_chunks AS chunks
         WHERE NOT EXISTS (
             SELECT 1 FROM content_lifecycle AS lifecycle
             WHERE lifecycle.content_id = chunks.content_id
           )
           AND ${sqlNoInodeContentReference('chunks.content_id')}
         GROUP BY chunks.content_id
         ORDER BY chunks.content_id
         LIMIT ?`, CONTENT_IDS_PER_SQL_EXEC)];
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
                this.executeMeasuredTransaction(plan, { source: 'content-gc', limitMode: 'bounded' }, () => {
                    this.sql.exec(`INSERT OR IGNORE INTO content_lifecycle (content_id, state, created_at)
               SELECT candidate.content_id, 'gc', ?
               FROM (${candidates}) AS candidate
               WHERE EXISTS (
                   SELECT 1 FROM file_chunks
                   WHERE file_chunks.content_id = candidate.content_id
                 )
                 AND ${sqlNoInodeContentReference('candidate.content_id')}`, Date.now(), ...contentIds);
                });
                transactions++;
            }
        }
        if (transactions < maximum) {
            const stagingRows = [...this.sql.exec(`SELECT lifecycle.content_id
         FROM content_lifecycle AS lifecycle
         WHERE lifecycle.state = 'staging'
           AND ${sqlNoInodeContentReference('lifecycle.content_id')}
         ORDER BY lifecycle.created_at, lifecycle.content_id
         LIMIT ?`, CONTENT_IDS_PER_SQL_EXEC)];
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
                this.executeMeasuredTransaction(plan, { source: 'content-gc', limitMode: 'bounded' }, () => {
                    this.sql.exec(`UPDATE content_lifecycle AS lifecycle
               SET state = 'gc'
               WHERE lifecycle.state = 'staging'
                 AND lifecycle.content_id IN (${placeholders})
                 AND ${sqlNoInodeContentReference('lifecycle.content_id')}`, ...contentIds);
                });
                transactions++;
            }
        }
        while (transactions < maximum) {
            const lifecycle = [...this.sql.exec(`SELECT lifecycle.content_id
         FROM content_lifecycle AS lifecycle
         WHERE lifecycle.state = 'gc'
           AND ${sqlNoInodeContentReference('lifecycle.content_id')}
         ORDER BY lifecycle.created_at, lifecycle.content_id
         LIMIT 1`)];
            if (lifecycle.length === 0)
                break;
            const contentId = String(lifecycle[0].content_id);
            const candidates = [...this.sql.exec(`SELECT chunk_id, length(data) AS byte_length
         FROM file_chunks
         WHERE content_id = ?
         ORDER BY chunk_id
         LIMIT ?`, contentId, Math.min(MAX_TX_LOGICAL_ROWS - 1, CHUNK_ROWS_PER_SQL_EXEC))];
            const chunkIds = [];
            let blobBytes = 0;
            for (const row of candidates) {
                const byteLength = clampNonNegativeInt(Number(row.byte_length));
                if (chunkIds.length > 0 && blobBytes + byteLength > MAX_TX_BLOB_BYTES)
                    break;
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
            this.executeMeasuredTransaction(plan, { source: 'content-gc', limitMode: 'bounded' }, () => {
                if (chunkIds.length > 0) {
                    const placeholders = chunkIds.map(() => '?').join(',');
                    this.sql.exec(`DELETE FROM file_chunks
               WHERE content_id = ?
                 AND chunk_id IN (${placeholders})
                 AND EXISTS (
                   SELECT 1 FROM content_lifecycle
                   WHERE content_lifecycle.content_id = ?
                     AND content_lifecycle.state = 'gc'
                 )
                 AND ${sqlNoInodeContentReference('?')}`, contentId, ...chunkIds, contentId, contentId, contentId);
                }
                this.sql.exec(`DELETE FROM content_lifecycle AS lifecycle
             WHERE lifecycle.content_id = ?
               AND lifecycle.state = 'gc'
               AND ${sqlNoInodeContentReference('lifecycle.content_id')}
               AND NOT EXISTS (
                 SELECT 1 FROM file_chunks
                 WHERE file_chunks.content_id = lifecycle.content_id
               )`, contentId);
            });
            transactions++;
        }
        if (maximum > 0) {
            const hasGcBacklog = transactions >= maximum && [...this.sql.exec(`SELECT 1
         FROM content_lifecycle AS lifecycle
         WHERE lifecycle.state = 'gc'
           AND ${sqlNoInodeContentReference('lifecycle.content_id')}
         LIMIT 1`)].length > 0;
            this.maintenancePending = !orphanScanComplete || !stagingScanComplete || hasGcBacklog;
        }
        return { transactions };
    }
    runContentMaintenanceSafely(maxTransactions, force = false) {
        if (!force && !this.maintenancePending)
            return;
        const startedAt = performance.now();
        try {
            this.runContentMaintenance(maxTransactions);
        }
        catch (error) {
            this.maintenancePending = true;
            console.error('[sqlite-vfs] content maintenance failed:', this.errorMessage(error));
        }
        finally {
            this.recordDuration(this._maintenanceDuration, performance.now() - startedAt);
        }
    }
    metricsOnlyPlan(metrics) {
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
    recordOverLimitFile(path, limit, metrics) {
        this._overLimitFileCount++;
        this._lastOverLimitFile = { path, limit, ...metrics };
    }
    recordDuration(summary, durationMs) {
        summary.count++;
        summary.totalMs += durationMs;
        summary.lastMs = durationMs;
        summary.maxMs = Math.max(summary.maxMs, durationMs);
    }
    currentRetainedWriteBytes() {
        return this.writeStreamCredits.stats.current;
    }
    /** Best-effort process.memoryUsage().heapUsed; 0 in DO contexts. */
    _safeHeapUsed() {
        try {
            const mu = globalThis.process?.memoryUsage?.();
            return Number(mu?.heapUsed) || 0;
        }
        catch {
            return 0;
        }
    }
    prepareBatchTransaction(payload, allocateContentIds) {
        const deletedInodes = this.collectBatchDeletions(payload.deletePaths ?? []);
        const deletedInodesByPath = new Map(deletedInodes.map((inode) => [inode.path, inode]));
        const builder = new TransactionPlanBuilder();
        const deletedPaths = new Set(payload.deletePaths ?? []);
        for (const inode of deletedInodes)
            deletedPaths.add(inode.path);
        for (const path of deletedPaths) {
            const inode = deletedInodesByPath.get(path);
            builder.addDeletedPath(path, inode);
            if (inode && !inode.isDir)
                builder.addGcContent(this.contentIdForInode(inode));
        }
        const normalizedInodes = new Map();
        for (const entry of payload.inodes) {
            this.validateInodeContentShape(entry);
            const kind = inodeKind(entry);
            normalizedInodes.set(entry.path, {
                ...entry,
                kind,
                isDir: kind === 'directory',
                uid: entry.uid ?? 1000,
                gid: entry.gid ?? 1000,
            });
        }
        const chunksByPath = new Map();
        for (const chunk of payload.chunks) {
            const entries = chunksByPath.get(chunk.path);
            if (entries)
                entries.push(chunk);
            else
                chunksByPath.set(chunk.path, [chunk]);
        }
        const contentIds = new Map();
        const reservedContentIds = allocateContentIds ? new Set() : undefined;
        let preflightContentIndex = 0;
        for (const entry of normalizedInodes.values()) {
            const prior = this.inodes.get(entry.path);
            if (entry.isDir) {
                if ((chunksByPath.get(entry.path)?.length ?? 0) > 0) {
                    throw new Error(`EINVAL: directory batch entry has chunks: ${entry.path}`);
                }
                builder.addInode({ ...entry, kind: inodeKind(entry), contentId: null });
            }
            else {
                const fileChunks = chunksByPath.get(entry.path) ?? [];
                this.validateFileChunks(entry, fileChunks);
                const contentId = allocateContentIds
                    ? this.createContentId(reservedContentIds)
                    : `preflight:${preflightContentIndex++}`;
                contentIds.set(entry.path, contentId);
                builder.addStagingContent(contentId);
                builder.addInode({ ...entry, kind: inodeKind(entry), contentId });
                builder.addPublishedContent(contentId);
            }
            if (prior && !prior.isDir)
                builder.addGcContent(this.contentIdForInode(prior));
        }
        for (const entry of payload.chunks) {
            const contentId = contentIds.get(entry.path)
                ?? (() => {
                    const inode = this.inodes.get(entry.path);
                    if (!inode || inode.kind !== 'file') {
                        throw new Error(`EINVAL: chunk has no regular file inode: ${entry.path}`);
                    }
                    return this.contentIdForInode(inode);
                })();
            builder.addChunk({ ...entry, contentId });
        }
        return {
            payload: { ...payload, inodes: [...normalizedInodes.values()] },
            plan: builder.build(),
            deletedInodes,
        };
    }
    validateFileChunks(inode, chunks) {
        this.validateInodeContentShape(inode);
        if (inode.chunkCount !== chunks.length) {
            throw new Error(`EINVAL: ${inode.path}: expected ${inode.chunkCount} chunks, got ${chunks.length}`);
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
                throw new Error(`EINVAL: ${inode.path}: chunk ${index} has ${chunk.data.byteLength} bytes; expected ${expected}`);
            }
            total += chunk.data.byteLength;
        }
        if (total !== inode.size) {
            throw new Error(`EINVAL: ${inode.path}: chunk bytes ${total} do not match size ${inode.size}`);
        }
    }
    validateInodeContentShape(inode) {
        const kind = inodeKind(inode);
        const expectedParent = this.parentPath(inode.path);
        if (inode.parentPath !== expectedParent) {
            throw new Error(`EINVAL: ${inode.path}: parentPath ${inode.parentPath} does not match ${expectedParent}`);
        }
        if (inode.isDir !== (kind === 'directory')) {
            throw new Error(`EINVAL: ${inode.path}: inode kind ${kind} conflicts with isDir=${inode.isDir}`);
        }
        if (!Number.isSafeInteger(inode.size) || inode.size < 0) {
            throw new Error(`EINVAL: ${inode.path}: invalid size ${inode.size}`);
        }
        if (!Number.isSafeInteger(inode.chunkCount) || inode.chunkCount < 0) {
            throw new Error(`EINVAL: ${inode.path}: invalid chunk count ${inode.chunkCount}`);
        }
        if (kind === 'directory' && inode.size !== 0) {
            throw new Error(`EINVAL: ${inode.path}: directory size must be zero`);
        }
        const expectedChunkCount = kind === 'directory' || inode.size === 0
            ? 0
            : Math.ceil(inode.size / CHUNK_SIZE);
        if (inode.chunkCount !== expectedChunkCount) {
            throw new Error(`EINVAL: ${inode.path}: expected ${expectedChunkCount} chunks for ${inode.size} bytes, got ${inode.chunkCount}`);
        }
    }
    assertTransactionFits(metrics) {
        const limit = exceededTransactionLimit(metrics);
        if (limit === null)
            return;
        const maximum = limit === 'blobBytes'
            ? MAX_TX_BLOB_BYTES
            : limit === 'logicalRows'
                ? MAX_TX_LOGICAL_ROWS
                : MAX_TX_SQL_EXECS;
        throw new SqliteVfsTransactionTooLargeError(limit, metrics[limit], maximum, metrics);
    }
    _writeBatchOnce(prepared, execution, publishedChunkCount, onCommit) {
        const { payload, plan, deletedInodes } = prepared;
        try {
            this.executeTransactionPlan(plan, execution, onCommit);
        }
        catch (error) {
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
            }
            else {
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
        const __diag = (globalThis.process?.env?.NIMBUS_DIAG_INSTALL_PIPELINE === '1');
        const replacedPaths = new Set();
        for (const entry of plan.inodes) {
            const prior = this.inodes.get(entry.path);
            if (prior !== undefined)
                replacedPaths.add(entry.path);
            const atime = entry.atime !== undefined && Number.isFinite(entry.atime) ? entry.atime : entry.mtime;
            const node = {
                path: entry.path,
                parentPath: entry.parentPath,
                kind: entry.kind,
                isDir: entry.isDir,
                size: entry.size,
                atime,
                mtime: entry.mtime,
                mode: entry.mode,
                uid: entry.uid,
                gid: entry.gid,
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
                console.warn('[sqlite-vfs/W2.5b] stale-prior path=' + entry.path +
                    ' parent=' + entry.parentPath +
                    ' priorParent=' + prior.parentPath +
                    ' priorIsDir=' + prior.isDir +
                    ' entryIsDir=' + entry.isDir +
                    ' indexedBefore=' + indexed);
            }
            // Counter delta — gated on prior so we don't double-count.
            if (prior === undefined) {
                if (entry.isDir)
                    this._totalDirs++;
                else {
                    this._totalFiles++;
                    this._usedBytes += entry.size;
                }
            }
            else {
                // Replace: handle dir↔file flip + size delta. (Identical to pre-W2.5a.)
                if (prior.isDir && !entry.isDir) {
                    this._totalDirs--;
                    this._totalFiles++;
                    this._usedBytes += entry.size;
                }
                else if (!prior.isDir && entry.isDir) {
                    this._totalFiles--;
                    this._usedBytes -= prior.size;
                    this._totalDirs++;
                }
                else if (!entry.isDir) {
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
            const touched = new Set(plan.affectedPaths);
            for (const entry of plan.inodes)
                touched.add(entry.path);
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
        return { inodes: inodeCount, chunks: chunkCount };
    }
    collectBatchDeletions(deletePaths) {
        if (deletePaths.length === 0)
            return [];
        const roots = new Set(deletePaths);
        const deleted = [];
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
    mkdirBatch(paths, cred) {
        this.assertMutationsAllowed(paths);
        const mtime = Date.now();
        const toCreate = [];
        const seen = new Set();
        for (const path of paths) {
            const parts = path.split('/').filter(Boolean);
            let current = '';
            for (const part of parts) {
                current = current ? current + '/' + part : part;
                if (!seen.has(current) && !this.exists(current, cred)) {
                    seen.add(current);
                    toCreate.push({
                        path: current,
                        parentPath: this.parentPath(current),
                        isDir: true,
                        size: 0,
                        mtime,
                        mode: 0o777,
                        uid: cred.uid,
                        gid: cred.gid,
                        chunkCount: 0,
                    });
                }
            }
        }
        if (toCreate.length === 0)
            return 0;
        this.writeBatch({ inodes: toCreate, chunks: [] }, cred);
        return toCreate.length;
    }
    // ── Stats ─────────────────────────────────────────────────────────────
    /**
     * Debug-only: recompute counters from scratch and return any drift
     * against the running counters. Returns null if consistent. Used by
     * the B3 runtime test; production paths should never call this
     * (the whole point of B3 is avoiding the O(N) walk).
     */
    _verifyCounters() {
        let f = 0, d = 0, b = 0;
        for (const inode of this.inodes.values()) {
            if (inode.isDir)
                d++;
            else {
                f++;
                b += inode.size;
            }
        }
        if (f === this._totalFiles && d === this._totalDirs && b === this._usedBytes)
            return null;
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
        let activeCreditWaitDuration = 0;
        for (const startedAt of this._creditWaitStarts.values()) {
            activeCreditWaitDuration += now - startedAt;
        }
        const activeMetrics = this._activeTransaction?.plan.metrics ?? null;
        const creditStats = this.writeStreamCredits.stats;
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
                // Legacy names alias the same credited logical payload counter. The
                // 8 MiB pool includes both a decoded chunk record and staged buckets.
                writeStreamSpoolBytes: creditStats.current,
                retainedWriteBytes: {
                    current: this.currentRetainedWriteBytes(),
                    peak: creditStats.peak,
                },
                decoderRetainedBytes: {
                    current: creditStats.current,
                    peak: creditStats.peak,
                },
                creditRetainedBytes: {
                    current: creditStats.current,
                    peak: creditStats.peak,
                    limit: MAX_GLOBAL_WRITE_STREAM_CREDIT_BYTES,
                    queued: creditStats.queued,
                },
                stagedBytes: {
                    current: this._stagedStreamBytes,
                    peak: this._peakStagedStreamBytes,
                },
                gcBytes: { current: 0, peak: 0 },
                phases: {
                    decodeDrainWaitMs: durationSnapshot(this._decodeDrainDuration, activeDecodeDrainDuration),
                    creditWaitMs: durationSnapshot(this._creditWaitDuration, activeCreditWaitDuration),
                    // count is the number of content-maintenance runs.
                    maintenanceMs: durationSnapshot(this._maintenanceDuration, 0),
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
                        p95: recentPercentile(this._transactionDurationSamples, this._transactionDurationSampleCount, 0.95),
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
function inodeKind(inode) {
    const kind = inode.kind ?? (inode.isDir ? 'directory' : 'file');
    if (kind !== 'file' && kind !== 'directory' && kind !== 'symlink') {
        throw new Error(`EINVAL: invalid inode kind ${String(kind)}`);
    }
    return kind;
}
function inodeKindCode(kind) {
    if (kind === 'file')
        return INODE_KIND_FILE;
    if (kind === 'directory')
        return INODE_KIND_DIRECTORY;
    if (kind === 'symlink')
        return INODE_KIND_SYMLINK;
    throw new Error(`EINVAL: invalid inode kind ${String(kind)}`);
}
function inodeKindFromCode(code) {
    if (code === INODE_KIND_FILE)
        return 'file';
    if (code === INODE_KIND_DIRECTORY)
        return 'directory';
    if (code === INODE_KIND_SYMLINK)
        return 'symlink';
    throw new Error(`EIO: invalid durable inode kind ${code}`);
}
/** POSIX S_IFMT filetype bits for a stored st_mode (S_IFREG/S_IFDIR/S_IFLNK). */
function inodeTypeBits(kind) {
    if (kind === 'file')
        return 0o100000;
    if (kind === 'directory')
        return 0o040000;
    return 0o120000;
}
function batchMutationPaths(payload) {
    const paths = new Set(payload.deletePaths ?? []);
    for (const inode of payload.inodes)
        paths.add(inode.path);
    for (const chunk of payload.chunks)
        paths.add(chunk.path);
    return paths;
}
function pathsOverlap(left, right) {
    return left === ''
        || right === ''
        || left === right
        || left.startsWith(`${right}/`)
        || right.startsWith(`${left}/`);
}
function vfsError(code, message) {
    return Object.assign(new Error(`${code}: ${message}`), { code });
}
/**
 * Seekable form of the durable reference probe
 * `NOT EXISTS (... WHERE inodes.kind != 1 AND COALESCE(inodes.content_id,
 * inodes.path) = <ref>)`. SQLite cannot seek an expression index from a
 * correlated subquery (the probe degrades to a per-outer-row SCAN of inodes,
 * making the orphan scan O(chunks × inodes)), so the generated-content and
 * legacy path-keyed cases are split into two probes that seek plain-column
 * indexes: idx_inodes_content and the path primary key. `ref` is a column
 * reference or a `?` placeholder; with `?` the value must be bound twice.
 */
function sqlNoInodeContentReference(ref) {
    return `NOT EXISTS (
       SELECT 1 FROM inodes
       WHERE inodes.kind != 1 AND inodes.content_id = ${ref}
     )
     AND NOT EXISTS (
       SELECT 1 FROM inodes
       WHERE inodes.kind != 1 AND inodes.content_id IS NULL AND inodes.path = ${ref}
     )`;
}
function emptyDurationSummary() {
    return { count: 0, totalMs: 0, lastMs: 0, maxMs: 0 };
}
function durationSnapshot(summary, current) {
    return {
        current,
        count: summary.count,
        total: summary.totalMs,
        last: summary.lastMs,
        max: summary.maxMs,
    };
}
function recentPercentile(samples, count, percentile) {
    if (count === 0)
        return 0;
    const sorted = Array.from(samples.subarray(0, count)).sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * percentile) - 1);
    return sorted[index] ?? 0;
}
function clampNonNegativeInt(value) {
    return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}
// ── SqliteVFSProvider (MountProvider for Nimbus Kernel VFS) ────────────────────
export class SqliteVFSProvider {
    raw;
    vfs;
    prefix;
    constructor(vfs, prefix, cred = CRED_KERNEL) {
        this.raw = vfs;
        this.vfs = vfs.as(cred);
        this.prefix = prefix.replace(/^\/+/, '').replace(/\/+$/, '');
    }
    as(cred) { return new SqliteVFSProvider(this.raw, this.prefix, cred); }
    resolve(sub) {
        const c = sub.replace(/^\/+/, '').replace(/\/+$/, '');
        return c ? this.prefix + '/' + c : this.prefix;
    }
    readFile(sub) { return this.vfs.readFile(this.resolve(sub)); }
    readFileString(sub) { return this.vfs.readFileString(this.resolve(sub)); }
    readRange(sub, offset, length) {
        return this.vfs.readRange(this.resolve(sub), offset, length);
    }
    writeFile(sub, content) {
        const fp = this.resolve(sub);
        const pp = fp.includes('/') ? fp.substring(0, fp.lastIndexOf('/')) : '';
        if (pp && !this.vfs.exists(pp))
            this.vfs.mkdir(pp, { recursive: true });
        this.vfs.writeFile(fp, content);
    }
    writeRange(sub, offset, bytes) {
        const fp = this.resolve(sub);
        const pp = fp.includes('/') ? fp.substring(0, fp.lastIndexOf('/')) : '';
        if (pp && !this.vfs.exists(pp))
            this.vfs.mkdir(pp, { recursive: true });
        this.vfs.writeRange(fp, offset, bytes);
    }
    truncate(sub, size) { this.vfs.truncate(this.resolve(sub), size); }
    exists(sub) { return this.vfs.exists(this.resolve(sub)); }
    access(sub, mode) { this.vfs.access(this.resolve(sub), mode); }
    stat(sub) { return this.vfs.stat(this.resolve(sub)); }
    readdir(sub) { return this.vfs.readdir(this.resolve(sub)); }
    unlink(sub) { this.vfs.unlink(this.resolve(sub)); }
    mkdir(sub, opts) {
        this.vfs.mkdir(this.resolve(sub), opts);
    }
    rmdir(sub) { this.vfs.rmdir(this.resolve(sub)); }
    rename(o, n) { this.vfs.rename(this.resolve(o), this.resolve(n)); }
    copyFile(s, d) { this.vfs.copyFile(this.resolve(s), this.resolve(d)); }
    chmod(sub, mode) { this.vfs.chmod(this.resolve(sub), mode); }
    chown(sub, uid, gid) {
        this.vfs.chown(this.resolve(sub), uid, gid);
    }
}
