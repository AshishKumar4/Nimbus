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
import { VfsEventEmitter } from './events.js';
import { normalizeVfsPath } from './path.js';
import { LRU_MAX_ENTRIES, FS_LIST_PAGE_LIMIT, INODE_CACHE_MAX_ENTRIES, } from '../constants.js';
import { CHUNK_SIZE, MAX_TX_BLOB_BYTES, MAX_TX_LOGICAL_ROWS, MAX_TX_SQL_EXECS, MAX_GLOBAL_WRITE_STREAM_CREDIT_BYTES, SQL_MAX_BOUND_PARAMETERS, } from '@nimbus-sh/platform/limits.js';
import { recordFailure } from '@nimbus-sh/platform/oom-discriminator.js';
import { classifyError } from '@nimbus-sh/platform/oom-classify.js';
import { acquireSupervisorAllocation } from '@nimbus-sh/platform/heavy-alloc-coord.js';
import { enc, dec } from '../_shared/bytes.js';
import { decodeWriteBatchStream, } from '@nimbus-sh/platform/w7-frame.js';
import { WeightedCreditPool, } from '@nimbus-sh/platform/weighted-credit-pool.js';
import { LEGACY_SYMLINK_REGISTRY_PATH } from './symlink-registry.js';
import { CDC_MIN, ContentCutter, EMPTY_CONTENT_KEY, ManifestDigest, chunkHash, cutContent, hex, } from './content-chunking.js';
import { CRED_KERNEL, } from '../runtime/os-contracts.js';
/** Schema version of the v2 content store. */
const VFS_SCHEMA = 2;
/**
 * Live view of the global object. `process` is not in the Workers lib, so its
 * shape is declared here rather than assumed present.
 */
const nodeHost = globalThis;
const INODE_ROW_COLUMNS = 14;
const CHUNK_ROW_COLUMNS = 4;
const MANIFEST_ROW_COLUMNS = 4;
const CONTENT_ROW_COLUMNS = 6;
const GC_ROW_COLUMNS = 2;
export const INODE_ROWS_PER_SQL_EXEC = Math.floor(SQL_MAX_BOUND_PARAMETERS / INODE_ROW_COLUMNS);
const CHUNK_ROWS_PER_SQL_EXEC = Math.floor(SQL_MAX_BOUND_PARAMETERS / CHUNK_ROW_COLUMNS);
const MANIFEST_ROWS_PER_SQL_EXEC = Math.floor(SQL_MAX_BOUND_PARAMETERS / MANIFEST_ROW_COLUMNS);
const CONTENT_ROWS_PER_SQL_EXEC = Math.floor(SQL_MAX_BOUND_PARAMETERS / CONTENT_ROW_COLUMNS);
const GC_ROWS_PER_SQL_EXEC = Math.floor(SQL_MAX_BOUND_PARAMETERS / GC_ROW_COLUMNS);
const TOMBSTONE_ROWS_PER_SQL_EXEC = Math.floor(SQL_MAX_BOUND_PARAMETERS / 2);
/**
 * Tombstones kept for invalidatedSince to answer cursors older than the
 * in-memory log from SQL. Past this the oldest go, a page per maintenance
 * call, and the floor rises: a cursor below it poisons.
 */
const TOMBSTONE_RETAIN_ROWS = 65_536;
const TOMBSTONE_PRUNE_PAGE_ROWS = 2_048;
/** Paths an answer from SQL may carry; past it the caller reconciles against list(). */
const SQL_DELTA_MAX_PATHS = 16_384;
/** Keys in one `IN (…)` list, leaving room for a statement's other parameters. */
const KEYS_PER_SQL_EXEC = SQL_MAX_BOUND_PARAMETERS - 10;
/**
 * Largest file whose manifest a read keeps whole (FastCDC cuts at least every
 * CDC_MIN bytes, so ≤ 256 rows), and manifests kept: ≈ 1 MiB of heap at most.
 */
const MANIFEST_KEPT_BYTES = 256 * CDC_MIN;
const MANIFEST_WINDOWS = 64;
/** A history row read as the inode it was: its generation is gen_from. */
const HISTORY_SELECT_COLUMNS = 'path, parent_path, kind, size, atime, mtime, ctime, mode, uid, gid, ino, gen_from AS gen, chunk_id, content_id';
/** Paths one restore transaction changes, and history rows one drop transaction examines. */
const RESTORE_PAGE_ROWS = 200;
/** Lookups one snapshot view caches. */
const SNAPSHOT_VIEW_CACHE_ENTRIES = 4096;
const DROP_PAGE_ROWS = 200;
/** Inode rows one copyTree transaction copies. */
const COPY_PAGE_ROWS = 250;
/** Manifest rows one copy transaction moves. */
const MANIFEST_PAGE_ROWS = 200;
/** Manifest rows one GC transaction drains: each also queues its chunk, and the page's content ids ride along. */
const GC_MANIFEST_ROWS = Math.floor((MAX_TX_LOGICAL_ROWS - KEYS_PER_SQL_EXEC) / 2);
const TRANSACTION_DURATION_SAMPLE_COUNT = 128;
/** Storage key of the shared scratch tree. `normalizeVfsPath` drops the slash. */
const TMP_ROOT = 'tmp';
export const VFS_APPEND_RECEIPT_LIMIT = 2048;
const INODE_KIND_FILE = 0;
const INODE_KIND_DIRECTORY = 1;
const INODE_KIND_SYMLINK = 2;
/** The inode columns `inodeFromRow` reads. */
const INODE_SELECT_COLUMNS = 'path, parent_path, kind, size, atime, mtime, ctime, mode, uid, gid, ino, gen, chunk_id, content_id';
const INODE_SELECT_COLUMNS_AS_I = INODE_SELECT_COLUMNS.split(', ').map((column) => `i.${column}`).join(', ');
/** Rows one page of a subtree walk holds: a bound on its heap, not on the tree. */
const SUBTREE_PAGE_ROWS = 4096;
/** vfs_gc_queue kinds. */
const GC_CHUNK = 0;
const GC_CONTENT = 1;
/** vfs_contents states. */
const CONTENT_STAGING = 0;
const CONTENT_LIVE = 1;
const CONTENT_DYING = 2;
/**
 * Tables of the pre-v2 layout. v2 ignores their rows and a bounded janitor
 * deletes them; the columns named identify ours, so a host table that merely
 * shares a name is left alone.
 */
const LEGACY_TABLES = [
    { name: 'file_chunks', columns: ['content_id', 'chunk_id', 'data'] },
    { name: 'inodes', columns: ['path', 'parent_path', 'size', 'mode'] },
    { name: 'content_lifecycle', columns: ['content_id', 'state', 'created_at'] },
    { name: 'vfs_ino_allocator', columns: ['slot', 'next'] },
    { name: 'vfs_schema_migrations', columns: ['id', 'applied_at'] },
    { name: 'fs_objects', columns: ['path', 'chunk_index', 'data'] },
];
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
/** Chunk and manifest rows a file of `size` bytes costs at most. */
function pieceRows(size) {
    if (size === 0)
        return { pieces: 0, manifest: 0 };
    if (size <= CHUNK_SIZE)
        return { pieces: 1, manifest: 0 };
    // FastCDC cuts below CDC_MIN only at the end, so this bounds the count.
    const pieces = Math.ceil(size / CDC_MIN);
    return { pieces, manifest: pieces };
}
class TransactionPlanBuilder {
    history;
    inodes = [];
    deletes = [];
    staged = [];
    stagingCreated = [];
    gcRefs = [];
    affectedPaths = new Set();
    blobBytes = 0;
    pieces = 0;
    manifestRows = 0;
    contentRows = 0;
    rewrites = 0;
    edits = 0;
    fileRows = 0;
    gcRefCount = 0;
    /** `history`: a snapshot is pinned, so replaced rows keep before-images. */
    constructor(history) {
        this.history = history;
    }
    addInode(entry) {
        this.inodes.push(entry);
        this.affectedPaths.add(entry.path);
        if (!entry.isDir)
            this.fileRows++;
        const content = entry.content;
        switch (content.type) {
            case 'small':
                this.pieces++;
                this.blobBytes += content.piece.data.byteLength;
                break;
            case 'large':
                this.pieces += content.pieces.length;
                this.manifestRows += content.pieces.length;
                this.contentRows++;
                this.blobBytes += content.size;
                break;
            case 'staged':
                this.contentRows++;
                break;
            case 'rewrite':
                this.pieces++;
                this.rewrites++;
                this.blobBytes += content.piece.data.byteLength;
                break;
            case 'edit':
                this.edits++;
                // The rows it replaces queue their chunks: about as many as it writes.
                this.gcRefCount += content.pieces.length + 1;
                this.pieces += content.pieces.length;
                this.manifestRows += content.pieces.length;
                for (const { piece } of content.pieces)
                    this.blobBytes += piece.data.byteLength;
                break;
            default:
                break;
        }
    }
    /** Create a staging content's row in this transaction. */
    addStaging(content) {
        this.stagingCreated.push(content);
        this.contentRows++;
    }
    /** Append one chunk to a staging content's manifest. */
    addStagedPiece(content, piece, path) {
        if (content.id === 0 && !this.stagingCreated.includes(content)) {
            this.stagingCreated.push(content);
            this.contentRows++;
        }
        this.staged.push({ content, off: content.size, piece });
        content.size += piece.data.byteLength;
        content.count++;
        content.digest.add(piece.hash);
        this.pieces++;
        this.manifestRows++;
        this.blobBytes += piece.data.byteLength;
        this.affectedPaths.add(path);
    }
    addDeletedPath(path, prior, dereference = true) {
        this.deletes.push({ path, prior, dereference });
        this.affectedPaths.add(path);
        if (dereference && prior !== undefined && !prior.isDir)
            this.gcRefCount++;
    }
    addGcRef(ref) {
        this.gcRefs.push(ref);
    }
    wouldExceedPieces(additionalBlobBytes, additionalPieces) {
        return exceededTransactionLimit(this.metricsWith({
            blobBytes: additionalBlobBytes,
            pieces: additionalPieces,
            manifestRows: additionalPieces,
            contentRows: 1,
        }));
    }
    /**
     * Would admitting one whole file — every chunk, its manifest, its inode and
     * the reference it replaces — exceed the bound? Answering before the first
     * chunk is staged keeps a file that fits one transaction out of staging.
     */
    wouldExceedFile(byteLength) {
        return exceededTransactionLimit(this.metricsWithFile(byteLength));
    }
    /** This plan's cost with one more whole file of `byteLength` bytes admitted. */
    metricsWithFile(byteLength) {
        const rows = pieceRows(byteLength);
        return this.metricsWith({
            blobBytes: byteLength,
            pieces: rows.pieces,
            manifestRows: rows.manifest,
            contentRows: rows.manifest > 0 ? 1 : 0,
            inodeRows: 1,
            paths: 1,
        });
    }
    /** Would one more inode row — and the path it touches — exceed the bound? */
    wouldExceedInode() {
        return exceededTransactionLimit(this.metricsWith({ inodeRows: 1, paths: 1 }));
    }
    /** Would one more removal exceed the bound? */
    wouldExceedDeletion() {
        return exceededTransactionLimit(this.metricsWith({ deletes: 1, paths: 1 }));
    }
    get empty() {
        return this.inodes.length === 0
            && this.deletes.length === 0
            && this.staged.length === 0
            && this.stagingCreated.length === 0
            && this.gcRefs.length === 0;
    }
    build() {
        return {
            inodes: this.inodes,
            deletes: this.deletes,
            staged: this.staged,
            stagingCreated: this.stagingCreated,
            gcRefs: this.gcRefs,
            affectedPaths: this.affectedPaths,
            metrics: this.metricsWith({}),
        };
    }
    /**
     * What this plan would cost with `addition` admitted. One formula serves
     * both the built plan and every admission test, so a bound can never be
     * checked against a different accounting than the one it commits under.
     * Counts are upper bounds: a deduplicated chunk writes no row.
     */
    metricsWith(addition) {
        const inodeRows = this.inodes.length + (addition.inodeRows ?? 0);
        const deletes = this.deletes.length + (addition.deletes ?? 0);
        const pieces = this.pieces + (addition.pieces ?? 0);
        const manifestRows = this.manifestRows + (addition.manifestRows ?? 0);
        const contentRows = this.contentRows + (addition.contentRows ?? 0);
        // Every replaced or removed file may queue one reference; directories name none.
        const gcRows = this.gcRefs.length + this.fileRows + (addition.inodeRows ?? 0) + this.gcRefCount + (addition.deletes ?? 0);
        const historyRows = this.history ? inodeRows + deletes : 0;
        return {
            blobBytes: this.blobBytes + (addition.blobBytes ?? 0),
            // A delete writes its tombstone too.
            logicalRows: inodeRows + deletes * 2 + pieces + manifestRows + contentRows + gcRows + historyRows,
            sqlExecs: 2
                + groupedSqlExecs(historyRows, KEYS_PER_SQL_EXEC)
                + groupedSqlExecs(deletes, KEYS_PER_SQL_EXEC)
                + groupedSqlExecs(deletes, TOMBSTONE_ROWS_PER_SQL_EXEC)
                + groupedSqlExecs(pieces, KEYS_PER_SQL_EXEC)
                + groupedSqlExecs(pieces, CHUNK_ROWS_PER_SQL_EXEC)
                + groupedSqlExecs(manifestRows, MANIFEST_ROWS_PER_SQL_EXEC)
                + groupedSqlExecs(contentRows, KEYS_PER_SQL_EXEC)
                + groupedSqlExecs(contentRows, CONTENT_ROWS_PER_SQL_EXEC)
                + contentRows
                + this.rewrites
                + this.edits * 3
                + groupedSqlExecs(inodeRows, INODE_ROWS_PER_SQL_EXEC)
                + groupedSqlExecs(gcRows, GC_ROWS_PER_SQL_EXEC),
            affectedPaths: this.affectedPaths.size + (addition.paths ?? 0),
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
/**
 * The inode cache: a bounded, write-through view of the `inodes` table.
 *
 * SQLite is the tree. `inodes` is keyed by path and indexed by parent, so any
 * one lookup is one indexed read and nothing needs the whole table in memory;
 * this saves the read for the paths in use. Absence here means "not cached",
 * never ENOENT: `get` falls through to SQLite, which is the authority.
 *
 * It stays coherent the way the always-resident map it replaces did: every
 * committed publication `set`s or `delete`s the paths it wrote.
 *
 * Two generations rather than a list: a hit in the young one is one Map
 * lookup, a hit in the old one promotes the entry, and when the young one
 * fills, the old one is dropped whole. At most `capacity` entries stay
 * resident, plus what open descriptions hold.
 *
 * An inode an open description holds is never dropped. Descriptions share the
 * canonical object, so a second descriptor sees chmod/chown/utimes at once and
 * an unlink leaves every holder on the same retired inode. A reload would hand
 * the next lookup a second object for the same file.
 */
class InodeTable {
    capacity;
    load;
    held;
    young = new Map();
    old = new Map();
    constructor(capacity, load, held) {
        this.capacity = capacity;
        this.load = load;
        this.held = held;
    }
    get size() {
        return this.young.size + this.old.size;
    }
    get(path) {
        const young = this.young.get(path);
        if (young !== undefined)
            return young;
        const old = this.old.get(path);
        if (old !== undefined) {
            this.old.delete(path);
            this.admit(path, old);
            return old;
        }
        const loaded = this.load(path);
        if (loaded !== undefined)
            this.admit(path, loaded);
        return loaded;
    }
    /** The cached object, if any, without reading SQLite. */
    peek(path) {
        return this.young.get(path) ?? this.old.get(path);
    }
    set(path, inode) {
        this.old.delete(path);
        this.admit(path, inode);
    }
    delete(path) {
        this.young.delete(path);
        this.old.delete(path);
    }
    clear() {
        this.young = new Map();
        this.old = new Map();
    }
    admit(path, inode) {
        this.young.set(path, inode);
        if (this.young.size * 2 < this.capacity)
            return;
        const dropped = this.old;
        this.old = this.young;
        this.young = new Map();
        for (const opened of this.held) {
            if (opened.path !== null && dropped.get(opened.path) === opened.inode) {
                this.young.set(opened.path, opened.inode);
            }
        }
    }
}
// ── SqliteVFS ───────────────────────────────────────────────────────────────
export class SqliteVFS {
    openNodes = new Set();
    sql;
    ctx;
    events;
    // ── INode cache (bounded; SQLite holds the tree) ──────────────────────
    inodes;
    // ── Chunk cache (LRU, 512 × ≤64KB = 32MB) ────────────────────────────
    // Keyed by chunk id. A chunk's bytes change only by an in-place rewrite of
    // an unshared chunk, which evicts it; deduplicated files share entries.
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
    // Replaces a scan of every inode on every /api/stats poll. One aggregate
    // over `inodes` loads them on the first read (ensureCounters); from then
    // on mkdir, batch writes/deletes and rename maintain them at committed
    // publication. Deltas applied before the load are overwritten by it.
    // Rollback unloads them, and the next read aggregates the durable rows.
    _countersLoaded = false;
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
    // so unrelated writes no longer invalidate them. The stamps are in memory;
    // a file without one reports its row's generation, and anything else the
    // floor, which starts at the clock at open.
    //
    // Bounded by bytes, like the invalidation log below: a million-file tree
    // written in one lifetime would otherwise hold a revision per path. Past
    // the budget the oldest quarter goes at once (dropOldestPathRevisions),
    // and a path with no entry reports _revisionFloor, the newest revision
    // dropped, which is at least the last revision of every path without an
    // entry. It must never report less: a resident row, a write receipt or an
    // expected revision compared against a smaller number would be vouched for
    // by a revision older than the path's last change. The floor only rises,
    // so a dropped path can report a higher revision with nothing under it
    // changed, which costs its readers a refetch, never a stale byte.
    _pathRevisions = new Map();
    _pathRevisionBytes = 0;
    _revisionFloor = 0;
    pathRevisionBudget;
    static PATH_REVISIONS_MAX_BYTES = 16 * 1024 * 1024;
    transactionPublication = null;
    // ── Invalidation log (facet cache coherence) ──────────────────────────
    // A facet's resident set is a cache of this VFS, and it learns what to
    // drop by asking `invalidatedSince(cursor)` for the delta. _pathRevisions
    // cannot serve that: it answers "what is the watermark under here", not
    // "what changed since when".
    //
    // The epoch names the clock. Revisions are durable generations
    // (vfs_state.gen), so they survive a supervisor restart, and the epoch is
    // the database's incarnation, created with it: a facet holding a cursor
    // from before a restart gets a delta, not a refill. What the epoch must
    // never allow is ABA, a cursor meeting a clock that went back and forward
    // over it with different writes: gens never regress within one database,
    // and a new database is a new incarnation. A storage point-in-time
    // recovery does regress gens and keeps the incarnation, so one must be
    // followed by rotateIncarnation().
    _epoch = '';
    /** invalidatedSince answers from SQL only above this: the newest pruned tombstone. */
    _tombstoneFloor = 0;
    _tombstoneRows = null;
    tombstoneRetain;
    _invalidations = [];
    _invalidationBytes = 0;
    /**
     * The log holds every publication after this revision: the clock at open,
     * then the newest revision an entry was dropped from. A cursor below it
     * cannot be served completely.
     */
    _invalidationFloor = 0;
    // Bounded by BYTES, not by entry count. An entry-count bound is not a
    // bound at all here: paths are unbounded in length, so N entries permit
    // unbounded memory — and this lives in the supervisor DO, the side that
    // is measurably memory-constrained and has been observed resetting under
    // allocation pressure. Overflow poisons the cursors that fall behind the
    // log, and a poisoned reader repairs itself against `list()`'s absolute
    // per-path revisions rather than by rebuying its whole cache — see
    // vfs/facet-resident-store.ts. So the budget can stay small even under the
    // continuous churn of an npm install, which must not be able to grow it.
    //
    // Note what this bound does NOT license: it is small because a poison is
    // CHEAP to recover from, and "cheap" is a property of the recovery path, not
    // of this file. It was not, once — a poison used to re-materialise the
    // reader's entire filesystem — and the two statements lived far enough apart
    // that the cost went unnoticed until it took an agent turn past the DO CPU
    // limit.
    static INVALIDATION_LOG_MAX_BYTES = 256 * 1024;
    /** Names the revision clock: this database's incarnation, stable across restarts. */
    get epoch() { return this._epoch; }
    /**
     * Start a new clock epoch: every cursor held against the old one poisons.
     * For a storage restore to an earlier point in time, which takes the
     * generations back under cursors facets still hold.
     */
    rotateIncarnation() {
        const incarnation = crypto.randomUUID();
        this.transactionSync(() => {
            this.sql.exec('UPDATE vfs_state SET incarnation = ? WHERE slot = 1', incarnation);
        });
        this._epoch = incarnation;
        this._invalidations = [];
        this._invalidationBytes = 0;
        this._invalidationFloor = this._revision;
        return incarnation;
    }
    exclusiveMutationLeases = new Map();
    activeMutationOwner = null;
    /** Shared by every concurrent stream targeting this session's VFS. */
    writeStreamCredits = new WeightedCreditPool(MAX_GLOBAL_WRITE_STREAM_CREDIT_BYTES);
    _stagedStreamBytes = 0;
    _peakStagedStreamBytes = 0;
    /**
     * Staging contents a live operation is still assembling. Durable state 0
     * alone does not protect them from GC: after a restart nothing is live, and
     * every state-0 content is garbage.
     */
    activeStagingContentIds = new Set();
    /** True only while vfs_gc_queue may hold work or a janitor has rows left. */
    maintenancePending = false;
    /** Resume points of the GC queue walk, per kind; pinned ids are stepped over. */
    gcCursor = [0, 0];
    /** Keyset cursor of the reference audit (chunks, then contents); null once done this lifetime. */
    auditCursor = { kind: GC_CHUNK, id: 0 };
    /** Legacy tables still holding rows, until the janitor drops them. */
    legacyTables = [];
    /** Last committed generation: every committed VFS transaction advances it. */
    _gen = 0;
    /** MAX(vfs_snapshots.gen), 0 without a snapshot. */
    _pinGen = 0;
    /** Whole manifests of recently read files up to MANIFEST_KEPT_BYTES, by content id (LRU). */
    manifestWindows = new Map();
    /** Snapshot generations by name, loaded on first use. */
    snapshotGens = null;
    /** writeStreams in flight, for snapshot's quiesce. */
    activeStreams = new Set();
    /** Content keys computed for manifests whose digest could not be stored. */
    contentKeyMemo = new Map();
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
    namespace;
    deviceId;
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
    constructor(sql, ctx, namespace, options = {}) {
        const inodeCacheEntries = options.inodeCacheEntries ?? INODE_CACHE_MAX_ENTRIES;
        if (!Number.isSafeInteger(inodeCacheEntries) || inodeCacheEntries < 2) {
            throw vfsError('EINVAL', `inode cache must hold at least 2 entries, not ${inodeCacheEntries}`);
        }
        const pathRevisionBytes = options.pathRevisionBytes ?? SqliteVFS.PATH_REVISIONS_MAX_BYTES;
        if (!Number.isSafeInteger(pathRevisionBytes) || pathRevisionBytes < 0) {
            throw vfsError('EINVAL', `per-path revision budget must be a byte count, not ${pathRevisionBytes}`);
        }
        this.pathRevisionBudget = pathRevisionBytes;
        this.tombstoneRetain = options.tombstoneRows ?? TOMBSTONE_RETAIN_ROWS;
        if (!Number.isSafeInteger(this.tombstoneRetain) || this.tombstoneRetain < 0) {
            throw vfsError('EINVAL', `tombstone retention must be a row count, not ${this.tombstoneRetain}`);
        }
        sql.exec('CREATE TABLE IF NOT EXISTS nimbus_filesystem_identity (slot INTEGER PRIMARY KEY CHECK(slot = 1), namespace TEXT NOT NULL)');
        if (namespace === undefined) {
            let row = [...sql.exec('SELECT namespace FROM nimbus_filesystem_identity WHERE slot = 1')][0];
            if (!row) {
                sql.exec('INSERT OR IGNORE INTO nimbus_filesystem_identity(slot, namespace) VALUES (1, ?)', crypto.randomUUID());
                row = [...sql.exec('SELECT namespace FROM nimbus_filesystem_identity WHERE slot = 1')][0];
                if (!row)
                    throw new Error('[sqlite-vfs] filesystem identity row missing after insert');
            }
            namespace = String(row.namespace);
        }
        if (!namespace || namespace.length > 256)
            throw vfsError('EINVAL', 'invalid filesystem namespace');
        this.namespace = namespace;
        sql.exec('CREATE TABLE IF NOT EXISTS nimbus_filesystem_devices (id INTEGER PRIMARY KEY AUTOINCREMENT, namespace TEXT NOT NULL UNIQUE)');
        let device = [...sql.exec('SELECT id FROM nimbus_filesystem_devices WHERE namespace = ?', namespace)][0];
        if (!device) {
            sql.exec('INSERT OR IGNORE INTO nimbus_filesystem_devices(namespace) VALUES (?)', namespace);
            device = [...sql.exec('SELECT id FROM nimbus_filesystem_devices WHERE namespace = ?', namespace)][0];
            if (!device)
                throw new Error('[sqlite-vfs] filesystem device row missing after insert');
        }
        this.deviceId = Number(device.id);
        this.sql = sql;
        this.ctx = ctx;
        this.events = new VfsEventEmitter();
        this.inodes = new InodeTable(inodeCacheEntries, (path) => this.loadInode(path), this.openNodes);
        this.initSchema();
        this.resumeAppendMaintenance();
        this.queueAbandonedStaging();
        this.resumeJobs();
        this.runContentMaintenanceSafely(2, true);
    }
    // ── Schema ────────────────────────────────────────────────────────────
    initSchema() {
        this.transactionSync(() => {
            this.sql.exec(`CREATE TABLE IF NOT EXISTS vfs_append_receipts_v2 (
        namespace TEXT NOT NULL,
        pid INTEGER NOT NULL,
        writer_id TEXT NOT NULL,
        module_id TEXT NOT NULL,
        operation_id INTEGER NOT NULL,
        path TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        digest TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (namespace, pid, writer_id, module_id, operation_id)
      )`);
            this.sql.exec(`CREATE TABLE IF NOT EXISTS vfs_append_writer_state_v2 (
        namespace TEXT NOT NULL,
        pid INTEGER NOT NULL,
        writer_id TEXT NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0,
        retired_at INTEGER,
        PRIMARY KEY (namespace, pid, writer_id)
      )`);
            this.sql.exec(`CREATE TABLE IF NOT EXISTS vfs_append_module_state_v2 (
        namespace TEXT NOT NULL,
        pid INTEGER NOT NULL,
        writer_id TEXT NOT NULL,
        module_id TEXT NOT NULL,
        acked_through INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (namespace, pid, writer_id, module_id)
      )`);
            this.sql.exec(`CREATE TABLE IF NOT EXISTS vfs_append_pid_revocations_v2 (
        namespace TEXT NOT NULL,
        pid INTEGER NOT NULL,
        retired_at INTEGER NOT NULL,
        PRIMARY KEY (namespace, pid)
      )`);
            this.sql.exec(`CREATE TABLE IF NOT EXISTS vfs_append_acked_gaps_v2 (
        namespace TEXT NOT NULL,
        pid INTEGER NOT NULL,
        writer_id TEXT NOT NULL,
        module_id TEXT NOT NULL,
        operation_id INTEGER NOT NULL,
        path TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        digest TEXT NOT NULL,
        PRIMARY KEY (namespace, pid, writer_id, module_id, operation_id)
      )`);
            // Every counter moves inside the transaction that consumes it.
            this.sql.exec(`CREATE TABLE IF NOT EXISTS vfs_state (
        slot INTEGER PRIMARY KEY CHECK (slot = 1),
        schema INTEGER NOT NULL,
        incarnation TEXT NOT NULL,
        gen INTEGER NOT NULL,
        pin_gen INTEGER NOT NULL,
        next_ino INTEGER NOT NULL,
        next_chunk INTEGER NOT NULL,
        next_content INTEGER NOT NULL,
        tomb_floor INTEGER NOT NULL
      )`);
            const state = [...this.sql.exec('SELECT schema FROM vfs_state WHERE slot = 1')][0];
            if (!state) {
                this.sql.exec('INSERT INTO vfs_state (slot, schema, incarnation, gen, pin_gen, next_ino, next_chunk, next_content, tomb_floor) VALUES (1, ?, ?, 0, 0, 1, 1, 1, 0)', VFS_SCHEMA, crypto.randomUUID());
            }
            else if (Number(state.schema) !== VFS_SCHEMA) {
                throw new Error(`[sqlite-vfs] unsupported filesystem schema ${String(state.schema)}`);
            }
            this.sql.exec(`CREATE TABLE IF NOT EXISTS vfs_inodes (
        path TEXT PRIMARY KEY,
        parent_path TEXT NOT NULL,
        kind INTEGER NOT NULL CHECK (kind IN (0, 1, 2)),
        size INTEGER NOT NULL,
        atime INTEGER NOT NULL,
        mtime INTEGER NOT NULL,
        ctime INTEGER NOT NULL,
        mode INTEGER NOT NULL,
        uid INTEGER NOT NULL,
        gid INTEGER NOT NULL,
        ino INTEGER NOT NULL,
        gen INTEGER NOT NULL,
        chunk_id INTEGER NULL,
        content_id INTEGER NULL,
        CHECK (chunk_id IS NULL OR content_id IS NULL)
      ) WITHOUT ROWID`);
            this.sql.exec('CREATE INDEX IF NOT EXISTS vfs_inodes_parent ON vfs_inodes(parent_path, kind)');
            this.sql.exec('CREATE INDEX IF NOT EXISTS vfs_inodes_gen ON vfs_inodes(gen)');
            this.sql.exec('CREATE INDEX IF NOT EXISTS vfs_inodes_chunk ON vfs_inodes(chunk_id) WHERE chunk_id IS NOT NULL');
            this.sql.exec('CREATE INDEX IF NOT EXISTS vfs_inodes_content ON vfs_inodes(content_id) WHERE content_id IS NOT NULL');
            // A 64 KiB row is far past WITHOUT ROWID's row-size guidance, so chunks
            // keep a rowid and their hash gets its own unique index.
            this.sql.exec(`CREATE TABLE IF NOT EXISTS vfs_chunks (
        id INTEGER PRIMARY KEY,
        hash BLOB NOT NULL,
        size INTEGER NOT NULL,
        data BLOB NOT NULL,
        state INTEGER NOT NULL DEFAULT 0
      )`);
            this.sql.exec('CREATE UNIQUE INDEX IF NOT EXISTS vfs_chunks_hash ON vfs_chunks(hash)');
            this.sql.exec(`CREATE TABLE IF NOT EXISTS vfs_contents (
        id INTEGER PRIMARY KEY,
        size INTEGER NOT NULL,
        chunk_count INTEGER NOT NULL,
        digest BLOB NULL,
        state INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )`);
            this.sql.exec('CREATE UNIQUE INDEX IF NOT EXISTS vfs_contents_digest ON vfs_contents(digest) WHERE digest IS NOT NULL');
            this.sql.exec('CREATE INDEX IF NOT EXISTS vfs_contents_staging ON vfs_contents(created_at) WHERE state = 0');
            this.sql.exec(`CREATE TABLE IF NOT EXISTS vfs_content_chunks (
        content_id INTEGER NOT NULL,
        off INTEGER NOT NULL,
        len INTEGER NOT NULL,
        chunk_id INTEGER NOT NULL,
        PRIMARY KEY (content_id, off)
      ) WITHOUT ROWID`);
            this.sql.exec('CREATE INDEX IF NOT EXISTS vfs_content_chunks_chunk ON vfs_content_chunks(chunk_id)');
            this.sql.exec(`CREATE TABLE IF NOT EXISTS vfs_inode_history (
        path TEXT NOT NULL,
        gen_to INTEGER NOT NULL,
        gen_from INTEGER NOT NULL,
        parent_path TEXT NOT NULL,
        kind INTEGER NOT NULL,
        size INTEGER NOT NULL,
        atime INTEGER NOT NULL,
        mtime INTEGER NOT NULL,
        ctime INTEGER NOT NULL,
        mode INTEGER NOT NULL,
        uid INTEGER NOT NULL,
        gid INTEGER NOT NULL,
        ino INTEGER NOT NULL,
        chunk_id INTEGER NULL,
        content_id INTEGER NULL,
        PRIMARY KEY (path, gen_to)
      ) WITHOUT ROWID`);
            this.sql.exec('CREATE INDEX IF NOT EXISTS vfs_history_parent ON vfs_inode_history(parent_path, gen_to)');
            this.sql.exec('CREATE INDEX IF NOT EXISTS vfs_history_gen ON vfs_inode_history(gen_to)');
            // One row per deleted path, written with the delete: what lets
            // invalidatedSince answer a cursor from before this incarnation's log.
            this.sql.exec(`CREATE TABLE IF NOT EXISTS vfs_tombstones (
        path TEXT PRIMARY KEY,
        gen INTEGER NOT NULL
      ) WITHOUT ROWID`);
            this.sql.exec('CREATE INDEX IF NOT EXISTS vfs_tombstones_gen ON vfs_tombstones(gen)');
            this.sql.exec('CREATE INDEX IF NOT EXISTS vfs_history_chunk ON vfs_inode_history(chunk_id) WHERE chunk_id IS NOT NULL');
            this.sql.exec('CREATE INDEX IF NOT EXISTS vfs_history_content ON vfs_inode_history(content_id) WHERE content_id IS NOT NULL');
            this.sql.exec(`CREATE TABLE IF NOT EXISTS vfs_gc_queue (
        kind INTEGER NOT NULL,
        id INTEGER NOT NULL,
        PRIMARY KEY (kind, id)
      ) WITHOUT ROWID`);
            this.sql.exec(`CREATE TABLE IF NOT EXISTS vfs_snapshots (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        gen INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )`);
            // Operations of many transactions whose prefix is not a state a crash
            // may leave: the row records how to finish them.
            this.sql.exec(`CREATE TABLE IF NOT EXISTS vfs_jobs (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        args TEXT NOT NULL,
        cursor TEXT NOT NULL,
        start_gen INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )`);
        });
        const state = [...this.sql.exec('SELECT gen, pin_gen, incarnation, tomb_floor FROM vfs_state WHERE slot = 1')][0];
        this._gen = Number(state.gen);
        this._pinGen = Number(state.pin_gen);
        this._epoch = String(state.incarnation);
        this._tombstoneFloor = Number(state.tomb_floor);
        this._revision = this._gen;
        // Nothing is stamped yet, and every earlier mutation is at or below the
        // clock at open: a directory or a missing path reports it.
        this._revisionFloor = this._gen;
        this._invalidationFloor = this._gen;
        this.legacyTables = LEGACY_TABLES
            .filter(({ name, columns }) => {
            const present = this.tableColumns(name);
            return columns.every((column) => present.has(column));
        })
            .map(({ name }) => name);
        if (this.legacyTables.length > 0)
            this.maintenancePending = true;
    }
    /**
     * After a restart no operation is assembling anything, so every state-0
     * content is an abandoned write: queue them all. Read first, so a store
     * with none opens without a write.
     */
    queueAbandonedStaging() {
        if ([...this.sql.exec(`SELECT 1 FROM vfs_contents WHERE state = ${CONTENT_STAGING} LIMIT 1`)].length === 0)
            return;
        this.transactionSync(() => {
            this.sql.exec(`INSERT OR IGNORE INTO vfs_gc_queue (kind, id) SELECT ${GC_CONTENT}, id FROM vfs_contents WHERE state = ${CONTENT_STAGING}`);
        });
        this.maintenancePending = true;
    }
    tableColumns(table) {
        const rows = this.sql.exec(`PRAGMA table_info(${table})`);
        return new Set([...rows].map((row) => String(row.name)));
    }
    // ── INode loading ─────────────────────────────────────────────────────
    /** The cache's loader: the inode at `path`, read from SQLite. */
    loadInode(path) {
        const row = [...this.sql.exec(`SELECT ${INODE_SELECT_COLUMNS} FROM vfs_inodes WHERE path = ?`, path)][0];
        return row === undefined ? undefined : this.inodeFromRow(row);
    }
    inodeFromRow(row) {
        const kind = inodeKindFromCode(Number(row.kind));
        return {
            path: String(row.path),
            parentPath: String(row.parent_path),
            kind,
            isDir: kind === 'directory',
            size: Number(row.size),
            atime: Number(row.atime),
            mtime: Number(row.mtime),
            ctime: Number(row.ctime),
            mode: Number(row.mode),
            uid: Number(row.uid),
            gid: Number(row.gid),
            chunkId: row.chunk_id === null || row.chunk_id === undefined ? null : Number(row.chunk_id),
            contentId: row.content_id === null || row.content_id === undefined ? null : Number(row.content_id),
            ino: Number(row.ino),
            gen: Number(row.gen),
        };
    }
    /**
     * Load the running counters with one aggregate over `vfs_inodes`, the first
     * time anything reads them. Opening does not pay for it; the first stats
     * read does, once.
     */
    ensureCounters() {
        if (this._countersLoaded)
            return;
        const durable = this.aggregateCounters();
        this._totalFiles = durable.files;
        this._totalDirs = durable.dirs;
        this._usedBytes = durable.bytes;
        this._countersLoaded = true;
    }
    /** Every non-directory counts as a file, symlinks included, as it always has. */
    aggregateCounters() {
        const row = [...this.sql.exec(`SELECT COUNT(*) AS total,
              COALESCE(SUM(kind = ${INODE_KIND_DIRECTORY}), 0) AS dirs,
              COALESCE(SUM(CASE WHEN kind = ${INODE_KIND_DIRECTORY} THEN 0 ELSE size END), 0) AS bytes
       FROM vfs_inodes`)][0];
        const dirs = Number(row?.dirs ?? 0);
        return { files: Number(row?.total ?? 0) - dirs, dirs, bytes: Number(row?.bytes ?? 0) };
    }
    // ── LRU chunk cache ───────────────────────────────────────────────────
    cacheGet(chunkId) {
        const entry = this.cache.get(chunkId);
        if (entry) {
            this._cacheHits++;
            // Move to MRU position
            this.cache.delete(chunkId);
            this.cache.set(chunkId, entry);
            return entry;
        }
        this._cacheMisses++;
        return null;
    }
    cacheSet(chunkId, data) {
        const existing = this.cache.get(chunkId);
        if (existing) {
            this._cacheBytes -= existing.length;
            this.cache.delete(chunkId);
        }
        const owned = this.copyBytes(data);
        this._cacheBytes += owned.length;
        this.cache.set(chunkId, owned);
        this.enforceCacheLimit();
    }
    cacheEvict(chunkId) {
        const entry = this.cache.get(chunkId);
        if (!entry)
            return;
        this.cache.delete(chunkId);
        this._cacheBytes -= entry.length;
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
        this._cacheBytes -= this.cache.get(firstKey).length;
        this.cache.delete(firstKey);
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
        this._evictions += this.cache.size;
        this.cache.clear();
        this._cacheBytes = 0;
    }
    // ── Helpers ───────────────────────────────────────────────────────────
    openDescription(path, cred, rights) {
        const resolved = this.checkAccess(path, (rights.read ? 4 : 0) | (rights.write ? 2 : 0), cred);
        if (!resolved.inode)
            throw vfsError('ENOENT', path);
        // Descriptions share the canonical inode object: a second descriptor
        // sees chmod/chown/utimes instantly, and unlink leaves every holder
        // pointing at the same retired inode rather than diverging copies.
        const opened = { inode: resolved.inode, path: resolved.path, closed: false };
        this.openNodes.add(opened);
        const current = () => {
            if (opened.closed)
                throw vfsError('EBADF', path);
            return opened.inode;
        };
        const stat = () => {
            const node = current();
            return { ...this.statOf(node), nlink: opened.path === null ? 0 : 1 };
        };
        const read = (offset, length) => {
            const node = current();
            if (!rights.read)
                throw vfsError('EBADF', path);
            if (node.isDir)
                throw vfsError('EISDIR', path);
            const start = clampNonNegativeInt(offset);
            const end = Math.min(node.size, start + clampNonNegativeInt(length));
            return this.readContent(node, start, end, false);
        };
        return {
            get ino() { return current().ino; },
            path: () => { current(); if (opened.path === null)
                throw vfsError('ENOENT', path); return opened.path; },
            stat, read,
            write: (offset, bytes) => {
                const node = current();
                if (!rights.write)
                    throw vfsError('EBADF', path);
                if (node.isDir)
                    throw vfsError('EISDIR', path);
                const start = clampNonNegativeInt(offset);
                if (opened.path !== null)
                    this.writeRange(opened.path, start, bytes, CRED_KERNEL);
                else if (bytes.length)
                    this.rewriteFile(node, null, Math.max(node.size, start + bytes.length), { start, bytes });
                return bytes.length;
            },
            truncate: size => {
                const node = current();
                if (!rights.write)
                    throw vfsError('EBADF', path);
                if (node.isDir)
                    throw vfsError('EISDIR', path);
                if (!Number.isSafeInteger(size) || size < 0)
                    throw vfsError('EINVAL', path);
                if (opened.path !== null)
                    this.truncate(opened.path, size, CRED_KERNEL);
                else if (size !== node.size)
                    this.rewriteFile(node, null, size, null);
            },
            readdir: () => {
                if (!current().isDir)
                    throw vfsError('ENOTDIR', path);
                if (!rights.read)
                    throw vfsError('EBADF', path);
                return opened.path === null ? [] : this.readdir(opened.path, CRED_KERNEL);
            },
            chmod: mode => {
                const node = current();
                if (cred.uid !== 0 && cred.uid !== node.uid)
                    throw vfsError('EPERM', path);
                this.assertConfinedModeChange(node, mode, cred, opened.path ?? path);
                if (opened.path !== null)
                    this.chmod(opened.path, mode, CRED_KERNEL);
                else {
                    node.mode = inodeTypeBits(node.kind) | (mode & 0o7777);
                    node.ctime = this.now();
                }
            },
            chown: (uid, gid) => {
                if (cred.uid !== 0)
                    throw vfsError('EPERM', path);
                if (opened.path !== null)
                    this.chown(opened.path, uid, gid, CRED_KERNEL, true);
                else {
                    current().uid = uid;
                    current().gid = gid;
                    current().ctime = this.now();
                }
            },
            utimes: (atime, mtime) => {
                if (cred.uid !== 0 && cred.uid !== current().uid && !rights.write)
                    throw vfsError('EPERM', path);
                if (opened.path !== null)
                    this.utimes(opened.path, atime, mtime, CRED_KERNEL);
                else {
                    current().atime = atime;
                    current().mtime = mtime;
                    current().ctime = this.now();
                }
            },
            close: () => {
                opened.closed = true;
                this.openNodes.delete(opened);
                // A detached description's content was queued when it was unlinked
                // and stepped over while pinned; it is collectable now.
                if (opened.path === null)
                    this.maintenancePending = true;
            },
        };
    }
    now() { return Date.now(); }
    parentPath(path) {
        return path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';
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
    confinedTmpRoots = new Map();
    /**
     * Confine a principal. `tmpRoot` is a storage key, not a logical path — the
     * caller owns creating and chowning it, because a per-principal `chown` is
     * uid-0 only and a guest cannot provision its own.
     */
    confinePrincipal(uid, tmpRoot) {
        const root = normalizeVfsPath(tmpRoot);
        if (root === '')
            throw vfsError('EINVAL', 'a private /tmp root cannot be the filesystem root');
        this.confinedTmpRoots.set(uid, root);
    }
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
    assertConfinedModeChange(inode, mode, cred, path) {
        if (!this.isConfined(cred))
            return;
        const current = inode.mode & 0o7777;
        const granted = (mode & 0o6077) & ~current;
        const unstuck = current & ~mode & 0o1000;
        if (granted === 0 && unstuck === 0)
            return;
        throw vfsError('EPERM', `${path}: mode change would grant permission outside your own principal; use u+x`);
    }
    /**
     * Permission bits a new inode is created with. umask never masks 07000, so
     * a confined principal's creation drops setuid/setgid here, the one grant
     * its umask cannot refuse. Sticky only restricts others and is kept.
     */
    creationMode(requested, cred) {
        return requested & ~cred.umask & (this.isConfined(cred) ? 0o1777 : 0o7777);
    }
    isConfined(cred) {
        return cred.uid !== 0 && this.confinedTmpRoots.has(cred.uid);
    }
    /** Drop a confinement. A principal's `/tmp` dies with it; its home does not. */
    releasePrincipal(uid) {
        this.confinedTmpRoots.delete(uid);
    }
    /**
     * Logical path -> storage key, for one credential.
     *
     * Everything under `/tmp` belongs to the caller's own private root, which is
     * what makes the same path mean different bytes per principal. Idempotent: a
     * key already inside that root is returned untouched, so the several methods
     * that derive a key before handing it on cannot stack the rewrite.
     */
    storageKey(path, cred) {
        const key = normalizeVfsPath(path);
        const root = this.confinedTmpRoots.get(cred.uid);
        if (root === undefined)
            return key;
        if (key === root || key.startsWith(`${root}/`))
            return key;
        if (key === TMP_ROOT)
            return root;
        if (!key.startsWith(`${TMP_ROOT}/`))
            return key;
        return `${root}/${key.slice(TMP_ROOT.length + 1)}`;
    }
    /**
     * Storage key -> the name this credential knows it by, or `null` when it has
     * none. The inverse of {@link storageKey}, for the one surface that reports
     * paths it was not asked about: {@link list}.
     *
     * A confined caller has no name for the shared scratch tree — `/tmp` is its
     * own root — nor for another principal's, so both answer `null` and are
     * omitted. An unconfined caller sees storage as it is, which is what the
     * kernel and the session user need.
     */
    logicalPath(key, cred) {
        const root = this.confinedTmpRoots.get(cred.uid);
        if (root === undefined)
            return key;
        if (key === root)
            return TMP_ROOT;
        if (key.startsWith(`${root}/`))
            return `${TMP_ROOT}/${key.slice(root.length + 1)}`;
        // The SHARED scratch root has no name here — this caller's `/tmp` is its
        // own root, which already supplied that entry. Returning it too would
        // enumerate one name twice, for two different directories.
        return key === TMP_ROOT || key.startsWith(`${TMP_ROOT}/`) ? null : key;
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
            readRangeUncached: (path, offset, length) => (this.readRange(path, offset, length, bound, { cached: false })),
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
            list: (after, limit) => this.list(after ?? null, Math.min(Math.max(1, Math.trunc(limit ?? FS_LIST_PAGE_LIMIT)), FS_LIST_PAGE_LIMIT), bound),
            unlink: (path) => this.unlink(path, bound),
            rmdir: (path) => this.rmdir(path, bound),
            removeRecursive: (path) => this.removeRecursive(path, bound),
            rename: (oldPath, newPath) => this.rename(oldPath, newPath, bound),
            copyFile: (src, dest) => this.copyFile(src, dest, bound),
            copyTree: (src, dest, options) => this.copyTree(src, dest, bound, options),
            writeBatch: (payload) => this.writeBatch(payload, bound),
            writeStream: (stream, options) => this.writeStream(stream, options, bound),
            mkdirBatch: (paths) => this.mkdirBatch(paths, bound),
            revision: (path) => this.revision(path, bound),
            contentKey: (path) => this.contentKey(path, bound),
            epoch: this._epoch,
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
    /**
     * Resolve `path` for `cred`. `tree` looks inodes up: the live tree, or a
     * snapshot's (SnapshotVfs), which resolves symlinks inside itself.
     */
    resolvePath(path, cred, followLeaf, allowMissing, tree = this.inodes) {
        let current = this.storageKey(path, cred);
        const seen = new Set();
        for (let hops = 0; hops <= 40; hops++) {
            const parts = current.split('/').filter(Boolean);
            let prefix = '';
            let restarted = false;
            for (let index = 0; index < parts.length; index++) {
                prefix = prefix ? `${prefix}/${parts[index]}` : parts[index];
                const inode = tree.get(prefix);
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
                    // An ABSOLUTE target is a logical path the same way the caller's
                    // was, so it goes through the same rewrite: otherwise a symlink to
                    // /tmp/y stored inside a private tree would read the shared one,
                    // which is the one way out of the confinement. A RELATIVE target
                    // resolves against a key that is already private, so it stays there.
                    const resolvedTarget = target.startsWith('/')
                        ? this.storageKey(target, cred)
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
            return { path: current, inode: tree.get(current) };
        }
        throw vfsError('ELOOP', path);
    }
    checkAccess(path, want, cred, options = {}) {
        const resolved = this.resolvePath(path, cred, options.followLeaf ?? true, options.allowMissingLeaf ?? false, options.tree);
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
     * POSIX sticky-bit restriction on a shared directory.
     *
     * Write permission on a directory is normally enough to remove or rename
     * anything inside it, which is why `/tmp` is `1777` and not `0777`: the
     * sticky bit narrows that to the entry's owner, the directory's owner, and
     * root. Nothing enforced it here, so a world-writable shared directory gave
     * every principal the ability to delete every other principal's files —
     * the mode said one thing and the filesystem did another.
     */
    checkStickyParentMutation(path, inode, cred) {
        if (cred.uid === 0)
            return;
        const parent = this.parentPath(normalizeVfsPath(path));
        if (parent === '')
            return;
        const parentInode = this.inodes.get(parent);
        if (!parentInode || (parentInode.mode & 0o1000) === 0)
            return;
        if (cred.uid !== parentInode.uid && cred.uid !== inode.uid) {
            throw vfsError('EPERM', normalizeVfsPath(path));
        }
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
     * Without a path: the global mutation clock, which is the last committed
     * generation (`vfs_state.gen`) as of the last publication. With a path:
     * the clock value at the last mutation inside that path's subtree, or the
     * revision floor if that is older than the revisions still held (0 if
     * nothing under it changed in this lifetime and nothing has been dropped).
     * Never less than the last mutation. `revision('')` equals the global clock
     * by construction (every mutation stamps all ancestors).
     */
    revision(path, cred) {
        if (path === undefined)
            return this._revision;
        // A credentialed caller asks about its own view; a confined one asking
        // after /tmp/x means its own file, so the counter must be that file's.
        const p = cred === undefined ? normalizeVfsPath(path) : this.storageKey(path, cred);
        if (p === '')
            return this._revision;
        return this.pathRevision(p);
    }
    /**
     * A storage key's revision: its own stamp; else, for a file or symlink,
     * its row's generation, which its last mutation wrote and which survives
     * restarts, so an untouched file keeps its revision across incarnations;
     * else the floor. Never more than the global clock, so a row written by a
     * transaction not yet published reports the clock.
     */
    pathRevision(key, inode) {
        const stamped = this._pathRevisions.get(key);
        if (stamped !== undefined)
            return stamped;
        const node = inode ?? this.inodes.get(key);
        if (node !== undefined && !node.isDir)
            return Math.min(node.gen, this._revision);
        return this._revisionFloor;
    }
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
    bumpRevision(paths) {
        for (const opened of this.openNodes) {
            if (opened.path === null)
                continue;
            const live = this.inodes.get(opened.path);
            if (live)
                opened.inode = live;
            else {
                opened.path = null;
                opened.inode.ctime = this.now();
            }
        }
        if (this.transactionPublication) {
            for (const path of paths)
                this.transactionPublication.paths.add(path);
            return;
        }
        if (this._gen <= this._revision)
            this.advanceGeneration();
        const rev = this._gen;
        this._revision = rev;
        for (const path of paths) {
            let p = normalizeVfsPath(path);
            const mutated = p;
            while (p !== '') {
                const stamped = this._pathRevisions.get(p);
                // Stamped by this bump already, and so was every ancestor.
                if (stamped === rev)
                    break;
                if (stamped === undefined)
                    this._pathRevisionBytes += SqliteVFS.entryBytes(p);
                this._pathRevisions.set(p, rev);
                p = this.parentPath(p);
            }
            if (mutated === '')
                continue;
            this._record(rev, mutated);
            const parent = this.parentPath(mutated);
            if (parent !== '')
                this._record(rev, parent);
        }
        if (this._pathRevisionBytes > this.pathRevisionBudget)
            this.dropOldestPathRevisions();
        if (this._invalidationBytes <= SqliteVFS.INVALIDATION_LOG_MAX_BYTES)
            return;
        let dropped = 0;
        while (dropped < this._invalidations.length
            && this._invalidationBytes > SqliteVFS.INVALIDATION_LOG_MAX_BYTES) {
            this._invalidationBytes -= SqliteVFS.entryBytes(this._invalidations[dropped].path);
            this._invalidationFloor = this._invalidations[dropped].rev;
            dropped++;
        }
        if (dropped > 0)
            this._invalidations = this._invalidations.slice(dropped);
    }
    /** Commit a generation that writes nothing, so a publication has a tick of its own. */
    advanceGeneration() {
        let gen = 0;
        this.transactionSync(() => {
            gen = Number([...this.sql.exec('UPDATE vfs_state SET gen = gen + 1 WHERE slot = 1 RETURNING gen')][0].gen);
        });
        this._gen = gen;
    }
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
    dropOldestPathRevisions() {
        while (this._pathRevisionBytes > this.pathRevisionBudget) {
            const stamps = Float64Array.from(this._pathRevisions.values()).sort();
            const cutoff = stamps[Math.floor(stamps.length / 4)];
            for (const [path, stamped] of this._pathRevisions) {
                if (stamped > cutoff)
                    continue;
                this._pathRevisions.delete(path);
                this._pathRevisionBytes -= SqliteVFS.entryBytes(path);
            }
            this._revisionFloor = Math.max(this._revisionFloor, cutoff);
        }
    }
    /** UTF-16 payload plus a flat allowance for the entry object itself. */
    static entryBytes(path) {
        return path.length * 2 + 48;
    }
    _record(rev, path) {
        this._invalidations.push({ rev, path });
        this._invalidationBytes += SqliteVFS.entryBytes(path);
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
     *
     * Each path carries the revision it was last mutated at inside the window,
     * not just its name. That is what lets a caller keep a cell it wrote
     * itself: it holds the revision its own write produced, so a report at
     * that same revision is its own mutation coming back, while a peer's
     * later write to the same path reports a HIGHER revision and still
     * invalidates. A name alone cannot separate those two, and the difference
     * between them is a whole resident set thrown away on every flush.
     */
    invalidatedSince(epoch, cursor) {
        const rev = this._revision;
        if (epoch !== this._epoch || cursor > rev) {
            return { epoch: this._epoch, rev, paths: [], poison: true };
        }
        if (cursor === rev)
            return { epoch: this._epoch, rev, paths: [], poison: false };
        // Revisions are generations, so consecutive publications need not be
        // consecutive integers: completeness is judged against the newest
        // revision any entry was dropped from, never against oldest - 1.
        if (cursor < this._invalidationFloor) {
            const paths = this.invalidatedFromSql(cursor, rev);
            return paths === null
                ? { epoch: this._epoch, rev, paths: [], poison: true }
                : { epoch: this._epoch, rev, paths, poison: false };
        }
        // The log is append-ordered by revision, so the last entry for a path
        // is its newest — the one the caller has to be at or past to keep it.
        const latest = new Map();
        for (const entry of this._invalidations) {
            if (entry.rev > cursor)
                latest.set(entry.path, entry.rev);
        }
        const paths = [...latest].map(([path, pathRev]) => ({ path, rev: pathRev }));
        return { epoch: this._epoch, rev, paths, poison: false };
    }
    /**
     * The delta for a cursor older than the log, from the rows themselves:
     * every row written in (cursor, rev] and every path deleted in it (its
     * tombstone), each with its parent, at the generation that wrote it. As
     * complete as the log, since every mutation writes a row or a tombstone.
     * Null (poison) below the tombstone floor, or past SQL_DELTA_MAX_PATHS,
     * where a reconcile against list() is cheaper than the delta.
     */
    invalidatedFromSql(cursor, rev) {
        if (cursor < this._tombstoneFloor)
            return null;
        const latest = new Map();
        const note = (path, gen) => {
            if ((latest.get(path) ?? -1) < gen)
                latest.set(path, gen);
        };
        for (const table of ['vfs_inodes', 'vfs_tombstones']) {
            const rows = [...this.sql.exec(`SELECT path, gen FROM ${table} WHERE gen > ? AND gen <= ? LIMIT ?`, cursor, rev, SQL_DELTA_MAX_PATHS + 1)];
            if (rows.length > SQL_DELTA_MAX_PATHS)
                return null;
            for (const row of rows) {
                const path = String(row.path);
                const gen = Number(row.gen);
                note(path, gen);
                const parent = this.parentPath(path);
                if (parent !== '')
                    note(parent, gen);
            }
            if (latest.size > SQL_DELTA_MAX_PATHS)
                return null;
        }
        return [...latest].map(([path, pathRev]) => ({ path, rev: pathRev }));
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
        const normalized = this.storageKey(path, cred);
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
        const now = this.now();
        const builder = this.newPlan();
        builder.addInode({
            path,
            parentPath: this.parentPath(path),
            kind: 'directory',
            isDir: true,
            size: 0,
            atime: now,
            mtime: now,
            mode: this.creationMode(requestedMode ?? 0o777, cred),
            uid: cred.uid,
            gid: cred.gid,
            content: { type: 'none' },
        });
        this._writeBatchOnce({ plan: builder.build(), deletedInodes: [] }, { source: 'strict-batch', limitMode: 'bounded' });
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
                : this.creationMode(options?.mode ?? 0o666, cred),
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
            this.replaceFileWithStagedContent(inode, data, onCommit);
        }
    }
    symlink(target, path, cred) {
        this.assertMutationsAllowed([path]);
        const normalized = this.storageKey(path, cred);
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
    readInodeBytes(_path, inode, cached = true) {
        return this.readContent(inode, 0, inode.size, cached);
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
        return this.readInodeBytes(resolved.path, inode, false);
    }
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
    readRange(path, offset, length, cred, options = {}) {
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
        return this.readContent(inode, start, end, options.cached !== false);
    }
    /** Bytes [start, end) of the content an inode (or a snapshot's row) names. */
    readContent(ref, start, end, cached) {
        if (end <= start)
            return new Uint8Array(0);
        if (ref.chunkId !== null) {
            const data = this.readChunk(ref.chunkId, cached, ref.path);
            if (data.byteLength !== ref.size) {
                throw new Error(`EIO: ${ref.path}: chunk ${ref.chunkId} has ${data.byteLength} bytes; inode says ${ref.size}`);
            }
            // A whole-file read hands back its own buffer: a cached chunk must not
            // be mutable through what a caller was given.
            return cached || start !== 0 || end !== data.byteLength ? data.slice(start, end) : data;
        }
        if (ref.contentId === null)
            throw new Error(`EIO: ${ref.path}: ${ref.size} bytes with no content`);
        const rows = this.manifestRange(ref.contentId, ref.size, start, end);
        const out = new Uint8Array(end - start);
        let covered = start;
        if (cached) {
            // Hits from the LRU; every miss in one statement.
            const found = new Map();
            const missing = [];
            for (const row of rows) {
                const hit = this.cacheGet(row.chunkId);
                if (hit)
                    found.set(row.chunkId, hit);
                else
                    missing.push(row.chunkId);
            }
            for (let i = 0; i < missing.length; i += KEYS_PER_SQL_EXEC) {
                const page = missing.slice(i, i + KEYS_PER_SQL_EXEC);
                this._sqlReads++;
                for (const row of this.sql.exec(`SELECT id, data FROM vfs_chunks WHERE id IN (${page.map(() => '?').join(',')})`, ...page)) {
                    const data = this.blobToUint8Array(row.data);
                    found.set(Number(row.id), data);
                    this.cacheSet(Number(row.id), data);
                }
            }
            for (const row of rows) {
                const data = found.get(row.chunkId);
                if (!data)
                    throw new Error(`EIO: ${ref.path}: missing chunk ${row.chunkId} at ${row.off}`);
                covered = this.copyManifestRow(ref.path, out, start, end, row, data, covered);
            }
        }
        else {
            // One statement for the whole range: nothing is cached, so nothing is looked up.
            for (let i = 0; i < rows.length; i += KEYS_PER_SQL_EXEC) {
                const page = rows.slice(i, i + KEYS_PER_SQL_EXEC);
                const byId = new Map();
                this._sqlReads++;
                for (const row of this.sql.exec(`SELECT id, data FROM vfs_chunks WHERE id IN (${page.map(() => '?').join(',')})`, ...page.map((row) => row.chunkId)))
                    byId.set(Number(row.id), this.blobToUint8Array(row.data));
                for (const row of page) {
                    const data = byId.get(row.chunkId);
                    if (!data)
                        throw new Error(`EIO: ${ref.path}: missing chunk ${row.chunkId} at ${row.off}`);
                    covered = this.copyManifestRow(ref.path, out, start, end, row, data, covered);
                }
            }
        }
        if (covered < end)
            throw new Error(`EIO: ${ref.path}: manifest ends at ${covered}, file at ${end}`);
        return out;
    }
    copyManifestRow(path, out, start, end, row, data, covered) {
        if (data.byteLength !== row.len || row.off > covered) {
            throw new Error(`EIO: ${path}: manifest row at ${row.off} does not continue ${covered}`);
        }
        const from = Math.max(start, row.off);
        const to = Math.min(end, row.off + row.len);
        if (to > from)
            out.set(data.subarray(from - row.off, to - row.off), from - start);
        return Math.max(covered, row.off + row.len);
    }
    /**
     * The manifest rows of `contentId` overlapping [start, end), in order.
     *
     * A manifest of a file up to MANIFEST_KEPT_BYTES (at most 256 rows) is read
     * whole once and kept (manifestWindows), so a run of small reads in it costs
     * its chunk reads alone, as it did when chunks were positional. A larger one
     * is read per range: one descending seek for the row holding `start`, and a
     * range scan only past its end. A kept manifest is dropped when it is edited.
     */
    manifestRange(contentId, size, start, end) {
        if (size <= MANIFEST_KEPT_BYTES) {
            let rows = this.manifestWindows.get(contentId);
            if (rows === undefined) {
                this._sqlReads++;
                rows = [];
                for (const row of this.sql.exec('SELECT off, len, chunk_id FROM vfs_content_chunks WHERE content_id = ? ORDER BY off', contentId))
                    rows.push({ off: Number(row.off), len: Number(row.len), chunkId: Number(row.chunk_id) });
                if (this.manifestWindows.size >= MANIFEST_WINDOWS) {
                    this.manifestWindows.delete(this.manifestWindows.keys().next().value);
                }
                this.manifestWindows.set(contentId, rows);
            }
            else {
                this.manifestWindows.delete(contentId);
                this.manifestWindows.set(contentId, rows);
            }
            // Binary search for the row holding `start`.
            let lo = 0;
            let hi = rows.length - 1;
            while (lo < hi) {
                const mid = (lo + hi + 1) >> 1;
                if (rows[mid].off <= start)
                    lo = mid;
                else
                    hi = mid - 1;
            }
            let last = lo;
            while (last < rows.length && rows[last].off < end)
                last++;
            return rows.slice(lo, last);
        }
        this._sqlReads++;
        const first = [...this.sql.exec('SELECT off, len, chunk_id FROM vfs_content_chunks WHERE content_id = ? AND off <= ? ORDER BY off DESC LIMIT 1', contentId, start)][0];
        const out = [];
        let next = start;
        if (first !== undefined) {
            const row = { off: Number(first.off), len: Number(first.len), chunkId: Number(first.chunk_id) };
            out.push(row);
            next = row.off + row.len;
        }
        if (next >= end)
            return out;
        for (const row of this.sql.exec('SELECT off, len, chunk_id FROM vfs_content_chunks WHERE content_id = ? AND off >= ? AND off < ? ORDER BY off', contentId, next, end))
            out.push({ off: Number(row.off), len: Number(row.len), chunkId: Number(row.chunk_id) });
        return out;
    }
    /** One chunk's bytes, through the LRU when `cached`. */
    readChunk(chunkId, cached, path) {
        if (cached) {
            const hit = this.cacheGet(chunkId);
            if (hit)
                return hit;
        }
        this._sqlReads++;
        const row = [...this.sql.exec('SELECT data FROM vfs_chunks WHERE id = ?', chunkId)][0];
        if (!row)
            throw new Error(`EIO: ${path}: missing chunk ${chunkId}`);
        const data = this.blobToUint8Array(row.data);
        if (cached)
            this.cacheSet(chunkId, data);
        return data;
    }
    /**
     * The content key of an inode's bytes: sha256 of them up to CHUNK_SIZE,
     * else the digest of the manifest's ordered chunk hashes. An in-place edit
     * clears a manifest's digest; it is recomputed here and stored unless
     * another content already holds it.
     */
    contentKeyOf(ref) {
        if (ref.chunkId !== null) {
            const row = [...this.sql.exec('SELECT hash FROM vfs_chunks WHERE id = ?', ref.chunkId)][0];
            if (!row)
                throw new Error(`EIO: ${ref.path}: missing chunk ${ref.chunkId}`);
            return hex(this.blobToUint8Array(row.hash));
        }
        if (ref.contentId === null)
            return hex(EMPTY_CONTENT_KEY);
        const content = [...this.sql.exec('SELECT digest FROM vfs_contents WHERE id = ?', ref.contentId)][0];
        if (!content)
            throw new Error(`EIO: ${ref.path}: missing content ${ref.contentId}`);
        if (content.digest !== null && content.digest !== undefined)
            return hex(this.blobToUint8Array(content.digest));
        const memo = this.contentKeyMemo.get(ref.contentId);
        if (memo !== undefined)
            return memo;
        const digest = new ManifestDigest();
        for (const row of this.sql.exec(`SELECT c.hash AS hash FROM vfs_content_chunks cc JOIN vfs_chunks c ON c.id = cc.chunk_id
       WHERE cc.content_id = ? ORDER BY cc.off`, ref.contentId))
            digest.add(this.blobToUint8Array(row.hash));
        const key = digest.digest(ref.size);
        const taken = [...this.sql.exec('SELECT 1 FROM vfs_contents WHERE digest = ?', key)].length > 0;
        if (taken)
            this.contentKeyMemo.set(ref.contentId, hex(key));
        else
            this.transactionSync(() => { this.sql.exec('UPDATE vfs_contents SET digest = ? WHERE id = ?', key, ref.contentId); });
        return hex(key);
    }
    /** contentKeyOf from a list row's joined chunk hash or digest, so a page costs no lookup per file. */
    listedContentKey(inode, row) {
        if (inode.chunkId !== null && row.chunk_hash !== null && row.chunk_hash !== undefined) {
            return hex(this.blobToUint8Array(row.chunk_hash));
        }
        if (inode.contentId !== null && row.content_digest !== null && row.content_digest !== undefined) {
            return hex(this.blobToUint8Array(row.content_digest));
        }
        return this.contentKeyOf(inode);
    }
    contentKey(path, cred) {
        const resolved = this.checkAccess(path, 0o4, cred);
        const inode = resolved.inode;
        if (!inode)
            throw vfsError('ENOENT', path);
        if (inode.kind === 'directory')
            throw vfsError('EISDIR', resolved.path);
        return this.contentKeyOf(inode);
    }
    /**
     * Overwrite `bytes` at `offset`. Only the chunks around the range are
     * re-cut and rewritten (rewriteFile); writing past EOF zero-fills the gap.
     * Creates the file when missing; callers own parent-dir creation (same
     * contract as writeFile).
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
        this.rewriteFile(prior, effectivePath, Math.max(prior.size, end), { start, bytes }, onCommit);
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
        const pidRevoked = [...this.sql.exec('SELECT 1 AS revoked FROM vfs_append_pid_revocations_v2 WHERE namespace = ? AND pid = ?', this.namespace, pid)].length > 0;
        if (pidRevoked)
            throw vfsError('ESTALE', `append process ${pid} is being retired`);
        const writer = [...this.sql.exec(`SELECT revoked FROM vfs_append_writer_state_v2
       WHERE namespace = ? AND pid = ? AND writer_id = ?`, this.namespace, pid, writerId)][0];
        if (!writer || Number(writer.revoked) !== 0) {
            throw vfsError('ESTALE', `append writer ${pid}/${writerId} is unavailable`);
        }
        let moduleState = [...this.sql.exec(`SELECT acked_through FROM vfs_append_module_state_v2
       WHERE namespace = ? AND pid = ? AND writer_id = ? AND module_id = ?`, this.namespace, pid, writerId, moduleId)][0];
        const ackedThrough = Number(moduleState?.acked_through ?? 0);
        if (operationId <= ackedThrough)
            return bytes.byteLength;
        const acknowledgedGap = [...this.sql.exec(`SELECT path, byte_length, digest
       FROM vfs_append_acked_gaps_v2
       WHERE namespace = ? AND pid = ? AND writer_id = ? AND module_id = ? AND operation_id = ?`, this.namespace, pid, writerId, moduleId, operationId)][0];
        if (acknowledgedGap) {
            if (acknowledgedGap.path !== normalized
                || Number(acknowledgedGap.byte_length) !== bytes.byteLength
                || acknowledgedGap.digest !== digest) {
                throw vfsError('EINVAL', `append acknowledgement collision for ${pid}/${operationId}`);
            }
            return bytes.byteLength;
        }
        const existing = [...this.sql.exec(`SELECT path, byte_length, digest
       FROM vfs_append_receipts_v2
       WHERE namespace = ? AND pid = ? AND writer_id = ? AND module_id = ? AND operation_id = ?`, this.namespace, pid, writerId, moduleId, operationId)][0];
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
           SELECT operation_id FROM vfs_append_receipts_v2
             WHERE namespace = ? AND pid = ? AND writer_id = ? AND module_id = ?
           UNION ALL
           SELECT operation_id FROM vfs_append_acked_gaps_v2
             WHERE namespace = ? AND pid = ? AND writer_id = ? AND module_id = ?
         )`, this.namespace, pid, writerId, moduleId, this.namespace, pid, writerId, moduleId)][0]?.operation_id
            ?? ackedThrough);
        if (operationId > Math.max(ackedThrough, highestKnown) + VFS_APPEND_RECEIPT_LIMIT) {
            throw vfsError('EINVAL', `append operation gap exceeds ${VFS_APPEND_RECEIPT_LIMIT}`);
        }
        this.assertMutationsAllowed([normalized]);
        const resolved = this.checkAccess(normalized, 0, cred, { allowMissingLeaf: true });
        const effectivePath = resolved.path;
        const inode = resolved.inode;
        if (inode?.kind === 'directory')
            throw vfsError('EISDIR', effectivePath);
        if (inode && inode.kind !== 'file') {
            throw vfsError('EINVAL', `${effectivePath} is not a regular file`);
        }
        if (inode && !this.accessInode(inode, 0o2, cred))
            throw vfsError('EACCES', effectivePath);
        if (!inode)
            this.checkParentAccess(effectivePath, cred);
        const offset = inode?.size ?? 0;
        const retainedCount = Number([...this.sql.exec(`SELECT
           (SELECT COUNT(*) FROM vfs_append_writer_state_v2 WHERE namespace = ? AND revoked = 0)
           + (SELECT COUNT(*) FROM vfs_append_module_state_v2 WHERE namespace = ?)
           + (SELECT COUNT(*) FROM vfs_append_receipts_v2 WHERE namespace = ?)
           + (SELECT COUNT(*) FROM vfs_append_acked_gaps_v2 WHERE namespace = ?) AS count`, this.namespace, this.namespace, this.namespace, this.namespace)][0]?.count ?? 0);
        const requiredRows = 1 + (moduleState ? 0 : 1);
        if (retainedCount > VFS_APPEND_RECEIPT_LIMIT - requiredRows) {
            throw vfsError('ENOSPC', 'append receipt journal is full');
        }
        if (!moduleState) {
            this.sql.exec(`INSERT INTO vfs_append_module_state_v2
         (namespace, pid, writer_id, module_id, acked_through) VALUES (?, ?, ?, ?, 0)`, this.namespace, pid, writerId, moduleId);
            moduleState = { acked_through: 0 };
        }
        const recordReceipt = () => {
            this.sql.exec(`INSERT INTO vfs_append_receipts_v2
         (namespace, pid, writer_id, module_id, operation_id, path, byte_length, digest, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, this.namespace, pid, writerId, moduleId, operationId, normalized, bytes.byteLength, digest, Date.now());
        };
        this.writeRange(effectivePath, offset, bytes, cred, recordReceipt);
        return bytes.byteLength;
    }
    activateAppendWriter(pid, writerId) {
        if (!Number.isSafeInteger(pid) || pid <= 0)
            throw vfsError('EINVAL', `invalid append pid ${pid}`);
        assertAppendIncarnation(writerId, 'writer');
        if ([...this.sql.exec('SELECT 1 AS revoked FROM vfs_append_pid_revocations_v2 WHERE namespace = ? AND pid = ?', this.namespace, pid)].length > 0) {
            throw vfsError('ESTALE', `append process ${pid} is being retired`);
        }
        const writers = [...this.sql.exec(`SELECT writer_id, revoked FROM vfs_append_writer_state_v2
       WHERE namespace = ? AND pid = ?`, this.namespace, pid)];
        const writer = writers.find((candidate) => candidate.writer_id === writerId);
        if (writer && Number(writer.revoked) === 0) {
            return;
        }
        if (writers.length > 0) {
            throw vfsError('ESTALE', `append process ${pid} already has a different writer`);
        }
        const retainedCount = Number([...this.sql.exec(`SELECT
           (SELECT COUNT(*) FROM vfs_append_writer_state_v2 WHERE namespace = ? AND revoked = 0)
           + (SELECT COUNT(*) FROM vfs_append_module_state_v2 WHERE namespace = ?)
           + (SELECT COUNT(*) FROM vfs_append_receipts_v2 WHERE namespace = ?)
           + (SELECT COUNT(*) FROM vfs_append_acked_gaps_v2 WHERE namespace = ?) AS count`, this.namespace, this.namespace, this.namespace, this.namespace)][0]?.count ?? 0);
        if (retainedCount >= VFS_APPEND_RECEIPT_LIMIT) {
            throw vfsError('ENOSPC', 'append receipt journal is full');
        }
        this.transactionSync(() => {
            this.sql.exec(`INSERT INTO vfs_append_writer_state_v2
         (namespace, pid, writer_id, revoked, retired_at) VALUES (?, ?, ?, 0, NULL)`, this.namespace, pid, writerId);
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
        const writer = [...this.sql.exec(`SELECT revoked FROM vfs_append_writer_state_v2
       WHERE namespace = ? AND pid = ? AND writer_id = ?`, this.namespace, pid, writerId)][0];
        if (!writer || Number(writer.revoked) !== 0) {
            throw vfsError('ESTALE', `append writer ${pid} is unavailable`);
        }
        const moduleState = [...this.sql.exec(`SELECT acked_through FROM vfs_append_module_state_v2
       WHERE namespace = ? AND pid = ? AND writer_id = ? AND module_id = ?`, this.namespace, pid, writerId, moduleId)][0];
        if (!moduleState) {
            throw vfsError('ESTALE', `append module ${pid}/${writerId}/${moduleId} is unavailable`);
        }
        let ackedThrough = Number(moduleState.acked_through);
        if (operationId <= ackedThrough)
            return;
        const existingGap = [...this.sql.exec(`SELECT 1 AS present FROM vfs_append_acked_gaps_v2
       WHERE namespace = ? AND pid = ? AND writer_id = ? AND module_id = ? AND operation_id = ?`, this.namespace, pid, writerId, moduleId, operationId)].length > 0;
        let receipt;
        if (!existingGap) {
            receipt = [...this.sql.exec(`SELECT path, byte_length, digest
         FROM vfs_append_receipts_v2
         WHERE namespace = ? AND pid = ? AND writer_id = ? AND module_id = ? AND operation_id = ?`, this.namespace, pid, writerId, moduleId, operationId)][0];
            if (!receipt) {
                throw vfsError('EINVAL', `append operation ${pid}/${operationId} has not completed`);
            }
        }
        const acknowledged = [...this.sql.exec(`SELECT operation_id FROM vfs_append_acked_gaps_v2
       WHERE namespace = ? AND pid = ? AND writer_id = ? AND module_id = ? AND operation_id > ?
       ORDER BY operation_id`, this.namespace, pid, writerId, moduleId, ackedThrough)];
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
                    if (!receipt) {
                        throw vfsError('EINVAL', `append operation ${pid}/${operationId} has not completed`);
                    }
                    this.sql.exec(`INSERT INTO vfs_append_acked_gaps_v2
             (namespace, pid, writer_id, module_id, operation_id, path, byte_length, digest)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, this.namespace, pid, writerId, moduleId, operationId, receipt.path, receipt.byte_length, receipt.digest);
                    this.sql.exec(`DELETE FROM vfs_append_receipts_v2
             WHERE namespace = ? AND pid = ? AND writer_id = ? AND module_id = ? AND operation_id = ?`, this.namespace, pid, writerId, moduleId, operationId);
                }
                if (ackedThrough > priorAckedThrough) {
                    this.sql.exec(`UPDATE vfs_append_module_state_v2 SET acked_through = ?
             WHERE namespace = ? AND pid = ? AND writer_id = ? AND module_id = ?`, ackedThrough, this.namespace, pid, writerId, moduleId);
                }
            });
        }
        if (ackedThrough > priorAckedThrough) {
            this.deleteAppendRowsBounded('vfs_append_acked_gaps_v2', 'namespace = ? AND pid = ? AND writer_id = ? AND module_id = ? AND operation_id <= ?', [this.namespace, pid, writerId, moduleId, ackedThrough]);
        }
    }
    revokeAppendWriter(pid, writerId) {
        if (!Number.isSafeInteger(pid) || pid <= 0)
            throw vfsError('EINVAL', `invalid append pid ${pid}`);
        assertAppendIncarnation(writerId, 'writer');
        this.transactionSync(() => {
            this.sql.exec(`UPDATE vfs_append_writer_state_v2
         SET revoked = 1, retired_at = ?
         WHERE namespace = ? AND pid = ? AND writer_id = ?`, Date.now(), this.namespace, pid, writerId);
        });
        this.deleteAppendRowsBounded('vfs_append_receipts_v2', 'namespace = ? AND pid = ? AND writer_id = ?', [this.namespace, pid, writerId]);
        this.deleteAppendRowsBounded('vfs_append_acked_gaps_v2', 'namespace = ? AND pid = ? AND writer_id = ?', [this.namespace, pid, writerId]);
        this.deleteAppendRowsBounded('vfs_append_module_state_v2', 'namespace = ? AND pid = ? AND writer_id = ?', [this.namespace, pid, writerId]);
        this.deleteAppendRowsBounded('vfs_append_writer_state_v2', 'namespace = ? AND pid = ? AND writer_id = ? AND revoked = 1', [this.namespace, pid, writerId]);
    }
    revokeAppendWriters(pid) {
        if (!Number.isSafeInteger(pid) || pid <= 0)
            throw vfsError('EINVAL', `invalid append pid ${pid}`);
        this.transactionSync(() => {
            this.sql.exec(`INSERT INTO vfs_append_pid_revocations_v2 (namespace, pid, retired_at) VALUES (?, ?, ?)
         ON CONFLICT(namespace, pid) DO UPDATE SET retired_at = excluded.retired_at`, this.namespace, pid, Date.now());
        });
        this.finishAppendPidRevocation(pid);
    }
    revokeAppendWritersThrough(maxPid) {
        if (!Number.isSafeInteger(maxPid) || maxPid < 0) {
            throw vfsError('EINVAL', `invalid append pid ceiling ${maxPid}`);
        }
        for (;;) {
            const pids = [...this.sql.exec(`SELECT DISTINCT pid FROM vfs_append_writer_state_v2
         WHERE namespace = ? AND pid <= ?
         ORDER BY pid
         LIMIT ?`, this.namespace, maxPid, MAX_TX_LOGICAL_ROWS)];
            if (pids.length === 0)
                return;
            for (const row of pids)
                this.revokeAppendWriters(Number(row.pid));
        }
    }
    finishAppendPidRevocation(pid) {
        for (;;) {
            const writers = [...this.sql.exec(`SELECT writer_id FROM vfs_append_writer_state_v2
         WHERE namespace = ? AND pid = ? AND revoked = 0
         ORDER BY rowid
         LIMIT ?`, this.namespace, pid, Math.min(MAX_TX_LOGICAL_ROWS, SQL_MAX_BOUND_PARAMETERS - 3))];
            if (writers.length === 0)
                break;
            const placeholders = writers.map(() => '?').join(',');
            this.transactionSync(() => {
                this.sql.exec(`UPDATE vfs_append_writer_state_v2
           SET revoked = 1, retired_at = ?
           WHERE namespace = ? AND pid = ? AND writer_id IN (${placeholders})`, Date.now(), this.namespace, pid, ...writers.map((writer) => writer.writer_id));
            });
        }
        this.deleteAppendRowsBounded('vfs_append_receipts_v2', 'namespace = ? AND pid = ?', [this.namespace, pid]);
        this.deleteAppendRowsBounded('vfs_append_acked_gaps_v2', 'namespace = ? AND pid = ?', [this.namespace, pid]);
        this.deleteAppendRowsBounded('vfs_append_module_state_v2', 'namespace = ? AND pid = ?', [this.namespace, pid]);
        this.deleteAppendRowsBounded('vfs_append_writer_state_v2', 'namespace = ? AND pid = ? AND revoked = 1', [this.namespace, pid]);
        this.transactionSync(() => {
            this.sql.exec('DELETE FROM vfs_append_pid_revocations_v2 WHERE namespace = ? AND pid = ?', this.namespace, pid);
        });
    }
    deleteAppendRowsBounded(table, predicate, params) {
        for (;;) {
            const rows = [...this.sql.exec(`SELECT rowid FROM ${table} WHERE ${predicate} ORDER BY rowid LIMIT ?`, ...params, Math.min(MAX_TX_LOGICAL_ROWS, SQL_MAX_BOUND_PARAMETERS))];
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
            const revocations = [...this.sql.exec(`SELECT pid FROM vfs_append_pid_revocations_v2
         WHERE namespace = ?
         ORDER BY pid
         LIMIT ?`, this.namespace, MAX_TX_LOGICAL_ROWS)];
            if (revocations.length === 0)
                break;
            for (const row of revocations) {
                this.finishAppendPidRevocation(Number(row.pid));
            }
        }
        for (const table of [
            'vfs_append_receipts_v2',
            'vfs_append_acked_gaps_v2',
            'vfs_append_module_state_v2',
        ]) {
            this.deleteAppendRowsBounded(table, `namespace = ? AND EXISTS (
          SELECT 1 FROM vfs_append_writer_state_v2 AS writer
          WHERE writer.namespace = ${table}.namespace
            AND writer.pid = ${table}.pid
            AND writer.writer_id = ${table}.writer_id
            AND writer.revoked = 1
        )`, [this.namespace]);
        }
        this.deleteAppendRowsBounded('vfs_append_writer_state_v2', 'namespace = ? AND revoked = 1', [this.namespace]);
        this.deleteAppendRowsBounded('vfs_append_acked_gaps_v2', `namespace = ? AND EXISTS (
        SELECT 1 FROM vfs_append_module_state_v2 AS module
        WHERE module.namespace = vfs_append_acked_gaps_v2.namespace
          AND module.pid = vfs_append_acked_gaps_v2.pid
          AND module.writer_id = vfs_append_acked_gaps_v2.writer_id
          AND module.module_id = vfs_append_acked_gaps_v2.module_id
          AND module.acked_through >= vfs_append_acked_gaps_v2.operation_id
      )`, [this.namespace]);
    }
    /**
     * Truncate or zero-extend to `size`. Only the chunk at the new end is
     * re-cut; rows past it go. Every mutation commits before return.
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
        if (newSize === inode.size)
            return;
        this.rewriteFile(inode, resolved.path, newSize, null);
    }
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
    rewriteFile(node, path, newSize, change, onCommit) {
        const oldSize = node.size;
        const changeStart = change === null ? Math.min(oldSize, newSize) : Math.min(change.start, oldSize);
        const changeEnd = change === null ? newSize : change.start + change.bytes.length;
        // The new file's bytes [from, to): old bytes, the change over them, zeros past the old end.
        const segment = (from, to) => {
            const out = new Uint8Array(to - from);
            const oldTo = Math.min(to, oldSize);
            if (from < oldTo)
                out.set(this.readContent(node, from, oldTo, true), 0);
            if (change !== null) {
                const s = Math.max(from, change.start);
                const e = Math.min(to, change.start + change.bytes.length);
                if (e > s)
                    out.set(change.bytes.subarray(s - change.start, e - change.start), s - from);
            }
            return out;
        };
        const piece = (data) => ({ data, hash: chunkHash(data) });
        if (newSize <= CHUNK_SIZE) {
            let content;
            if (newSize === 0)
                content = { type: 'none' };
            else {
                const next = piece(segment(0, newSize));
                content = path !== null && node.chunkId !== null && this.chunkUnshared(node, path)
                    ? { type: 'rewrite', chunkId: node.chunkId, piece: next }
                    : { type: 'small', piece: next };
            }
            this.publishRewrite(node, path, newSize, content, onCommit);
            return;
        }
        // The old chunk holding the first changed byte; for growth, the last one,
        // whose end was the old EOF and may now move.
        let from = 0;
        if (node.contentId !== null) {
            const at = Math.min(changeStart, oldSize - 1);
            const row = [...this.sql.exec('SELECT MAX(off) AS off FROM vfs_content_chunks WHERE content_id = ? AND off <= ?', node.contentId, at)][0];
            from = Number(row?.off ?? 0);
        }
        const boundaries = node.contentId === null ? null : this.manifestOffsets(node.contentId, from);
        const held = [];
        let heldBytes = 0;
        let staging = null;
        let builder = null;
        const stagedPath = path ?? node.path;
        const flush = () => {
            if (builder === null || builder.empty)
                return;
            const plan = builder.build();
            builder = this.newPlan();
            this.assertTransactionFits(plan.metrics);
            this.executeTransactionPlan(plan, { source: 'content-stage', limitMode: 'bounded' });
        };
        const stage = (next) => {
            builder ??= this.newPlan();
            if (builder.wouldExceedPieces(next.data.byteLength, 1) !== null)
                flush();
            builder.addStagedPiece(staging, next, stagedPath);
        };
        const startStaging = () => {
            staging = this.beginStaging();
            if (node.contentId !== null && from > 0)
                this.stageManifestCopy(staging, node.contentId, 0, from);
            staging.size = from;
            for (const entry of held)
                stage(entry.piece);
            held.length = 0;
        };
        let offset = from;
        let to = -1;
        const cutter = new ContentCutter();
        const take = (data) => {
            const next = piece(data);
            if (staging === null) {
                held.push({ off: offset, piece: next });
                heldBytes += data.byteLength;
                if (heldBytes > MAX_TX_BLOB_BYTES / 2)
                    startStaging();
            }
            else
                stage(next);
            offset += data.byteLength;
            // Past the change, a cut on an old boundary is where the cuts rejoin.
            if (boundaries !== null && offset >= changeEnd && offset < newSize && boundaries.has(offset)) {
                to = offset;
                return true;
            }
            return false;
        };
        try {
            scan: for (let pos = from; pos < newSize;) {
                const end = Math.min(newSize, pos + CHUNK_SIZE);
                for (const data of cutter.push(segment(pos, end)))
                    if (take(data))
                        break scan;
                pos = end;
            }
            if (to < 0) {
                for (const data of cutter.finish())
                    take(data);
                to = oldSize;
            }
            if (staging === null) {
                const unshared = path !== null && node.contentId !== null && this.contentUnshared(node, path);
                let content = null;
                if (unshared) {
                    content = { type: 'edit', contentId: node.contentId, from, to, pieces: held };
                }
                else if (from === 0 && to >= oldSize) {
                    const digest = new ManifestDigest();
                    for (const entry of held)
                        digest.add(entry.piece.hash);
                    content = { type: 'large', pieces: held.map((entry) => entry.piece), size: newSize, digest: digest.digest(newSize) };
                }
                if (content !== null && this.tryPublishRewrite(node, path, newSize, content, onCommit))
                    return;
                startStaging();
            }
            const target = staging;
            if (node.contentId !== null && to < oldSize) {
                flush();
                target.size = to;
                this.stageManifestCopy(target, node.contentId, to, oldSize);
            }
            flush();
            this.publishRewrite(node, path, newSize, { type: 'staged', content: target }, onCommit);
        }
        catch (error) {
            const failed = staging;
            if (failed !== null && failed.id !== 0)
                this.abandonStaging(failed);
            throw error;
        }
    }
    /** Publish a rewrite in one transaction when it fits; false when it does not. */
    tryPublishRewrite(node, path, newSize, content, onCommit) {
        const builder = this.newPlan();
        builder.addInode(this.rewrittenEntry(node, path, newSize, content));
        const plan = builder.build();
        if (exceededTransactionLimit(onCommit ? withCommitRowMetrics(plan.metrics) : plan.metrics) !== null)
            return false;
        this.commitRewrite(node, path, plan, onCommit);
        return true;
    }
    publishRewrite(node, path, newSize, content, onCommit) {
        const builder = this.newPlan();
        builder.addInode(this.rewrittenEntry(node, path, newSize, content));
        const plan = builder.build();
        this.assertTransactionFits(onCommit ? withCommitRowMetrics(plan.metrics) : plan.metrics);
        this.commitRewrite(node, path, plan, onCommit);
    }
    rewrittenEntry(node, path, newSize, content) {
        return {
            path: path ?? node.path,
            parentPath: path === null ? node.parentPath : this.parentPath(path),
            kind: 'file',
            isDir: false,
            size: newSize,
            atime: node.atime,
            mtime: this.now(),
            mode: node.mode,
            uid: node.uid,
            gid: node.gid,
            ino: node.ino,
            content,
            detached: path === null ? node : undefined,
        };
    }
    commitRewrite(node, path, plan, onCommit) {
        if (path !== null) {
            this._writeBatchOnce({ plan, deletedInodes: [] }, { source: 'range-mutation', limitMode: 'bounded' }, onCommit);
            this.runContentMaintenanceSafely(1);
            return;
        }
        this.executeTransactionPlan(plan, { source: 'range-mutation', limitMode: 'bounded' }, onCommit, [node]);
        const entry = plan.inodes[0];
        node.size = entry.size;
        node.chunkId = entry.chunkId ?? null;
        node.contentId = entry.contentId ?? null;
        node.mtime = entry.mtime;
        node.ctime = entry.ctime;
        this.runContentMaintenanceSafely(1);
    }
    /** The start offsets of a manifest's rows after `after`, read a page at a time on demand. */
    manifestOffsets(contentId, after) {
        let loaded = after;
        let done = false;
        const offsets = new Set();
        return {
            has: (offset) => {
                while (!done && loaded < offset) {
                    const rows = [...this.sql.exec('SELECT off FROM vfs_content_chunks WHERE content_id = ? AND off > ? ORDER BY off LIMIT ?', contentId, loaded, MANIFEST_PAGE_ROWS)];
                    for (const row of rows)
                        offsets.add(Number(row.off));
                    if (rows.length < MANIFEST_PAGE_ROWS)
                        done = true;
                    if (rows.length > 0)
                        loaded = Number(rows[rows.length - 1].off);
                }
                return offsets.has(offset);
            },
        };
    }
    /**
     * True when nothing but the live row at `path` can observe `node`'s chunk,
     * so the chunk may be rewritten in place: no other inode, manifest or
     * history row names it, no snapshot can see the row (the write would
     * preserve it), and no detached description holds it.
     */
    chunkUnshared(node, path) {
        const chunkId = node.chunkId;
        if (node.gen <= this._pinGen)
            return false;
        for (const opened of this.openNodes) {
            if (opened.inode.chunkId === chunkId && opened.path !== path)
                return false;
        }
        return [...this.sql.exec(`SELECT 1 FROM vfs_inodes WHERE chunk_id = ? AND path != ?
       UNION ALL SELECT 1 FROM vfs_content_chunks WHERE chunk_id = ?
       UNION ALL SELECT 1 FROM vfs_inode_history WHERE chunk_id = ?
       LIMIT 1`, chunkId, path, chunkId, chunkId)].length === 0;
    }
    /** The manifest counterpart of chunkUnshared: the CoW guard for large files. */
    contentUnshared(node, path) {
        const contentId = node.contentId;
        if (node.gen <= this._pinGen)
            return false;
        for (const opened of this.openNodes) {
            if (opened.inode.contentId === contentId && opened.path !== path)
                return false;
        }
        return [...this.sql.exec(`SELECT 1 FROM vfs_inodes WHERE content_id = ? AND path != ?
       UNION ALL SELECT 1 FROM vfs_inode_history WHERE content_id = ?
       LIMIT 1`, contentId, path, contentId)].length === 0;
    }
    newPlan() {
        return new TransactionPlanBuilder(this._pinGen > 0);
    }
    /** Create a state-0 content in its own transaction and hold it live. */
    beginStaging() {
        const staging = { id: 0, size: 0, count: 0, hashed: true, digest: new ManifestDigest() };
        const builder = this.newPlan();
        builder.addStaging(staging);
        this.executeTransactionPlan(builder.build(), { source: 'content-stage', limitMode: 'bounded' });
        return staging;
    }
    /**
     * Copy `source`'s manifest rows over [lo, hi) into `staging` by reference,
     * a bounded page per transaction. The copied chunks' hashes are not read,
     * so the published content's digest is left for contentKey to fill.
     */
    stageManifestCopy(staging, source, lo, hi) {
        staging.hashed = false;
        let cursor = lo;
        while (cursor < hi) {
            const page = [...this.sql.exec(`SELECT off, len FROM vfs_content_chunks WHERE content_id = ? AND off >= ? AND off < ? ORDER BY off LIMIT ?`, source, cursor, hi, MANIFEST_PAGE_ROWS)];
            if (page.length === 0)
                break;
            const last = page[page.length - 1];
            const next = Number(last.off) + Number(last.len);
            this.executeMeasuredTransaction(this.metricsOnlyPlan({ blobBytes: 0, logicalRows: page.length, sqlExecs: 1, affectedPaths: 0 }), { source: 'content-stage', limitMode: 'bounded' }, () => {
                this.sql.exec(`INSERT INTO vfs_content_chunks (content_id, off, len, chunk_id)
             SELECT ?, off, len, chunk_id FROM vfs_content_chunks WHERE content_id = ? AND off >= ? AND off < ?`, staging.id, source, cursor, next);
            });
            staging.count += page.length;
            cursor = next;
        }
        staging.size = hi;
    }
    /** A staging content that will never publish: queue it now. */
    abandonStaging(staging) {
        this.activeStagingContentIds.delete(staging.id);
        try {
            this.transactionSync(() => {
                this.sql.exec('INSERT OR IGNORE INTO vfs_gc_queue (kind, id) VALUES (?, ?)', GC_CONTENT, staging.id);
            });
        }
        catch { /* the open-time sweep queues every state-0 content */ }
        this.maintenancePending = true;
    }
    readFileString(path, cred) {
        return dec.decode(this.readFile(path, cred));
    }
    stat(path, cred, followLeaf) {
        const resolved = this.checkAccess(path, 0, cred, { followLeaf });
        const inode = resolved.inode;
        if (!inode)
            throw vfsError('ENOENT', path);
        return this.statOf(inode);
    }
    /** A linked inode's stat, for `stat` and for the entries `list` reports. */
    statOf(inode) {
        return {
            dev: this.deviceId, ino: inode.ino, nlink: 1,
            type: inode.kind,
            size: inode.size,
            atime: inode.atime || inode.mtime,
            ctime: inode.ctime,
            mtime: inode.mtime,
            mode: inode.mode,
            uid: inode.uid,
            gid: inode.gid,
            gen: inode.gen,
        };
    }
    /**
     * Rewrite an inode's metadata in its own generation. The row is rewritten
     * whole so a snapshot that can see it keeps its before-image, and the
     * content it names carries over by reference.
     */
    publishMetadata(inode, fields) {
        const builder = this.newPlan();
        builder.addInode({
            path: inode.path,
            parentPath: inode.parentPath,
            kind: inode.kind,
            isDir: inode.isDir,
            size: inode.size,
            atime: fields.atime ?? inode.atime,
            mtime: fields.mtime ?? inode.mtime,
            mode: fields.mode ?? inode.mode,
            uid: fields.uid ?? inode.uid,
            gid: fields.gid ?? inode.gid,
            ino: inode.ino,
            content: { type: 'ref', chunkId: inode.chunkId, contentId: inode.contentId },
        });
        this._writeBatchOnce({ plan: builder.build(), deletedInodes: [] }, { source: 'range-mutation', limitMode: 'bounded' });
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
        this.publishMetadata(inode, { atime, mtime });
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
        this.assertConfinedModeChange(inode, mode, cred, resolved.path);
        this.assertMutationsAllowed([inode.path]);
        this.publishMetadata(inode, { mode: inodeTypeBits(inode.kind) | (mode & 0o7777) });
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
        this.publishMetadata(inode, {
            uid: uid ?? inode.uid,
            gid: gid ?? inode.gid,
            mode: cred.uid === 0 ? inode.mode : inode.mode & ~0o6000,
        });
    }
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
    list(after, limit, cred) {
        // Before the walk, deliberately — see VfsListPage.
        const epoch = this._epoch;
        const rev = this._revision;
        const from = after === null || after === undefined ? '' : this.storageKey(after, cred);
        const entries = [];
        let cursor = from;
        // Rows arrive in path order, so a run of entries in one directory shares
        // one check of the directories above it.
        let checkedParent = null;
        let parentReachable = false;
        for (;;) {
            const rows = [...this.sql.exec(`SELECT ${INODE_SELECT_COLUMNS_AS_I}, c.hash AS chunk_hash, ct.digest AS content_digest
         FROM vfs_inodes i
         LEFT JOIN vfs_chunks c ON c.id = i.chunk_id
         LEFT JOIN vfs_contents ct ON ct.id = i.content_id
         WHERE i.path > ? ORDER BY i.path LIMIT ?`, cursor, limit + 1)];
            for (const row of rows) {
                if (entries.length >= limit)
                    return { epoch, rev, entries, next: entries[entries.length - 1].path };
                const path = String(row.path);
                // Reported in the caller's OWN path space. Enumerating raw storage keys
                // would name a private root the caller cannot address and does not know
                // it has, and a caller feeding such a path back would be asking about
                // someone else's tree. `null` means the path has no name for this
                // caller, which is the same OMIT the access check below performs.
                const logical = this.logicalPath(path, cred);
                if (logical === null)
                    continue;
                // What checkAccess(path, 0, cred, { followLeaf: false }) asks of an
                // entry that exists: every directory above it is traversable.
                const parent = this.parentPath(path);
                if (parent !== checkedParent) {
                    checkedParent = parent;
                    try {
                        if (parent !== '')
                            this.checkAccess(parent, 0o1, cred);
                        parentReachable = true;
                    }
                    catch {
                        parentReachable = false;
                    }
                }
                if (!parentReachable)
                    continue;
                // Read from the row rather than through the cache: one page of an
                // enumeration says nothing about which inodes will be used next.
                const inode = this.inodes.peek(path) ?? this.inodeFromRow(row);
                // The storage key's revision, the one revision() reports for the name
                // this entry is listed under: a confined caller's /tmp/x is its own
                // file, not the shared one at the same name.
                const pathRevision = this.pathRevision(path, inode);
                entries.push({
                    path: logical,
                    kind: inode.kind,
                    size: inode.size,
                    rev: pathRevision,
                    stat: { ...this.statOf(inode), revision: pathRevision },
                    ...(inode.kind === 'symlink' ? { linkTarget: this.readlink(logical, cred) } : {}),
                    ...(inode.kind === 'file' ? { contentKey: this.listedContentKey(inode, row) } : {}),
                });
            }
            if (rows.length <= limit)
                return { epoch, rev, entries, next: null };
            cursor = String(rows[rows.length - 1].path);
        }
    }
    readdir(path, cred) {
        const np = this.storageKey(path, cred);
        const resolved = np ? this.checkAccess(np, 0o4, cred) : { path: '', inode: undefined };
        const inode = resolved.inode;
        if (inode && inode.kind !== 'directory')
            throw vfsError('ENOTDIR', path);
        // One seek of the parent index. The entries are read, not cached: naming
        // a directory's entries says nothing about which of them will be used.
        const results = [];
        for (const row of this.sql.exec('SELECT path, kind FROM vfs_inodes WHERE parent_path = ?', np)) {
            const child = String(row.path);
            results.push({ name: child.slice(child.lastIndexOf('/') + 1), type: inodeKindFromCode(Number(row.kind)) });
        }
        // W2.6a: sort lexicographically, by UTF-16 code unit. Consumers that
        // walk readdir results — buildPrefetchBundle, buildManifest, the
        // kernel-VFS mount layer — rely on a stable order, and this is the one
        // they have always had. SQLite's byte order is not it: the two disagree
        // on names outside the Basic Multilingual Plane.
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
        this.checkStickyParentMutation(resolved.path, inode, cred);
        if (inode.isDir)
            throw vfsError('EISDIR', resolved.path);
        this.writeBatch({ inodes: [], chunks: [], deletePaths: [resolved.path] }, cred);
    }
    rmdir(path, cred) {
        this.assertMutationsAllowed([path]);
        const np = this.storageKey(path, cred);
        const resolved = this.checkAccess(np, 0, cred, { followLeaf: false });
        this.checkParentAccess(resolved.path, cred);
        const inode = this.inodes.get(np);
        if (!inode)
            throw vfsError('ENOENT', path);
        this.checkStickyParentMutation(resolved.path, inode, cred);
        // Empty is one seek of the parent index.
        if ([...this.sql.exec('SELECT 1 FROM vfs_inodes WHERE parent_path = ? LIMIT 1', np)].length > 0) {
            throw vfsError('ENOTEMPTY', path);
        }
        if (!inode.isDir)
            throw vfsError('ENOTDIR', path);
        this.writeBatch({ inodes: [], chunks: [], deletePaths: [np] }, cred);
    }
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
    removeRecursive(path, cred) {
        this.assertMutationsAllowed([path]);
        const resolved = this.checkAccess(path, 0, cred, { followLeaf: false });
        if (!resolved.inode)
            throw vfsError('ENOENT', normalizeVfsPath(path));
        this.checkParentAccess(resolved.path, cred);
        this.checkStickyParentMutation(resolved.path, resolved.inode, cred);
        // The directories the recursive walk used to enumerate are exactly the
        // directory inodes of the subtree, and enumerating one needed read
        // permission. Answering from the index would otherwise skip that check.
        // All of them pass before the first group commits.
        for (const inode of this.subtreeDescending(resolved.path, resolved.inode, true)) {
            if (!this.accessInode(inode, 0o4, cred))
                throw vfsError('EACCES', inode.path);
        }
        let removed = 0;
        let group = [];
        let budget = this.newPlan();
        const flush = () => {
            if (group.length === 0)
                return;
            const paths = group;
            group = [];
            budget = this.newPlan();
            // Every group re-authorises its own paths and re-checks the mutation
            // guard through commitBatch, so each check is contemporaneous with the
            // transaction that acts on it.
            this.commitBatch({ inodes: [], chunks: [], deletePaths: paths }, cred);
            removed += paths.length;
        };
        for (const inode of this.subtreeDescending(resolved.path, resolved.inode, false)) {
            // Close the group before the entry that would overflow it. The estimate
            // only picks the boundary — the commit asserts the bound it writes.
            if (budget.wouldExceedDeletion() !== null)
                flush();
            budget.addDeletedPath(inode.path, inode);
            group.push(inode.path);
        }
        flush();
        this.runContentMaintenanceSafely(1);
        return removed;
    }
    /**
     * The inodes under `root`, then `root` itself, in descending path order, a
     * bounded page at a time. A path under a directory extends the directory's
     * path, so it sorts after it: every entry comes before the directory that
     * holds it. Each page starts below the last path read, so removing what
     * was already yielded does not disturb the walk.
     */
    *subtreeDescending(root, rootInode, directoriesOnly) {
        const range = subtreeRange(root);
        const kind = directoriesOnly ? ` AND kind = ${INODE_KIND_DIRECTORY}` : '';
        let below = range.upper;
        for (;;) {
            const rows = [...(below === null
                    ? this.sql.exec(`SELECT ${INODE_SELECT_COLUMNS} FROM vfs_inodes WHERE path > ?${kind} ORDER BY path DESC LIMIT ?`, range.lower, SUBTREE_PAGE_ROWS)
                    : this.sql.exec(`SELECT ${INODE_SELECT_COLUMNS} FROM vfs_inodes WHERE path > ? AND path < ?${kind} ORDER BY path DESC LIMIT ?`, range.lower, below, SUBTREE_PAGE_ROWS))];
            for (const row of rows)
                yield this.inodes.peek(String(row.path)) ?? this.inodeFromRow(row);
            if (rows.length < SUBTREE_PAGE_ROWS)
                break;
            below = String(rows[rows.length - 1].path);
        }
        if (!directoriesOnly || rootInode.isDir)
            yield rootInode;
    }
    rename(oldPath, newPath, cred) {
        this.assertMutationsAllowed([oldPath, newPath]);
        // Resolve private /tmp names to storage keys before reading or mutating.
        const source = this.checkAccess(oldPath, 0, cred, { followLeaf: false });
        const inode = source.inode;
        if (!inode)
            throw vfsError('ENOENT', oldPath);
        const target = this.checkAccess(newPath, 0, cred, { followLeaf: false, allowMissingLeaf: true });
        oldPath = source.path;
        newPath = target.path;
        this.checkParentAccess(oldPath, cred);
        this.checkParentAccess(newPath, cred);
        if (oldPath === newPath)
            return;
        if (newPath.startsWith(`${oldPath}/`)) {
            throw new Error(`EINVAL: cannot move ${oldPath} inside itself`);
        }
        this.checkStickyParentMutation(oldPath, inode, cred);
        // W-3 (WASI filesystem WASI): if newPath already exists, unlink it first so the
        // SQL UPDATE doesn't conflict on inodes.path uniqueness. POSIX rename(2)
        // overwrites the destination atomically; clang's atomic-write pattern
        // (write tmp + rename → final) depends on this. Without this branch,
        // a 2nd `make` after a prior successful build throws on UPDATE
        // failure. Pre-unlink covers both file-over-file and file-over-dir
        // (the latter is rare but POSIX permits it for empty dirs).
        const destInode = target.inode;
        if (destInode) {
            this.checkStickyParentMutation(newPath, destInode, cred);
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
            // POSIX: a directory never replaces a non-directory. Refusing it also
            // keeps an occupied destination to the single-entry file-onto-file
            // move, whose publication is one transaction — so the destination this
            // move supersedes is never dropped by a group that later fails.
            if (inode.isDir) {
                throw new Error(`ENOTDIR: cannot overwrite non-directory ${newPath} with directory ${oldPath}`);
            }
        }
        // Both questions a rename asks — what moves, and what is already at the
        // destination — are subtree queries, and the index answers them in the
        // size of those subtrees. Scanning every inode twice made an atomic write
        // (write temp, rename over) cost the whole filesystem per call.
        const moving = this.collectSubtreeInodes([oldPath]).reverse();
        const movingPaths = new Set(moving.map((entry) => entry.path));
        const targetPaths = new Set(moving.map((entry) => newPath + entry.path.substring(oldPath.length)));
        for (const existing of this.collectSubtreeInodes([newPath])) {
            if (movingPaths.has(existing.path) || existing.path === destInode?.path)
                continue;
            if (targetPaths.has(existing.path) || existing.path.startsWith(`${newPath}/`)) {
                throw new Error(`ENOTEMPTY: rename target subtree conflicts at ${existing.path}`);
            }
        }
        // `moving` is shallowest-first, which is the order publication needs: a
        // parent directory exists before the children that name it. Retiring the
        // source needs the opposite.
        const retiring = [...moving].reverse();
        const touchedPaths = new Set();
        const commit = (builder) => {
            if (builder.empty)
                return;
            const plan = builder.build();
            this.assertTransactionFits(plan.metrics);
            // Before executing: a commit that throws after it is durable is reported too.
            for (const path of plan.affectedPaths)
                touchedPaths.add(path);
            this.executeTransactionPlan(plan, { source: 'content-publish', limitMode: 'bounded' });
            const rows = plan.inodes.length + plan.deletes.length;
            this._sqlWrites += rows;
            this._batchWrites++;
            this._batchWriteRows += rows;
        };
        // ── Phase 1: publish the whole tree at the destination ────────────────
        //
        // Content moves by id, so a file is reachable from both paths for the
        // width of this phase and its bytes are written once. Nothing leaves the
        // source until this phase has committed in full, so an entry is never at
        // neither path — the guarantee a caller that has already cleared the
        // destination is relying on.
        //
        // A failure here unwinds what it published, leaving exactly the pre-move
        // state: a partially populated destination would otherwise refuse the
        // retry as a subtree conflict.
        let builder = this.newPlan();
        if (destInode) {
            // Path uniqueness: the occupant goes in the same transaction as the
            // inode replacing it. That is only ever the file-onto-file case, whose
            // subtree is a single entry, so this group is the whole move.
            builder.addDeletedPath(newPath, destInode);
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
                // Content moves by reference: the bytes are never read or written.
                content: { type: 'ref', chunkId: entry.chunkId, contentId: entry.contentId },
                // A rename keeps the inode: the number follows the entry, not the path.
                ino: entry.ino,
                // Only the moved inode itself changes; its descendants keep their ctime.
                ctime: entry.path === oldPath ? undefined : entry.ctime,
            };
            return { entry, stored };
        });
        const committed = [];
        let group = [];
        const flushPublished = () => {
            if (builder.empty)
                return;
            commit(builder);
            committed.push(...group);
            group = [];
            builder = this.newPlan();
        };
        try {
            for (const { stored } of renamed) {
                // Close the group before the entry that would overflow it. The
                // estimate only picks the boundary — the commit asserts the bound it
                // writes.
                if (builder.wouldExceedInode() !== null)
                    flushPublished();
                builder.addInode(stored);
                group.push(stored);
            }
            flushPublished();
        }
        catch (error) {
            this.unpublishRenameDestination(committed);
            if (touchedPaths.size > 0)
                this.bumpRevision([...touchedPaths]);
            throw error;
        }
        // The superseded occupant goes first: it shares its path with the entry
        // published over it, exactly as the transaction deleted before inserting.
        if (destInode) {
            for (const opened of this.openNodes)
                if (opened.path === destInode.path)
                    opened.path = null;
            destInode.ctime = this.now();
            this.inodes.delete(destInode.path);
            this._totalFiles--;
            this._usedBytes -= destInode.size;
        }
        for (const { entry, stored } of renamed) {
            for (const opened of this.openNodes)
                if (opened.path === entry.path)
                    opened.path = stored.path;
            const moved = {
                ...entry,
                path: stored.path,
                parentPath: stored.parentPath,
                ctime: stored.ctime,
                gen: stored.gen,
            };
            this.inodes.set(moved.path, moved);
            if (moved.isDir)
                this._totalDirs++;
            else {
                this._totalFiles++;
                this._usedBytes += moved.size;
            }
        }
        // ── Phase 2: retire the source ────────────────────────────────────────
        //
        // Deepest-first, so every committed prefix leaves a smaller consistent
        // tree behind — the same property the batched removal relies on. No
        // content is collected here and none is queued: the destination inodes
        // published above reference it, so these paths orphan nothing. Each group
        // leaves the cache and the counters as it commits, so a group that fails
        // leaves them describing the prefix that did.
        builder = this.newPlan();
        let retired = [];
        const retire = () => {
            commit(builder);
            for (const entry of retired) {
                this.inodes.delete(entry.path);
                if (entry.isDir)
                    this._totalDirs--;
                else {
                    this._totalFiles--;
                    this._usedBytes -= entry.size;
                }
            }
            retired = [];
            builder = this.newPlan();
        };
        try {
            for (const entry of retiring) {
                if (builder.wouldExceedDeletion() !== null)
                    retire();
                builder.addDeletedPath(entry.path, entry, false);
                retired.push(entry);
            }
            retire();
        }
        catch (error) {
            // What committed is visible, so it is published before the error goes.
            this.bumpRevision([...touchedPaths]);
            throw error;
        }
        this.bumpRevision([...touchedPaths]);
        this.emitMutation('rename', newPath, oldPath);
        this.runContentMaintenanceSafely(1);
    }
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
    unpublishRenameDestination(published) {
        if (published.length === 0)
            return;
        const deepestFirst = [...published].reverse();
        let builder = this.newPlan();
        const flush = () => {
            if (builder.empty)
                return;
            const plan = builder.build();
            builder = this.newPlan();
            this.assertTransactionFits(plan.metrics);
            this.executeTransactionPlan(plan, { source: 'content-publish', limitMode: 'bounded' });
        };
        try {
            for (const stored of deepestFirst) {
                if (builder.wouldExceedDeletion() !== null)
                    flush();
                // The source still holds these references, so none is queued.
                builder.addDeletedPath(stored.path, undefined, false);
            }
            flush();
        }
        catch { /* the source is intact; report the original failure */ }
    }
    /**
     * Copy a file by reference: one inode row naming the source's chunk or
     * manifest. No byte is read or written; a later write to either side
     * copies on write (rewriteFile's sharing probes).
     */
    copyFile(src, dest, cred) {
        const source = this.checkAccess(src, 0o4, cred);
        const inode = source.inode;
        if (!inode)
            throw vfsError('ENOENT', src);
        if (inode.kind === 'directory')
            throw vfsError('EISDIR', source.path);
        if (inode.kind !== 'file')
            throw vfsError('EINVAL', `${source.path} is not a regular file`);
        this.assertMutationsAllowed([dest]);
        const target = this.checkAccess(dest, 0, cred, { allowMissingLeaf: true });
        const prior = target.inode;
        if (prior?.kind === 'directory')
            throw vfsError('EISDIR', target.path);
        if (prior && prior.kind !== 'file')
            throw vfsError('EINVAL', `${target.path} is not a regular file`);
        if (prior && !this.accessInode(prior, 0o2, cred))
            throw vfsError('EACCES', target.path);
        if (!prior)
            this.checkParentAccess(target.path, cred);
        const now = this.now();
        const builder = this.newPlan();
        builder.addInode({
            path: target.path,
            parentPath: this.parentPath(target.path),
            kind: 'file',
            isDir: false,
            size: inode.size,
            atime: now,
            mtime: now,
            mode: prior ? prior.mode : this.creationMode(0o666, cred),
            uid: prior?.uid ?? cred.uid,
            gid: prior?.gid ?? cred.gid,
            content: { type: 'ref', chunkId: inode.chunkId, contentId: inode.contentId },
        });
        this._writeBatchOnce({ plan: builder.build(), deletedInodes: [] }, { source: 'strict-batch', limitMode: 'bounded' });
        this.runContentMaintenanceSafely(1);
    }
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
    copyTree(src, dst, cred, options = {}) {
        this.assertMutationsAllowed([dst]);
        const atGen = options.at === undefined ? undefined : this.requireSnapshot(options.at);
        const tree = atGen === undefined ? this.inodes : { get: (path) => this.inodeAt(path, atGen) };
        const source = this.checkAccess(src, 0o4, cred, { followLeaf: false, tree });
        const root = source.inode;
        const target = this.checkAccess(dst, 0, cred, { followLeaf: false, allowMissingLeaf: true });
        if (target.inode)
            throw vfsError('EEXIST', target.path);
        this.checkParentAccess(target.path, cred);
        if (target.path === source.path || target.path.startsWith(`${source.path}/`)) {
            throw vfsError('EINVAL', `cannot copy ${source.path} into itself`);
        }
        if (cred.uid !== 0 && root.isDir) {
            const entries = atGen === undefined
                ? this.subtreeDescending(source.path, root, false)
                : this.subtreeAt(source.path, atGen);
            for (const inode of entries) {
                if (!this.accessInode(inode, inode.isDir ? 0o5 : inode.kind === 'symlink' ? 0 : 0o4, cred)) {
                    throw vfsError('EACCES', inode.path);
                }
            }
        }
        const job = {
            src: source.path,
            dst: target.path,
            uid: cred.uid,
            gid: cred.gid,
            clearBits: options.preserve ? 0 : (cred.umask & 0o777) | 0o6000,
            preserveOwner: options.preserve === true && cred.uid === 0,
            preserveTimes: options.preserve === true,
            ...(atGen === undefined ? {} : { at: options.at, atGen }),
        };
        return this.runCopyTree(job, null);
    }
    /** Every entry strictly under `root` as of generation `g`, a page at a time. */
    *subtreeAt(root, g) {
        const range = subtreeRange(root);
        let cursor = range.lower;
        for (;;) {
            const page = this.pageAt(g, cursor, SUBTREE_PAGE_ROWS);
            for (const inode of page) {
                if (range.upper !== null && inode.path >= range.upper)
                    return;
                yield inode;
            }
            if (page.length < SUBTREE_PAGE_ROWS)
                return;
            cursor = page[page.length - 1].path;
        }
    }
    /**
     * Run a copyTree job to completion: the root row and the job row in the
     * first transaction, then one page per transaction, the cursor moving in
     * the transaction that copies the page. `id` resumes a recorded job.
     */
    runCopyTree(job, id) {
        const range = subtreeRange(job.src);
        const columns = 'path, parent_path, kind, size, atime, mtime, mode, uid, gid, chunk_id, content_id';
        // The rows copied: the live tree, or the snapshot's (live rows it still
        // sees, plus the history rows covering it). Generations are integers.
        const source = job.atGen === undefined
            ? 'vfs_inodes'
            : `(SELECT ${columns} FROM vfs_inodes WHERE gen <= ${job.atGen}
          UNION ALL SELECT ${columns} FROM vfs_inode_history WHERE gen_to > ${job.atGen} AND gen_from <= ${job.atGen})`;
        let jobId = id;
        let cursor = jobId === null ? null : String([...this.sql.exec('SELECT cursor FROM vfs_jobs WHERE id = ?', jobId)][0].cursor);
        let copied = 0;
        for (;;) {
            const now = this.now();
            const page = cursor === null
                ? [...this.sql.exec(`SELECT path, kind, size FROM ${source} WHERE path = ?`, job.src)]
                : [...(range.upper === null
                        ? this.sql.exec(`SELECT path, kind, size FROM ${source} WHERE path > ? ORDER BY path LIMIT ?`, cursor, COPY_PAGE_ROWS)
                        : this.sql.exec(`SELECT path, kind, size FROM ${source} WHERE path > ? AND path < ? ORDER BY path LIMIT ?`, cursor, range.upper, COPY_PAGE_ROWS))];
            const last = page.length > 0 ? String(page[page.length - 1].path) : null;
            const done = cursor !== null && page.length < COPY_PAGE_ROWS;
            let gen = 0;
            this.executeMeasuredTransaction(this.metricsOnlyPlan({ blobBytes: 0, logicalRows: page.length + 2, sqlExecs: 4, affectedPaths: page.length }), { source: 'content-publish', limitMode: 'bounded' }, () => {
                const state = [...this.sql.exec('UPDATE vfs_state SET gen = gen + 1 WHERE slot = 1 RETURNING gen, next_ino')][0];
                gen = Number(state.gen);
                const firstIno = Number(state.next_ino);
                if (page.length > 0) {
                    const lower = cursor === null ? job.src : cursor;
                    const tail = job.src.length + 1;
                    this.sql.exec(`INSERT OR IGNORE INTO vfs_inodes
                 (path, parent_path, kind, size, atime, mtime, ctime, mode, uid, gid, ino, gen, chunk_id, content_id)
               SELECT ? || substr(path, ?),
                      CASE WHEN path = ? THEN ? ELSE ? || substr(parent_path, ?) END,
                      kind, size,
                      CASE WHEN ? THEN atime ELSE ? END, CASE WHEN ? THEN mtime ELSE ? END, ?,
                      CASE WHEN kind = ${INODE_KIND_SYMLINK} THEN mode ELSE mode & ~? END,
                      CASE WHEN ? THEN uid ELSE ? END, CASE WHEN ? THEN gid ELSE ? END,
                      ? + row_number() OVER (ORDER BY path) - 1, ?, chunk_id, content_id
               FROM ${source} WHERE path ${cursor === null ? '=' : '>'} ? AND path <= ? ORDER BY path`, job.dst, tail, job.src, this.parentPath(job.dst), job.dst, tail, job.preserveTimes ? 1 : 0, now, job.preserveTimes ? 1 : 0, now, now, job.clearBits, job.preserveOwner ? 1 : 0, job.uid, job.preserveOwner ? 1 : 0, job.gid, firstIno, gen, lower, last);
                    this.sql.exec('UPDATE vfs_state SET next_ino = ? WHERE slot = 1', firstIno + page.length);
                }
                if (jobId === null) {
                    jobId = Number([...this.sql.exec(`INSERT INTO vfs_jobs (kind, args, cursor, start_gen, created_at) VALUES ('copyTree', ?, ?, ?, ?) RETURNING id`, JSON.stringify(job), job.src === '' ? '' : `${job.src}/`, gen, now)][0].id);
                }
                else if (done) {
                    this.sql.exec('DELETE FROM vfs_jobs WHERE id = ?', jobId);
                }
                else {
                    this.sql.exec('UPDATE vfs_jobs SET cursor = ? WHERE id = ?', last, jobId);
                }
            });
            this._gen = gen;
            const published = [];
            for (const row of page) {
                const path = job.dst + String(row.path).slice(job.src.length);
                published.push(path);
                if (!this._countersLoaded)
                    continue;
                if (Number(row.kind) === INODE_KIND_DIRECTORY)
                    this._totalDirs++;
                else {
                    this._totalFiles++;
                    this._usedBytes += Number(row.size);
                }
            }
            copied += page.length;
            if (published.length > 0)
                this.bumpRevision(published);
            // One event for the tree, as rename emits: events queue until the
            // turn ends, and one per copied row would hold the whole tree.
            if (cursor === null)
                this.emitMutation(Number(page[0]?.kind) === INODE_KIND_DIRECTORY ? 'addDir' : 'add', job.dst);
            if (cursor === null) {
                cursor = job.src === '' ? '' : `${job.src}/`;
                if (Number(page[0]?.kind) !== INODE_KIND_DIRECTORY) {
                    // A file or symlink is its own whole tree: its job ends with it.
                    this.transactionSync(() => { this.sql.exec('DELETE FROM vfs_jobs WHERE id = ?', jobId); });
                    return copied;
                }
                continue;
            }
            if (done)
                return copied;
            cursor = last;
        }
    }
    /** Finish every job a reset interrupted. Runs at open; a job resumes from its cursor. */
    resumeJobs() {
        for (const row of [...this.sql.exec('SELECT id, kind, args, start_gen FROM vfs_jobs ORDER BY id')]) {
            const id = Number(row.id);
            try {
                const args = JSON.parse(String(row.args));
                if (row.kind === 'copyTree')
                    this.runCopyTree(args, id);
                else if (row.kind === 'restore')
                    this.runRestore(id, args, Number(row.start_gen));
                else if (row.kind === 'drop')
                    this.runDrop(id, Number(args.g));
                else
                    throw new Error(`unknown job kind ${String(row.kind)}`);
            }
            catch (error) {
                console.error(`[sqlite-vfs] job ${id} (${String(row.kind)}) failed to resume:`, this.errorMessage(error));
            }
        }
    }
    // ── Snapshots, history, restore ───────────────────────────────────────
    //
    // A snapshot names a generation. Live rows with gen <= it, and history
    // rows with gen_from <= it < gen_to, are its tree. The first write after
    // the newest snapshot to a row it can see (gen <= pin_gen) keeps the old
    // row as history in the same transaction; later writes to that path find
    // gen > pin_gen and keep nothing. So a snapshot is one row, and history
    // grows only with divergence.
    /** Every snapshot, oldest first. */
    snapshots() {
        return [...this.sql.exec('SELECT name, gen, created_at FROM vfs_snapshots ORDER BY gen, id')]
            .map((row) => ({ name: String(row.name), gen: Number(row.gen), createdAt: Number(row.created_at) }));
    }
    snapshot(name, options = {}) {
        if (typeof name !== 'string' || name === '' || name.length > 256)
            throw vfsError('EINVAL', 'invalid snapshot name');
        if (!options.quiesce)
            return this.pinSnapshot(name);
        return (async () => {
            while (this.activeStreams.size > 0)
                await Promise.allSettled([...this.activeStreams]);
            return this.pinSnapshot(name);
        })();
    }
    pinSnapshot(name) {
        if (this.snapshotGen(name) !== undefined)
            throw vfsError('EEXIST', `snapshot ${name}`);
        const createdAt = this.now();
        let gen = 0;
        this.transactionSync(() => {
            gen = Number([...this.sql.exec('SELECT gen FROM vfs_state WHERE slot = 1')][0].gen);
            this.sql.exec('INSERT INTO vfs_snapshots (name, gen, created_at) VALUES (?, ?, ?)', name, gen, createdAt);
            this.sql.exec('UPDATE vfs_state SET pin_gen = ? WHERE slot = 1', gen);
        });
        this._pinGen = gen;
        this.snapshotGens?.set(name, gen);
        return { name, gen, createdAt };
    }
    snapshotGen(name) {
        if (this.snapshotGens === null) {
            this.snapshotGens = new Map(this.snapshots().map((snap) => [snap.name, snap.gen]));
        }
        return this.snapshotGens.get(name);
    }
    requireSnapshot(name) {
        const gen = this.snapshotGen(name);
        if (gen === undefined)
            throw vfsError('ENOENT', `snapshot ${name}`);
        return gen;
    }
    /** The inode at `path` as of generation `g`: its live row if unchanged since, else the history row covering `g`. */
    inodeAt(path, g) {
        const live = [...this.sql.exec(`SELECT ${INODE_SELECT_COLUMNS} FROM vfs_inodes WHERE path = ? AND gen <= ?`, path, g)][0];
        if (live !== undefined)
            return this.inodeFromRow(live);
        const past = [...this.sql.exec(`SELECT ${HISTORY_SELECT_COLUMNS} FROM vfs_inode_history
       WHERE path = ? AND gen_to > ? AND gen_from <= ? ORDER BY gen_to LIMIT 1`, path, g, g)][0];
        return past === undefined ? undefined : this.inodeFromRow(past);
    }
    /** The children of `dir` as of generation `g`, in UTF-16 name order (readdir's). */
    childrenAt(dir, g) {
        const out = new Map();
        for (const row of this.sql.exec(`SELECT ${INODE_SELECT_COLUMNS} FROM vfs_inodes WHERE parent_path = ? AND gen <= ?`, dir, g)) {
            out.set(String(row.path), this.inodeFromRow(row));
        }
        for (const row of this.sql.exec(`SELECT ${HISTORY_SELECT_COLUMNS} FROM vfs_inode_history WHERE parent_path = ? AND gen_to > ? AND gen_from <= ?`, dir, g, g))
            out.set(String(row.path), this.inodeFromRow(row));
        return [...out.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    }
    /** One keyset page of the tree as of `g`, in path order: live and history merged. */
    pageAt(g, after, limit) {
        const live = [...this.sql.exec(`SELECT ${INODE_SELECT_COLUMNS} FROM vfs_inodes WHERE path > ? AND gen <= ? ORDER BY path LIMIT ?`, after, g, limit)].map((row) => this.inodeFromRow(row));
        const past = [...this.sql.exec(`SELECT ${HISTORY_SELECT_COLUMNS} FROM vfs_inode_history
       WHERE path > ? AND gen_to > ? AND gen_from <= ? ORDER BY path LIMIT ?`, after, g, g, limit)].map((row) => this.inodeFromRow(row));
        return [...live, ...past].sort((a, b) => (a.path < b.path ? -1 : 1)).slice(0, limit);
    }
    /**
     * A read-only view of snapshot `name` for `cred`: the same methods, the
     * same permission checks and symlink resolution, over the tree the
     * snapshot pinned. Mutators throw EROFS; every call after the snapshot is
     * dropped throws ESTALE (its history may already be collected).
     */
    at(name, cred = CRED_KERNEL) {
        const g = this.requireSnapshot(name);
        const bound = Object.freeze({
            uid: cred.uid,
            gid: cred.gid,
            groups: Object.freeze([...cred.groups]),
            umask: cred.umask & 0o777,
        });
        // A snapshot's rows never change, so the view caches lookups (bounded;
        // directories dominate, since every resolution walks them).
        const seen = new Map();
        const tree = {
            get: (path) => {
                const hit = seen.get(path);
                if (hit !== undefined)
                    return hit ?? undefined;
                const inode = this.inodeAt(path, g);
                if (seen.size >= SNAPSHOT_VIEW_CACHE_ENTRIES)
                    seen.clear();
                seen.set(path, inode ?? null);
                return inode;
            },
        };
        const pinned = () => {
            if (this.snapshotGen(name) !== g)
                throw vfsError('ESTALE', `snapshot ${name} was dropped`);
        };
        const readOnly = () => { throw vfsError('EROFS', `snapshot ${name} is read-only`); };
        const resolve = (path, want, followLeaf = true) => {
            pinned();
            return this.checkAccess(path, want, bound, { followLeaf, tree });
        };
        const probe = (path) => {
            pinned();
            try {
                return this.checkAccess(path, 0, bound, { followLeaf: false, allowMissingLeaf: true, tree }).inode;
            }
            catch (error) {
                const code = error.code;
                if (code === 'ENOENT' || code === 'ENOTDIR')
                    return undefined;
                throw error;
            }
        };
        const file = (path) => {
            const resolved = resolve(path, 0o4);
            const inode = resolved.inode;
            if (inode.kind === 'directory')
                throw vfsError('EISDIR', resolved.path);
            if (inode.kind !== 'file')
                throw vfsError('EINVAL', `${resolved.path} is not a regular file`);
            return inode;
        };
        const range = (path, offset, length) => {
            const inode = file(path);
            const start = clampNonNegativeInt(offset);
            const end = Math.min(inode.size, start + clampNonNegativeInt(length));
            return this.readContent(inode, start, end, true);
        };
        const readlink = (path) => {
            const inode = resolve(path, 0, false).inode;
            if (inode.kind !== 'symlink')
                throw vfsError('EINVAL', `${path} is not a symlink`);
            return dec.decode(this.readContent(inode, 0, inode.size, true));
        };
        return {
            cred: bound,
            exists: (path) => probe(path) !== undefined,
            isDirectory: (path) => probe(path)?.kind === 'directory',
            isFile: (path) => probe(path)?.kind === 'file',
            isSymlink: (path) => probe(path)?.kind === 'symlink',
            access: (path, mode) => { resolve(path, mode); },
            mkdir: readOnly,
            writeFile: readOnly,
            symlink: readOnly,
            readlink,
            resolveSymlink: (path) => {
                pinned();
                try {
                    return this.resolvePath(path, bound, true, false, tree).path;
                }
                catch (error) {
                    if (error.code === 'ELOOP')
                        return null;
                    throw error;
                }
            },
            readFile: (path) => { const inode = file(path); return this.readContent(inode, 0, inode.size, true); },
            readFileUncached: (path) => { const inode = file(path); return this.readContent(inode, 0, inode.size, false); },
            readRange: range,
            readRangeUncached: (path, offset, length) => {
                const inode = file(path);
                const start = clampNonNegativeInt(offset);
                return this.readContent(inode, start, Math.min(inode.size, start + clampNonNegativeInt(length)), false);
            },
            writeRange: readOnly,
            appendOnce: readOnly,
            acknowledgeAppend: readOnly,
            truncate: readOnly,
            readFileString: (path) => { const inode = file(path); return dec.decode(this.readContent(inode, 0, inode.size, true)); },
            stat: (path) => this.statOf(resolve(path, 0).inode),
            lstat: (path) => this.statOf(resolve(path, 0, false).inode),
            utimes: readOnly,
            chmod: readOnly,
            chown: readOnly,
            readdir: (path) => {
                const np = this.storageKey(path, bound);
                if (np !== '') {
                    const inode = resolve(np, 0o4).inode;
                    if (inode.kind !== 'directory')
                        throw vfsError('ENOTDIR', path);
                }
                else
                    pinned();
                return this.childrenAt(np, g).map((child) => ({
                    name: child.path.slice(child.path.lastIndexOf('/') + 1),
                    type: child.kind,
                }));
            },
            list: (after, limit) => {
                pinned();
                const pageLimit = Math.min(Math.max(1, Math.trunc(limit ?? FS_LIST_PAGE_LIMIT)), FS_LIST_PAGE_LIMIT);
                const from = after === null || after === undefined ? '' : this.storageKey(after, bound);
                const entries = [];
                const searchableDirs = new Map();
                let cursor = from;
                for (;;) {
                    const page = this.pageAt(g, cursor, pageLimit + 1);
                    for (const inode of page) {
                        if (entries.length >= pageLimit)
                            return { epoch: this._epoch, rev: g, entries, next: entries[entries.length - 1].path };
                        const logical = this.logicalPath(inode.path, bound);
                        if (logical === null)
                            continue;
                        const parent = this.parentPath(inode.path);
                        if (parent !== '' && bound.uid !== 0) {
                            let searchable = searchableDirs.get(parent);
                            if (searchable === undefined) {
                                try {
                                    this.checkAccess(parent, 0o1, bound, { tree });
                                    searchable = true;
                                }
                                catch {
                                    searchable = false;
                                }
                                searchableDirs.set(parent, searchable);
                            }
                            if (!searchable)
                                continue;
                        }
                        entries.push({
                            path: logical,
                            kind: inode.kind,
                            size: inode.size,
                            rev: g,
                            stat: { ...this.statOf(inode), revision: g },
                            ...(inode.kind === 'symlink' ? { linkTarget: dec.decode(this.readContent(inode, 0, inode.size, true)) } : {}),
                        });
                    }
                    if (page.length <= pageLimit)
                        return { epoch: this._epoch, rev: g, entries, next: null };
                    cursor = page[page.length - 1].path;
                }
            },
            unlink: readOnly,
            rmdir: readOnly,
            removeRecursive: readOnly,
            rename: readOnly,
            copyFile: readOnly,
            copyTree: readOnly,
            writeBatch: readOnly,
            writeStream: readOnly,
            mkdirBatch: readOnly,
            revision: () => g,
            contentKey: (path) => {
                const inode = resolve(path, 0o4).inode;
                if (inode.kind === 'directory')
                    throw vfsError('EISDIR', path);
                return this.contentKeyOf(inode);
            },
            epoch: this._epoch,
        };
    }
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
    restore(name, options = {}) {
        const g = this.requireSnapshot(name);
        const subtree = options.subtree === undefined ? '' : normalizeVfsPath(options.subtree);
        if (subtree !== '')
            this.assertMutationsAllowed([subtree]);
        else if (this.exclusiveMutationLeases.size > 0)
            throw vfsError('EBUSY', 'an exclusive filesystem mutation is active');
        let id = 0;
        let startGen = 0;
        this.transactionSync(() => {
            startGen = Number([...this.sql.exec('SELECT gen FROM vfs_state WHERE slot = 1')][0].gen) + 1;
            id = Number([...this.sql.exec(`INSERT INTO vfs_jobs (kind, args, cursor, start_gen, created_at) VALUES ('restore', ?, '', ?, ?) RETURNING id`, JSON.stringify({ name, g, subtree }), startGen, this.now())][0].id);
        });
        return { restored: this.runRestore(id, { name, g, subtree }, startGen) };
    }
    runRestore(id, job, startGen) {
        const range = subtreeRange(job.subtree);
        // Path filter for both tables, as SQL plus its parameters.
        const within = job.subtree === ''
            ? { sql: '', params: [] }
            : { sql: ' AND (path = ? OR (path > ? AND path < ?))', params: [job.subtree, range.lower, range.upper] };
        let restored = 0;
        for (;;) {
            const changed = [...this.sql.exec(`SELECT ${INODE_SELECT_COLUMNS} FROM vfs_inodes WHERE gen > ? AND gen < ?${within.sql} ORDER BY gen LIMIT ?`, job.g, startGen, ...within.params, RESTORE_PAGE_ROWS)].map((row) => this.inodeFromRow(row));
            const revived = changed.length < RESTORE_PAGE_ROWS
                ? [...this.sql.exec(`SELECT ${HISTORY_SELECT_COLUMNS} FROM vfs_inode_history AS h
           WHERE gen_to > ? AND gen_from <= ?${within.sql}
             AND NOT EXISTS (SELECT 1 FROM vfs_inodes i WHERE i.path = h.path)
           ORDER BY path LIMIT ?`, job.g, job.g, ...within.params, RESTORE_PAGE_ROWS - changed.length)].map((row) => this.inodeFromRow(row))
                : [];
            if (changed.length === 0 && revived.length === 0) {
                this.transactionSync(() => { this.sql.exec('DELETE FROM vfs_jobs WHERE id = ?', id); });
                return restored;
            }
            const builder = this.newPlan();
            const deletedInodes = [];
            const restoredRow = (past) => ({
                path: past.path,
                parentPath: past.parentPath,
                kind: past.kind,
                isDir: past.isDir,
                size: past.size,
                atime: past.atime,
                mtime: past.mtime,
                mode: past.mode,
                uid: past.uid,
                gid: past.gid,
                ino: past.ino,
                content: { type: 'ref', chunkId: past.chunkId, contentId: past.contentId },
            });
            for (const live of changed) {
                const past = this.historyAt(live.path, job.g);
                if (past === undefined) {
                    builder.addDeletedPath(live.path, live);
                    deletedInodes.push(live);
                }
                else
                    builder.addInode(restoredRow(past));
            }
            for (const past of revived)
                builder.addInode(restoredRow(past));
            this._writeBatchOnce({ plan: builder.build(), deletedInodes }, { source: 'content-publish', limitMode: 'bounded' });
            restored += changed.length + revived.length;
        }
    }
    /** The history row covering generation `g` at `path`, if any. */
    historyAt(path, g) {
        const row = [...this.sql.exec(`SELECT ${HISTORY_SELECT_COLUMNS} FROM vfs_inode_history
       WHERE path = ? AND gen_to > ? AND gen_from <= ? ORDER BY gen_to LIMIT 1`, path, g, g)][0];
        return row === undefined ? undefined : this.inodeFromRow(row);
    }
    /**
     * Drop snapshot `name`: its row and pin_gen in one transaction, then the
     * history rows no remaining snapshot covers, a page per transaction, each
     * page queuing the references it drops. Refused while a restore or a
     * copy reads from it. Returns the history rows removed.
     */
    dropSnapshot(name) {
        const g = this.requireSnapshot(name);
        for (const job of [...this.sql.exec("SELECT args FROM vfs_jobs WHERE kind IN ('restore', 'copyTree')")]) {
            const args = JSON.parse(String(job.args));
            if (args.name === name || args.at === name)
                throw vfsError('EBUSY', `snapshot ${name} is in use by a job`);
        }
        let id = 0;
        let pinGen = 0;
        this.transactionSync(() => {
            this.sql.exec('DELETE FROM vfs_snapshots WHERE name = ?', name);
            pinGen = Number([...this.sql.exec('SELECT COALESCE(MAX(gen), 0) AS g FROM vfs_snapshots')][0].g);
            this.sql.exec('UPDATE vfs_state SET pin_gen = ? WHERE slot = 1', pinGen);
            id = Number([...this.sql.exec(`INSERT INTO vfs_jobs (kind, args, cursor, start_gen, created_at) VALUES ('drop', ?, ?, 0, ?) RETURNING id`, JSON.stringify({ g }), JSON.stringify([g, '']), this.now())][0].id);
        });
        this._pinGen = pinGen;
        this.snapshotGens?.delete(name);
        const dropped = this.runDrop(id, g);
        this.runContentMaintenanceSafely(2);
        return { dropped };
    }
    runDrop(id, g) {
        let [afterGen, afterPath] = JSON.parse(String([...this.sql.exec('SELECT cursor FROM vfs_jobs WHERE id = ?', id)][0].cursor));
        const kept = this.snapshots().map((snap) => snap.gen);
        let dropped = 0;
        for (;;) {
            const page = [...this.sql.exec(`SELECT path, gen_to, gen_from, chunk_id, content_id FROM vfs_inode_history
         WHERE gen_to > ? OR (gen_to = ? AND path > ?) ORDER BY gen_to, path LIMIT ?`, afterGen, afterGen, afterPath, DROP_PAGE_ROWS)];
            const done = page.length < DROP_PAGE_ROWS;
            // Only rows that covered the dropped generation can have lost their last snapshot.
            const dead = page.filter((row) => {
                const from = Number(row.gen_from);
                const to = Number(row.gen_to);
                return from <= g && !kept.some((s) => from <= s && s < to);
            });
            if (page.length > 0) {
                const last = page[page.length - 1];
                afterGen = Number(last.gen_to);
                afterPath = String(last.path);
            }
            this.executeMeasuredTransaction(this.metricsOnlyPlan({ blobBytes: 0, logicalRows: dead.length * 2 + 1, sqlExecs: 8, affectedPaths: 0 }), { source: 'content-gc', limitMode: 'bounded' }, () => {
                for (let i = 0; i < dead.length; i += KEYS_PER_SQL_EXEC / 2) {
                    const batch = dead.slice(i, i + KEYS_PER_SQL_EXEC / 2);
                    this.sql.exec(`DELETE FROM vfs_inode_history WHERE (path, gen_to) IN (VALUES ${batch.map(() => '(?, ?)').join(',')})`, ...batch.flatMap((row) => [row.path, row.gen_to]));
                }
                const queue = new GcQueue();
                for (const row of dead) {
                    if (row.chunk_id !== null)
                        queue.add(GC_CHUNK, Number(row.chunk_id));
                    if (row.content_id !== null)
                        queue.add(GC_CONTENT, Number(row.content_id));
                }
                this.insertRows('vfs_gc_queue (kind, id)', GC_ROW_COLUMNS, queue.rows(), 'INSERT OR IGNORE');
                if (done)
                    this.sql.exec('DELETE FROM vfs_jobs WHERE id = ?', id);
                else
                    this.sql.exec('UPDATE vfs_jobs SET cursor = ? WHERE id = ?', JSON.stringify([afterGen, afterPath]), id);
            });
            dropped += dead.length;
            if (dead.length > 0)
                this.maintenancePending = true;
            if (done)
                return dropped;
        }
    }
    /**
     * What changed between two trees of this filesystem: snapshots by name, or
     * `null` for the live tree. Only paths some generation between the two
     * wrote are examined — O(changes), not O(tree) — and content is compared by
     * key, so an equal key proves equal bytes. One page in path order.
     */
    diff(from, to, options = {}) {
        const ga = from === null ? this._gen : this.requireSnapshot(from);
        const gb = to === null ? this._gen : this.requireSnapshot(to);
        const lo = Math.min(ga, gb);
        const hi = Math.max(ga, gb);
        const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? FS_LIST_PAGE_LIMIT)), FS_LIST_PAGE_LIMIT);
        const after = options.after ?? '';
        const candidates = [...this.sql.exec(`SELECT path FROM (
         SELECT path FROM vfs_inodes WHERE gen > ? AND gen <= ?
         UNION SELECT path FROM vfs_inode_history WHERE gen_to > ? AND gen_to <= ?
         UNION SELECT path FROM vfs_inode_history WHERE gen_from > ? AND gen_from <= ?
       ) WHERE path > ? ORDER BY path LIMIT ?`, lo, hi, lo, hi, lo, hi, after, limit + 1)].map((row) => String(row.path));
        const at = (path, g) => (g === this._gen ? this.inodes.get(path) : this.inodeAt(path, g));
        const entries = [];
        for (const path of candidates.slice(0, limit)) {
            const a = at(path, ga);
            const b = at(path, gb);
            if (a === undefined && b === undefined)
                continue;
            if (a === undefined) {
                entries.push({ path, change: 'added', type: b.kind });
                continue;
            }
            if (b === undefined) {
                entries.push({ path, change: 'removed', type: a.kind });
                continue;
            }
            const sameMeta = a.kind === b.kind && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid && a.size === b.size;
            const sameRef = a.chunkId === b.chunkId && a.contentId === b.contentId;
            if (sameMeta && (sameRef || a.kind === 'directory' || this.contentKeyOf(a) === this.contentKeyOf(b)))
                continue;
            entries.push({ path, change: 'modified', type: b.kind });
        }
        return { entries, next: candidates.length > limit ? candidates[limit - 1] : null };
    }
    /** Jobs in flight: what a reset would resume at the next open. */
    jobs() {
        return [...this.sql.exec('SELECT id, kind, args, cursor FROM vfs_jobs ORDER BY id')].map((row) => ({
            id: Number(row.id),
            kind: String(row.kind),
            args: JSON.parse(String(row.args)),
            cursor: String(row.cursor),
        }));
    }
    /**
     * The storage ledger (N18): what the store holds and what snapshots pin.
     * Counts scan indexes, so this is for diagnostics and admission decisions,
     * not a per-request poll (getStats stays O(1)).
     */
    storeStats() {
        const one = (query) => Number([...this.sql.exec(query)][0].n);
        return {
            chunks: one('SELECT COUNT(*) AS n FROM vfs_chunks'),
            chunkBytes: one('SELECT COALESCE(SUM(size), 0) AS n FROM vfs_chunks'),
            contents: one('SELECT COUNT(*) AS n FROM vfs_contents'),
            historyRows: one('SELECT COUNT(*) AS n FROM vfs_inode_history'),
            gcQueued: one('SELECT COUNT(*) AS n FROM vfs_gc_queue'),
            snapshots: one('SELECT COUNT(*) AS n FROM vfs_snapshots'),
            jobs: one('SELECT COUNT(*) AS n FROM vfs_jobs'),
            databaseBytes: one('SELECT page_count * page_size AS n FROM pragma_page_count(), pragma_page_size()'),
        };
    }
    // ── Batch write (npm install fast path) ───────────────────────────────
    normalizeBatchInode(entry, cred) {
        const path = this.storageKey(entry.path, cred);
        const prior = this.inodes.get(path);
        const newUid = cred.uid === 0 ? (entry.uid ?? 1000) : cred.uid;
        const newGid = cred.uid === 0 ? (entry.gid ?? 1000) : cred.gid;
        // ctime is the commit's clock, never the caller's.
        const { ctime: _unsettable, ...fields } = entry;
        return {
            ...fields,
            path,
            parentPath: this.storageKey(entry.parentPath, cred),
            mode: prior
                ? prior.mode
                : inodeKind(entry) === 'symlink'
                    ? inodeTypeBits('symlink') | 0o777
                    : this.creationMode(entry.mode, cred),
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
            const normalized = this.storageKey(path, cred);
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
        // Chunks name their inode by path, so they take the inodes' storage keys.
        const chunks = payload.chunks.map((chunk) => {
            const path = this.storageKey(chunk.path, cred);
            if (!pending.has(path))
                this.checkAccess(path, 0o2, cred, { followLeaf: false });
            return path === chunk.path ? chunk : { ...chunk, path };
        });
        return {
            ...payload,
            inodes,
            chunks,
            deletePaths: payload.deletePaths?.map((path) => this.storageKey(path, cred)),
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
        const result = this.commitBatch(payload, cred, onCommit);
        this.runContentMaintenanceSafely(1);
        return result;
    }
    /**
     * Authorise and commit one batch, without the maintenance pass. A standalone
     * mutation owes that pass; an operation built from several transactions owes
     * exactly one when it is finished. Charging it per transaction made removing
     * a tree run the orphan scan — which reads the chunk table — once for every
     * bounded group of the removal.
     */
    commitBatch(payload, cred, onCommit) {
        const normalized = this.authorizeBatch(payload, cred);
        this.assertMutationsAllowed(batchMutationPaths(normalized));
        return this._writeBatchWithRetry(normalized, { source: 'strict-batch', limitMode: 'bounded' }, true, onCommit);
    }
    /**
     * Write a file too large for one transaction: its FastCDC chunks stage into
     * a state-0 content over bounded transactions, and one more publishes it.
     * Until then no inode names the content and GC steps over it (active).
     */
    replaceFileWithStagedContent(inode, data, onCommit) {
        this.validateInodeContentShape(inode);
        if (inode.size !== data.byteLength) {
            throw new Error(`EINVAL: ${inode.path}: ${data.byteLength} bytes for size ${inode.size}`);
        }
        const staging = { id: 0, size: 0, count: 0, hashed: true, digest: new ManifestDigest() };
        let builder = this.newPlan();
        const flush = () => {
            if (builder.empty)
                return;
            const plan = builder.build();
            builder = this.newPlan();
            this.assertTransactionFits(plan.metrics);
            this.executeTransactionPlan(plan, { source: 'content-stage', limitMode: 'bounded' });
        };
        try {
            let start = 0;
            for (const end of cutContent(data)) {
                const piece = data.subarray(start, end);
                start = end;
                if (builder.wouldExceedPieces(piece.byteLength, 1) !== null)
                    flush();
                builder.addStagedPiece(staging, { data: piece, hash: chunkHash(piece) }, inode.path);
            }
            flush();
            const result = this.publishStagedFile(inode, staging, onCommit);
            this.runContentMaintenanceSafely(1);
            return result;
        }
        catch (error) {
            if (staging.id !== 0)
                this.abandonStaging(staging);
            this.runContentMaintenanceSafely(1);
            throw error;
        }
    }
    /**
     * The inode row publishing `inode` with `content`. Ownership is inherited
     * from what the path already holds; the reference it replaces is queued by
     * the transaction that commits it.
     */
    fileEntry(inode, content) {
        this.assertMutationsAllowed([inode.path]);
        const prior = this.inodes.get(inode.path);
        const kind = inodeKind(inode);
        return {
            path: inode.path,
            parentPath: inode.parentPath,
            kind,
            isDir: kind === 'directory',
            size: inode.size,
            atime: inode.atime,
            mtime: inode.mtime,
            mode: inode.mode,
            uid: inode.uid ?? prior?.uid ?? 1000,
            gid: inode.gid ?? prior?.gid ?? 1000,
            content,
        };
    }
    publishStagedFile(inode, staging, onCommit) {
        const builder = this.newPlan();
        builder.addInode(this.fileEntry(inode, { type: 'staged', content: staging }));
        const plan = builder.build();
        this.assertTransactionFits(onCommit ? withCommitRowMetrics(plan.metrics) : plan.metrics);
        const result = this._writeBatchOnce({ plan, deletedInodes: [] }, { source: 'content-publish', limitMode: 'bounded' }, onCommit);
        return { inodes: result.inodes, chunks: inode.chunkCount };
    }
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
    writeStream(stream, options = {}, cred) {
        const run = this.consumeStream(stream, options, cred);
        this.activeStreams.add(run);
        const settled = () => { this.activeStreams.delete(run); };
        run.then(settled, settled);
        return run;
    }
    async consumeStream(stream, options, cred) {
        const decodeDrainStartedAt = options.decodeDrainStartedAt ?? performance.now();
        const decodeDrainToken = {};
        this._decodeDrainStarts.set(decodeDrainToken, decodeDrainStartedAt);
        let decodeDrainFinished = false;
        let decodeDrainWaitMs = Math.max(0, performance.now() - decodeDrainStartedAt);
        let recordIterator = null;
        let recordIteratorFinished = false;
        let decodedRecordLease = null;
        /** Staging contents this stream created and has not yet published. */
        const ownedStaging = new Set();
        let activeFile = null;
        const progress = {
            committedGroupSequence: 0,
            committedPathCount: 0,
            inodes: 0,
            chunks: 0,
        };
        let phase = 'decode';
        // The pending publish group. Everything reset by a flush lives here.
        let group = this.newPlan();
        let groupLeases = [];
        let groupInodes = [];
        let groupPublishedChunks = 0;
        let groupPaths = 0;
        let groupStagedBytes = 0;
        // Directory upserts batch on their own: authorising a file consults the
        // committed inode tree for its parent, so directories flush before the
        // first file record rather than sharing the file group.
        let pendingDirectories = [];
        const flushGroup = () => {
            if (group.empty)
                return;
            const plan = group.build();
            const leases = groupLeases;
            const inodes = groupInodes;
            const publishedChunks = groupPublishedChunks;
            const paths = groupPaths;
            const stagedBytes = groupStagedBytes;
            group = this.newPlan();
            groupLeases = [];
            groupInodes = [];
            groupPublishedChunks = 0;
            groupPaths = 0;
            groupStagedBytes = 0;
            try {
                if (inodes.length === 0) {
                    // No file has completed, so the plan publishes nothing: these are
                    // the staged chunks of a file still in flight, and the bytes stay
                    // charged to it until its publication commits.
                    this.assertTransactionFits(plan.metrics);
                    this.executeTransactionPlan(plan, { source: 'content-stage', limitMode: 'bounded' });
                    this._stagedStreamBytes += plan.metrics.blobBytes;
                    this._peakStagedStreamBytes = Math.max(this._peakStagedStreamBytes, this._stagedStreamBytes);
                    if (activeFile)
                        activeFile.stagedBytes += plan.metrics.blobBytes;
                    return;
                }
                this.assertTransactionFits(plan.metrics);
                // Re-check the mutation guard here rather than only where each file
                // was accepted: a group commits after the records that follow it, so
                // this is the check that is contemporaneous with the write.
                const result = this.withMutationOwner(options.mutationOwner, () => {
                    this.assertMutationsAllowed(inodes);
                    return this._writeBatchOnce({ plan, deletedInodes: [] }, { source: 'content-publish', limitMode: 'bounded' });
                });
                let activeStaged = 0;
                for (const staged of plan.staged) {
                    if (staged.content === activeFile?.staging)
                        activeStaged += staged.piece.data.byteLength;
                }
                if (activeFile)
                    activeFile.stagedBytes += activeStaged;
                this._stagedStreamBytes = Math.max(0, this._stagedStreamBytes + activeStaged - stagedBytes);
                for (const entry of plan.inodes) {
                    if (entry.content.type === 'staged')
                        ownedStaging.delete(entry.content.content);
                }
                progress.committedGroupSequence++;
                progress.committedPathCount += paths;
                progress.inodes += result.inodes;
                progress.chunks += publishedChunks;
            }
            finally {
                for (const lease of leases)
                    lease.release();
            }
        };
        const flushDirectories = () => {
            if (pendingDirectories.length === 0)
                return;
            const inodes = pendingDirectories;
            pendingDirectories = [];
            const result = this.withMutationOwner(options.mutationOwner, () => (this.writeBatch({ inodes, chunks: [] }, cred)));
            progress.committedGroupSequence++;
            progress.committedPathCount += inodes.length;
            progress.inodes += result.inodes;
        };
        const stagePiece = (file, piece) => {
            if (file.held !== null) {
                file.held.push(piece);
                return;
            }
            if (file.staging === null) {
                file.staging = { id: 0, size: 0, count: 0, hashed: true, digest: new ManifestDigest() };
                ownedStaging.add(file.staging);
            }
            if (group.wouldExceedPieces(piece.data.byteLength, 1) !== null)
                flushGroup();
            group.addStagedPiece(file.staging, piece, file.inode.path);
        };
        const retainChunk = async (byteLength, signal) => {
            if (group.wouldExceedPieces(byteLength, 1) !== null)
                flushGroup();
            let writeLease = this.writeStreamCredits.tryAcquire(byteLength);
            if (!writeLease && !group.empty) {
                flushGroup();
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
                        // A delete observes everything the stream wrote before it.
                        phase = 'publish';
                        flushGroup();
                        flushDirectories();
                        const affected = Math.max(1, this.collectSubtreeInodes([record.path]).length);
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
                        pendingDirectories.push(record.inode);
                        // Directory inodes carry no payload, so the row count is the
                        // only bound in reach; the flush re-asserts it regardless.
                        if (pendingDirectories.length >= MAX_TX_LOGICAL_ROWS)
                            flushDirectories();
                        break;
                    }
                    case 'file-begin': {
                        if (activeFile)
                            throw new Error(`EINVAL: nested streamed file ${record.inode.path}`);
                        phase = 'validation';
                        this.validateInodeContentShape(record.inode);
                        phase = 'publish';
                        // Authorising a file reads its parent from the committed inode
                        // tree, so pending directories become visible first.
                        flushDirectories();
                        phase = 'validation';
                        this.withMutationOwner(options.mutationOwner, () => {
                            this.authorizeBatch({ inodes: [record.inode], chunks: [] }, cred);
                            this.assertMutationsAllowed([record.inode.path]);
                        });
                        phase = 'stage';
                        // Close the group before the file that would overflow it, so a
                        // file either fits whole or begins a group of its own; one too
                        // large for any group stages across several.
                        if (group.wouldExceedFile(record.inode.size) !== null)
                            flushGroup();
                        const whole = group.wouldExceedFile(record.inode.size) === null;
                        activeFile = {
                            streamContentId: record.streamContentId,
                            inode: record.inode,
                            received: 0,
                            nextChunk: 0,
                            cutter: new ContentCutter(),
                            held: whole ? [] : null,
                            heldLeases: [],
                            staging: null,
                            stagedBytes: 0,
                        };
                        break;
                    }
                    case 'file-chunk': {
                        decodedRecordLease = record.retention;
                        phase = 'validation';
                        const file = activeFile;
                        if (!file
                            || record.streamContentId !== file.streamContentId
                            || record.path !== file.inode.path) {
                            throw new Error(`EINVAL: streamed chunk ownership mismatch: ${record.path}`);
                        }
                        if (record.chunkId !== file.nextChunk || file.received + record.data.byteLength > file.inode.size) {
                            throw new Error(`EINVAL: ${record.path}: chunk ${record.chunkId} out of order or past size`);
                        }
                        file.nextChunk++;
                        file.received += record.data.byteLength;
                        phase = 'stage';
                        if (file.inode.size <= CHUNK_SIZE) {
                            // One chunk is the whole file; CDC starts only above CHUNK_SIZE.
                            file.held.push({ data: record.data, hash: new Uint8Array(0) });
                        }
                        else {
                            for (const data of file.cutter.push(record.data))
                                stagePiece(file, { data, hash: chunkHash(data) });
                        }
                        if (file.held !== null)
                            file.heldLeases.push(record.retention);
                        else
                            groupLeases.push(record.retention);
                        decodedRecordLease = null;
                        break;
                    }
                    case 'file-end': {
                        phase = 'validation';
                        const file = activeFile;
                        if (!file || record.streamContentId !== file.streamContentId) {
                            throw new Error(`EINVAL: streamed file-end ownership mismatch: ${record.path}`);
                        }
                        if (file.received !== file.inode.size) {
                            throw new Error(`EINVAL: ${record.path}: received ${file.received} of ${file.inode.size} bytes`);
                        }
                        phase = 'publish';
                        const inode = this.normalizeBatchInode(file.inode, cred);
                        let content;
                        if (file.inode.size === 0)
                            content = { type: 'none' };
                        else if (file.inode.size <= CHUNK_SIZE) {
                            const parts = file.held;
                            const data = parts.length === 1 ? parts[0].data : concatBytes(parts.map((part) => part.data));
                            content = { type: 'small', piece: { data, hash: chunkHash(data) } };
                        }
                        else {
                            for (const data of file.cutter.finish())
                                stagePiece(file, { data, hash: chunkHash(data) });
                            if (file.held !== null) {
                                const digest = new ManifestDigest();
                                for (const piece of file.held)
                                    digest.add(piece.hash);
                                content = { type: 'large', pieces: file.held, size: file.inode.size, digest: digest.digest(file.inode.size) };
                            }
                            else {
                                content = { type: 'staged', content: file.staging };
                            }
                        }
                        const overflows = file.held !== null
                            ? group.wouldExceedFile(file.inode.size)
                            : group.wouldExceedInode();
                        if (overflows !== null)
                            flushGroup();
                        this.withMutationOwner(options.mutationOwner, () => {
                            group.addInode(this.fileEntry(inode, content));
                        });
                        groupLeases.push(...file.heldLeases);
                        groupInodes.push(inode.path);
                        groupPublishedChunks += record.chunkCount;
                        groupStagedBytes += file.stagedBytes;
                        groupPaths++;
                        activeFile = null;
                        break;
                    }
                    case 'batch-end':
                        phase = 'publish';
                        flushDirectories();
                        flushGroup();
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
            for (const lease of groupLeases)
                lease.release();
            for (const lease of activeFile?.heldLeases ?? [])
                lease.release();
            groupLeases = [];
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
            // Staged bytes belonging to work that never reached a commit: the
            // file in flight, plus any completed file still pending in the group.
            const abandonedStagedBytes = (activeFile?.stagedBytes ?? 0) + groupStagedBytes;
            this._stagedStreamBytes = Math.max(0, this._stagedStreamBytes - abandonedStagedBytes);
            for (const staging of ownedStaging)
                if (staging.id !== 0)
                    this.abandonStaging(staging);
            this.runContentMaintenanceSafely(2);
        }
    }
    _writeBatchWithRetry(payload, execution, enforceLimits, onCommit) {
        const prepared = this.prepareBatchTransaction(payload);
        if (prepared.plan.inodes.length === 0 && prepared.plan.deletes.length === 0)
            return { inodes: 0, chunks: 0 };
        if (enforceLimits) {
            this.assertTransactionFits(onCommit ? withCommitRowMetrics(prepared.plan.metrics) : prepared.plan.metrics);
        }
        const chunks = payload.chunks.length;
        try {
            return { inodes: this._writeBatchOnce(prepared, execution, onCommit).inodes, chunks };
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
            return { inodes: this._writeBatchOnce(prepared, execution, onCommit).inodes, chunks };
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
    withTransaction(callback) {
        if (this.transactionPublication !== null) {
            throw new Error('[sqlite-vfs] nested embedder transactions are not supported');
        }
        const storage = this.ctx?.storage;
        if (!storage)
            throw new Error('[sqlite-vfs] atomic storage operation requires transactionSync');
        const publication = {
            paths: new Set(),
            events: new Array(),
        };
        const maintenancePending = this.maintenancePending;
        const openBefore = new Map([...this.openNodes].map(opened => [opened, { path: opened.path, inode: opened.inode }]));
        this.transactionPublication = publication;
        let result;
        try {
            result = storage.transactionSync(() => {
                const value = callback();
                if (value !== null && (typeof value === 'object' || typeof value === 'function')
                    && 'then' in value && typeof value.then === 'function') {
                    throw new TypeError('[sqlite-vfs] transaction callback must be synchronous');
                }
                return value;
            });
        }
        catch (error) {
            this.evictAll();
            this.maintenancePending = maintenancePending;
            try {
                this.inodes.clear();
                this._countersLoaded = false;
                this.contentKeyMemo.clear();
                this.manifestWindows.clear();
                // Generations the rollback discarded are reissued; nothing published them.
                const state = [...this.sql.exec('SELECT gen, pin_gen FROM vfs_state WHERE slot = 1')][0];
                this._gen = Number(state.gen);
                this._pinGen = Number(state.pin_gen);
                for (const opened of this.openNodes) {
                    const previous = openBefore.get(opened);
                    if (!previous) {
                        opened.closed = true;
                        this.openNodes.delete(opened);
                        continue;
                    }
                    // The committed row the description named, as the object every other
                    // lookup of that path now shares.
                    const live = previous.path === null ? undefined : this.inodes.get(previous.path);
                    opened.inode = live !== undefined && live.ino === previous.inode.ino ? live : previous.inode;
                    opened.path = previous.path;
                }
            }
            catch (reloadError) {
                throw new AggregateError([error, reloadError], '[sqlite-vfs] transaction rollback reload failed', { cause: error });
            }
            throw new Error('[sqlite-vfs] embedder transaction rolled back', { cause: error });
        }
        finally {
            this.transactionPublication = null;
        }
        if (publication.paths.size > 0)
            this.bumpRevision([...publication.paths]);
        for (const event of publication.events) {
            this.events.emit(event.type, event.path, event.oldPath);
        }
        this.runContentMaintenanceSafely(1);
        return result;
    }
    emitMutation(type, path, oldPath) {
        if (this.transactionPublication) {
            this.transactionPublication.events.push({ type, path, oldPath });
        }
        else {
            this.events.emit(type, path, oldPath);
        }
    }
    transactionSync(callback) {
        if (!this.ctx?.storage?.transactionSync) {
            throw new Error('[sqlite-vfs] atomic storage operation requires transactionSync');
        }
        this.ctx.storage.transactionSync(callback);
    }
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
    executeTransactionPlan(plan, execution, onCommit, priors) {
        const committedAt = this.now();
        const deletedPaths = new Set();
        for (const entry of plan.deletes)
            deletedPaths.add(entry.path);
        // Identity and the reference a row replaces are decided by the state
        // before this transaction: a path it both deletes and republishes keeps
        // its number, as it did when every inode was resident.
        const prior = plan.inodes.map((inode, index) => (inode.detached ?? (priors ? priors[index] : this.inodes.get(inode.path))));
        const deletedPrior = new Map();
        for (const entry of plan.deletes)
            deletedPrior.set(entry.path, entry.prior);
        let gen = 0;
        let pinGen = 0;
        const rewritten = [];
        const created = [];
        const published = [];
        try {
            this.executeMeasuredTransaction(plan, execution, () => {
                const state = [...this.sql.exec('UPDATE vfs_state SET gen = gen + 1 WHERE slot = 1 RETURNING gen, pin_gen, next_ino, next_chunk, next_content')][0];
                gen = Number(state.gen);
                pinGen = Number(state.pin_gen);
                let nextIno = Number(state.next_ino);
                let nextChunk = Number(state.next_chunk);
                let nextContent = Number(state.next_content);
                const counters = `${nextIno}:${nextChunk}:${nextContent}`;
                const queue = new GcQueue();
                for (const ref of plan.gcRefs)
                    queue.add(ref.kind, ref.id);
                // Before-images for every row this transaction replaces or removes
                // that a snapshot can see (gen <= pin_gen). None without a snapshot.
                if (pinGen > 0) {
                    const paths = [...plan.inodes.filter((entry) => !entry.detached).map((entry) => entry.path), ...deletedPaths];
                    for (let i = 0; i < paths.length; i += KEYS_PER_SQL_EXEC) {
                        const batch = paths.slice(i, i + KEYS_PER_SQL_EXEC);
                        this.sql.exec(`INSERT OR IGNORE INTO vfs_inode_history
                 (path, gen_to, gen_from, parent_path, kind, size, atime, mtime, ctime, mode, uid, gid, ino, chunk_id, content_id)
               SELECT path, ?, gen, parent_path, kind, size, atime, mtime, ctime, mode, uid, gid, ino, chunk_id, content_id
               FROM vfs_inodes WHERE gen <= ? AND path IN (${batch.map(() => '?').join(',')})`, gen, pinGen, ...batch);
                    }
                }
                const deletes = [...deletedPaths];
                for (let i = 0; i < deletes.length; i += KEYS_PER_SQL_EXEC) {
                    const batch = deletes.slice(i, i + KEYS_PER_SQL_EXEC);
                    this.sql.exec(`DELETE FROM vfs_inodes WHERE path IN (${batch.map(() => '?').join(',')})`, ...batch);
                }
                this.insertRows('vfs_tombstones (path, gen)', 2, deletes.flatMap((path) => [path, gen]), 'INSERT OR REPLACE');
                if (deletes.length > 0) {
                    if (this._tombstoneRows !== null)
                        this._tombstoneRows += deletes.length;
                    if (this.tombstoneRows() > this.tombstoneRetain)
                        this.maintenancePending = true;
                }
                for (const entry of plan.deletes) {
                    if (!entry.dereference || !entry.prior)
                        continue;
                    if (entry.prior.chunkId !== null)
                        queue.add(GC_CHUNK, entry.prior.chunkId);
                    if (entry.prior.contentId !== null)
                        queue.add(GC_CONTENT, entry.prior.contentId);
                }
                if (plan.stagingCreated.length > 0) {
                    const rows = [];
                    for (const staging of plan.stagingCreated) {
                        staging.id = nextContent++;
                        created.push(staging);
                        rows.push(staging.id, 0, 0, null, CONTENT_STAGING, committedAt);
                    }
                    this.insertRows('vfs_contents (id, size, chunk_count, digest, state, created_at)', CONTENT_ROW_COLUMNS, rows);
                }
                // ── Chunks, by hash ───────────────────────────────────────────────
                const pieces = [];
                const rewrites = [];
                for (const entry of plan.inodes) {
                    const content = entry.content;
                    if (content.type === 'small')
                        pieces.push(content.piece);
                    else if (content.type === 'large')
                        pieces.push(...content.pieces);
                    else if (content.type === 'edit')
                        for (const edit of content.pieces)
                            pieces.push(edit.piece);
                    else if (content.type === 'rewrite') {
                        pieces.push(content.piece);
                        rewrites.push({ entry, chunkId: content.chunkId, piece: content.piece });
                    }
                }
                for (const staged of plan.staged)
                    pieces.push(staged.piece);
                const chunkIds = new Map();
                const wanted = new Map();
                for (const piece of pieces)
                    wanted.set(hashKey(piece.hash), piece);
                const keys = [...wanted.keys()];
                for (let i = 0; i < keys.length; i += KEYS_PER_SQL_EXEC) {
                    const batch = keys.slice(i, i + KEYS_PER_SQL_EXEC);
                    for (const row of this.sql.exec(`SELECT id, hash FROM vfs_chunks WHERE hash IN (${batch.map(() => '?').join(',')})`, ...batch.map((key) => wanted.get(key).hash)))
                        chunkIds.set(hashKey(this.blobToUint8Array(row.hash)), Number(row.id));
                }
                // An unshared chunk is rewritten in place unless its new bytes
                // already exist. A piece that deduplicated onto its old bytes must
                // not follow them, so the old hash stops resolving to it.
                for (const rewrite of rewrites) {
                    const key = hashKey(rewrite.piece.hash);
                    if (chunkIds.has(key))
                        continue;
                    for (const [other, id] of chunkIds)
                        if (id === rewrite.chunkId)
                            chunkIds.delete(other);
                    this.sql.exec('UPDATE vfs_chunks SET hash = ?, size = ?, data = ? WHERE id = ?', rewrite.piece.hash, rewrite.piece.data.byteLength, rewrite.piece.data, rewrite.chunkId);
                    chunkIds.set(key, rewrite.chunkId);
                    rewritten.push(rewrite.chunkId);
                }
                const inserts = [];
                for (const [key, piece] of wanted) {
                    if (chunkIds.has(key))
                        continue;
                    const id = nextChunk++;
                    chunkIds.set(key, id);
                    inserts.push(id, piece.hash, piece.data.byteLength, piece.data);
                }
                this.insertRows('vfs_chunks (id, hash, size, data)', CHUNK_ROW_COLUMNS, inserts);
                const chunkOf = (piece) => chunkIds.get(hashKey(piece.hash));
                // ── Manifests ─────────────────────────────────────────────────────
                const manifest = [];
                for (const staged of plan.staged) {
                    manifest.push(staged.content.id, staged.off, staged.piece.data.byteLength, chunkOf(staged.piece));
                }
                // Whole large files and published stagings resolve by digest first:
                // identical bytes written twice share one content.
                const digests = new Map();
                const stagedDigests = new Map();
                for (const entry of plan.inodes) {
                    if (entry.content.type === 'large')
                        digests.set(hex(entry.content.digest), entry.content.digest);
                    else if (entry.content.type === 'staged' && entry.content.content.hashed) {
                        const digest = entry.content.content.digest.digest(entry.size);
                        stagedDigests.set(entry.content.content, digest);
                        digests.set(hex(digest), digest);
                    }
                }
                const contentByDigest = new Map();
                const digestKeys = [...digests.keys()];
                for (let i = 0; i < digestKeys.length; i += KEYS_PER_SQL_EXEC) {
                    const batch = digestKeys.slice(i, i + KEYS_PER_SQL_EXEC);
                    for (const row of this.sql.exec(`SELECT id, digest FROM vfs_contents WHERE digest IN (${batch.map(() => '?').join(',')})`, ...batch.map((key) => digests.get(key))))
                        contentByDigest.set(hex(this.blobToUint8Array(row.digest)), Number(row.id));
                }
                const contentRows = [];
                for (const entry of plan.inodes) {
                    const content = entry.content;
                    let chunkId = null;
                    let contentId = null;
                    switch (content.type) {
                        case 'none':
                            break;
                        case 'small':
                        case 'rewrite':
                            chunkId = chunkOf(content.piece);
                            break;
                        case 'ref':
                            chunkId = content.chunkId;
                            contentId = content.contentId;
                            break;
                        case 'large': {
                            const key = hex(content.digest);
                            contentId = contentByDigest.get(key) ?? null;
                            if (contentId === null) {
                                contentId = nextContent++;
                                contentByDigest.set(key, contentId);
                                contentRows.push(contentId, content.size, content.pieces.length, content.digest, CONTENT_LIVE, committedAt);
                                let off = 0;
                                for (const piece of content.pieces) {
                                    manifest.push(contentId, off, piece.data.byteLength, chunkOf(piece));
                                    off += piece.data.byteLength;
                                }
                            }
                            break;
                        }
                        case 'staged': {
                            const staging = content.content;
                            const digest = stagedDigests.get(staging) ?? null;
                            const existing = digest === null ? undefined : contentByDigest.get(hex(digest));
                            if (existing !== undefined && existing !== staging.id) {
                                contentId = existing;
                                queue.add(GC_CONTENT, staging.id);
                            }
                            else {
                                contentId = staging.id;
                                if (digest !== null)
                                    contentByDigest.set(hex(digest), staging.id);
                                this.sql.exec('UPDATE vfs_contents SET state = ?, digest = ?, size = ?, chunk_count = ? WHERE id = ?', CONTENT_LIVE, digest, entry.size, staging.count, staging.id);
                            }
                            published.push(staging);
                            break;
                        }
                        case 'edit': {
                            contentId = content.contentId;
                            const removed = [...this.sql.exec('SELECT chunk_id FROM vfs_content_chunks WHERE content_id = ? AND off >= ? AND off < ?', contentId, content.from, content.to)];
                            for (const row of removed)
                                queue.add(GC_CHUNK, Number(row.chunk_id));
                            this.sql.exec('DELETE FROM vfs_content_chunks WHERE content_id = ? AND off >= ? AND off < ?', contentId, content.from, content.to);
                            for (const { off, piece } of content.pieces) {
                                manifest.push(contentId, off, piece.data.byteLength, chunkOf(piece));
                            }
                            this.sql.exec('UPDATE vfs_contents SET size = ?, chunk_count = chunk_count - ? + ?, digest = NULL WHERE id = ?', entry.size, removed.length, content.pieces.length, contentId);
                            this.contentKeyMemo.delete(contentId);
                            this.manifestWindows.delete(contentId);
                            break;
                        }
                    }
                    entry.chunkId = chunkId;
                    entry.contentId = contentId;
                }
                this.insertRows('vfs_contents (id, size, chunk_count, digest, state, created_at)', CONTENT_ROW_COLUMNS, contentRows);
                this.insertRows('vfs_content_chunks (content_id, off, len, chunk_id)', MANIFEST_ROW_COLUMNS, manifest);
                // ── Inodes ────────────────────────────────────────────────────────
                const rows = [];
                for (let i = 0; i < plan.inodes.length; i++) {
                    const inode = plan.inodes[i];
                    const before = prior[i];
                    // Identity order: an explicit ino travels with moves and metadata
                    // changes; an existing row at this path keeps its number (write
                    // preserves identity, unlink+recreate allocates fresh); anything
                    // else takes the counter.
                    inode.ino ??= before?.ino ?? nextIno++;
                    inode.gen = gen;
                    inode.ctime ??= committedAt;
                    if (before) {
                        if (before.chunkId !== null && before.chunkId !== inode.chunkId)
                            queue.add(GC_CHUNK, before.chunkId);
                        if (before.contentId !== null && before.contentId !== inode.contentId)
                            queue.add(GC_CONTENT, before.contentId);
                    }
                    if (inode.detached) {
                        // Nothing durable names it; GC steps over it while it is pinned.
                        if (inode.chunkId !== null && inode.chunkId !== undefined)
                            queue.add(GC_CHUNK, inode.chunkId);
                        if (inode.contentId !== null && inode.contentId !== undefined)
                            queue.add(GC_CONTENT, inode.contentId);
                        continue;
                    }
                    rows.push(inode.path, inode.parentPath, inodeKindCode(inode.kind), inode.size, inode.atime !== undefined && Number.isFinite(inode.atime) ? inode.atime : inode.mtime, inode.mtime, inode.ctime, inode.mode, inode.uid, inode.gid, inode.ino, gen, inode.chunkId, inode.contentId);
                }
                this.insertRows('vfs_inodes (path, parent_path, kind, size, atime, mtime, ctime, mode, uid, gid, ino, gen, chunk_id, content_id)', INODE_ROW_COLUMNS, rows, 'INSERT OR REPLACE');
                const queued = queue.rows();
                this.insertRows('vfs_gc_queue (kind, id)', GC_ROW_COLUMNS, queued, 'INSERT OR IGNORE');
                if (queued.length > 0)
                    this.maintenancePending = true;
                onCommit?.();
                if (`${nextIno}:${nextChunk}:${nextContent}` !== counters) {
                    this.sql.exec('UPDATE vfs_state SET next_ino = ?, next_chunk = ?, next_content = ? WHERE slot = 1', nextIno, nextChunk, nextContent);
                }
            });
        }
        catch (error) {
            for (const staging of created)
                staging.id = 0;
            throw error;
        }
        this._gen = gen;
        for (const staging of created)
            this.activeStagingContentIds.add(staging.id);
        for (const staging of published)
            this.activeStagingContentIds.delete(staging.id);
        for (const chunkId of rewritten)
            this.cacheEvict(chunkId);
    }
    /** Multi-row INSERT of `values`, `columns` per row, in statements under the bound-parameter limit. */
    insertRows(target, columns, values, verb = 'INSERT') {
        const perExec = Math.floor(SQL_MAX_BOUND_PARAMETERS / columns) * columns;
        const row = `(${Array.from({ length: columns }, () => '?').join(',')})`;
        for (let i = 0; i < values.length; i += perExec) {
            const batch = values.slice(i, i + perExec);
            this.sql.exec(`${verb} INTO ${target} VALUES ${Array.from({ length: batch.length / columns }, () => row).join(',')}`, ...batch);
        }
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
    runContentMaintenance(maxTransactions = 4) {
        let transactions = 0;
        const maximum = clampNonNegativeInt(maxTransactions);
        while (transactions < maximum && this.legacyTables.length > 0) {
            this.legacyJanitorPage();
            transactions++;
        }
        const pinnedChunks = new Set();
        const pinnedContents = new Set(this.activeStagingContentIds);
        for (const opened of this.openNodes) {
            if (opened.inode.chunkId !== null)
                pinnedChunks.add(opened.inode.chunkId);
            if (opened.inode.contentId !== null)
                pinnedContents.add(opened.inode.contentId);
        }
        let contentsIdle = false;
        let chunksIdle = false;
        let wrapped = false;
        while (transactions < maximum) {
            const page = this.gcPage(GC_CONTENT, pinnedContents);
            if (page === null) {
                if (wrapped || this.gcCursor[GC_CONTENT] === 0) {
                    contentsIdle = true;
                    break;
                }
                this.gcCursor[GC_CONTENT] = 0;
                wrapped = true;
                continue;
            }
            if (page.length > 0) {
                this.collectContents(page, pinnedChunks);
                transactions++;
            }
        }
        wrapped = false;
        while (transactions < maximum) {
            const page = this.gcPage(GC_CHUNK, pinnedChunks);
            if (page === null) {
                if (wrapped || this.gcCursor[GC_CHUNK] === 0) {
                    chunksIdle = true;
                    break;
                }
                this.gcCursor[GC_CHUNK] = 0;
                wrapped = true;
                continue;
            }
            if (page.length > 0) {
                this.collectChunks(page);
                transactions++;
            }
        }
        if (transactions < maximum && this.auditCursor !== null) {
            this.auditPage(pinnedContents);
            transactions++;
        }
        // One page past the budget: GC can take every transaction a mutation
        // allows, and tombstones must not wait behind it for the next mutation.
        if (maximum > 0 && this.tombstoneRows() > this.tombstoneRetain) {
            this.pruneTombstones();
            transactions++;
        }
        while (transactions < maximum && this.tombstoneRows() > this.tombstoneRetain) {
            this.pruneTombstones();
            transactions++;
        }
        if (maximum > 0) {
            this.maintenancePending = this.legacyTables.length > 0 || !contentsIdle || !chunksIdle || this.auditCursor !== null
                || this.tombstoneRows() > this.tombstoneRetain;
        }
        return { transactions };
    }
    /** Tombstones held, counted once and then kept by the writers (an overcount only prunes early). */
    tombstoneRows() {
        if (this._tombstoneRows === null) {
            this._tombstoneRows = Number([...this.sql.exec('SELECT COUNT(*) AS n FROM vfs_tombstones')][0].n);
        }
        return this._tombstoneRows;
    }
    /** Drop the oldest page of tombstones and raise the floor to the newest dropped. */
    pruneTombstones() {
        const edge = [...this.sql.exec('SELECT gen FROM vfs_tombstones ORDER BY gen LIMIT 1 OFFSET ?', Math.min(TOMBSTONE_PRUNE_PAGE_ROWS, Math.max(1, this.tombstoneRows() - this.tombstoneRetain)) - 1)][0];
        if (edge === undefined) {
            this._tombstoneRows = null;
            return;
        }
        const floor = Number(edge.gen);
        let removed = 0;
        this.executeMeasuredTransaction(this.metricsOnlyPlan({ blobBytes: 0, logicalRows: TOMBSTONE_PRUNE_PAGE_ROWS * 2 + 1, sqlExecs: 3, affectedPaths: 0 }), { source: 'content-gc', limitMode: 'bounded' }, () => {
            removed = [...this.sql.exec('DELETE FROM vfs_tombstones WHERE gen <= ? RETURNING 1', floor)].length;
            this.sql.exec('UPDATE vfs_state SET tomb_floor = MAX(tomb_floor, ?) WHERE slot = 1', floor);
        });
        this._tombstoneFloor = Math.max(this._tombstoneFloor, floor);
        this._tombstoneRows = Math.max(0, this.tombstoneRows() - removed);
    }
    /**
     * The next page of queued ids of `kind` past the cursor, pinned ones
     * stepped over (the cursor moves past them; they stay queued). Null when
     * the queue has nothing past the cursor.
     */
    gcPage(kind, pinned) {
        const rows = [...this.sql.exec('SELECT id FROM vfs_gc_queue WHERE kind = ? AND id > ? ORDER BY id LIMIT ?', kind, this.gcCursor[kind], KEYS_PER_SQL_EXEC)];
        if (rows.length === 0)
            return null;
        this.gcCursor[kind] = Number(rows[rows.length - 1].id);
        const ids = [];
        for (const row of rows) {
            const id = Number(row.id);
            if (!pinned.has(id))
                ids.push(id);
        }
        return ids;
    }
    /**
     * Collect queued contents that no inode or history row names. A content
     * found dead is marked dying (state 2, digest cleared) in the same
     * transaction, so digest dedup can never adopt it again; its manifest then
     * drains a bounded page per transaction, and the row goes when the manifest
     * is empty. The drained rows' chunks are collected in the same transaction
     * when nothing else names them, and queued when something might.
     */
    collectContents(ids, pinnedChunks) {
        const list = ids.map(() => '?').join(',');
        const freed = [];
        this.executeMeasuredTransaction(this.metricsOnlyPlan({ blobBytes: 0, logicalRows: GC_MANIFEST_ROWS * 2 + ids.length, sqlExecs: 13, affectedPaths: 0 }), { source: 'content-gc', limitMode: 'bounded' }, () => {
            const dead = [...this.sql.exec(`SELECT id FROM vfs_contents AS c WHERE id IN (${list})
             AND NOT EXISTS (SELECT 1 FROM vfs_inodes WHERE content_id = c.id)
             AND NOT EXISTS (SELECT 1 FROM vfs_inode_history WHERE content_id = c.id)`, ...ids)].map((row) => Number(row.id));
            const finished = new Set(ids);
            if (dead.length > 0) {
                const deadList = dead.map(() => '?').join(',');
                this.sql.exec(`UPDATE vfs_contents SET state = ${CONTENT_DYING}, digest = NULL WHERE id IN (${deadList}) AND state != ${CONTENT_DYING}`, ...dead);
                const rows = [...this.sql.exec(`SELECT content_id, off, chunk_id FROM vfs_content_chunks WHERE content_id IN (${deadList})
             ORDER BY content_id, off LIMIT ?`, ...dead, GC_MANIFEST_ROWS)];
                // A full page may have stopped inside its last content: that one
                // keeps its unread rows and its queue row for the next pass.
                const partial = rows.length === GC_MANIFEST_ROWS ? rows[rows.length - 1] : null;
                const drained = dead.filter((id) => partial === null || id < Number(partial.content_id));
                if (partial !== null) {
                    const id = Number(partial.content_id);
                    for (const other of dead)
                        if (other >= id)
                            finished.delete(other);
                    this.sql.exec('DELETE FROM vfs_content_chunks WHERE content_id = ? AND off <= ?', id, Number(partial.off));
                    // The cursor stops before it, so the next pass resumes it.
                    this.gcCursor[GC_CONTENT] = Math.min(this.gcCursor[GC_CONTENT], id - 1);
                }
                if (drained.length > 0) {
                    const drainedList = drained.map(() => '?').join(',');
                    this.sql.exec(`DELETE FROM vfs_content_chunks WHERE content_id IN (${drainedList})`, ...drained);
                    this.sql.exec(`DELETE FROM vfs_contents WHERE id IN (${drainedList})`, ...drained);
                }
                const released = [...new Set(rows.map((row) => Number(row.chunk_id)))];
                const collectable = released.filter((id) => !pinnedChunks.has(id));
                if (collectable.length > 0) {
                    for (const row of this.sql.exec(`DELETE FROM vfs_chunks AS c WHERE id IN (${collectable.map(() => '?').join(',')})
                 AND NOT EXISTS (SELECT 1 FROM vfs_inodes WHERE chunk_id = c.id)
                 AND NOT EXISTS (SELECT 1 FROM vfs_content_chunks WHERE chunk_id = c.id)
                 AND NOT EXISTS (SELECT 1 FROM vfs_inode_history WHERE chunk_id = c.id)
               RETURNING id`, ...collectable))
                        freed.push(Number(row.id));
                }
                // What something may still name goes on the queue: its last
                // reference, when it goes, dereferences it again anyway.
                const gone = new Set(freed);
                const queued = [];
                for (const id of released)
                    if (!gone.has(id) && pinnedChunks.has(id))
                        queued.push(GC_CHUNK, id);
                this.insertRows('vfs_gc_queue (kind, id)', GC_ROW_COLUMNS, queued, 'INSERT OR IGNORE');
            }
            const done = [...finished];
            if (done.length > 0) {
                this.sql.exec(`DELETE FROM vfs_gc_queue WHERE kind = ${GC_CONTENT} AND id IN (${done.map(() => '?').join(',')})`, ...done);
            }
        });
        for (const id of freed)
            this.cacheEvict(id);
    }
    /** Delete queued chunks that no inode, manifest or history row names. */
    collectChunks(ids) {
        const list = ids.map(() => '?').join(',');
        const freed = [];
        this.executeMeasuredTransaction(this.metricsOnlyPlan({ blobBytes: 0, logicalRows: ids.length * 2, sqlExecs: 2, affectedPaths: 0 }), { source: 'content-gc', limitMode: 'bounded' }, () => {
            for (const row of this.sql.exec(`DELETE FROM vfs_chunks AS c WHERE id IN (${list})
             AND NOT EXISTS (SELECT 1 FROM vfs_inodes WHERE chunk_id = c.id)
             AND NOT EXISTS (SELECT 1 FROM vfs_content_chunks WHERE chunk_id = c.id)
             AND NOT EXISTS (SELECT 1 FROM vfs_inode_history WHERE chunk_id = c.id)
           RETURNING id`, ...ids))
                freed.push(Number(row.id));
            this.sql.exec(`DELETE FROM vfs_gc_queue WHERE kind = ${GC_CHUNK} AND id IN (${list})`, ...ids);
        });
        for (const id of freed)
            this.cacheEvict(id);
    }
    /**
     * One page of the reference audit: queue every chunk and content in the
     * page that nothing names: chunks first, then contents. It finds only what
     * a bug leaked, so it walks once per lifetime, a page per maintenance run,
     * and stops.
     */
    auditPage(pinnedContents) {
        const audit = this.auditCursor;
        const table = audit.kind === GC_CHUNK ? 'vfs_chunks' : 'vfs_contents';
        const page = [...this.sql.exec(`SELECT id FROM ${table} WHERE id > ? ORDER BY id LIMIT ?`, audit.id, KEYS_PER_SQL_EXEC)]
            .map((row) => Number(row.id));
        const leaked = audit.kind === GC_CHUNK
            ? this.unreferenced(page, [])
            : this.unreferenced([], page.filter((id) => !pinnedContents.has(id)));
        if (leaked.length > 0) {
            this.transactionSync(() => {
                this.insertRows('vfs_gc_queue (kind, id)', GC_ROW_COLUMNS, leaked, 'INSERT OR IGNORE');
            });
            this.maintenancePending = true;
        }
        if (page.length === KEYS_PER_SQL_EXEC)
            this.auditCursor = { kind: audit.kind, id: page[page.length - 1] };
        else
            this.auditCursor = audit.kind === GC_CHUNK ? { kind: GC_CONTENT, id: 0 } : null;
    }
    /** Queue rows (kind, id pairs) for the chunks and contents given that nothing names. */
    unreferenced(chunks, contents) {
        const out = [];
        for (let i = 0; i < chunks.length; i += KEYS_PER_SQL_EXEC) {
            const batch = chunks.slice(i, i + KEYS_PER_SQL_EXEC);
            for (const row of this.sql.exec(`SELECT id FROM vfs_chunks AS c WHERE id IN (${batch.map(() => '?').join(',')})
           AND NOT EXISTS (SELECT 1 FROM vfs_inodes WHERE chunk_id = c.id)
           AND NOT EXISTS (SELECT 1 FROM vfs_content_chunks WHERE chunk_id = c.id)
           AND NOT EXISTS (SELECT 1 FROM vfs_inode_history WHERE chunk_id = c.id)`, ...batch))
                out.push(GC_CHUNK, Number(row.id));
        }
        for (let i = 0; i < contents.length; i += KEYS_PER_SQL_EXEC) {
            const batch = contents.slice(i, i + KEYS_PER_SQL_EXEC);
            for (const row of this.sql.exec(`SELECT id FROM vfs_contents AS c WHERE id IN (${batch.map(() => '?').join(',')})
           AND NOT EXISTS (SELECT 1 FROM vfs_inodes WHERE content_id = c.id)
           AND NOT EXISTS (SELECT 1 FROM vfs_inode_history WHERE content_id = c.id)`, ...batch))
                out.push(GC_CONTENT, Number(row.id));
        }
        return out;
    }
    /**
     * Debug-only: walk every chunk and content and report what nothing names
     * and the queue does not hold. Zero after GC means no leak. O(store); tests
     * and diagnostics only.
     */
    _auditContentStore() {
        let chunks = 0;
        let contents = 0;
        const pinned = new Set(this.activeStagingContentIds);
        for (const opened of this.openNodes)
            if (opened.inode.contentId !== null)
                pinned.add(opened.inode.contentId);
        for (let cursor = 0;;) {
            const page = [...this.sql.exec('SELECT id FROM vfs_chunks WHERE id > ? ORDER BY id LIMIT ?', cursor, KEYS_PER_SQL_EXEC)]
                .map((row) => Number(row.id));
            const leaked = this.unreferenced(page, []);
            for (let i = 1; i < leaked.length; i += 2) {
                if ([...this.sql.exec('SELECT 1 FROM vfs_gc_queue WHERE kind = ? AND id = ?', GC_CHUNK, leaked[i])].length === 0)
                    chunks++;
            }
            if (page.length < KEYS_PER_SQL_EXEC)
                break;
            cursor = page[page.length - 1];
        }
        for (let cursor = 0;;) {
            const page = [...this.sql.exec('SELECT id FROM vfs_contents WHERE id > ? ORDER BY id LIMIT ?', cursor, KEYS_PER_SQL_EXEC)]
                .map((row) => Number(row.id));
            const leaked = this.unreferenced([], page.filter((id) => !pinned.has(id)));
            for (let i = 1; i < leaked.length; i += 2) {
                if ([...this.sql.exec('SELECT 1 FROM vfs_gc_queue WHERE kind = ? AND id = ?', GC_CONTENT, leaked[i])].length === 0)
                    contents++;
            }
            if (page.length < KEYS_PER_SQL_EXEC)
                break;
            cursor = page[page.length - 1];
        }
        return { chunks, contents };
    }
    /** Delete one page of the first legacy table's rows; drop it once empty. */
    legacyJanitorPage() {
        const table = this.legacyTables[0];
        const rows = [...this.sql.exec(`SELECT rowid AS r FROM ${table} LIMIT ?`, MAX_TX_LOGICAL_ROWS)];
        this.executeMeasuredTransaction(this.metricsOnlyPlan({ blobBytes: 0, logicalRows: rows.length, sqlExecs: 1, affectedPaths: 0 }), { source: 'content-gc', limitMode: 'bounded' }, () => {
            if (rows.length === 0)
                this.sql.exec(`DROP TABLE ${table}`);
            else {
                this.sql.exec(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} LIMIT ?)`, MAX_TX_LOGICAL_ROWS);
            }
        });
        if (rows.length === 0)
            this.legacyTables.shift();
    }
    runContentMaintenanceSafely(maxTransactions, force = false) {
        if (this.transactionPublication)
            return;
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
            deletes: [],
            staged: [],
            stagingCreated: [],
            gcRefs: [],
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
            const mu = nodeHost.process?.memoryUsage?.();
            return Number(mu?.heapUsed) || 0;
        }
        catch {
            return 0;
        }
    }
    /**
     * The plan of one strict batch. Every file's positional wire chunks are
     * joined, cut and hashed here, before the transaction; the hashes resolve
     * to chunk ids inside it.
     */
    prepareBatchTransaction(payload) {
        const deletedInodes = this.collectSubtreeInodes(payload.deletePaths ?? []);
        const deletedInodesByPath = new Map(deletedInodes.map((inode) => [inode.path, inode]));
        const builder = this.newPlan();
        const deletedPaths = new Set(payload.deletePaths ?? []);
        for (const inode of deletedInodes)
            deletedPaths.add(inode.path);
        for (const path of deletedPaths)
            builder.addDeletedPath(path, deletedInodesByPath.get(path));
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
            if (!normalizedInodes.has(chunk.path)) {
                throw new Error(`EINVAL: chunk has no regular file inode: ${chunk.path}`);
            }
            const entries = chunksByPath.get(chunk.path);
            if (entries)
                entries.push(chunk);
            else
                chunksByPath.set(chunk.path, [chunk]);
        }
        for (const entry of normalizedInodes.values()) {
            const kind = inodeKind(entry);
            let content = { type: 'none' };
            if (entry.isDir) {
                if ((chunksByPath.get(entry.path)?.length ?? 0) > 0) {
                    throw new Error(`EINVAL: directory batch entry has chunks: ${entry.path}`);
                }
            }
            else {
                const fileChunks = chunksByPath.get(entry.path) ?? [];
                this.validateFileChunks(entry, fileChunks);
                // Refuse a file no transaction can hold before cutting and hashing it.
                this.assertTransactionFits(builder.metricsWithFile(entry.size));
                content = fileContent(joinChunks(fileChunks));
            }
            builder.addInode({
                path: entry.path,
                parentPath: entry.parentPath,
                kind,
                isDir: kind === 'directory',
                size: entry.size,
                atime: entry.atime,
                mtime: entry.mtime,
                mode: entry.mode,
                uid: entry.uid,
                gid: entry.gid,
                content,
            });
        }
        return { plan: builder.build(), deletedInodes };
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
    _writeBatchOnce(prepared, execution, onCommit) {
        const { plan, deletedInodes } = prepared;
        // What stood at each published path before this transaction. Read now,
        // while it is still true: after the commit, a lookup finds the row the
        // commit wrote.
        const priors = plan.inodes.map((entry) => this.inodes.get(entry.path));
        try {
            this.executeTransactionPlan(plan, execution, onCommit, priors);
        }
        catch (error) {
            console.error('[sqlite-vfs] writeBatch failed:', this.errorMessage(error));
            throw error;
        }
        const postCommitStartedAt = performance.now();
        // 4. Publish the recursive deletions, then inode replacements.
        const deleted = new Set();
        for (const inode of deletedInodes) {
            deleted.add(inode.path);
            this.inodes.delete(inode.path);
            if (inode.isDir) {
                this._totalDirs--;
            }
            else {
                this._totalFiles--;
                this._usedBytes -= inode.size;
            }
        }
        // B3: the running counters move by each published inode's delta against
        // what it replaced: nothing, for a path this batch deleted first, and the
        // earlier entry, for a path the batch publishes twice.
        const replacedPaths = new Set();
        const published = new Map();
        for (let index = 0; index < plan.inodes.length; index++) {
            const entry = plan.inodes[index];
            const prior = published.get(entry.path) ?? (deleted.has(entry.path) ? undefined : priors[index]);
            if (prior !== undefined)
                replacedPaths.add(entry.path);
            const atime = entry.atime !== undefined && Number.isFinite(entry.atime) ? entry.atime : entry.mtime;
            if (entry.ino === undefined) {
                throw new Error(`[sqlite-vfs] committed inode ${entry.path} reached memory without an ino`);
            }
            const node = {
                path: entry.path,
                parentPath: entry.parentPath,
                kind: entry.kind,
                isDir: entry.isDir,
                size: entry.size,
                atime,
                mtime: entry.mtime,
                ctime: entry.ctime,
                mode: entry.mode,
                uid: entry.uid,
                gid: entry.gid,
                chunkId: entry.chunkId ?? null,
                contentId: entry.contentId ?? null,
                ino: entry.ino,
                gen: entry.gen,
            };
            this.inodes.set(entry.path, node);
            published.set(entry.path, node);
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
        this._sqlWrites += inodeCount + plan.deletes.length;
        this._batchWrites++;
        this._batchWriteRows += inodeCount + plan.deletes.length;
        if (inodeCount > 0 || plan.deletes.length > 0) {
            // One clock tick for the whole batch; stamp every touched path.
            this.bumpRevision([...plan.affectedPaths]);
        }
        // 5. Events observe the already-published metadata and revision.
        for (const inode of deletedInodes) {
            this.emitMutation(inode.isDir ? 'unlinkDir' : 'unlink', inode.path);
        }
        for (const entry of plan.inodes) {
            this.emitMutation(entry.isDir ? 'addDir' : replacedPaths.has(entry.path) ? 'change' : 'add', entry.path);
        }
        this.recordDuration(this._postCommitDuration, performance.now() - postCommitStartedAt);
        return { inodes: inodeCount };
    }
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
    collectSubtreeInodes(roots) {
        if (roots.length === 0)
            return [];
        const collected = [];
        const visited = new Set();
        for (const root of roots) {
            const range = subtreeRange(root);
            const rows = [
                ...this.sql.exec(`SELECT ${INODE_SELECT_COLUMNS} FROM vfs_inodes WHERE path = ?`, root),
                ...(range.upper === null
                    ? this.sql.exec(`SELECT ${INODE_SELECT_COLUMNS} FROM vfs_inodes WHERE path > ?`, range.lower)
                    : this.sql.exec(`SELECT ${INODE_SELECT_COLUMNS} FROM vfs_inodes WHERE path > ? AND path < ?`, range.lower, range.upper)),
            ];
            for (const row of rows) {
                const path = String(row.path);
                if (visited.has(path))
                    continue;
                visited.add(path);
                collected.push(this.inodes.peek(path) ?? this.inodeFromRow(row));
            }
        }
        // A child's path is always longer than its parent's, so length order
        // removes every descendant before the directory holding it. Ties break on
        // the path itself: nothing a delete publishes should depend on traversal
        // or insertion order.
        return collected.sort((a, b) => (b.path.length - a.path.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));
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
     * Debug-only: aggregate the counters from the durable rows and return any
     * drift against the running counters. Returns null if consistent. Used by
     * the B3 runtime test; production paths should never call this (the whole
     * point of B3 is avoiding the O(N) read). Counters no read has loaded yet
     * are loaded from the same aggregate, so they cannot drift.
     */
    _verifyCounters() {
        this.ensureCounters();
        const durable = this.aggregateCounters();
        if (durable.files === this._totalFiles && durable.dirs === this._totalDirs && durable.bytes === this._usedBytes)
            return null;
        return {
            expected: { files: durable.files, dirs: durable.dirs, bytes: durable.bytes },
            actual: { files: this._totalFiles, dirs: this._totalDirs, bytes: this._usedBytes },
        };
    }
    getStats() {
        // B3: O(1) — read the running counters. Previously three passes
        // over every inode (two filter + one for-of); at 50K inodes that
        // was 150K iterations per poll, every 5 s, serialising on the
        // input gate alongside shell keystrokes (AUDIT M10 / M-S8).
        this.ensureCounters();
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
            // INode stats. `total` counts the filesystem's inodes; `resident` is
            // how many of them the cache holds, bounded by `cacheCapacity` plus
            // those open descriptions hold.
            inodes: {
                total: totalFiles + totalDirs,
                files: totalFiles,
                directories: totalDirs,
                resident: this.inodes.size,
                cacheCapacity: this.inodes.capacity,
                memoryEstimate: this.inodes.size * 200, // ~200 bytes per resident entry
            },
            // Per-path revisions held, against their byte budget. A path without
            // one reports `floor`.
            pathRevisions: {
                paths: this._pathRevisions.size,
                bytes: this._pathRevisionBytes,
                maxBytes: this.pathRevisionBudget,
                floor: this._revisionFloor,
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
/**
 * The paths strictly under `root`, as a range of the path index: `lower` <
 * path < `upper`. A path under `root` extends it with '/', and '0' is the
 * character after '/', so no other path falls between `root/` and `root0`.
 * Every path is under the empty root, which has no upper bound.
 */
function subtreeRange(root) {
    return root === '' ? { lower: '', upper: null } : { lower: `${root}/`, upper: `${root}0` };
}
function vfsError(code, message) {
    return Object.assign(new Error(`${code}: ${message}`), { code });
}
/** A 32-byte hash as a Map key (one UTF-16 unit per byte). */
function hashKey(hash) {
    let key = '';
    for (let i = 0; i < hash.length; i++)
        key += String.fromCharCode(hash[i]);
    return key;
}
/** The (kind, id) rows one transaction queues for GC, each once. */
class GcQueue {
    seen = new Set();
    values = [];
    add(kind, id) {
        const key = `${kind}:${id}`;
        if (this.seen.has(key))
            return;
        this.seen.add(key);
        this.values.push(kind, id);
    }
    rows() {
        return this.values;
    }
}
function concatBytes(parts) {
    let length = 0;
    for (const part of parts)
        length += part.byteLength;
    const out = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.byteLength;
    }
    return out;
}
/**
 * A file's bytes from its positional wire chunks. Chunks that are adjacent
 * views of one buffer — what writeFile hands over — join without a copy.
 */
function joinChunks(chunks) {
    if (chunks.length === 0)
        return new Uint8Array(0);
    const ordered = [...chunks].sort((a, b) => a.chunkId - b.chunkId).map((chunk) => chunk.data);
    if (ordered.length === 1)
        return ordered[0];
    const first = ordered[0];
    let end = first.byteOffset + first.byteLength;
    for (let i = 1; i < ordered.length; i++) {
        const next = ordered[i];
        if (next.buffer !== first.buffer || next.byteOffset !== end)
            return concatBytes(ordered);
        end += next.byteLength;
    }
    return new Uint8Array(first.buffer, first.byteOffset, end - first.byteOffset);
}
/** How a whole file's bytes are stored when they fit one transaction. */
function fileContent(data) {
    if (data.byteLength === 0)
        return { type: 'none' };
    if (data.byteLength <= CHUNK_SIZE)
        return { type: 'small', piece: { data, hash: chunkHash(data) } };
    const pieces = [];
    const digest = new ManifestDigest();
    let start = 0;
    for (const end of cutContent(data)) {
        const piece = data.subarray(start, end);
        const hash = chunkHash(piece);
        pieces.push({ data: piece, hash });
        digest.add(hash);
        start = end;
    }
    return { type: 'large', pieces, size: data.byteLength, digest: digest.digest(data.byteLength) };
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
    lstat(sub) { return this.vfs.lstat(this.resolve(sub)); }
    readlink(sub) { return this.vfs.readlink(this.resolve(sub)); }
    symlink(target, sub) { this.vfs.symlink(target, this.resolve(sub)); }
    utimes(sub, atimeMs, mtimeMs) { this.vfs.utimes(this.resolve(sub), atimeMs, mtimeMs); }
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
