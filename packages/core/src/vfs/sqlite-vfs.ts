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

import { VfsEventEmitter, type VfsEvent, type VfsEventType } from './events.js';
import { normalizeVfsPath } from './path.js';
import { z } from 'zod/v4';
import {
  LRU_MAX_ENTRIES,
  BATCH_SIZE,
  FS_LIST_PAGE_LIMIT,
  MAX_RPC_SAFE_PAYLOAD_BYTES,
  FS_READ_BATCH_REQUEST_BYTES,
  INODE_CACHE_MAX_ENTRIES,
} from '../constants.js';
import {
  CHUNK_SIZE,
  MAX_TX_BLOB_BYTES,
  MAX_TX_LOGICAL_ROWS,
  MAX_TX_SQL_EXECS,
  MAX_GLOBAL_WRITE_STREAM_CREDIT_BYTES,
  SQL_MAX_BOUND_PARAMETERS,
  DO_STORAGE_LIMIT_BYTES,
} from '@nimbus-sh/platform/limits.js';
import { recordFailure } from '@nimbus-sh/platform/oom-discriminator.js';
import { classifyError } from '@nimbus-sh/platform/oom-classify.js';
import { acquireSupervisorAllocation } from '@nimbus-sh/platform/heavy-alloc-coord.js';
import { enc, dec } from '../_shared/bytes.js';
import {
  decodeWriteBatchStream,
  type BatchChunkEntry,
  type BatchInodeEntry,
  type BatchWritePayload,
  type VfsInodeKind,
  type W7DecodedRecord,
} from '@nimbus-sh/platform/w7-frame.js';
import {
  WeightedCreditPool,
  type CreditLease,
} from '@nimbus-sh/platform/weighted-credit-pool.js';
import { createHash } from 'node:crypto';
import { LEGACY_SYMLINK_REGISTRY_PATH } from './symlink-registry.js';
import { LEDGER_ROW_BYTES, StorageLedger, databaseBytesOf, type StorageLedgerView } from '../runtime/storage-ledger.js';
import {
  CDC_MIN,
  ContentCutter,
  EMPTY_CONTENT_KEY,
  ManifestDigest,
  cdcCut,
  chunkHash,
  cutContent,
  hex,
} from './content-chunking.js';
import {
  CRED_KERNEL,
  type VfsAcquireOptions,
  type VfsAcquireResult,
  type VfsCred,
  type VfsInvalidatedPath,
  type VfsListEntry,
  type VfsListPage,
  type SqlDatabase,
  type SqlRow,
  type TransactionHost,
} from '../runtime/os-contracts.js';

/**
 * Schema version of the content store. 3: `/` is inode 1 and the allocator
 * starts at 2, and directories carry a default ACL (dacl). A schema-2 store
 * numbered its first entry 1, so it is not read: it is reset, and the reset
 * is told like a v1 filesystem's (legacyReset).
 */
const VFS_SCHEMA = 3;
/** Every table of the content store, dropped when an older schema is reset. */
const STORE_TABLES = [
  'vfs_append_receipts_v2', 'vfs_append_writer_state_v2', 'vfs_append_module_state_v2',
  'vfs_append_pid_revocations_v2', 'vfs_append_acked_gaps_v2', 'vfs_state', 'vfs_inodes', 'vfs_chunks',
  'vfs_contents', 'vfs_content_chunks', 'vfs_inode_history', 'vfs_tombstones', 'vfs_cold_trash',
  'vfs_gc_queue', 'vfs_snapshots', 'vfs_jobs',
] as const;
/** The root directory has no row; this is what it is. */
export const ROOT_DIRECTORY_MODE = 0o40755;
/** The root's inode number, reserved: the allocator starts at 2. */
export const ROOT_INODE = 1;

// CHUNK_SIZE / LRU_MAX_ENTRIES / BATCH_SIZE are imported from ./constants.js
// (single source of truth). Facet-isolate code-strings duplicate the literal
// 65_536 by necessity — see the inline `CHUNK_SIZE = 65536` in
// generateGitNetworkFacetCode (worker git/network-facet.ts) and the
// parallel preamble (worker loaders/generated-workers.ts).

/**
 * The Node `process` global as far as this file probes it. workerd provides
 * no `process`, so every member stays optional and every read stays guarded.
 */
interface NodeProcessLike {
  memoryUsage?: () => { heapUsed: number };
}

/**
 * Live view of the global object. `process` is not in the Workers lib, so its
 * shape is declared here rather than assumed present.
 */
const nodeHost = globalThis as { process?: NodeProcessLike };

// ── Types ───────────────────────────────────────────────────────────────────
// VfsInodeKind and the writeBatch payload types (BatchInodeEntry,
// BatchChunkEntry, BatchWritePayload) live with the wire format that encodes
// them: @nimbus-sh/platform/w7-frame.js. Forwarded here because core@0.5.0
// published them from this module; platform stays the definition.
export type {
  BatchChunkEntry,
  BatchInodeEntry,
  BatchWritePayload,
  VfsInodeKind,
} from '@nimbus-sh/platform/w7-frame.js';

export interface ExclusiveMutationLease {
  readonly root: string;
  readonly owner: string;
}

export interface ExclusiveMutationOptions {
  readonly includeMissingAncestors?: boolean;
}

interface INode {
  path: string;
  parentPath: string;
  kind: VfsInodeKind;
  isDir: boolean;
  size: number;
  atime: number;
  mtime: number;
  /** Last content or metadata change; never settable by utimes. */
  ctime: number;
  mode: number;
  uid: number;
  gid: number;
  /** The chunk holding a file or symlink of 1..CHUNK_SIZE bytes. */
  chunkId: number | null;
  /** The manifest of a file larger than CHUNK_SIZE. */
  contentId: number | null;
  /** Stable inode number, allocated transactionally at publication. */
  ino: number;
  /** Generation of the transaction that wrote this version of the row. */
  gen: number;
  /**
   * A directory's default ACL base entries (u::, g::, o::) as nine permission
   * bits, or null: what an entry made in it gets instead of the umask.
   */
  defaultAcl: number | null;
}

/** Where path resolution looks inodes up: the live cache, or a snapshot's tree. */
interface InodeLookup {
  get(path: string): INode | undefined;
}

export interface VfsOpenDescription {
  /** Inode number the description currently resolves; 0 is never issued. */
  readonly ino: number;
  path(): string;
  stat(): VfsStat;
  read(offset: number, length: number): Uint8Array;
  write(offset: number, bytes: Uint8Array): number;
  truncate(size: number): void;
  readdir(): { name: string; type: VfsInodeKind }[];
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
  /** `file` with this description's pending writes applied, as flush applies them. */
  applyPending?(file: Uint8Array): Uint8Array;
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

/** Where a caller's path leads on SQLite (SqliteVFS.resolveName). */
export interface VfsNameResolution {
  /** The canonical caller name; following a link leaves resolution to the namespace instead. */
  name: string;
  /**
   * How the walk ended: at the entry, or at a component that is absent or
   * not a directory, the rest appended as spelled.
   */
  end: 'found' | 'absent' | 'not-directory';
}

export interface CredentialedVfs {
  readonly cred: VfsCred;
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
  isFile(path: string): boolean;
  isSymlink(path: string): boolean;
  /** What `path` itself is (a link is not followed), or null when absent: one lookup for the four questions above. */
  kind(path: string): VfsInodeKind | null;
  access(path: string, mode: number): void;
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): void;
  writeFile(path: string, content: string | Uint8Array, options?: { mode?: number }): void;
  symlink(target: string, path: string): void;
  readlink(path: string): string;
  resolveSymlink(path: string): string | null;
  /**
   * `path` resolved in one walk, in the caller's names, for a namespace that
   * lays other filesystems over parts of this one; null leaves it to the
   * namespace (see SqliteVFS.resolveName).
   */
  resolveName(path: string, followLeaf: boolean, stop?: (name: string) => boolean): VfsNameResolution | null;
  readFile(path: string): Uint8Array;
  /** Whole-file read that bypasses the LRU content cache (see SqliteVFS.readFileUncached). */
  readFileUncached(path: string): Uint8Array;
  readRange(path: string, offset: number, length: number): Uint8Array;
  /** Ranged read that bypasses the LRU content cache (see SqliteVFS.readRange). */
  readRangeUncached(path: string, offset: number, length: number): Uint8Array;
  writeRange(path: string, offset: number, bytes: Uint8Array): void;
  appendOnce(
    path: string,
    pid: number,
    writerId: string,
    moduleId: string,
    operationId: number,
    digest: string,
    bytes: Uint8Array,
  ): number;
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
  utimes(path: string, atimeMs: number | null | undefined, mtimeMs: number | null | undefined, options?: { followSymlinks?: boolean }): void;
  chmod(path: string, mode: number): void;
  /**
   * A directory's default ACL base entries (`setfacl -d -m u::,g::,o::`), as
   * nine permission bits, or null to remove it (`setfacl -k`). The owner or
   * root only.
   */
  setDefaultAcl(path: string, perms: number | null): void;
  /** The directory's default ACL base entries, or null (`getfacl`). */
  getDefaultAcl(path: string): number | null;
  chown(
    path: string,
    uid: number | null,
    gid: number | null,
    options?: { followSymlinks?: boolean },
  ): void;
  readdir(path: string): { name: string; type: VfsInodeKind }[];
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
  copyTree(src: string, dest: string, options?: { preserve?: boolean; at?: string }): number;
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
  copyTreeAsync(src: string, dest: string, options?: { preserve?: boolean; at?: string; mutationOwner?: string }): Promise<number>;
  writeBatch(payload: BatchWritePayload): { inodes: number; chunks: number };
  writeStream(
    stream: ReadableStream<Uint8Array>,
    options?: { decodeDrainStartedAt?: number; signal?: AbortSignal; mutationOwner?: string },
  ): Promise<WriteBatchStreamResult>;
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

const INODE_ROW_COLUMNS = 15;
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
const HISTORY_SELECT_COLUMNS = 'path, parent_path, kind, size, atime, mtime, ctime, mode, uid, gid, ino, gen_from AS gen, chunk_id, content_id, dacl';
/** Paths one restore transaction changes, and history rows one drop transaction examines. */
const RESTORE_PAGE_ROWS = 200;
/** Rows, chunk references and chunk bytes one export page or frame carries. */
const EXPORT_PAGE_ROWS = 250;
const EXPORT_PAGE_PIECES = 4_096;
const EXPORT_FRAME_BYTES = 8 * 1024 * 1024;
/** An imported file with more chunks than this stages across transactions. */
const IMPORT_INLINE_PIECES = 64;
/** Stale imports one sweep transaction ends: a job row and up to two queued contents each. */
const STALE_IMPORTS_PER_TX = 64;
const PAGE_DIGEST_MEMO_ENTRIES = 8_192;
/**
 * Transactions one slice of a long job runs before yielding: about 50k rows
 * of copyTree, a few seconds in workerd, well inside the time after which
 * it resets an object whose storage writes have not settled (measured: a
 * 1M-row copyTree in one turn was reset).
 */
const JOB_SLICE_PAGES = 200;
/** Chunks one tier pass moves, and chunk ids it examines. */
const TIER_PAGE_CHUNKS = 64;
const TIER_SCAN_ROWS = 4_096;
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
const INODE_SELECT_COLUMNS = 'path, parent_path, kind, size, atime, mtime, ctime, mode, uid, gid, ino, gen, chunk_id, content_id, dacl';
const INODE_SELECT_COLUMNS_AS_I = INODE_SELECT_COLUMNS.split(', ').map((column) => `i.${column}`).join(', ');
/** Rows one page of a subtree walk holds: a bound on its heap, not on the tree. */
const SUBTREE_PAGE_ROWS = 4096;
/** vfs_gc_queue kinds. */
const GC_CHUNK = 0;
const GC_CONTENT = 1;
/** vfs_contents states. */
const CONTENT_STAGING = 0;
/** vfs_chunks.state: bytes in `data`, or only in the cold store (P6). */
const CHUNK_LOCAL = 0;
const CHUNK_COLD = 1;
/**
 * N17: a chunk a lazy import named without its bytes. Its row holds the hash
 * and size and no data until hydrateChunks stores them; a read of it is EIO
 * (pendingChunkError), never bytes.
 */
const CHUNK_PENDING = 2;
/** SQL (over vfs_chunks AS c): no live row, live manifest or staging content names c. */
const LIVE_CHUNK_UNREFERENCED = `
  AND NOT EXISTS (SELECT 1 FROM vfs_inodes WHERE chunk_id = c.id)
  AND NOT EXISTS (SELECT 1 FROM vfs_content_chunks cc JOIN vfs_contents ct ON ct.id = cc.content_id
    WHERE cc.chunk_id = c.id AND (ct.state = ${CONTENT_STAGING} OR EXISTS (SELECT 1 FROM vfs_inodes i WHERE i.content_id = ct.id)))`;
const CONTENT_LIVE = 1;
const CONTENT_DYING = 2;

/**
 * Tables of the pre-v2 layout. v2 ignores their rows and a bounded janitor
 * deletes them; the columns named identify ours, so a host table that merely
 * shares a name is left alone.
 */
const LEGACY_TABLES: readonly { name: string; columns: readonly string[] }[] = [
  { name: 'file_chunks', columns: ['content_id', 'chunk_id', 'data'] },
  { name: 'inodes', columns: ['path', 'parent_path', 'size', 'mode'] },
  { name: 'content_lifecycle', columns: ['content_id', 'state', 'created_at'] },
  { name: 'vfs_ino_allocator', columns: ['slot', 'next'] },
  { name: 'vfs_schema_migrations', columns: ['id', 'applied_at'] },
  { name: 'fs_objects', columns: ['path', 'chunk_index', 'data'] },
];

type TransactionLimit = 'blobBytes' | 'logicalRows' | 'sqlExecs';
type TransactionSource =
  | 'strict-batch'
  | 'range-mutation'
  | 'content-stage'
  | 'content-publish'
  | 'content-gc';
type TransactionLimitMode = 'bounded';

/** A chunk's bytes and their sha256, hashed before its transaction opens. */
interface Piece {
  data: Uint8Array;
  hash: Uint8Array;
}

/** A chunk an import names by hash; `data` only when it must be stored. */
interface ImportedPiece {
  hash: Uint8Array;
  size: number;
  data: Uint8Array | null;
}

/**
 * A large content assembled across transactions. Its row is state 0 until
 * the transaction that publishes it; `id` is 0 until a transaction creates it.
 */
interface StagingContent {
  id: number;
  size: number;
  count: number;
  /** False once rows were copied from another manifest: `digest` then covers only part of it. */
  hashed: boolean;
  readonly digest: ManifestDigest;
  /**
   * Held by a durable row (an import's job names it) rather than by this
   * isolate: GC reads the pin from that row (stagingPins), so nothing in
   * memory can outlive a transaction that rolled it back.
   */
  durable?: boolean;
}

/** What a published inode row names, and how this transaction produces it. */
type InodeContent =
  /** A directory, or an empty file or symlink. */
  | { type: 'none' }
  /** 1..CHUNK_SIZE bytes: one chunk, deduplicated by hash. */
  | { type: 'small'; piece: Piece }
  /** More than CHUNK_SIZE bytes, whole in this transaction. */
  | { type: 'large'; pieces: readonly Piece[]; size: number; digest: Uint8Array }
  /** Unchanged or moved content (metadata change, rename, copy). */
  | { type: 'ref'; chunkId: number | null; contentId: number | null }
  /** A staged content this transaction publishes. */
  | { type: 'staged'; content: StagingContent; digest?: Uint8Array }
  /** An unshared small file's chunk, rewritten in place unless its new hash exists. */
  | { type: 'rewrite'; chunkId: number; piece: Piece }
  /**
   * Content named by chunk hashes (importPage): bytes only for chunks this
   * database lacks. `manifest` is false for one inline chunk (<= CHUNK_SIZE).
   */
  | { type: 'imported'; pieces: readonly ImportedPiece[]; size: number; manifest: boolean; digest: Uint8Array | null }
  /** An unshared large file's manifest, edited in place over [from, to). */
  | { type: 'edit'; contentId: number; from: number; to: number; pieces: readonly { off: number; piece: Piece }[] };

interface StoredInodeEntry {
  path: string;
  parentPath: string;
  kind: VfsInodeKind;
  isDir: boolean;
  size: number;
  atime?: number;
  mtime: number;
  mode: number;
  uid: number;
  gid: number;
  content: InodeContent;
  /** Set for moves and metadata changes; otherwise resolved at insert time. */
  ino?: number;
  /** Carried by entries a move leaves unchanged; otherwise the commit time. */
  ctime?: number;
  /** Resolved by the committing transaction. */
  chunkId?: number | null;
  contentId?: number | null;
  gen?: number;
  /** Absent: the row at this path keeps its own (a rewrite in place). */
  defaultAcl?: number | null;
  /**
   * An unlinked, still-open file: the content is written but no row is, and
   * nothing durable references it, so it is queued at once and GC steps over
   * it while a description pins it.
   */
  detached?: INode;
}

interface PlannedDelete {
  path: string;
  prior: INode | undefined;
  /** False when the row's references live on elsewhere (a move's source). */
  dereference: boolean;
}

interface StagedPiece {
  content: StagingContent;
  off: number;
  /** For a named piece (an import's chunk this database holds), `data` is empty. */
  piece: Piece;
  size: number;
  named: boolean;
}

interface TransactionPlanMetrics {
  blobBytes: number;
  logicalRows: number;
  sqlExecs: number;
  affectedPaths: number;
}

function withCommitRowMetrics(metrics: TransactionPlanMetrics): TransactionPlanMetrics {
  return {
    ...metrics,
    logicalRows: metrics.logicalRows + 1,
    sqlExecs: metrics.sqlExecs + 1,
  };
}

const VFS_APPEND_INCARNATION_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertAppendIncarnation(value: string, kind: 'writer' | 'module'): void {
  if (!VFS_APPEND_INCARNATION_PATTERN.test(value)) {
    throw vfsError('EINVAL', `invalid append ${kind} incarnation`);
  }
}

interface TransactionPlan {
  inodes: readonly StoredInodeEntry[];
  deletes: readonly PlannedDelete[];
  staged: readonly StagedPiece[];
  stagingCreated: readonly StagingContent[];
  affectedPaths: ReadonlySet<string>;
  metrics: TransactionPlanMetrics;
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

/** Chunk and manifest rows a file of `size` bytes costs at most. */
function pieceRows(size: number): { pieces: number; manifest: number } {
  if (size === 0) return { pieces: 0, manifest: 0 };
  if (size <= CHUNK_SIZE) return { pieces: 1, manifest: 0 };
  // FastCDC cuts below CDC_MIN only at the end, so this bounds the count.
  const pieces = Math.ceil(size / CDC_MIN);
  return { pieces, manifest: pieces };
}

class TransactionPlanBuilder {
  private readonly inodes: StoredInodeEntry[] = [];
  private readonly deletes: PlannedDelete[] = [];
  private readonly staged: StagedPiece[] = [];
  private readonly stagingCreated: StagingContent[] = [];
  private readonly affectedPaths = new Set<string>();
  private blobBytes = 0;
  private pieces = 0;
  private manifestRows = 0;
  private contentRows = 0;
  private rewrites = 0;
  private edits = 0;
  private fileRows = 0;
  private gcRefCount = 0;

  /** `history`: a snapshot is pinned, so replaced rows keep before-images. */
  constructor(private readonly history: boolean, private readonly commitRow = false) {}

  addInode(entry: StoredInodeEntry): void {
    this.inodes.push(entry);
    this.affectedPaths.add(entry.path);
    if (!entry.isDir) this.fileRows++;
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
      case 'imported':
        this.pieces += content.pieces.length;
        if (content.manifest) {
          this.manifestRows += content.pieces.length;
          this.contentRows++;
        }
        for (const piece of content.pieces) this.blobBytes += piece.data?.byteLength ?? 0;
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
        for (const { piece } of content.pieces) this.blobBytes += piece.data.byteLength;
        break;
      default:
        break;
    }
  }

  /** Create a staging content's row in this transaction. */
  addStaging(content: StagingContent): void {
    this.stagingCreated.push(content);
    this.contentRows++;
  }

  /** Append one chunk to a staging content's manifest. */
  addStagedPiece(content: StagingContent, piece: Piece, path: string): void {
    if (content.id === 0 && !this.stagingCreated.includes(content)) {
      this.stagingCreated.push(content);
      this.contentRows++;
    }
    this.staged.push({ content, off: content.size, piece, size: piece.data.byteLength, named: false });
    content.size += piece.data.byteLength;
    content.count++;
    content.digest.add(piece.hash);
    this.pieces++;
    this.manifestRows++;
    this.blobBytes += piece.data.byteLength;
    this.affectedPaths.add(path);
  }

  /** Append an imported chunk, by hash, carrying bytes only if this database lacks it. */
  addStagedImport(content: StagingContent, piece: ImportedPiece, path: string): void {
    if (content.id === 0 && !this.stagingCreated.includes(content)) {
      this.stagingCreated.push(content);
      this.contentRows++;
    }
    this.staged.push({
      content,
      off: content.size,
      piece: { hash: piece.hash, data: piece.data ?? NO_BYTES },
      size: piece.size,
      named: piece.data === null,
    });
    content.size += piece.size;
    content.count++;
    content.digest.add(piece.hash);
    this.pieces++;
    this.manifestRows++;
    this.blobBytes += piece.data?.byteLength ?? 0;
    this.affectedPaths.add(path);
  }

  addDeletedPath(path: string, prior: INode | undefined, dereference = true): void {
    this.deletes.push({ path, prior, dereference });
    this.affectedPaths.add(path);
    if (dereference && prior !== undefined && !prior.isDir) this.gcRefCount++;
  }

  wouldExceedPieces(additionalBlobBytes: number, additionalPieces: number): TransactionLimit | null {
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
  wouldExceedFile(byteLength: number): TransactionLimit | null {
    return exceededTransactionLimit(this.metricsWithFile(byteLength));
  }

  /** This plan's cost with one more whole file of `byteLength` bytes admitted. */
  metricsWithFile(byteLength: number): TransactionPlanMetrics {
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
  wouldExceedInode(): TransactionLimit | null {
    return exceededTransactionLimit(this.metricsWith({ inodeRows: 1, paths: 1 }));
  }

  /** Would one more removal exceed the bound? */
  wouldExceedDeletion(): TransactionLimit | null {
    return exceededTransactionLimit(this.metricsWith({ deletes: 1, paths: 1 }));
  }

  get empty(): boolean {
    return this.inodes.length === 0
      && this.deletes.length === 0
      && this.staged.length === 0
      && this.stagingCreated.length === 0;
  }

  build(): TransactionPlan {
    return {
      inodes: this.inodes,
      deletes: this.deletes,
      staged: this.staged,
      stagingCreated: this.stagingCreated,
      affectedPaths: this.affectedPaths,
      metrics: this.metricsWith({}, false),
    };
  }

  /**
   * What this plan would cost with `addition` admitted. One formula serves
   * both the built plan and every admission test, so a bound can never be
   * checked against a different accounting than the one it commits under.
   * Counts are upper bounds: a deduplicated chunk writes no row.
   */
  private metricsWith(addition: PlanAddition, reserveCommit = this.commitRow): TransactionPlanMetrics {
    const inodeRows = this.inodes.length + (addition.inodeRows ?? 0);
    const deletes = this.deletes.length + (addition.deletes ?? 0);
    const pieces = this.pieces + (addition.pieces ?? 0);
    const manifestRows = this.manifestRows + (addition.manifestRows ?? 0);
    const contentRows = this.contentRows + (addition.contentRows ?? 0);
    // Every replaced or removed file may queue one reference; directories name none.
    const gcRows = this.fileRows + (addition.inodeRows ?? 0) + this.gcRefCount + (addition.deletes ?? 0);
    const historyRows = this.history ? inodeRows + deletes : 0;
    return {
      blobBytes: this.blobBytes + (addition.blobBytes ?? 0),
      // A delete writes its tombstone too.
      logicalRows: inodeRows + deletes * 2 + pieces + manifestRows + contentRows + gcRows + historyRows + (reserveCommit ? 1 : 0),
      sqlExecs: 2 + (reserveCommit ? 1 : 0)
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

/** Rows and bytes a not-yet-admitted mutation would add to a plan. */
interface PlanAddition {
  blobBytes?: number;
  pieces?: number;
  manifestRows?: number;
  contentRows?: number;
  inodeRows?: number;
  deletes?: number;
  paths?: number;
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

/** A durable content reference: at most one of the two is set. */
interface ContentRef {
  chunkId: number | null;
  contentId: number | null;
}

/** The export format's version: rows naming chunks by sha256, pages naming their snapshot. */
export const VFS_EXPORT_SCHEMA = 3;

/** One entry of an exported tree, relative to the export's root ('' is the root). */
export interface VfsExportRow {
  path: string;
  /** Preserved only by a whole-root import into a fresh identity domain. */
  ino: number;
  kind: VfsInodeKind;
  size: number;
  mode: number;
  uid: number;
  gid: number;
  defaultAcl: number | null;
  atime: number;
  mtime: number;
  contentKey: string | null;
  /** Byte offset of this bounded manifest fragment. */
  pieceOffset: number;
  /** False for content in one chunk (<= CHUNK_SIZE bytes). */
  manifest: boolean;
  /** Chunk sha256 (hex) and size, in content order. */
  pieces: [string, number][];
}

export interface VfsExportPage {
  schema: number;
  /**
   * The snapshot the page reads, as `<database incarnation>:<generation>`.
   * Every page of one import comes from one: a page of another export is
   * refused while an import is open at its destination.
   */
  source: string;
  root: string;
  /** Exclusive source inode high-water; also covers every pinned snapshot. */
  nextIno: number;
  /** The cursor this page follows (null: the first page). */
  after: string | null;
  rows: VfsExportRow[];
  next: string | null;
}

export interface VfsExportChunk {
  hash: string;
  data: Uint8Array;
}

const ImportJobArgsSchema = z.object({
  dst: z.string(),
  /** The export every page must come from (VfsExportPage.source); absent until the first page. */
  source: z.string().optional(),
  /**
   * Where the import stands: the inode of dst's parent directory when it
   * began (the root's, for an import into the root), and of dst once dst
   * exists (absent: dst must be absent). An import whose paths no longer
   * resolve to these, or that records no parent, is stale (importPlaced).
   */
  parentIno: z.number().int().optional(),
  dstIno: z.number().int().optional(),
  /** The staging content holding chunks sent ahead of the pages (importChunks). */
  ahead: z.number().int().positive().optional(),
  sourceRoot: z.string().optional(),
  sourceNextIno: z.number().int().min(2).max(Number.MAX_SAFE_INTEGER).optional(),
  preserveInos: z.boolean().optional(),
  pending: z.object({
    path: z.string(),
    meta: z.string(),
    content: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
    count: z.number().int().nonnegative(),
  }).optional(),
});

const ExportCursorSchema = z.tuple([z.string(), z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER)]);
function exportCursor(path: string, offset = -1): string { return JSON.stringify([path, offset]); }
function readExportCursor(cursor: string | null): [string, number] | null {
  if (cursor === null) return null;
  try {
    const parsed = ExportCursorSchema.safeParse(JSON.parse(cursor));
    if (parsed.success) return parsed.data;
  } catch {}
  throw vfsError('EINVAL', 'invalid export cursor');
}
function importRowMeta(row: VfsExportRow): string {
  return JSON.stringify([row.path, row.ino, row.kind, row.size, row.mode, row.uid, row.gid,
    row.defaultAcl, row.atime, row.mtime, row.manifest, row.contentKey]);
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

/** A restore in progress, as its vfs_jobs row records it. */
interface RestoreJob {
  name: string;
  g: number;
  subtree: string;
}

/** A copyTree in progress, as its vfs_jobs row records it. */
interface CopyTreeJob {
  src: string;
  dst: string;
  uid: number;
  gid: number;
  /** Mode bits a copy loses: the umask and setuid/setgid, unless preserving. */
  clearBits: number;
  preserveOwner: boolean;
  preserveTimes: boolean;
  /** The snapshot copied from, when not the live tree. */
  at?: string;
  atGen?: number;
  /** Rows the copy writes, as admitted when it was planned (N18). */
  rows?: number;
}

interface PreparedBatchTransaction {
  plan: TransactionPlan;
  deletedInodes: readonly INode[];
}

/** One manifest row: `len` bytes at `off`, held by chunk `chunkId`. */
interface ManifestRow {
  off: number;
  len: number;
  chunkId: number;
}

interface NormalizedBatchInodeEntry extends Omit<BatchInodeEntry, 'uid' | 'gid'> {
  uid: number;
  gid: number;
  /** A new directory's inherited default ACL. */
  defaultAcl?: number | null;
}

/** An open description's hold on an inode. */
interface OpenedNode {
  inode: INode;
  path: string | null;
  closed: boolean;
}

/**
 * A directory change a delta reports as structural, which a reader answers by
 * evicting everything at or under it: the directory went ('removed': deleted,
 * or renamed away), or who may enter it changed ('changed': its mode, owner
 * or group).
 */
type StructuralChange = 'removed' | 'changed';
const NO_STRUCTURAL_CHANGES: ReadonlyMap<string, StructuralChange> = new Map();

/** The directories among `inodes`, each reported as having gone from its name. */
function removedDirectories(inodes: readonly INode[]): ReadonlyMap<string, StructuralChange> {
  const removed = new Map<string, StructuralChange>();
  for (const inode of inodes) if (inode.isDir) removed.set(inode.path, 'removed');
  return removed;
}

/** A directory whose mode, owner or group changed: who may enter it did. */
function accessChanged(path: string): ReadonlyMap<string, StructuralChange> {
  return new Map([[path, 'changed']]);
}

/** One invalidation-log entry: a storage key mutated at `rev`. */
interface LoggedMutation {
  rev: number;
  path: string;
  structural?: StructuralChange;
}

export interface SqliteVfsOptions {
  /**
   * Inodes held in memory; defaults to INODE_CACHE_MAX_ENTRIES. SQLite holds
   * every inode, so this bounds the heap, not the filesystem.
   */
  readonly inodeCacheEntries?: number;
  /**
   * Bytes of directory revision stamps held; defaults to 1 MiB. Past it the
   * oldest are dropped, and a directory without one reports at least the
   * newest revision dropped.
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
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  delete(keys: string[]): Promise<unknown>;
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
 * committed publication `set`s or `delete`s the paths it wrote. A `set`
 * replaces a resident entry and admits nothing: writing a path says nothing
 * about reading it next, and a workspace that writes a million files would
 * otherwise fill the cache with them. Only a lookup (`get`) admits.
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
  private young = new Map<string, INode>();
  private old = new Map<string, INode>();
  /** Counts the changes to what a path's entry is (set, delete, clear); a cache fill is no change. */
  epoch = 0;

  constructor(
    readonly capacity: number,
    private readonly load: (path: string) => INode | undefined,
    private readonly held: Iterable<OpenedNode>,
  ) {}

  get size(): number {
    return this.young.size + this.old.size;
  }

  get(path: string): INode | undefined {
    const young = this.young.get(path);
    if (young !== undefined) return young;
    const old = this.old.get(path);
    if (old !== undefined) {
      this.old.delete(path);
      this.admit(path, old);
      return old;
    }
    const loaded = this.load(path);
    if (loaded !== undefined) this.admit(path, loaded);
    return loaded;
  }

  /** The cached object, if any, without reading SQLite. */
  peek(path: string): INode | undefined {
    return this.young.get(path) ?? this.old.get(path);
  }

  /** A committed entry replaces the resident one; a path not resident stays out. */
  set(path: string, inode: INode): void {
    this.epoch++;
    if (this.young.has(path)) this.young.set(path, inode);
    else if (this.old.delete(path)) this.admit(path, inode);
  }

  delete(path: string): void {
    this.epoch++;
    this.young.delete(path);
    this.old.delete(path);
  }

  clear(): void {
    this.epoch++;
    this.young = new Map();
    this.old = new Map();
  }

  private admit(path: string, inode: INode): void {
    this.young.set(path, inode);
    if (this.young.size * 2 < this.capacity) return;
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
  private readonly openNodes = new Set<OpenedNode>();
  private sql: SqlDatabase;
  /** N18: the session's storage ledger, over this database (the session DO's). */
  readonly ledger: StorageLedger;
  /** The reservation the running synchronous operation draws from (N18). */
  private activeReservation: string | null = null;
  /** Whether the running synchronous call is uid 0's (it may use the kernel reserve). */
  private privileged = false;
  /** Interrupted copies resumed in this incarnation, each holding its reservation. */
  private readonly resumedCopies = new Set<number>();
  private ctx: TransactionHost | undefined;
  public readonly events: VfsEventEmitter;

  // ── INode cache (bounded; SQLite holds the tree) ──────────────────────
  private readonly inodes: InodeTable;

  // ── Chunk cache (LRU, 512 × ≤64KB = 32MB) ────────────────────────────
  // Keyed by chunk id. A chunk's bytes change only by an in-place rewrite of
  // an unshared chunk, which evicts it; deduplicated files share entries.
  // Map iteration order = insertion order. Delete+re-insert to move to MRU.
  private cache = new Map<number, Uint8Array>();
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
  // Replaces a scan of every inode on every /api/stats poll. One aggregate
  // over `inodes` loads them on the first read (ensureCounters); from then
  // on mkdir, batch writes/deletes and rename maintain them at committed
  // publication. Deltas applied before the load are overwritten by it.
  // Rollback unloads them, and the next read aggregates the durable rows.
  private _countersLoaded = false;
  private _totalFiles = 0;
  private _totalDirs = 0;
  private _usedBytes = 0;
  private _revision = 0;

  // ── Per-path revisions ────────────────────────────────────────────────
  // _revision is the monotonic mutation clock. revision(dir) is a subtree
  // watermark: it changes iff something under dir changed. Consumers
  // (runtime snapshot caches, page caches, handle staleness checks) key on
  // revision(path) instead of the global clock, so unrelated writes no
  // longer invalidate them.
  //
  // Every mutation writes the generation of the path it mutates into SQLite
  // (its row's `gen`, or its tombstone's), so a path's own last mutation is
  // durable and needs nothing in memory. What SQLite cannot answer in one
  // read is the subtree: that is the stamp. A mutation stamps each directory
  // above the mutated path with the clock value, and the mutated path itself
  // only if it already holds a stamp. So a written file costs no memory, and
  // the stamps are one per directory something was written under.
  //
  // A path's revision is its stamp; else, for a live file or symlink, its
  // row's generation (so an untouched file keeps it across restarts); else,
  // for a directory or a missing path, the larger of the floor and its row's
  // or tombstone's generation. The floor starts at the clock at open and
  // covers every stamp dropped and every tombstone pruned.
  //
  // The invariant (lean/Nimbus/Vfs/RevisionFloor.lean, Inv): every stamp is
  // above the floor, at most the clock, and at or below the stamp of each
  // directory above it. The newest mutation at or under a path is at or
  // below its stamp; without one, at or below its row's generation if it is
  // a file, else the later of the floor and its own generation. Each
  // directory strictly above a path holds a stamp at or above that path's
  // row or own generation, unless the floor covers it. So no path reports
  // below the last mutation at or under it, none above the clock, and a
  // directory never below anything under it.
  //
  // Bounded by bytes, like the invalidation log below. Past the budget the
  // oldest quarter goes at once (dropOldestPathRevisions) and the floor
  // rises to the newest revision dropped. It must never report less: a
  // resident row, a write receipt or an expected revision compared against a
  // smaller number would be vouched for by a revision older than the path's
  // last change. The floor only rises, so a directory whose stamp was
  // dropped can report a higher revision with nothing under it changed,
  // which costs its readers a refetch, never a stale byte.
  private _pathRevisions = new Map<string, number>();
  private _pathRevisionBytes = 0;
  private _revisionFloor = 0;
  private readonly pathRevisionBudget: number;
  private static readonly PATH_REVISIONS_MAX_BYTES = 1024 * 1024;
  private transactionPublication: {
    paths: Set<string>;
    events: { type: VfsEventType; path: string; oldPath?: string }[];
    structural: Map<string, StructuralChange>;
    removedDirectories: INode[];
  } | null = null;

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
  private _epoch = '';
  /** invalidatedSince answers from SQL only above this: the newest pruned tombstone. */
  private _tombstoneFloor = 0;
  private _tombstoneRows: number | null = null;
  private readonly tombstoneRetain: number;
  private readonly coldStore: VfsColdStore | null;
  /** Generations of snapshots prepareSnapshot hydrated: tiering leaves their chunks alone. */
  private readonly hotSnapshotGens = new Map<string, number>();
  /** Where the next tier pass resumes its walk of vfs_chunks. */
  private tierCursor = 0;
  private _invalidations: LoggedMutation[] = [];
  private _invalidationBytes = 0;
  /**
   * The log holds every publication after this revision: the clock at open,
   * then the newest revision an entry was dropped from. A cursor below it
   * cannot be served completely.
   */
  private _invalidationFloor = 0;
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
  private static readonly INVALIDATION_LOG_MAX_BYTES = 256 * 1024;
  // Directories the mutation whose events are being delivered just removed,
  // by storage key; set only while those events are delivered. A watch
  // judges an event under one of them by the directory it was in, so a
  // watcher that could see into a removed tree hears each entry go, and one
  // that could not hears only the directory (watchedName).
  private removedForEvents: ReadonlyMap<string, INode> | null = null;

  /** Names the revision clock: this database's incarnation, stable across restarts. */
  get epoch(): string { return this._epoch; }

  /**
   * Start a new clock epoch: every cursor held against the old one poisons.
   * For a storage restore to an earlier point in time, which takes the
   * generations back under cursors facets still hold.
   */
  rotateIncarnation(): string {
    this.sharedDirectories.clear();
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

  private readonly exclusiveMutationLeases = new Map<string, string>();
  private activeMutationOwner: string | null = null;

  /** Shared by every concurrent stream targeting this session's VFS. */
  private readonly writeStreamCredits = new WeightedCreditPool(
    MAX_GLOBAL_WRITE_STREAM_CREDIT_BYTES,
  );
  private _stagedStreamBytes = 0;
  private _peakStagedStreamBytes = 0;
  /**
   * Staging contents a live operation is still assembling. Durable state 0
   * alone does not protect them from GC: after a restart nothing is live, and
   * every state-0 content is garbage.
   */
  private readonly activeStagingContentIds = new Set<number>();
  /** True only while vfs_gc_queue may hold work or a janitor has rows left. */
  private maintenancePending = false;
  /** Resume points of the GC queue walk, per kind; pinned ids are stepped over. */
  private gcCursor: [number, number] = [0, 0];
  /** Keyset cursor of the reference audit (chunks, then contents); null once done this lifetime. */
  private auditCursor: { kind: typeof GC_CHUNK | typeof GC_CONTENT; id: number } | null = { kind: GC_CHUNK, id: 0 };
  /** Legacy tables still holding rows, until the janitor drops them. */
  private legacyTables: string[] = [];
  private _legacyReset = false;
  /** Last committed generation: every committed VFS transaction advances it. */
  private _gen = 0;
  /** MAX(vfs_snapshots.gen), 0 without a snapshot. */
  private _pinGen = 0;
  /** Whole manifests of recently read files up to MANIFEST_KEPT_BYTES, by content id (LRU). */
  private readonly manifestWindows = new Map<number, ManifestRow[]>();
  /** Set when a write commits while imports are open: one may no longer be where it began (sweepStaleImports). */
  private importSweepPending = true;
  /** False once a sweep has found no import open, until one begins. */
  private importJobsExist = true;
  /** Page digests by (generation, root, cursor, limit): a snapshot's pages never change. */
  private readonly pageDigests = new Map<string, { digest: string; next: string | null }>();
  /** Snapshot generations by name, loaded on first use. */
  private snapshotGens: Map<string, number> | null = null;
  /** writeStreams in flight, for snapshot's quiesce. */
  /**
   * Work that spans awaits and changes the tree across them (writeStream,
   * restoreAsync, sliced copyTree), for snapshot's quiesce.
   */
  private readonly activeWork = new Set<Promise<unknown>>();
  /** Set while a quiesced snapshot waits: new spanning work starts after it. */
  private quiesceGate: Promise<void> | null = null;
  /** Content keys computed for manifests whose digest could not be stored. */
  private readonly contentKeyMemo = new Map<number, string>();

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
  private _creditWaitDuration: DurationSummary = emptyDurationSummary();
  /** Whole content-maintenance runs, including the raw scans that execute
   * outside executeMeasuredTransaction; count doubles as the run counter. */
  private _maintenanceDuration: DurationSummary = emptyDurationSummary();
  private readonly _transactionDurationSamples = new Float64Array(TRANSACTION_DURATION_SAMPLE_COUNT);
  private _transactionDurationSampleCount = 0;
  private _transactionDurationSampleIndex = 0;
  private readonly _decodeDrainStarts = new Map<object, number>();
  private readonly _creditWaitStarts = new Map<object, number>();
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
  constructor(sql: SqlDatabase, ctx?: TransactionHost, namespace?: string, options: SqliteVfsOptions = {}) {
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
    this.coldStore = options.coldStore ?? null;
    if (!Number.isSafeInteger(this.tombstoneRetain) || this.tombstoneRetain < 0) {
      throw vfsError('EINVAL', `tombstone retention must be a row count, not ${this.tombstoneRetain}`);
    }
    sql.exec('CREATE TABLE IF NOT EXISTS nimbus_filesystem_identity (slot INTEGER PRIMARY KEY CHECK(slot = 1), namespace TEXT NOT NULL)');
    this.ledger = new StorageLedger(sql, {
      ...(options.storageLimit === undefined ? {} : { limit: options.storageLimit }),
      ...(options.storageKernelReserve === undefined ? {} : { kernelReserve: options.storageKernelReserve }),
    });
    // No operation outlives the engine that ran it: what they reserved is free.
    this.ledger.releaseAll();
    if (namespace === undefined) {
      let row = [...sql.exec('SELECT namespace FROM nimbus_filesystem_identity WHERE slot = 1')][0];
      if (!row) {
        sql.exec('INSERT OR IGNORE INTO nimbus_filesystem_identity(slot, namespace) VALUES (1, ?)', crypto.randomUUID());
        row = [...sql.exec('SELECT namespace FROM nimbus_filesystem_identity WHERE slot = 1')][0];
        if (!row) throw new Error('[sqlite-vfs] filesystem identity row missing after insert');
      }
      namespace = String(row.namespace);
    }
    if (!namespace || namespace.length > 256) throw vfsError('EINVAL', 'invalid filesystem namespace');
    this.namespace = namespace;
    sql.exec('CREATE TABLE IF NOT EXISTS nimbus_filesystem_devices (id INTEGER PRIMARY KEY AUTOINCREMENT, namespace TEXT NOT NULL UNIQUE)');
    let device = [...sql.exec('SELECT id FROM nimbus_filesystem_devices WHERE namespace = ?', namespace)][0];
    if (!device) {
      sql.exec('INSERT OR IGNORE INTO nimbus_filesystem_devices(namespace) VALUES (?)', namespace);
      device = [...sql.exec('SELECT id FROM nimbus_filesystem_devices WHERE namespace = ?', namespace)][0];
      if (!device) throw new Error('[sqlite-vfs] filesystem device row missing after insert');
    }
    this.deviceId = Number(device.id);
    this.sql = sql;
    this.ctx = ctx;
    this.events = new VfsEventEmitter();
    this.inodes = new InodeTable(inodeCacheEntries, (path) => this.loadInode(path), this.openNodes);
    this.initSchema();
    for (const row of this.sql.exec("SELECT args FROM vfs_jobs WHERE kind = 'import'")) {
      const job = ImportJobArgsSchema.parse(JSON.parse(String(row.args)));
      if (job.preserveInos) this.transactionSync(() => this.ensureImportIdentityIndexes());
    }
    if ([...this.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name IN ('vfs_inodes_ino', 'vfs_history_ino') LIMIT 1")].length) {
      this.transactionSync(() => this.dropUnusedImportIdentityIndexes());
    }
    this.resumeAppendMaintenance();
    this.queueAbandonedStaging();
    this.resumeJobs();
    this.runContentMaintenanceSafely(2, true);
  }

  // ── Schema ────────────────────────────────────────────────────────────

  /**
   * An older schema's store is not read: its tables go, so the open below
   * builds the current ones empty, and the loss is recorded to be told.
   * True when it reset one.
   */
  private resetOlderStore(): boolean {
    const hasState = [...this.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vfs_state'")].length > 0;
    if (!hasState) return false;
    const state = [...this.sql.exec('SELECT schema FROM vfs_state WHERE slot = 1')][0];
    if (!state || Number(state.schema) >= VFS_SCHEMA) return false;
    for (const table of STORE_TABLES) this.sql.exec(`DROP TABLE IF EXISTS ${table}`);
    return true;
  }

  private initSchema(): void {
    this.transactionSync(() => {
      const olderStoreReset = this.resetOlderStore();
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
        tomb_floor INTEGER NOT NULL,
        legacy_reset INTEGER NOT NULL
      )`);
      const state = [...this.sql.exec('SELECT schema FROM vfs_state WHERE slot = 1')][0];
      if (!state) {
        // The first v2 open: a pre-v2 filesystem here is not read, so its
        // loss is recorded, to be told until acknowledgeLegacyReset().
        this.sql.exec(
          'INSERT INTO vfs_state (slot, schema, incarnation, gen, pin_gen, next_ino, next_chunk, next_content, tomb_floor, legacy_reset) VALUES (1, ?, ?, 0, 0, 2, 1, 1, 0, ?)',
          VFS_SCHEMA,
          crypto.randomUUID(),
          olderStoreReset || this.presentLegacyTables().length > 0 ? 1 : 0,
        );
      } else if (Number(state.schema) !== VFS_SCHEMA) {
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
        dacl INTEGER NULL,
        CHECK (chunk_id IS NULL OR content_id IS NULL),
        -- ROOT_INODE (1) is \`/\`'s, which has no row: no entry can hold it.
        CHECK (ino > 1)
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
        dacl INTEGER NULL,
        PRIMARY KEY (path, gen_to)
      ) WITHOUT ROWID`);
      this.sql.exec('CREATE INDEX IF NOT EXISTS vfs_history_parent ON vfs_inode_history(parent_path, gen_to)');
      // (gen_to, path): drop's keyset walk seeks it; gen_to alone made each page a scan.
      this.sql.exec('CREATE INDEX IF NOT EXISTS vfs_history_gen_path ON vfs_inode_history(gen_to, path)');
      // One row per deleted path, written with the delete: what lets
      // invalidatedSince answer a cursor from before this incarnation's log.
      this.sql.exec(`CREATE TABLE IF NOT EXISTS vfs_tombstones (
        path TEXT PRIMARY KEY,
        gen INTEGER NOT NULL
      ) WITHOUT ROWID`);
      this.sql.exec('CREATE INDEX IF NOT EXISTS vfs_tombstones_gen ON vfs_tombstones(gen)');
      // Cold objects whose chunk GC deleted, for the next tier pass to delete.
      this.sql.exec('CREATE TABLE IF NOT EXISTS vfs_cold_trash (hash BLOB PRIMARY KEY) WITHOUT ROWID');
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
      this.sql.exec('CREATE INDEX IF NOT EXISTS vfs_snapshots_gen ON vfs_snapshots(gen)');
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
    const state = [...this.sql.exec('SELECT gen, pin_gen, incarnation, tomb_floor FROM vfs_state WHERE slot = 1')][0]!;
    this._gen = Number(state.gen);
    this._pinGen = Number(state.pin_gen);
    this._epoch = String(state.incarnation);
    this._tombstoneFloor = Number(state.tomb_floor);
    this._revision = this._gen;
    // Nothing is stamped yet, and every earlier mutation is at or below the
    // clock at open: a directory or a missing path reports at least it.
    this._revisionFloor = this._gen;
    this._invalidationFloor = this._gen;
    this.legacyTables = this.presentLegacyTables();
    if (this.legacyTables.length > 0) this.maintenancePending = true;
    this._legacyReset = Number([...this.sql.exec('SELECT legacy_reset FROM vfs_state WHERE slot = 1')][0]!.legacy_reset) === 1;
  }

  /** Tables a pre-v2 Nimbus filesystem left here, recognised by their columns. */
  private presentLegacyTables(): string[] {
    return LEGACY_TABLES
      .filter(({ name, columns }) => {
        const present = this.tableColumns(name);
        return columns.every((column) => present.has(column));
      })
      .map(({ name }) => name);
  }

  /**
   * True while a pre-v2 filesystem this database held has not been told
   * about: schema v2 does not read it, so the session starts empty, and a
   * host should say so (and drop state that pointed into it) before
   * calling acknowledgeLegacyReset(). Survives restarts until then.
   */
  get legacyReset(): boolean { return this._legacyReset; }

  acknowledgeLegacyReset(): void {
    if (!this._legacyReset) return;
    this.transactionSync(() => { this.sql.exec('UPDATE vfs_state SET legacy_reset = 0 WHERE slot = 1'); });
    this._legacyReset = false;
  }

  /**
   * Queue interrupted staging after a restart. Durable import manifests
   * have been re-pinned above, so GC skips them. A store with none stays read-only.
   */
  private queueAbandonedStaging(): void {
    if ([...this.sql.exec(`SELECT 1 FROM vfs_contents WHERE state = ${CONTENT_STAGING} LIMIT 1`)].length === 0) return;
    this.transactionSync(() => {
      this.sql.exec(
        `INSERT OR IGNORE INTO vfs_gc_queue (kind, id) SELECT ${GC_CONTENT}, id FROM vfs_contents WHERE state = ${CONTENT_STAGING}`,
      );
    });
    this.maintenancePending = true;
  }

  private tableColumns(table: string): Set<string> {
    const rows = this.sql.exec(`PRAGMA table_info(${table})`);
    return new Set([...rows].map((row) => String(row.name)));
  }

  // ── INode loading ─────────────────────────────────────────────────────

  /** The cache's loader: the inode at `path`, read from SQLite. */
  private loadInode(path: string): INode | undefined {
    const row = [...this.sql.exec(`SELECT ${INODE_SELECT_COLUMNS} FROM vfs_inodes WHERE path = ?`, path)][0];
    return row === undefined ? undefined : this.inodeFromRow(row);
  }

  private inodeFromRow(row: SqlRow): INode {
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
      defaultAcl: row.dacl === null || row.dacl === undefined ? null : Number(row.dacl),
    };
  }

  /**
   * Load the running counters with one aggregate over `vfs_inodes`, the first
   * time anything reads them. Opening does not pay for it; the first stats
   * read does, once.
   */
  private ensureCounters(): void {
    if (this._countersLoaded) return;
    const durable = this.aggregateCounters();
    this._totalFiles = durable.files;
    this._totalDirs = durable.dirs;
    this._usedBytes = durable.bytes;
    this._countersLoaded = true;
  }

  /** Every non-directory counts as a file, symlinks included, as it always has. */
  private aggregateCounters(): { files: number; dirs: number; bytes: number } {
    const row = [...this.sql.exec(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(kind = ${INODE_KIND_DIRECTORY}), 0) AS dirs,
              COALESCE(SUM(CASE WHEN kind = ${INODE_KIND_DIRECTORY} THEN 0 ELSE size END), 0) AS bytes
       FROM vfs_inodes`,
    )][0];
    const dirs = Number(row?.dirs ?? 0);
    return { files: Number(row?.total ?? 0) - dirs, dirs, bytes: Number(row?.bytes ?? 0) };
  }

  // ── LRU chunk cache ───────────────────────────────────────────────────

  private cacheGet(chunkId: number): Uint8Array | null {
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

  private cacheSet(chunkId: number, data: Uint8Array): void {
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

  private cacheEvict(chunkId: number): void {
    const entry = this.cache.get(chunkId);
    if (!entry) return;
    this.cache.delete(chunkId);
    this._cacheBytes -= entry.length;
  }

  private enforceCacheLimit(): void {
    while (this.cache.size > this._lruMaxEntries) this.evictOne();
  }

  private evictOne(): void {
    // Evict the LRU entry (first in Map iteration order)
    const firstKey = this.cache.keys().next().value;
    if (firstKey === undefined) return;

    this._cacheBytes -= this.cache.get(firstKey)!.length;
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
    this._evictions += this.cache.size;
    this.cache.clear();
    this._cacheBytes = 0;
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  openDescription(path: string, cred: VfsCred, rights: { read: boolean; write: boolean }): VfsOpenDescription {
    const resolved = this.checkAccess(path, (rights.read ? 4 : 0) | (rights.write ? 2 : 0), cred);
    if (!resolved.inode) throw vfsError('ENOENT', path);
    // Descriptions share the canonical inode object: a second descriptor
    // sees chmod/chown/utimes instantly, and unlink leaves every holder
    // pointing at the same retired inode rather than diverging copies.
    const opened: OpenedNode = { inode: resolved.inode, path: resolved.path, closed: false };
    this.openNodes.add(opened);
    const current = (): INode => {
      if (opened.closed) throw vfsError('EBADF', path);
      return opened.inode;
    };
    const stat = (): VfsStat => {
      const node = current();
      return { ...this.statOf(node), nlink: opened.path === null ? 0 : 1 };
    };
    const read = (offset: number, length: number): Uint8Array => {
      const node = current();
      if (!rights.read) throw vfsError('EBADF', path);
      if (node.isDir) throw vfsError('EISDIR', path);
      const start = clampNonNegativeInt(offset);
      const end = Math.min(node.size, start + clampNonNegativeInt(length));
      return this.readContent(node, start, end, false);
    };
    return {
      get ino(): number { return current().ino; },
      // The opener's name for the file, which descriptor-relative lookups
      // resolve beneath: the key would put them in a different view.
      path: () => {
        current();
        const name = opened.path === null ? null : this.logicalPath(opened.path, cred);
        if (name === null) throw vfsError('ENOENT', path);
        return name;
      },
      stat, read,
      write: (offset, bytes) => {
        const node = current();
        if (!rights.write) throw vfsError('EBADF', path);
        if (node.isDir) throw vfsError('EISDIR', path);
        const start = clampNonNegativeInt(offset);
        if (opened.path !== null) this.writeRange(opened.path, start, bytes, CRED_KERNEL);
        else if (bytes.length) this.rewriteFile(node, null, Math.max(node.size, start + bytes.length), { start, bytes });
        return bytes.length;
      },
      truncate: size => {
        const node = current();
        if (!rights.write) throw vfsError('EBADF', path);
        if (node.isDir) throw vfsError('EISDIR', path);
        if (!Number.isSafeInteger(size) || size < 0) throw vfsError('EINVAL', path);
        if (opened.path !== null) this.truncate(opened.path, size, CRED_KERNEL);
        else if (size !== node.size) this.rewriteFile(node, null, size, null);
      },
      readdir: () => {
        if (!current().isDir) throw vfsError('ENOTDIR', path);
        if (!rights.read) throw vfsError('EBADF', path);
        return opened.path === null ? [] : this.readdir(opened.path, CRED_KERNEL);
      },
      chmod: mode => this.chmodInode(current(), mode, cred, opened.path),
      chown: (uid, gid) => {
        if (cred.uid !== 0) throw vfsError('EPERM', path);
        if (opened.path !== null) this.chown(opened.path, uid, gid, CRED_KERNEL, true);
        else { current().uid = uid; current().gid = gid; current().ctime = this.now(); }
      },
      utimes: (atime, mtime) => {
        if (cred.uid !== 0 && cred.uid !== current().uid && !rights.write) throw vfsError('EPERM', path);
        if (opened.path !== null) this.utimes(opened.path, atime, mtime, CRED_KERNEL);
        else { current().atime = atime; current().mtime = mtime; current().ctime = this.now(); }
      },
      close: () => {
        opened.closed = true;
        this.openNodes.delete(opened);
        // A detached description's content was queued when it was unlinked
        // and stepped over while pinned; it is collectable now.
        if (opened.path === null) this.maintenancePending = true;
      },
    };
  }

  private now(): number { return Date.now(); }

  private parentPath(path: string): string {
    return path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';
  }

  private blobToUint8Array(blob: unknown): Uint8Array {
    if (blob instanceof Uint8Array) return blob;
    if (blob instanceof ArrayBuffer) return new Uint8Array(blob);
    if (ArrayBuffer.isView(blob)) return new Uint8Array(blob.buffer, blob.byteOffset, blob.byteLength);
    return new Uint8Array(0);
  }

  private copyBytes(data: Uint8Array): Uint8Array {
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
  private confinedTmpRoots = new Map<number, string>();

  /**
   * The last walk resolveName completed on the live tree. The operation a
   * caller runs next on the name it returned (a stat, a read, its revision)
   * finds the walk here instead of repeating it (resolvePath). It holds only
   * while nothing that could move a resolution has happened since: no change
   * to the inode table, no mutation (bumpRevision), no change to confinement.
   * Keyed by the view's credential object. Adjacent entries can share the
   * parent search proof; resolveName still consults the namespace each time.
   */
  private lastResolution: {
    epoch: number; tableEpoch: number; cred: VfsCred; name: string; key: string; inode: INode; leafIsLink: boolean;
  } | null = null;
  private resolutionEpoch = 0;
  private readonly sharedDirectories = new Map<string, { ino: number; gid: number; acl: number; mode: number }>();

  /** Host-only, engine-local delegation; roots themselves retain ordinary POSIX semantics. */
  registerSharedDirectory(path: string): () => void {
    const { path: root, inode } = this.checkAccess(path, 0, CRED_KERNEL);
    if (!inode?.isDir || root === '') throw vfsError('EINVAL', 'shared root must be a non-root directory');
    if (inode.uid !== 0 || (inode.mode & 0o2000) === 0 || inode.defaultAcl === null
        || (inode.defaultAcl & 0o070) !== 0o070) throw vfsError('EPERM', 'shared root requires kernel ownership, setgid and a group-rwx default ACL');
    this.assertMutationsAllowed([root]);
    for (const key of this.sharedDirectories.keys()) if (pathsOverlap(key, root)) throw vfsError('EBUSY', 'shared roots overlap');
    const registration = { ino: inode.ino, gid: inode.gid, acl: inode.defaultAcl, mode: inode.mode & 0o7777 };
    this.sharedDirectories.set(root, registration);
    return () => { if (this.sharedDirectories.get(root) === registration) this.sharedDirectories.delete(root); };
  }

  private sharedDirectory(path: string): { ino: number; gid: number; acl: number; mode: number } | undefined {
    if (this.sharedDirectories.size === 0) return undefined;
    for (let root = this.parentPath(path); root !== ''; root = this.parentPath(root)) {
      const registration = this.sharedDirectories.get(root);
      if (!registration) continue;
      const inode = this.inodes.get(root);
      if (!inode || inode.ino !== registration.ino || inode.uid !== 0 || inode.gid !== registration.gid
          || (inode.mode & registration.mode) !== registration.mode || inode.defaultAcl === null
          || (inode.defaultAcl & registration.acl) !== registration.acl) {
        this.sharedDirectories.delete(root);
        return undefined;
      }
      return registration;
    }
    return undefined;
  }

  private revokeSharedDirectories(path: string): void {
    for (const root of this.sharedDirectories.keys()) {
      if (path === '' || root === path || root.startsWith(path + '/')) this.sharedDirectories.delete(root);
    }
  }

  private sharedMode(mode: number, directory: boolean): number {
    return (mode & ~0o070) | ((mode & 0o700) >> 3) | (directory ? 0o2000 : 0);
  }

  private normalizeSharedEntry(entry: StoredInodeEntry, cred: VfsCred, owner = entry.uid): void {
    if (entry.kind === 'symlink') return;
    const registration = this.sharedDirectory(entry.path);
    if (!registration) return;
    const mode = this.sharedMode(entry.mode, entry.isDir);
    const acl = entry.isDir ? registration.acl : entry.defaultAcl;
    if (mode === entry.mode && entry.gid === registration.gid && acl === entry.defaultAcl) return;
    if (cred.uid !== 0 && (owner !== cred.uid || (cred.gid !== registration.gid && !cred.groups.includes(registration.gid)))) {
      throw vfsError('EPERM', entry.path + ': shared metadata requires owner and group membership');
    }
    entry.mode = mode;
    entry.gid = registration.gid;
    if (entry.isDir) entry.defaultAcl = registration.acl;
  }


  /**
   * Confine a principal. `tmpRoot` is a storage key, not a logical path — the
   * caller owns creating and chowning it, because a per-principal `chown` is
   * uid-0 only and a guest cannot provision its own.
   */
  confinePrincipal(uid: number, tmpRoot: string): void {
    const root = normalizeVfsPath(tmpRoot);
    if (root === '') throw vfsError('EINVAL', 'a private /tmp root cannot be the filesystem root');
    this.confinedTmpRoots.set(uid, root);
    this.resolutionEpoch++;
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
  private assertConfinedModeChange(inode: INode, mode: number, cred: VfsCred, path: string): void {
    if (!this.isConfined(cred)) return;
    const current = inode.mode & 0o7777;
    const granted = (mode & 0o6077) & ~current;
    const unstuck = current & ~mode & 0o1000;
    if (granted === 0 && unstuck === 0) return;
    throw vfsError('EPERM', `${path}: mode change would grant permission outside your own principal; use u+x`);
  }

  /**
   * Permission bits a new inode is created with. umask never masks 07000, so
   * a confined principal's creation drops setuid/setgid here, the one grant
   * its umask cannot refuse. Sticky only restricts others and is kept.
   */
  private creationMode(requested: number, cred: VfsCred): number {
    return requested & ~cred.umask & (this.isConfined(cred) ? 0o1777 : 0o7777);
  }

  /**
   * What a new entry at storage key `key` is made with, from its parent (a
   * row, or one staged earlier in the same batch):
   * - a parent with a default ACL gives the requested permissions ANDed with
   *   its base entries, no umask, and a new directory inherits the ACL;
   * - a setgid parent gives its group, and a new directory is setgid too
   *   (Linux; Kinu N26). Otherwise the caller's umask and primary group.
   */
  private creationAttrs(
    key: string,
    requested: number,
    cred: VfsCred,
    directory: boolean,
    staged?: ReadonlyMap<string, { mode: number; gid: number; defaultAcl: number | null }>,
  ): { mode: number; gid: number; defaultAcl: number | null } {
    const parentKey = this.parentPath(key);
    const parent = staged?.get(parentKey) ?? this.inodes.get(parentKey);
    const acl = parent?.defaultAcl ?? null;
    let mode = acl === null
      ? this.creationMode(requested, cred)
      : (requested & (this.isConfined(cred) ? 0o1000 : 0o7000)) | (requested & 0o777 & acl);
    let gid = cred.gid;
    if (parent !== undefined && (parent.mode & 0o2000) !== 0) {
      gid = parent.gid;
      if (directory) mode |= 0o2000;
    }
    const shared = this.sharedDirectory(key);
    if (shared) {
      if (cred.uid !== 0 && cred.gid !== shared.gid && !cred.groups.includes(shared.gid)) throw vfsError('EPERM', key + ': shared group membership required');
      mode = this.sharedMode(mode, directory);
      gid = shared.gid;
      return { mode, gid, defaultAcl: directory ? shared.acl : null };
    }
    return { mode, gid, defaultAcl: directory ? acl : null };
  }

  private isConfined(cred: VfsCred): boolean {
    return cred.uid !== 0 && this.confinedTmpRoots.has(cred.uid);
  }

  /** Drop a confinement. A principal's `/tmp` dies with it; its home does not. */
  releasePrincipal(uid: number): void {
    this.confinedTmpRoots.delete(uid);
    this.resolutionEpoch++;
  }

  /**
   * Logical path -> storage key, for one credential.
   *
   * Everything under `/tmp` belongs to the caller's own private root, which is
   * what makes the same path mean different bytes per principal. Idempotent: a
   * key already inside that root is returned untouched, so the several methods
   * that derive a key before handing it on cannot stack the rewrite.
   */
  private storageKey(path: string, cred: VfsCred): string {
    return this.keyOfName(normalizeVfsPath(path), this.confinedTmpRoots.get(cred.uid));
  }

  /** {@link storageKey} of a name already normalized, under a principal's private root. */
  private keyOfName(name: string, root: string | undefined): string {
    if (root === undefined) return name;
    if (name === root || name.startsWith(`${root}/`)) return name;
    if (name === TMP_ROOT) return root;
    if (!name.startsWith(`${TMP_ROOT}/`)) return name;
    return `${root}/${name.slice(TMP_ROOT.length + 1)}`;
  }

  /**
   * The name a credential uses for `path`, whichever spelling it came in: a
   * confined caller's own root is `/tmp`, whether it wrote /tmp/x or the
   * root's storage key. One name per file is what lets resolution walk the
   * caller's view rather than storage.
   */
  private nameOf(path: string, cred: VfsCred): string {
    const key = this.storageKey(path, cred);
    // Never null: storageKey never yields a key this caller has no name for.
    return this.logicalPath(key, cred) ?? key;
  }

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
  private logicalPath(key: string, cred: VfsCred): string | null {
    const root = this.confinedTmpRoots.get(cred.uid);
    if (root === undefined) return key;
    if (key === root) return TMP_ROOT;
    if (key.startsWith(`${root}/`)) return `${TMP_ROOT}/${key.slice(root.length + 1)}`;
    // The SHARED scratch root has no name here — this caller's `/tmp` is its
    // own root, which already supplied that entry. Returning it too would
    // enumerate one name twice, for two different directories.
    return key === TMP_ROOT || key.startsWith(`${TMP_ROOT}/`) ? null : key;
  }

  // ── Filesystem operations ─────────────────────────────────────────────

  /**
   * uid 0's view: its writes may use the storage the ledger keeps back from
   * everyone else (N18's kernel reserve, as ext4 reserves blocks for root).
   * Covers each call's synchronous part; the kernel's bookkeeping is that.
   */
  private privilegedView(view: CredentialedVfs): CredentialedVfs {
    const out = {} as CredentialedVfs;
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(view))) {
      const value = descriptor.value;
      if (typeof value === 'function') {
        descriptor.value = (...args: unknown[]) => {
          const prior = this.privileged;
          this.privileged = true;
          try { return value(...args); } finally { this.privileged = prior; }
        };
      }
      Object.defineProperty(out, key, descriptor);
    }
    return out;
  }


  /** Bind credentials and, optionally, the capability of a live mutation lease. */
  as(cred: VfsCred, options?: { mutationOwner?: string }): CredentialedVfs {
    const engine = this;
    const mutationOwner = options?.mutationOwner;
    const bound = Object.freeze({
      uid: cred.uid,
      gid: cred.gid,
      groups: Object.freeze([...cred.groups]),
      umask: cred.umask & 0o777,
    });
    const view: CredentialedVfs = {
      cred: bound,
      exists: (path) => this.exists(path, bound),
      isDirectory: (path) => this.isDirectory(path, bound),
      isFile: (path) => this.isFile(path, bound),
      isSymlink: (path) => this.isSymlink(path, bound),
      kind: (path) => this.probeInode(path, bound)?.kind ?? null,
      access: (path, mode) => { this.checkAccess(path, mode, bound); },
      mkdir: (path, options) => this.mkdir(path, options, bound),
      writeFile: (path, content, options) => this.writeFile(path, content, options, bound),
      symlink: (target, path) => this.symlink(target, path, bound),
      readlink: (path) => this.readlink(path, bound),
      resolveSymlink: (path) => this.resolveSymlink(path, bound),
      resolveName: (path, followLeaf, stop) => this.resolveName(path, bound, followLeaf, stop),
      readFile: (path) => this.readFile(path, bound),
      readFileUncached: (path) => this.readFileUncached(path, bound),
      readRange: (path, offset, length) => this.readRange(path, offset, length, bound),
      readRangeUncached: (path, offset, length) => (
        this.readRange(path, offset, length, bound, { cached: false })
      ),
      writeRange: (path, offset, bytes) => this.writeRange(path, offset, bytes, bound),
      appendOnce: (path, pid, writerId, moduleId, operationId, digest, bytes) => (
        this.appendOnce(path, pid, writerId, moduleId, operationId, digest, bytes, bound)
      ),
      acknowledgeAppend: (pid, writerId, moduleId, operationId) => (
        this.acknowledgeAppend(pid, writerId, moduleId, operationId)
      ),
      truncate: (path, size) => this.truncate(path, size, bound),
      readFileString: (path) => this.readFileString(path, bound),
      stat: (path) => this.stat(path, bound, true),
      lstat: (path) => this.stat(path, bound, false),
      utimes: (path, atimeMs, mtimeMs, options) => this.utimes(path, atimeMs, mtimeMs, bound, options?.followSymlinks !== false),
      chmod: (path, mode) => this.chmod(path, mode, bound),
      setDefaultAcl: (path, perms) => this.setDefaultAcl(path, perms, bound),
      getDefaultAcl: (path) => this.getDefaultAcl(path, bound),
      chown: (path, uid, gid, options) => this.chown(
        path,
        uid,
        gid,
        bound,
        options?.followSymlinks !== false,
      ),
      readdir: (path) => this.readdir(path, bound),
      list: (after, limit) => this.list(
        after ?? null,
        Math.min(Math.max(1, Math.trunc(limit ?? FS_LIST_PAGE_LIMIT)), FS_LIST_PAGE_LIMIT),
        bound,
      ),
      acquire: (epoch, cursor, options) => this.acquire(epoch, cursor, bound, options),
      unlink: (path) => this.unlink(path, bound),
      rmdir: (path) => this.rmdir(path, bound),
      removeRecursive: (path) => this.removeRecursive(path, bound),
      rename: (oldPath, newPath) => this.rename(oldPath, newPath, bound),
      copyFile: (src, dest) => this.copyFile(src, dest, bound),
      copyTree: (src, dest, options) => this.copyTreeNow(this.planCopyTree(src, dest, bound, options)),
      copyTreeAsync: (src, dest, options) => {
        const owner = mutationOwner ?? options?.mutationOwner;
        const job = this.withMutationOwner(owner, () => this.planCopyTree(src, dest, bound, options));
        return this.spanning(() => this.copyTreeInSlices(job, owner), owner);
      },
      writeBatch: (payload) => this.writeBatch(payload, bound),
      writeStream: (stream, options) => this.writeStream(stream,
        mutationOwner === undefined ? options : { ...options, mutationOwner }, bound),
      mkdirBatch: (paths) => this.mkdirBatch(paths, bound),
      revision: (path) => this.revision(path, bound),
      contentKey: (path) => this.contentKey(path, bound),
      invalidatedSince: (epoch, cursor) => this.invalidatedSince(epoch, cursor, bound),
      storageKey: (path) => this.storageKey(path, bound),
      subscribe: (path, listener) => this.subscribe(path, bound, listener),
      // Live: a view outlives rotateIncarnation.
      get epoch() { return engine._epoch; },
    };
    if (mutationOwner !== undefined) {
      // Only synchronous mutations enter an ambient scope; spanning work carries the owner per slice.
      const mutations: Partial<CredentialedVfs> = {
        mkdir: (path, options) => this.withMutationOwner(mutationOwner, () => this.mkdir(path, options, bound)),
        writeFile: (path, content, options) => this.withMutationOwner(mutationOwner, () => this.writeFile(path, content, options, bound)),
        symlink: (target, path) => this.withMutationOwner(mutationOwner, () => this.symlink(target, path, bound)),
        writeRange: (path, offset, bytes) => this.withMutationOwner(mutationOwner, () => this.writeRange(path, offset, bytes, bound)),
        appendOnce: (path, pid, writerId, moduleId, operationId, digest, bytes) => this.withMutationOwner(mutationOwner,
          () => this.appendOnce(path, pid, writerId, moduleId, operationId, digest, bytes, bound)),
        acknowledgeAppend: (pid, writerId, moduleId, operationId) => this.withMutationOwner(mutationOwner,
          () => this.acknowledgeAppend(pid, writerId, moduleId, operationId)),
        truncate: (path, size) => this.withMutationOwner(mutationOwner, () => this.truncate(path, size, bound)),
        utimes: (path, atimeMs, mtimeMs, options) => this.withMutationOwner(mutationOwner,
          () => this.utimes(path, atimeMs, mtimeMs, bound, options?.followSymlinks !== false)),
        chmod: (path, mode) => this.withMutationOwner(mutationOwner, () => this.chmod(path, mode, bound)),
        setDefaultAcl: (path, perms) => this.withMutationOwner(mutationOwner, () => this.setDefaultAcl(path, perms, bound)),
        chown: (path, uid, gid, options) => this.withMutationOwner(mutationOwner,
          () => this.chown(path, uid, gid, bound, options?.followSymlinks !== false)),
        unlink: (path) => this.withMutationOwner(mutationOwner, () => this.unlink(path, bound)),
        rmdir: (path) => this.withMutationOwner(mutationOwner, () => this.rmdir(path, bound)),
        removeRecursive: (path) => this.withMutationOwner(mutationOwner, () => this.removeRecursive(path, bound)),
        rename: (from, to) => this.withMutationOwner(mutationOwner, () => this.rename(from, to, bound)),
        copyFile: (from, to) => this.withMutationOwner(mutationOwner, () => this.copyFile(from, to, bound)),
        copyTree: (from, to, options) => this.withMutationOwner(mutationOwner,
          () => this.copyTreeNow(this.planCopyTree(from, to, bound, options))),
        writeBatch: (payload) => this.withMutationOwner(mutationOwner, () => this.writeBatch(payload, bound)),
        mkdirBatch: (paths) => this.withMutationOwner(mutationOwner, () => this.mkdirBatch(paths, bound)),
      };
      Object.assign(view, mutations);
    }
    return bound.uid === 0 ? this.privilegedView(view) : view;
  }

  private accessInode(inode: INode, want: number, cred: VfsCred): boolean {
    return this.accessMode(inode.mode, inode.uid, inode.gid, want, cred);
  }

  private accessMode(mode: number, uid: number, gid: number, want: number, cred: VfsCred): boolean {
    const requested = want & 0o7;
    if (requested === 0) return true;
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
  private resolvePath(
    path: string,
    cred: VfsCred,
    followLeaf: boolean,
    allowMissing: boolean,
    tree: InodeLookup = this.inodes,
  ): { path: string; inode: INode | undefined; name: string } {
    const root = this.confinedTmpRoots.get(cred.uid);
    let current = this.nameOf(path, cred);
    // The walk resolveName just did for this name, when nothing since could
    // have changed where it leads (see lastResolution).
    const last = this.lastResolution;
    if (
      last !== null && last.name === current && last.cred === cred && tree === this.inodes
      && last.epoch === this.resolutionEpoch && last.tableEpoch === this.inodes.epoch
      && !(followLeaf && last.leafIsLink)
    ) {
      return { path: last.key, inode: last.inode, name: current };
    }
    // Hops are counted, never deduplicated (Linux, MAXSYMLINKS 40): a link
    // met again on a longer path (`loop -> .`) is one more hop, not a cycle.
    for (let hops = 0; hops <= 40; hops++) {
      const parts = current.split('/').filter(Boolean);
      let prefix = '';
      let restarted = false;
      for (let index = 0; index < parts.length; index++) {
        prefix = prefix ? `${prefix}/${parts[index]}` : parts[index];
        const inode = tree.get(this.keyOfName(prefix, root));
        const leaf = index === parts.length - 1;
        if (!inode) {
          if (leaf || allowMissing) return { path: this.keyOfName(current, root), inode: undefined, name: current };
          throw vfsError('ENOENT', prefix);
        }
        if (inode.kind === 'symlink' && (!leaf || followLeaf)) {
          if (hops === 40) throw vfsError('ELOOP', path);
          const target = dec.decode(this.readInodeBytes(inode.path, inode));
          const suffix = parts.slice(index + 1).join('/');
          const base = target.startsWith('/') ? target : `${this.parentPath(prefix)}/${target}`;
          current = this.nameOf(suffix ? `${base}/${suffix}` : base, cred);
          restarted = true;
          break;
        }
        if (!leaf) {
          if (inode.kind !== 'directory') throw vfsError('ENOTDIR', prefix);
          if (!this.accessInode(inode, 0o1, cred)) throw vfsError('EACCES', prefix);
        }
      }
      if (restarted) continue;
      const key = this.keyOfName(current, root);
      return { path: key, inode: tree.get(key), name: current };
    }
    throw vfsError('ELOOP', path);
  }

  /**
   * Walk a plain SQLite path once, checking ancestor search permission. A
   * link that needs following, or a name claimed by the namespace, returns
   * null for the existing component walk. Thus mount shadowing, link-hop
   * limits and physical `..` traversal keep their namespace semantics.
   * `stop` must include mount ancestors: declining the first component
   * declines this descent, but not a link target. `end` distinguishes a
   * missing entry from a non-directory component without throwing merely
   * to report absence. The returned name's engine operations share this
   * traversal proof (lastResolution), rather than walking it again.
   */
  private resolveName(
    path: string,
    cred: VfsCred,
    followLeaf: boolean,
    stop: ((name: string) => boolean) | undefined,
    tree: InodeLookup = this.inodes,
  ): VfsNameResolution | null {
    const root = this.confinedTmpRoots.get(cred.uid);
    const current = this.nameOf(path, cred);
    // A namespace's claim includes every ancestor of a mount. Even a
    // reusable inode walk asks the current namespace first: mount/unmount
    // is not an engine mutation.
    const firstEnd = current.indexOf('/');
    if (current !== '' && stop?.(firstEnd === -1 ? current : current.slice(0, firstEnd))) return null;
    const last = this.lastResolution;
    const reusable = last !== null && tree === this.inodes && last.cred === cred
      && last.epoch === this.resolutionEpoch && last.tableEpoch === this.inodes.epoch;
    if (reusable && last.name === current) {
      return followLeaf && last.leafIsLink ? null : { name: current, end: 'found' };
    }
    // Adjacent directory entries share the traversal/search proof, not a
    // routing table. Any mutation invalidates it, and the leaf is always
    // looked up anew (including links and absence).
    const parentEnd = current.lastIndexOf('/');
    const sameParent = reusable && parentEnd >= 0 && parentEnd === last.name.lastIndexOf('/')
      && current.slice(0, parentEnd) === last.name.slice(0, parentEnd);
    const parts = current === '' ? [] : sameParent ? [current.slice(parentEnd + 1)] : current.split('/');
    let prefix = sameParent ? current.slice(0, parentEnd) : '';
    let found: INode | undefined;
    for (let index = 0; index < parts.length; index++) {
      prefix = prefix ? `${prefix}/${parts[index]}` : parts[index]!;
      const inode = tree.get(this.keyOfName(prefix, root));
      found = inode;
      const leaf = index === parts.length - 1;
      if (!inode) return { name: current, end: 'absent' };
      if (inode.kind === 'symlink' && (!leaf || followLeaf)) return null;
      if (!leaf) {
        if (inode.kind !== 'directory') return { name: current, end: 'not-directory' };
        if (!this.accessInode(inode, 0o1, cred)) throw vfsError('EACCES', prefix);
      }
    }
    if (found !== undefined && tree === this.inodes) {
      this.lastResolution = {
        epoch: this.resolutionEpoch, tableEpoch: this.inodes.epoch, cred, name: current,
        key: this.keyOfName(current, root), inode: found, leafIsLink: found.kind === 'symlink',
      };
    }
    return { name: current, end: 'found' };
  }

  private checkAccess(
    path: string,
    want: number,
    cred: VfsCred,
    options: { followLeaf?: boolean; allowMissingLeaf?: boolean; tree?: InodeLookup } = {},
  ): { path: string; inode: INode | undefined } {
    const resolved = this.resolvePath(
      path,
      cred,
      options.followLeaf ?? true,
      options.allowMissingLeaf ?? false,
      options.tree,
    );
    if (!resolved.inode) {
      if (options.allowMissingLeaf) return resolved;
      throw vfsError('ENOENT', normalizeVfsPath(path));
    }
    if (!this.accessInode(resolved.inode, want, cred)) {
      throw vfsError('EACCES', resolved.path);
    }
    return resolved;
  }

  /**
   * `/` has no row: it is 0755 root:root by definition, and adding or
   * removing a name in it needs write and search there like any directory.
   */
  private checkRootWritable(path: string, cred: VfsCred): void {
    if (!this.accessMode(ROOT_DIRECTORY_MODE, 0, 0, 0o3, cred)) throw vfsError('EACCES', normalizeVfsPath(path));
  }

  private checkParentAccess(path: string, cred: VfsCred): void {
    const parent = this.parentPath(normalizeVfsPath(path));
    if (parent === '') { this.checkRootWritable(path, cred); return; }
    const resolved = this.checkAccess(parent, 0o3, cred);
    if (resolved.inode?.kind !== 'directory') throw vfsError('ENOTDIR', parent);
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
  private checkStickyParentMutation(path: string, inode: INode, cred: VfsCred): void {
    if (cred.uid === 0) return;
    const parent = this.parentPath(normalizeVfsPath(path));
    if (parent === '') return;
    const parentInode = this.inodes.get(parent);
    if (!parentInode || (parentInode.mode & 0o1000) === 0) return;
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
  private probeInode(path: string, cred: VfsCred): INode | undefined {
    try {
      return this.checkAccess(path, 0, cred, { followLeaf: false, allowMissingLeaf: true }).inode;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
      throw error;
    }
  }

  private exists(path: string, cred: VfsCred): boolean {
    return this.probeInode(path, cred) !== undefined;
  }

  private isDirectory(path: string, cred: VfsCred): boolean {
    return this.probeInode(path, cred)?.kind === 'directory';
  }

  private isFile(path: string, cred: VfsCred): boolean {
    return this.probeInode(path, cred)?.kind === 'file';
  }

  private isSymlink(path: string, cred: VfsCred): boolean {
    return this.probeInode(path, cred)?.kind === 'symlink';
  }

  /**
   * Without a path: the global mutation clock, which is the last committed
   * generation (`vfs_state.gen`) as of the last publication. With a path:
   * the clock value at the last mutation inside that path's subtree, or a
   * later one (the revision floor) if that is older than what is still held.
   * Never less than the last mutation, never more than the clock.
   * `revision('')` equals the global clock.
   */
  revision(path?: string, cred?: VfsCred): number {
    if (path === undefined) return this._revision;
    // A credentialed caller asks about its own view; a confined one asking
    // after /tmp/x means its own file, so the counter must be that file's.
    const p = cred === undefined ? normalizeVfsPath(path) : this.storageKey(path, cred);
    if (p === '') return this._revision;
    // Mutations stamp the path a name resolves to, so that is the counter.
    let resolved: { path: string; inode: INode | undefined };
    try { resolved = this.resolvePath(p, cred ?? CRED_KERNEL, true, true); } catch { return this.pathRevision(p); }
    // The walk's own lookup of the leaf: a second would read SQLite again for a missing one.
    return this.pathRevision(resolved.path, resolved.inode ?? null);
  }

  /**
   * A storage key's revision: its stamp; else, for a file or symlink, its
   * row's generation, which its last mutation wrote and which survives
   * restarts, so an untouched file keeps its revision across incarnations;
   * else (a directory, or no row) the floor or the generation of its row or
   * tombstone, whichever is later. Never more than the global clock, so a
   * row written by a transaction not yet published reports the clock.
   * `inode` is the row at `key`, null for none; omitted, it is looked up.
   */
  private pathRevision(key: string, inode?: INode | null): number {
    const stamped = this._pathRevisions.get(key);
    if (stamped !== undefined) return stamped;
    const node = inode === undefined ? this.inodes.get(key) : inode;
    if (node && !node.isDir) return Math.min(node.gen, this._revision);
    if (node) return Math.max(this._revisionFloor, Math.min(node.gen, this._revision));
    const tombstone = [...this.sql.exec('SELECT gen FROM vfs_tombstones WHERE path = ?', key)][0];
    return Math.max(this._revisionFloor, Math.min(Number(tombstone?.gen ?? 0), this._revision));
  }

  /**
   * Advance the clock to the committed generation, stamp the directories
   * above every path, and record the mutation in the invalidation log. Every
   * mutation commits at least one generation before it gets here, so the
   * clock is strictly monotonic and equals `vfs_state.gen` after each
   * publication; an operation of several transactions ticks it once, to its
   * last generation.
   *
   * A mutated path is stamped only if it holds a stamp already (it was a
   * directory something was written under): the transaction that mutated it
   * wrote its row's or its tombstone's generation, which is what
   * pathRevision reports for it without one. Stamping it too would hold a
   * revision in memory for every file ever written or removed.
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
  private bumpRevision(
    paths: readonly string[],
    structural: ReadonlyMap<string, StructuralChange> = NO_STRUCTURAL_CHANGES,
  ): void {
    this.resolutionEpoch++;
    for (const opened of this.openNodes) {
      if (opened.path === null) continue;
      const live = this.inodes.get(opened.path);
      if (live) opened.inode = live;
      else { opened.path = null; opened.inode.ctime = this.now(); }
    }
    if (this.transactionPublication) {
      for (const path of paths) this.transactionPublication.paths.add(path);
      for (const [path, change] of structural) {
        // A directory removed after its mode changed was removed.
        if (this.transactionPublication.structural.get(path) !== 'removed') {
          this.transactionPublication.structural.set(path, change);
        }
      }
      return;
    }
    if (this._gen <= this._revision) this.advanceGeneration();
    const rev = this._gen;
    this._revision = rev;
    for (const path of paths) {
      const mutated = normalizeVfsPath(path);
      if (mutated === '') continue;
      let p = this.parentPath(mutated);
      while (p !== '') {
        const stamped = this._pathRevisions.get(p);
        // Stamped by this bump already, and so was every directory above it.
        if (stamped === rev) break;
        if (stamped === undefined) this._pathRevisionBytes += SqliteVFS.entryBytes(p);
        this._pathRevisions.set(p, rev);
        p = this.parentPath(p);
      }
      // A stamp it holds answers for it before its row does, so it moves too.
      if (this._pathRevisions.has(mutated)) this._pathRevisions.set(mutated, rev);
      this._record(rev, mutated, structural.get(mutated));
      const parent = this.parentPath(mutated);
      if (parent !== '') this._record(rev, parent);
    }
    if (this._pathRevisionBytes > this.pathRevisionBudget) this.dropOldestPathRevisions();
    if (this._invalidationBytes <= SqliteVFS.INVALIDATION_LOG_MAX_BYTES) return;
    let dropped = 0;
    while (
      dropped < this._invalidations.length
      && this._invalidationBytes > SqliteVFS.INVALIDATION_LOG_MAX_BYTES
    ) {
      this._invalidationBytes -= SqliteVFS.entryBytes(this._invalidations[dropped]!.path);
      this._invalidationFloor = this._invalidations[dropped]!.rev;
      dropped++;
    }
    if (dropped > 0) this._invalidations = this._invalidations.slice(dropped);
  }

  /** Commit a generation that writes nothing, so a publication has a tick of its own. */
  private advanceGeneration(): void {
    let gen = 0;
    this.transactionSync(() => {
      gen = Number([...this.sql.exec('UPDATE vfs_state SET gen = gen + 1 WHERE slot = 1 RETURNING gen')][0]!.gen);
    });
    this._gen = gen;
  }

  /**
   * Drop every per-path revision at or below the oldest quarter's newest,
   * and raise the floor to it. A quarter at a time, so the sort is paid once
   * per quarter of the budget, not once per mutation.
   *
   * Everything at or below one revision goes together, and a directory is
   * stamped whenever anything under it is mutated, so it is never older than
   * what it holds: a dropped directory takes every stamp under it along, and
   * revision(dir) stays at or above the revision of every path under it.
   */
  private dropOldestPathRevisions(): void {
    while (this._pathRevisionBytes > this.pathRevisionBudget) {
      const stamps = Float64Array.from(this._pathRevisions.values()).sort();
      this.dropPathRevisionsThrough(stamps[Math.floor(stamps.length / 4)]!);
    }
  }

  /**
   * Raise the floor to `cutoff`, dropping every stamp at or below it: a stamp
   * under the floor would report its directory below a missing path under
   * it, which reports the floor.
   */
  private dropPathRevisionsThrough(cutoff: number): void {
    for (const [path, stamped] of this._pathRevisions) {
      if (stamped > cutoff) continue;
      this._pathRevisions.delete(path);
      this._pathRevisionBytes -= SqliteVFS.entryBytes(path);
    }
    this._revisionFloor = Math.max(this._revisionFloor, cutoff);
  }

  /** UTF-16 payload plus a flat allowance for the entry object itself. */
  private static entryBytes(path: string): number {
    return path.length * 2 + 48;
  }

  private _record(rev: number, path: string, structural?: StructuralChange): void {
    this._invalidations.push(structural === undefined ? { rev, path } : { rev, path, structural });
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
  invalidatedSince(epoch: string | null, cursor: number, cred?: VfsCred): VfsAcquireResult {
    const rev = this._revision;
    if (epoch !== this._epoch || cursor > rev) {
      return { epoch: this._epoch, rev, paths: [], poison: true };
    }
    if (cursor === rev) return { epoch: this._epoch, rev, paths: [], poison: false };
    // Revisions are generations, so consecutive publications need not be
    // consecutive integers: completeness is judged against the newest
    // revision any entry was dropped from, never against oldest - 1. Older
    // than that, the rows answer, and the same view rules apply to them.
    let log: readonly LoggedMutation[] = this._invalidations;
    if (cursor < this._invalidationFloor) {
      const fromSql = this.invalidatedFromSql(cursor, rev);
      if (fromSql === null) return { epoch: this._epoch, rev, paths: [], poison: true };
      log = fromSql;
    }
    // One entry per path, at its newest revision in the window: the one the
    // caller has to be at or past to keep what it holds there.
    const merged = new Map<string, VfsInvalidatedPath>();
    const report = (path: string, pathRev: number, subtree: boolean, structural: boolean): void => {
      const prior = merged.get(path);
      const entry: VfsInvalidatedPath = { path, rev: Math.max(prior?.rev ?? 0, pathRev) };
      if (subtree || prior?.subtree) entry.subtree = true;
      if (structural || prior?.structural) entry.structural = true;
      merged.set(path, entry);
    };
    if (cred === undefined) {
      for (const entry of log) {
        if (entry.rev > cursor) report(entry.path, entry.rev, false, entry.structural !== undefined);
      }
      return { epoch: this._epoch, rev, paths: [...merged.values()], poison: false };
    }
    // Where each directory's position went in the window: the newest
    // revision it was removed or renamed away at, by the caller's name.
    const removedAt = new Map<string, number>();
    for (const entry of log) {
      if (entry.rev <= cursor || entry.structural !== 'removed') continue;
      const name = this.logicalPath(entry.path, cred);
      if (name !== null) removedAt.set(name, Math.max(removedAt.get(name) ?? 0, entry.rev));
    }
    // Per directory, the highest one at or above it that the caller may not
    // enter now: one lookup per directory per answer, not per entry.
    const closedAbove = new Map<string, string | null>();
    for (const entry of log) {
      if (entry.rev <= cursor) continue;
      const name = this.logicalPath(entry.path, cred);
      if (name === null) continue;
      const behind = this.hiddenBehind(name, entry.rev, cred, removedAt, closedAbove);
      if (behind === null) report(name, entry.rev, false, entry.structural !== undefined);
      else report(behind, entry.rev, true, false);
    }
    return { epoch: this._epoch, rev, paths: [...merged.values()], poison: false };
  }

  /**
   * The directory above `name` that stands between the caller and it, if
   * any: the highest that the caller may not enter now, or whose place went
   * at or after `rev` (removed or renamed away, so the entry names a path
   * that is no longer there, whatever stands at that name now). Null when
   * there is none: the caller may see `name` itself. The caller may see
   * whatever is returned, since every directory above it passed.
   */
  private hiddenBehind(
    name: string,
    rev: number,
    cred: VfsCred,
    removedAt: ReadonlyMap<string, number>,
    closedAbove: Map<string, string | null>,
  ): string | null {
    const parent = this.parentPath(name);
    let behind = this.closedAbove(parent, cred, closedAbove);
    if (removedAt.size > 0) {
      for (let dir = parent; dir !== ''; dir = this.parentPath(dir)) {
        if ((removedAt.get(dir) ?? -1) >= rev && (behind === null || dir.length < behind.length)) behind = dir;
      }
    }
    return behind;
  }

  /** The highest directory at or above `dir` that the caller may not enter now, or null. */
  private closedAbove(dir: string, cred: VfsCred, memo: Map<string, string | null>): string | null {
    if (dir === '') return null;
    const known = memo.get(dir);
    if (known !== undefined) return known;
    let closed = this.closedAbove(this.parentPath(dir), cred, memo);
    if (closed === null) {
      const inode = this.inodes.get(this.keyOfName(dir, this.confinedTmpRoots.get(cred.uid)));
      if (inode === undefined || inode.kind !== 'directory' || !this.accessInode(inode, 0o1, cred)) closed = dir;
    }
    memo.set(dir, closed);
    return closed;
  }

  /**
   * A watch in `cred`'s view (CredentialedVfs.subscribe). A watch is not a
   * cache, so an event it may not see is simply not delivered.
   */
  private subscribe(path: string, cred: VfsCred, listener: (event: VfsEvent) => void): () => void {
    return this.events.onPath(this.storageKey(path, cred), (event) => {
      const name = this.watchedName(event.path, cred);
      if (name === null) return;
      const oldPath = event.oldPath === undefined ? null : this.watchedName(event.oldPath, cred);
      const { oldPath: _stored, ...rest } = event;
      listener(oldPath === null ? { ...rest, path: name } : { ...rest, path: name, oldPath });
    });
  }

  /**
   * The caller's name for an event's path, if it may see it: every
   * directory above it enterable. A directory the same mutation removed is
   * judged as it was, so a removed tree the caller could see into is heard
   * entry by entry, and one it could not, only at its top.
   */
  private watchedName(key: string, cred: VfsCred): string | null {
    const name = this.logicalPath(key, cred);
    if (name === null) return null;
    const root = this.confinedTmpRoots.get(cred.uid);
    const parts = name.split('/');
    let dir = '';
    for (let index = 0; index < parts.length - 1; index++) {
      dir = dir === '' ? parts[index]! : `${dir}/${parts[index]}`;
      const dirKey = this.keyOfName(dir, root);
      const inode = this.inodes.get(dirKey) ?? this.removedForEvents?.get(dirKey);
      if (inode === undefined || inode.kind !== 'directory' || !this.accessInode(inode, 0o1, cred)) return null;
    }
    return name;
  }

  /**
   * The delta for a cursor older than the log, from the rows themselves:
   * every row written in (cursor, rev] and every path deleted in it (its
   * tombstone), each with its parent, at the generation that wrote it. As
   * complete as the log, since every mutation writes a row or a tombstone.
   * Null (poison) below the tombstone floor, or past SQL_DELTA_MAX_PATHS,
   * where a reconcile against list() is cheaper than the delta.
   */
  private invalidatedFromSql(cursor: number, rev: number): LoggedMutation[] | null {
    if (cursor < this._tombstoneFloor) return null;
    // One mutation per path, at its newest generation in the window, as the
    // log would have held it. The rows do not say what kind of change a
    // directory had, so the answer assumes the widest: a tombstone is a
    // removal (whatever stands there now is a new directory, and nothing
    // held under the old one may survive), and a directory row written in the
    // window may have changed who can enter it.
    const latest = new Map<string, LoggedMutation>();
    const note = (path: string, gen: number, structural?: StructuralChange): void => {
      const prior = latest.get(path);
      const kept = prior?.structural === 'removed' ? 'removed' : structural ?? prior?.structural;
      const entry: LoggedMutation = { path, rev: Math.max(prior?.rev ?? -1, gen) };
      if (kept !== undefined) entry.structural = kept;
      latest.set(path, entry);
    };
    for (const table of ['vfs_inodes', 'vfs_tombstones'] as const) {
      const rows = [...this.sql.exec(
        table === 'vfs_inodes'
          ? 'SELECT path, gen, kind FROM vfs_inodes WHERE gen > ? AND gen <= ? LIMIT ?'
          : 'SELECT path, gen FROM vfs_tombstones WHERE gen > ? AND gen <= ? LIMIT ?',
        cursor,
        rev,
        SQL_DELTA_MAX_PATHS + 1,
      )];
      if (rows.length > SQL_DELTA_MAX_PATHS) return null;
      for (const row of rows) {
        const path = String(row.path);
        const gen = Number(row.gen);
        const structural: StructuralChange | undefined = table === 'vfs_tombstones'
          ? 'removed'
          : Number(row.kind) === INODE_KIND_DIRECTORY ? 'changed' : undefined;
        note(path, gen, structural);
        const parent = this.parentPath(path);
        if (parent !== '') note(parent, gen);
      }
      if (latest.size > SQL_DELTA_MAX_PATHS) return null;
    }
    return [...latest.values()];
  }


  acquireExclusiveMutation(
    path: string,
    options: ExclusiveMutationOptions = {},
  ): ExclusiveMutationLease {
    let root = normalizeVfsPath(path);
    if (!root) throw vfsError('EINVAL', 'exclusive mutation root cannot be empty');
    if (options.includeMissingAncestors) {
      const parts = root.split('/');
      for (let index = 0; index < parts.length; index++) {
        const candidate = parts.slice(0, index + 1).join('/');
        const inode = this.inodes.get(candidate);
        if (!inode) {
          root = candidate;
          break;
        }
        if (inode.kind !== 'directory') break;
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

  acquireGlobalExclusiveMutation(): ExclusiveMutationLease {
    if (this.exclusiveMutationLeases.size > 0) {
      throw vfsError('EBUSY', 'session has an active exclusive filesystem mutation');
    }
    const owner = crypto.randomUUID();
    this.exclusiveMutationLeases.set(owner, '');
    return { root: '', owner };
  }

  releaseExclusiveMutation(owner: string): void {
    this.exclusiveMutationLeases.delete(owner);
  }

  hasExclusiveMutation(): boolean {
    return this.exclusiveMutationLeases.size > 0;
  }

  private withMutationOwner<T>(owner: string | undefined, callback: () => T): T {
    if (owner === undefined) return callback();
    if (!this.exclusiveMutationLeases.has(owner)) throw vfsError('ESTALE', 'exclusive mutation lease is no longer active');
    if (this.activeMutationOwner !== null) {
      throw new Error('[sqlite-vfs] nested mutation owner scope is not supported');
    }
    this.activeMutationOwner = owner;
    try {
      return callback();
    } finally {
      this.activeMutationOwner = null;
    }
  }

  assertMutationAllowed(path: string): void {
    this.assertMutationsAllowed([path]);
  }

  private assertMutationsAllowed(paths: Iterable<string>): void {
    for (const path of paths) {
      const normalized = normalizeVfsPath(path);
      // Another owner's lease first (EBUSY), whoever asks; then a lease
      // holder's own root (EPERM), which bounds where its work may land.
      if (this.activeMutationOwner === null &&
          normalized === LEGACY_SYMLINK_REGISTRY_PATH &&
          this.exclusiveMutationLeases.size > 0) {
        throw vfsError('EBUSY', `${normalized} is locked while an exclusive mutation is active`);
      }
      for (const [owner, root] of this.exclusiveMutationLeases) {
        if (!pathsOverlap(normalized, root) || owner === this.activeMutationOwner) continue;
        throw vfsError('EBUSY', `${normalized} is locked by exclusive mutation at ${root || '/'}`);
      }
      if (this.activeMutationOwner !== null) {
        const ownedRoot = this.exclusiveMutationLeases.get(this.activeMutationOwner);
        if (ownedRoot === undefined || (ownedRoot !== '' && normalized !== ownedRoot && !normalized.startsWith(`${ownedRoot}/`))) {
          throw vfsError('EPERM', `${normalized} is outside exclusive mutation root ${ownedRoot ?? ''}`);
        }
      }
    }
  }

  private mkdir(path: string, options: { recursive?: boolean; mode?: number } | undefined, cred: VfsCred): void {
    const normalized = this.storageKey(path, cred);
    this.assertMutationsAllowed([normalized]);
    if (this.exists(normalized, cred)) return;
    // A directory is created where its name resolves with the last component
    // unfollowed, as mkdir(2) does: under a link to a directory, inside that
    // directory. The storage key alone would put the row under the link
    // itself, where nothing reaches it, after checking the link's target.
    const create = (name: string): void => {
      const placed = this.resolvePath(name, cred, false, true).path;
      this.assertMutationsAllowed([placed]);
      this.checkParentAccess(placed, cred);
      this._mkdirSingle(placed, options?.mode, cred);
    };
    if (!options?.recursive) {
      create(normalized);
      return;
    }
    let current = '';
    for (const part of this.nameOf(normalized, cred).split('/').filter(Boolean)) {
      current = current ? `${current}/${part}` : part;
      if (!this.exists(current, cred)) create(current);
    }
  }

  private _mkdirSingle(path: string, requestedMode: number | undefined, cred: VfsCred): void {
    const now = this.now();
    const made = this.creationAttrs(path, requestedMode ?? 0o777, cred, true);
    const builder = this.newPlan();
    builder.addInode({
      path,
      parentPath: this.parentPath(path),
      kind: 'directory',
      isDir: true,
      size: 0,
      atime: now,
      mtime: now,
      mode: made.mode,
      uid: cred.uid,
      gid: made.gid,
      content: { type: 'none' },
      defaultAcl: made.defaultAcl,
    });
    this._writeBatchOnce({ plan: builder.build(), deletedInodes: [] }, { source: 'strict-batch', limitMode: 'bounded' });
  }

  private writeFile(
    path: string,
    content: string | Uint8Array,
    options: { mode?: number } | undefined,
    cred: VfsCred,
    onCommit?: () => void,
  ): void {
    this.assertMutationsAllowed([path]);
    const resolved = this.checkAccess(path, 0, cred, { allowMissingLeaf: true });
    const effectivePath = resolved.path;
    if (resolved.inode) {
      if (resolved.inode.kind === 'directory') throw vfsError('EISDIR', effectivePath);
      if (resolved.inode.kind !== 'file') throw vfsError('EINVAL', `${effectivePath} is not a regular file`);
      if (!this.accessInode(resolved.inode, 0o2, cred)) throw vfsError('EACCES', effectivePath);
    } else {
      this.checkParentAccess(effectivePath, cred);
    }
    const data = typeof content === 'string' ? enc.encode(content) : content;
    const pp = this.parentPath(effectivePath);
    const now = this.now();
    const chunkCount = data.length === 0 ? 0 : Math.ceil(data.length / CHUNK_SIZE);
    const chunks: BatchChunkEntry[] = [];
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
    const made = prior ? undefined : this.creationAttrs(effectivePath, options?.mode ?? 0o666, cred, false);
    const inode: BatchInodeEntry = {
      path: effectivePath,
      parentPath: pp,
      kind: 'file',
      isDir: false,
      size: data.length,
      atime: now,
      mtime: now,
      mode: prior?.kind === 'file'
        ? prior.mode
        : made?.mode ?? this.creationMode(options?.mode ?? 0o666, cred),
      uid: prior?.uid ?? cred.uid,
      gid: prior?.gid ?? made!.gid,
      chunkCount,
    };
    try {
      this.writeBatch({ inodes: [inode], chunks }, cred, onCommit);
    } catch (error) {
      if (!(error instanceof SqliteVfsTransactionTooLargeError)) throw error;
      this.replaceFileWithStagedContent(inode, data, onCommit);
    }
  }

  private symlink(target: string, path: string, cred: VfsCred): void {
    this.assertMutationsAllowed([path]);
    const normalized = this.storageKey(path, cred);
    // Created where the name resolves with its last component unfollowed, as
    // symlink(2) does: under a link to a directory, inside that directory.
    // The storage key alone would put the row under the link itself, where
    // nothing reaches it, after checking permission on the link's target.
    const prior = this.checkAccess(normalized, 0, cred, { followLeaf: false, allowMissingLeaf: true });
    if (prior.inode) throw vfsError('EEXIST', normalized);
    const placed = prior.path;
    this.checkParentAccess(placed, cred);
    const data = enc.encode(target);
    const now = this.now();
    const chunkCount = data.length === 0 ? 0 : Math.ceil(data.length / CHUNK_SIZE);
    const inode: BatchInodeEntry = {
      path: placed,
      parentPath: this.parentPath(placed),
      kind: 'symlink',
      isDir: false,
      size: data.length,
      atime: now,
      mtime: now,
      mode: inodeTypeBits('symlink') | 0o777,
      uid: cred.uid,
      gid: this.creationAttrs(placed, 0o777, cred, false).gid,
      chunkCount,
    };
    const chunks = Array.from({ length: chunkCount }, (_, chunkId) => ({
      path: placed,
      chunkId,
      data: data.subarray(chunkId * CHUNK_SIZE, (chunkId + 1) * CHUNK_SIZE),
    }));
    this.writeBatch({ inodes: [inode], chunks }, cred);
  }

  private readlink(path: string, cred: VfsCred): string {
    const resolved = this.checkAccess(path, 0, cred, { followLeaf: false });
    if (resolved.inode?.kind !== 'symlink') throw vfsError('EINVAL', `${path} is not a symlink`);
    return dec.decode(this.readInodeBytes(resolved.path, resolved.inode));
  }

  /** Where `path` leads, in the caller's names, or null for a loop. */
  private resolveSymlink(path: string, cred: VfsCred): string | null {
    try {
      return this.resolvePath(path, cred, true, false).name;
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ELOOP') {
        return null;
      }
      throw error;
    }
  }

  private readFile(path: string, cred: VfsCred): Uint8Array {
    const resolved = this.checkAccess(path, 0o4, cred);
    const inode = resolved.inode;
    if (!inode) throw vfsError('ENOENT', path);
    if (inode.kind === 'directory') throw vfsError('EISDIR', resolved.path);
    if (inode.kind !== 'file') throw vfsError('EINVAL', `${resolved.path} is not a regular file`);
    return this.readInodeBytes(resolved.path, inode);
  }

  private readInodeBytes(_path: string, inode: INode, cached = true): Uint8Array {
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
  private readFileUncached(path: string, cred: VfsCred): Uint8Array {
    const resolved = this.checkAccess(path, 0o4, cred);
    const inode = resolved.inode;
    if (!inode) throw vfsError('ENOENT', path);
    if (inode.kind === 'directory') throw vfsError('EISDIR', resolved.path);
    if (inode.kind !== 'file') throw vfsError('EINVAL', `${resolved.path} is not a regular file`);
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
  private readRange(
    path: string,
    offset: number,
    length: number,
    cred: VfsCred,
    options: { cached?: boolean } = {},
  ): Uint8Array {
    const resolved = this.checkAccess(path, 0o4, cred);
    const inode = resolved.inode;
    if (!inode) throw vfsError('ENOENT', path);
    if (inode.kind === 'directory') throw vfsError('EISDIR', resolved.path);
    if (inode.kind !== 'file') throw vfsError('EINVAL', `${resolved.path} is not a regular file`);
    const start = clampNonNegativeInt(offset);
    const end = Math.min(inode.size, start + clampNonNegativeInt(length));
    if (start >= end) return new Uint8Array(0);
    return this.readContent(inode, start, end, options.cached !== false);
  }

  /** Bytes [start, end) of the content an inode (or a snapshot's row) names. */
  private readContent(ref: ContentRef & { size: number; path: string }, start: number, end: number, cached: boolean): Uint8Array {
    if (end <= start) return new Uint8Array(0);
    if (ref.chunkId !== null) {
      const data = this.readChunk(ref.chunkId, cached, ref.path);
      if (data.byteLength !== ref.size) {
        throw vfsError('EIO', `${ref.path}: chunk ${ref.chunkId} has ${data.byteLength} bytes; inode says ${ref.size}`);
      }
      // A whole-file read hands back its own buffer: a cached chunk must not
      // be mutable through what a caller was given.
      return cached || start !== 0 || end !== data.byteLength ? data.slice(start, end) : data;
    }
    if (ref.contentId === null) throw vfsError('EIO', `${ref.path}: ${ref.size} bytes with no content`);
    const rows = this.manifestRange(ref.contentId, ref.size, start, end);
    const out = new Uint8Array(end - start);
    let covered = start;
    if (cached) {
      // Hits from the LRU; every miss in one statement.
      const found = new Map<number, Uint8Array>();
      const missing: number[] = [];
      for (const row of rows) {
        const hit = this.cacheGet(row.chunkId);
        if (hit) found.set(row.chunkId, hit);
        else missing.push(row.chunkId);
      }
      for (let i = 0; i < missing.length; i += KEYS_PER_SQL_EXEC) {
        const page = missing.slice(i, i + KEYS_PER_SQL_EXEC);
        this._sqlReads++;
        for (const row of this.sql.exec(
          `SELECT id, data, state FROM vfs_chunks WHERE id IN (${page.map(() => '?').join(',')})`,
          ...page,
        )) {
          if (Number(row.state) !== CHUNK_LOCAL) throw unreadableChunkError(Number(row.state), ref.path);
          const data = this.blobToUint8Array(row.data);
          found.set(Number(row.id), data);
          this.cacheSet(Number(row.id), data);
        }
      }
      for (const row of rows) {
        const data = found.get(row.chunkId);
        if (!data) throw vfsError('EIO', `${ref.path}: missing chunk ${row.chunkId} at ${row.off}`);
        covered = this.copyManifestRow(ref.path, out, start, end, row, data, covered);
      }
    } else {
      // One statement for the whole range: nothing is cached, so nothing is looked up.
      for (let i = 0; i < rows.length; i += KEYS_PER_SQL_EXEC) {
        const page = rows.slice(i, i + KEYS_PER_SQL_EXEC);
        const byId = new Map<number, Uint8Array>();
        this._sqlReads++;
        for (const row of this.sql.exec(
          `SELECT id, data, state FROM vfs_chunks WHERE id IN (${page.map(() => '?').join(',')})`,
          ...page.map((row) => row.chunkId),
        )) {
          if (Number(row.state) !== CHUNK_LOCAL) throw unreadableChunkError(Number(row.state), ref.path);
          byId.set(Number(row.id), this.blobToUint8Array(row.data));
        }
        for (const row of page) {
          const data = byId.get(row.chunkId);
          if (!data) throw vfsError('EIO', `${ref.path}: missing chunk ${row.chunkId} at ${row.off}`);
          covered = this.copyManifestRow(ref.path, out, start, end, row, data, covered);
        }
      }
    }
    if (covered < end) throw vfsError('EIO', `${ref.path}: manifest ends at ${covered}, file at ${end}`);
    return out;
  }

  private copyManifestRow(
    path: string,
    out: Uint8Array,
    start: number,
    end: number,
    row: ManifestRow,
    data: Uint8Array,
    covered: number,
  ): number {
    if (data.byteLength !== row.len || row.off > covered) {
      throw vfsError('EIO', `${path}: manifest row at ${row.off} does not continue ${covered}`);
    }
    const from = Math.max(start, row.off);
    const to = Math.min(end, row.off + row.len);
    if (to > from) out.set(data.subarray(from - row.off, to - row.off), from - start);
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
  private manifestRange(contentId: number, size: number, start: number, end: number): ManifestRow[] {
    if (size <= MANIFEST_KEPT_BYTES) {
      let rows = this.manifestWindows.get(contentId);
      if (rows === undefined) {
        this._sqlReads++;
        rows = [];
        for (const row of this.sql.exec(
          'SELECT off, len, chunk_id FROM vfs_content_chunks WHERE content_id = ? ORDER BY off',
          contentId,
        )) rows.push({ off: Number(row.off), len: Number(row.len), chunkId: Number(row.chunk_id) });
        if (this.manifestWindows.size >= MANIFEST_WINDOWS) {
          this.manifestWindows.delete(this.manifestWindows.keys().next().value!);
        }
        this.manifestWindows.set(contentId, rows);
      } else {
        this.manifestWindows.delete(contentId);
        this.manifestWindows.set(contentId, rows);
      }
      // Binary search for the row holding `start`.
      let lo = 0;
      let hi = rows.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (rows[mid]!.off <= start) lo = mid;
        else hi = mid - 1;
      }
      let last = lo;
      while (last < rows.length && rows[last]!.off < end) last++;
      return rows.slice(lo, last);
    }
    this._sqlReads++;
    const first = [...this.sql.exec(
      'SELECT off, len, chunk_id FROM vfs_content_chunks WHERE content_id = ? AND off <= ? ORDER BY off DESC LIMIT 1',
      contentId,
      start,
    )][0];
    const out: ManifestRow[] = [];
    let next = start;
    if (first !== undefined) {
      const row = { off: Number(first.off), len: Number(first.len), chunkId: Number(first.chunk_id) };
      out.push(row);
      next = row.off + row.len;
    }
    if (next >= end) return out;
    for (const row of this.sql.exec(
      'SELECT off, len, chunk_id FROM vfs_content_chunks WHERE content_id = ? AND off >= ? AND off < ? ORDER BY off',
      contentId,
      next,
      end,
    )) out.push({ off: Number(row.off), len: Number(row.len), chunkId: Number(row.chunk_id) });
    return out;
  }

  /** One chunk's bytes, through the LRU when `cached`. */
  private readChunk(chunkId: number, cached: boolean, path: string): Uint8Array {
    if (cached) {
      const hit = this.cacheGet(chunkId);
      if (hit) return hit;
    }
    this._sqlReads++;
    const row = [...this.sql.exec('SELECT data, state FROM vfs_chunks WHERE id = ?', chunkId)][0];
    if (!row) throw vfsError('EIO', `${path}: missing chunk ${chunkId}`);
    if (Number(row.state) !== CHUNK_LOCAL) throw unreadableChunkError(Number(row.state), path);
    const data = this.blobToUint8Array(row.data);
    if (cached) this.cacheSet(chunkId, data);
    return data;
  }

  /**
   * The content key of an inode's bytes: sha256 of them up to CHUNK_SIZE,
   * else the digest of the manifest's ordered chunk hashes. An in-place edit
   * clears a manifest's digest; it is recomputed here and stored unless
   * another content already holds it.
   */
  private contentKeyOf(ref: ContentRef & { size: number; path: string }): string {
    if (ref.chunkId !== null) {
      const row = [...this.sql.exec('SELECT hash FROM vfs_chunks WHERE id = ?', ref.chunkId)][0];
      if (!row) throw vfsError('EIO', `${ref.path}: missing chunk ${ref.chunkId}`);
      return hex(this.blobToUint8Array(row.hash));
    }
    if (ref.contentId === null) return hex(EMPTY_CONTENT_KEY);
    const content = [...this.sql.exec('SELECT digest FROM vfs_contents WHERE id = ?', ref.contentId)][0];
    if (!content) throw vfsError('EIO', `${ref.path}: missing content ${ref.contentId}`);
    if (content.digest !== null && content.digest !== undefined) return hex(this.blobToUint8Array(content.digest));
    const memo = this.contentKeyMemo.get(ref.contentId);
    if (memo !== undefined) return memo;
    const digest = this.manifestDigest(ref.contentId);
    const key = digest.digest(ref.size);
    const taken = [...this.sql.exec('SELECT 1 FROM vfs_contents WHERE digest = ?', key)].length > 0;
    if (taken) this.contentKeyMemo.set(ref.contentId, hex(key));
    else this.transactionSync(() => { this.sql.exec('UPDATE vfs_contents SET digest = ? WHERE id = ?', key, ref.contentId); });
    return hex(key);
  }

  private manifestDigest(content: number): ManifestDigest {
    const digest = new ManifestDigest();
    for (let after = -1; ;) {
      const rows = [...this.sql.exec(
        `SELECT cc.off, c.hash FROM vfs_content_chunks cc JOIN vfs_chunks c ON c.id = cc.chunk_id
         WHERE cc.content_id = ? AND cc.off > ? ORDER BY cc.off LIMIT ?`, content, after, EXPORT_PAGE_PIECES,
      )];
      for (const row of rows) digest.add(this.blobToUint8Array(row.hash));
      if (rows.length < EXPORT_PAGE_PIECES) return digest;
      after = Number(rows[rows.length - 1]!.off);
    }
  }

  /** contentKeyOf from a list row's joined chunk hash or digest, so a page costs no lookup per file. */
  private listedContentKey(inode: INode, row: SqlRow): string {
    if (inode.chunkId !== null && row.chunk_hash !== null && row.chunk_hash !== undefined) {
      return hex(this.blobToUint8Array(row.chunk_hash));
    }
    if (inode.contentId !== null && row.content_digest !== null && row.content_digest !== undefined) {
      return hex(this.blobToUint8Array(row.content_digest));
    }
    return this.contentKeyOf(inode);
  }

  private contentKey(path: string, cred: VfsCred): string {
    const resolved = this.checkAccess(path, 0o4, cred);
    const inode = resolved.inode;
    if (!inode) throw vfsError('ENOENT', path);
    if (inode.kind === 'directory') throw vfsError('EISDIR', resolved.path);
    return this.contentKeyOf(inode);
  }

  /**
   * Overwrite `bytes` at `offset`. Only the chunks around the range are
   * re-cut and rewritten (rewriteFile); writing past EOF zero-fills the gap.
   * Creates the file when missing; callers own parent-dir creation (same
   * contract as writeFile).
   */
  private writeRange(
    path: string,
    offset: number,
    bytes: Uint8Array,
    cred: VfsCred,
    onCommit?: () => void,
  ): void {
    this.assertMutationsAllowed([path]);
    const resolved = this.checkAccess(path, 0, cred, { allowMissingLeaf: true });
    const effectivePath = resolved.path;
    const prior = resolved.inode;
    if (prior?.kind === 'directory') throw vfsError('EISDIR', effectivePath);
    if (prior && prior.kind !== 'file') throw vfsError('EINVAL', `${effectivePath} is not a regular file`);
    if (prior && !this.accessInode(prior, 0o2, cred)) throw vfsError('EACCES', effectivePath);
    if (!prior) this.checkParentAccess(effectivePath, cred);
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
      if (onCommit) this.transactionSync(onCommit);
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
  private appendOnce(
    path: string,
    pid: number,
    writerId: string,
    moduleId: string,
    operationId: number,
    digest: string,
    bytes: Uint8Array,
    cred: VfsCred,
  ): number {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw vfsError('EINVAL', `invalid append pid ${pid}`);
    assertAppendIncarnation(writerId, 'writer');
    assertAppendIncarnation(moduleId, 'module');
    if (!Number.isSafeInteger(operationId) || operationId <= 0) {
      throw vfsError('EINVAL', `invalid append operation ${operationId}`);
    }
    const normalized = normalizeVfsPath(path);
    const pidRevoked = [...this.sql.exec(
      'SELECT 1 AS revoked FROM vfs_append_pid_revocations_v2 WHERE namespace = ? AND pid = ?',
      this.namespace,
      pid,
    )].length > 0;
    if (pidRevoked) throw vfsError('ESTALE', `append process ${pid} is being retired`);
    const writer = [...this.sql.exec(
      `SELECT revoked FROM vfs_append_writer_state_v2
       WHERE namespace = ? AND pid = ? AND writer_id = ?`,
      this.namespace,
      pid,
      writerId,
    )][0] as { revoked: number } | undefined;
    if (!writer || Number(writer.revoked) !== 0) {
      throw vfsError('ESTALE', `append writer ${pid}/${writerId} is unavailable`);
    }

    let moduleState = [...this.sql.exec(
      `SELECT acked_through FROM vfs_append_module_state_v2
       WHERE namespace = ? AND pid = ? AND writer_id = ? AND module_id = ?`,
      this.namespace,
      pid,
      writerId,
      moduleId,
    )][0] as { acked_through: number } | undefined;
    const ackedThrough = Number(moduleState?.acked_through ?? 0);
    if (operationId <= ackedThrough) return bytes.byteLength;

    const acknowledgedGap = [...this.sql.exec(
      `SELECT path, byte_length, digest
       FROM vfs_append_acked_gaps_v2
       WHERE namespace = ? AND pid = ? AND writer_id = ? AND module_id = ? AND operation_id = ?`,
      this.namespace,
      pid,
      writerId,
      moduleId,
      operationId,
    )][0] as { path: string; byte_length: number; digest: string } | undefined;
    if (acknowledgedGap) {
      if (
        acknowledgedGap.path !== normalized
        || Number(acknowledgedGap.byte_length) !== bytes.byteLength
        || acknowledgedGap.digest !== digest
      ) {
        throw vfsError('EINVAL', `append acknowledgement collision for ${pid}/${operationId}`);
      }
      return bytes.byteLength;
    }

    const existing = [...this.sql.exec(
      `SELECT path, byte_length, digest
       FROM vfs_append_receipts_v2
       WHERE namespace = ? AND pid = ? AND writer_id = ? AND module_id = ? AND operation_id = ?`,
      this.namespace,
      pid,
      writerId,
      moduleId,
      operationId,
    )][0] as { path: string; byte_length: number; digest: string } | undefined;
    if (existing) {
      if (
        existing.path !== normalized
        || Number(existing.byte_length) !== bytes.byteLength
        || existing.digest !== digest
      ) {
        throw vfsError('EINVAL', `append receipt collision for ${pid}/${writerId}/${operationId}`);
      }
      return bytes.byteLength;
    }

    const highestKnown = Number(
      ([...this.sql.exec(
        `SELECT MAX(operation_id) AS operation_id
         FROM (
           SELECT operation_id FROM vfs_append_receipts_v2
             WHERE namespace = ? AND pid = ? AND writer_id = ? AND module_id = ?
           UNION ALL
           SELECT operation_id FROM vfs_append_acked_gaps_v2
             WHERE namespace = ? AND pid = ? AND writer_id = ? AND module_id = ?
         )`,
        this.namespace,
        pid,
        writerId,
        moduleId,
        this.namespace,
        pid,
        writerId,
        moduleId,
      )][0] as { operation_id?: number | null } | undefined)?.operation_id
        ?? ackedThrough,
    );
    if (operationId > Math.max(ackedThrough, highestKnown) + VFS_APPEND_RECEIPT_LIMIT) {
      throw vfsError('EINVAL', `append operation gap exceeds ${VFS_APPEND_RECEIPT_LIMIT}`);
    }

    this.assertMutationsAllowed([normalized]);
    const resolved = this.checkAccess(normalized, 0, cred, { allowMissingLeaf: true });
    const effectivePath = resolved.path;
    const inode = resolved.inode;
    if (inode?.kind === 'directory') throw vfsError('EISDIR', effectivePath);
    if (inode && inode.kind !== 'file') {
      throw vfsError('EINVAL', `${effectivePath} is not a regular file`);
    }
    if (inode && !this.accessInode(inode, 0o2, cred)) throw vfsError('EACCES', effectivePath);
    if (!inode) this.checkParentAccess(effectivePath, cred);
    const offset = inode?.size ?? 0;

    const retainedCount = Number(
      ([...this.sql.exec(
        `SELECT
           (SELECT COUNT(*) FROM vfs_append_writer_state_v2 WHERE namespace = ? AND revoked = 0)
           + (SELECT COUNT(*) FROM vfs_append_module_state_v2 WHERE namespace = ?)
           + (SELECT COUNT(*) FROM vfs_append_receipts_v2 WHERE namespace = ?)
           + (SELECT COUNT(*) FROM vfs_append_acked_gaps_v2 WHERE namespace = ?) AS count`,
        this.namespace,
        this.namespace,
        this.namespace,
        this.namespace,
      )][0] as { count?: number } | undefined)?.count ?? 0,
    );
    const requiredRows = 1 + (moduleState ? 0 : 1);
    if (retainedCount > VFS_APPEND_RECEIPT_LIMIT - requiredRows) {
      throw vfsError('ENOSPC', 'append receipt journal is full');
    }
    if (!moduleState) {
      this.sql.exec(
        `INSERT INTO vfs_append_module_state_v2
         (namespace, pid, writer_id, module_id, acked_through) VALUES (?, ?, ?, ?, 0)`,
        this.namespace,
        pid,
        writerId,
        moduleId,
      );
      moduleState = { acked_through: 0 };
    }

    const recordReceipt = (): void => {
      this.sql.exec(
        `INSERT INTO vfs_append_receipts_v2
         (namespace, pid, writer_id, module_id, operation_id, path, byte_length, digest, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        this.namespace,
        pid,
        writerId,
        moduleId,
        operationId,
        normalized,
        bytes.byteLength,
        digest,
        Date.now(),
      );
    };
    this.writeRange(effectivePath, offset, bytes, cred, recordReceipt);
    return bytes.byteLength;
  }

  activateAppendWriter(pid: number, writerId: string): void {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw vfsError('EINVAL', `invalid append pid ${pid}`);
    assertAppendIncarnation(writerId, 'writer');
    if ([...this.sql.exec(
      'SELECT 1 AS revoked FROM vfs_append_pid_revocations_v2 WHERE namespace = ? AND pid = ?',
      this.namespace,
      pid,
    )].length > 0) {
      throw vfsError('ESTALE', `append process ${pid} is being retired`);
    }
    const writers = [...this.sql.exec(
      `SELECT writer_id, revoked FROM vfs_append_writer_state_v2
       WHERE namespace = ? AND pid = ?`,
      this.namespace,
      pid,
    )] as { writer_id: string; revoked: number }[];
    const writer = writers.find((candidate) => candidate.writer_id === writerId);
    if (writer && Number(writer.revoked) === 0) {
      return;
    }
    if (writers.length > 0) {
      throw vfsError('ESTALE', `append process ${pid} already has a different writer`);
    }
    const retainedCount = Number(
      ([...this.sql.exec(
        `SELECT
           (SELECT COUNT(*) FROM vfs_append_writer_state_v2 WHERE namespace = ? AND revoked = 0)
           + (SELECT COUNT(*) FROM vfs_append_module_state_v2 WHERE namespace = ?)
           + (SELECT COUNT(*) FROM vfs_append_receipts_v2 WHERE namespace = ?)
           + (SELECT COUNT(*) FROM vfs_append_acked_gaps_v2 WHERE namespace = ?) AS count`,
        this.namespace,
        this.namespace,
        this.namespace,
        this.namespace,
      )][0] as { count?: number } | undefined)?.count ?? 0,
    );
    if (retainedCount >= VFS_APPEND_RECEIPT_LIMIT) {
      throw vfsError('ENOSPC', 'append receipt journal is full');
    }
    this.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO vfs_append_writer_state_v2
         (namespace, pid, writer_id, revoked, retired_at) VALUES (?, ?, ?, 0, NULL)`,
        this.namespace,
        pid,
        writerId,
      );
    });
  }

  private acknowledgeAppend(
    pid: number,
    writerId: string,
    moduleId: string,
    operationId: number,
  ): void {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw vfsError('EINVAL', `invalid append pid ${pid}`);
    assertAppendIncarnation(writerId, 'writer');
    assertAppendIncarnation(moduleId, 'module');
    if (!Number.isSafeInteger(operationId) || operationId <= 0) {
      throw vfsError('EINVAL', `invalid append operation ${operationId}`);
    }
    const writer = [...this.sql.exec(
      `SELECT revoked FROM vfs_append_writer_state_v2
       WHERE namespace = ? AND pid = ? AND writer_id = ?`,
      this.namespace,
      pid,
      writerId,
    )][0] as { revoked: number } | undefined;
    if (!writer || Number(writer.revoked) !== 0) {
      throw vfsError('ESTALE', `append writer ${pid} is unavailable`);
    }
    const moduleState = [...this.sql.exec(
      `SELECT acked_through FROM vfs_append_module_state_v2
       WHERE namespace = ? AND pid = ? AND writer_id = ? AND module_id = ?`,
      this.namespace,
      pid,
      writerId,
      moduleId,
    )][0] as { acked_through: number } | undefined;
    if (!moduleState) {
      throw vfsError('ESTALE', `append module ${pid}/${writerId}/${moduleId} is unavailable`);
    }
    let ackedThrough = Number(moduleState.acked_through);
    if (operationId <= ackedThrough) return;
    const existingGap = [...this.sql.exec(
      `SELECT 1 AS present FROM vfs_append_acked_gaps_v2
       WHERE namespace = ? AND pid = ? AND writer_id = ? AND module_id = ? AND operation_id = ?`,
      this.namespace,
      pid,
      writerId,
      moduleId,
      operationId,
    )].length > 0;
    let receipt: { path: string; byte_length: number; digest: string } | undefined;
    if (!existingGap) {
      receipt = [...this.sql.exec(
        `SELECT path, byte_length, digest
         FROM vfs_append_receipts_v2
         WHERE namespace = ? AND pid = ? AND writer_id = ? AND module_id = ? AND operation_id = ?`,
        this.namespace,
        pid,
        writerId,
        moduleId,
        operationId,
      )][0] as { path: string; byte_length: number; digest: string } | undefined;
      if (!receipt) {
        throw vfsError('EINVAL', `append operation ${pid}/${operationId} has not completed`);
      }
    }

    const acknowledged = [...this.sql.exec(
      `SELECT operation_id FROM vfs_append_acked_gaps_v2
       WHERE namespace = ? AND pid = ? AND writer_id = ? AND module_id = ? AND operation_id > ?
       ORDER BY operation_id`,
      this.namespace,
      pid,
      writerId,
      moduleId,
      ackedThrough,
    )] as { operation_id: number }[];
    if (!existingGap) acknowledged.push({ operation_id: operationId });
    acknowledged.sort((left, right) => Number(left.operation_id) - Number(right.operation_id));
    for (const row of acknowledged) {
      const sequence = Number(row.operation_id);
      if (sequence <= ackedThrough) continue;
      if (sequence !== ackedThrough + 1) break;
      ackedThrough = sequence;
    }

    const priorAckedThrough = Number(moduleState.acked_through);
    if (!existingGap || ackedThrough > priorAckedThrough) {
      this.transactionSync(() => {
        if (!existingGap) {
          if (!receipt) {
            throw vfsError('EINVAL', `append operation ${pid}/${operationId} has not completed`);
          }
          this.sql.exec(
            `INSERT INTO vfs_append_acked_gaps_v2
             (namespace, pid, writer_id, module_id, operation_id, path, byte_length, digest)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            this.namespace,
            pid,
            writerId,
            moduleId,
            operationId,
            receipt.path,
            receipt.byte_length,
            receipt.digest,
          );
          this.sql.exec(
            `DELETE FROM vfs_append_receipts_v2
             WHERE namespace = ? AND pid = ? AND writer_id = ? AND module_id = ? AND operation_id = ?`,
            this.namespace,
            pid,
            writerId,
            moduleId,
            operationId,
          );
        }
        if (ackedThrough > priorAckedThrough) {
          this.sql.exec(
            `UPDATE vfs_append_module_state_v2 SET acked_through = ?
             WHERE namespace = ? AND pid = ? AND writer_id = ? AND module_id = ?`,
            ackedThrough,
            this.namespace,
            pid,
            writerId,
            moduleId,
          );
        }
      });
    }
    if (ackedThrough > priorAckedThrough) {
      this.deleteAppendRowsBounded(
        'vfs_append_acked_gaps_v2',
        'namespace = ? AND pid = ? AND writer_id = ? AND module_id = ? AND operation_id <= ?',
        [this.namespace, pid, writerId, moduleId, ackedThrough],
      );
    }
  }

  revokeAppendWriter(pid: number, writerId: string): void {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw vfsError('EINVAL', `invalid append pid ${pid}`);
    assertAppendIncarnation(writerId, 'writer');
    this.transactionSync(() => {
      this.sql.exec(
        `UPDATE vfs_append_writer_state_v2
         SET revoked = 1, retired_at = ?
         WHERE namespace = ? AND pid = ? AND writer_id = ?`,
        Date.now(),
        this.namespace,
        pid,
        writerId,
      );
    });
    this.deleteAppendRowsBounded(
      'vfs_append_receipts_v2',
      'namespace = ? AND pid = ? AND writer_id = ?',
      [this.namespace, pid, writerId],
    );
    this.deleteAppendRowsBounded(
      'vfs_append_acked_gaps_v2',
      'namespace = ? AND pid = ? AND writer_id = ?',
      [this.namespace, pid, writerId],
    );
    this.deleteAppendRowsBounded(
      'vfs_append_module_state_v2',
      'namespace = ? AND pid = ? AND writer_id = ?',
      [this.namespace, pid, writerId],
    );
    this.deleteAppendRowsBounded(
      'vfs_append_writer_state_v2',
      'namespace = ? AND pid = ? AND writer_id = ? AND revoked = 1',
      [this.namespace, pid, writerId],
    );
  }

  revokeAppendWriters(pid: number): void {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw vfsError('EINVAL', `invalid append pid ${pid}`);
    this.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO vfs_append_pid_revocations_v2 (namespace, pid, retired_at) VALUES (?, ?, ?)
         ON CONFLICT(namespace, pid) DO UPDATE SET retired_at = excluded.retired_at`,
        this.namespace,
        pid,
        Date.now(),
      );
    });
    this.finishAppendPidRevocation(pid);
  }

  revokeAppendWritersThrough(maxPid: number): void {
    if (!Number.isSafeInteger(maxPid) || maxPid < 0) {
      throw vfsError('EINVAL', `invalid append pid ceiling ${maxPid}`);
    }
    for (;;) {
      const pids = [...this.sql.exec(
        `SELECT DISTINCT pid FROM vfs_append_writer_state_v2
         WHERE namespace = ? AND pid <= ?
         ORDER BY pid
         LIMIT ?`,
        this.namespace,
        maxPid,
        MAX_TX_LOGICAL_ROWS,
      )] as { pid: number }[];
      if (pids.length === 0) return;
      for (const row of pids) this.revokeAppendWriters(Number(row.pid));
    }
  }

  private finishAppendPidRevocation(pid: number): void {
    for (;;) {
      const writers = [...this.sql.exec(
        `SELECT writer_id FROM vfs_append_writer_state_v2
         WHERE namespace = ? AND pid = ? AND revoked = 0
         ORDER BY rowid
         LIMIT ?`,
        this.namespace,
        pid,
        Math.min(MAX_TX_LOGICAL_ROWS, SQL_MAX_BOUND_PARAMETERS - 3),
      )] as { writer_id: string }[];
      if (writers.length === 0) break;
      const placeholders = writers.map(() => '?').join(',');
      this.transactionSync(() => {
        this.sql.exec(
          `UPDATE vfs_append_writer_state_v2
           SET revoked = 1, retired_at = ?
           WHERE namespace = ? AND pid = ? AND writer_id IN (${placeholders})`,
          Date.now(),
          this.namespace,
          pid,
          ...writers.map((writer) => writer.writer_id),
        );
      });
    }
    this.deleteAppendRowsBounded('vfs_append_receipts_v2', 'namespace = ? AND pid = ?', [this.namespace, pid]);
    this.deleteAppendRowsBounded('vfs_append_acked_gaps_v2', 'namespace = ? AND pid = ?', [this.namespace, pid]);
    this.deleteAppendRowsBounded('vfs_append_module_state_v2', 'namespace = ? AND pid = ?', [this.namespace, pid]);
    this.deleteAppendRowsBounded(
      'vfs_append_writer_state_v2',
      'namespace = ? AND pid = ? AND revoked = 1',
      [this.namespace, pid],
    );
    this.transactionSync(() => {
      this.sql.exec(
        'DELETE FROM vfs_append_pid_revocations_v2 WHERE namespace = ? AND pid = ?',
        this.namespace,
        pid,
      );
    });
  }

  private deleteAppendRowsBounded(
    table:
      | 'vfs_append_receipts_v2'
      | 'vfs_append_acked_gaps_v2'
      | 'vfs_append_module_state_v2'
      | 'vfs_append_writer_state_v2',
    predicate: string,
    params: readonly unknown[],
  ): void {
    for (;;) {
      const rows = [...this.sql.exec(
        `SELECT rowid FROM ${table} WHERE ${predicate} ORDER BY rowid LIMIT ?`,
        ...params,
        Math.min(MAX_TX_LOGICAL_ROWS, SQL_MAX_BOUND_PARAMETERS),
      )] as { rowid: number }[];
      if (rows.length === 0) return;
      const placeholders = rows.map(() => '?').join(',');
      this.transactionSync(() => {
        this.sql.exec(
          `DELETE FROM ${table} WHERE rowid IN (${placeholders})`,
          ...rows.map((row) => row.rowid),
        );
      });
    }
  }

  private resumeAppendMaintenance(): void {
    for (;;) {
      const revocations = [...this.sql.exec(
        `SELECT pid FROM vfs_append_pid_revocations_v2
         WHERE namespace = ?
         ORDER BY pid
         LIMIT ?`,
        this.namespace,
        MAX_TX_LOGICAL_ROWS,
      )] as { pid: number }[];
      if (revocations.length === 0) break;
      for (const row of revocations) {
        this.finishAppendPidRevocation(Number(row.pid));
      }
    }
    for (const table of [
      'vfs_append_receipts_v2',
      'vfs_append_acked_gaps_v2',
      'vfs_append_module_state_v2',
    ] as const) {
      this.deleteAppendRowsBounded(
        table,
        `namespace = ? AND EXISTS (
          SELECT 1 FROM vfs_append_writer_state_v2 AS writer
          WHERE writer.namespace = ${table}.namespace
            AND writer.pid = ${table}.pid
            AND writer.writer_id = ${table}.writer_id
            AND writer.revoked = 1
        )`,
        [this.namespace],
      );
    }
    this.deleteAppendRowsBounded(
      'vfs_append_writer_state_v2',
      'namespace = ? AND revoked = 1',
      [this.namespace],
    );
    this.deleteAppendRowsBounded(
      'vfs_append_acked_gaps_v2',
      `namespace = ? AND EXISTS (
        SELECT 1 FROM vfs_append_module_state_v2 AS module
        WHERE module.namespace = vfs_append_acked_gaps_v2.namespace
          AND module.pid = vfs_append_acked_gaps_v2.pid
          AND module.writer_id = vfs_append_acked_gaps_v2.writer_id
          AND module.module_id = vfs_append_acked_gaps_v2.module_id
          AND module.acked_through >= vfs_append_acked_gaps_v2.operation_id
      )`,
      [this.namespace],
    );
  }

  /**
   * Truncate or zero-extend to `size`. Only the chunk at the new end is
   * re-cut; rows past it go. Every mutation commits before return.
   */
  private truncate(path: string, size: number, cred: VfsCred): void {
    this.assertMutationsAllowed([path]);
    const resolved = this.checkAccess(path, 0o2, cred);
    const inode = resolved.inode;
    if (!inode) throw vfsError('ENOENT', path);
    if (inode.kind === 'directory') throw vfsError('EISDIR', resolved.path);
    if (inode.kind !== 'file') throw vfsError('EINVAL', `${resolved.path} is not a regular file`);
    const newSize = clampNonNegativeInt(size);
    if (newSize === inode.size) return;
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
  private rewriteFile(
    node: INode,
    path: string | null,
    newSize: number,
    change: { start: number; bytes: Uint8Array } | null,
    onCommit?: () => void,
  ): void {
    const oldSize = node.size;
    const changeStart = change === null ? Math.min(oldSize, newSize) : Math.min(change.start, oldSize);
    const changeEnd = change === null ? newSize : change.start + change.bytes.length;
    // The new file's bytes [from, to): old bytes, the change over them, zeros past the old end.
    const segment = (from: number, to: number): Uint8Array => {
      const out = new Uint8Array(to - from);
      const oldTo = Math.min(to, oldSize);
      if (from < oldTo) out.set(this.readContent(node, from, oldTo, true), 0);
      if (change !== null) {
        const s = Math.max(from, change.start);
        const e = Math.min(to, change.start + change.bytes.length);
        if (e > s) out.set(change.bytes.subarray(s - change.start, e - change.start), s - from);
      }
      return out;
    };
    const piece = (data: Uint8Array): Piece => ({ data, hash: chunkHash(data) });

    if (newSize <= CHUNK_SIZE) {
      let content: InodeContent;
      if (newSize === 0) content = { type: 'none' };
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
      const row = [...this.sql.exec(
        'SELECT MAX(off) AS off FROM vfs_content_chunks WHERE content_id = ? AND off <= ?',
        node.contentId,
        at,
      )][0];
      from = Number(row?.off ?? 0);
    }
    const boundaries = node.contentId === null ? null : this.manifestOffsets(node.contentId, from);
    const held: { off: number; piece: Piece }[] = [];
    let heldBytes = 0;
    let staging: StagingContent | null = null;
    let builder: TransactionPlanBuilder | null = null;
    const stagedPath = path ?? node.path;
    const flush = (): void => {
      if (builder === null || builder.empty) return;
      const plan = builder.build();
      builder = this.newPlan();
      this.assertTransactionFits(plan.metrics);
      this.executeTransactionPlan(plan, { source: 'content-stage', limitMode: 'bounded' });
    };
    const stage = (next: Piece): void => {
      builder ??= this.newPlan();
      if (builder.wouldExceedPieces(next.data.byteLength, 1) !== null) flush();
      builder!.addStagedPiece(staging!, next, stagedPath);
    };
    const startStaging = (): void => {
      staging = this.beginStaging();
      if (node.contentId !== null && from > 0) this.stageManifestCopy(staging, node.contentId, 0, from);
      staging.size = from;
      for (const entry of held) stage(entry.piece);
      held.length = 0;
    };
    let offset = from;
    let to = -1;
    const cutter = new ContentCutter();
    const take = (data: Uint8Array): boolean => {
      const next = piece(data);
      if (staging === null) {
        held.push({ off: offset, piece: next });
        heldBytes += data.byteLength;
        if (heldBytes > MAX_TX_BLOB_BYTES / 2) startStaging();
      } else stage(next);
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
        for (const data of cutter.push(segment(pos, end))) if (take(data)) break scan;
        pos = end;
      }
      if (to < 0) {
        for (const data of cutter.finish()) take(data);
        to = oldSize;
      }

      if (staging === null) {
        const unshared = path !== null && node.contentId !== null && this.contentUnshared(node, path);
        let content: InodeContent | null = null;
        if (unshared) {
          content = { type: 'edit', contentId: node.contentId!, from, to, pieces: held };
        } else if (from === 0 && to >= oldSize) {
          const digest = new ManifestDigest();
          for (const entry of held) digest.add(entry.piece.hash);
          content = { type: 'large', pieces: held.map((entry) => entry.piece), size: newSize, digest: digest.digest(newSize) };
        }
        if (content !== null && this.tryPublishRewrite(node, path, newSize, content, onCommit)) return;
        startStaging();
      }
      const target = staging!;
      if (node.contentId !== null && to < oldSize) {
        flush();
        target.size = to;
        this.stageManifestCopy(target, node.contentId, to, oldSize);
      }
      flush();
      this.publishRewrite(node, path, newSize, { type: 'staged', content: target }, onCommit);
    } catch (error) {
      const failed = staging as StagingContent | null;
      if (failed !== null && failed.id !== 0) this.abandonStaging(failed);
      throw error;
    }
  }

  /** Publish a rewrite in one transaction when it fits; false when it does not. */
  private tryPublishRewrite(
    node: INode,
    path: string | null,
    newSize: number,
    content: InodeContent,
    onCommit?: () => void,
  ): boolean {
    const builder = this.newPlan();
    builder.addInode(this.rewrittenEntry(node, path, newSize, content));
    const plan = builder.build();
    if (exceededTransactionLimit(onCommit ? withCommitRowMetrics(plan.metrics) : plan.metrics) !== null) return false;
    this.commitRewrite(node, path, plan, onCommit);
    return true;
  }

  private publishRewrite(
    node: INode,
    path: string | null,
    newSize: number,
    content: InodeContent,
    onCommit?: () => void,
  ): void {
    const builder = this.newPlan();
    builder.addInode(this.rewrittenEntry(node, path, newSize, content));
    const plan = builder.build();
    this.assertTransactionFits(onCommit ? withCommitRowMetrics(plan.metrics) : plan.metrics);
    this.commitRewrite(node, path, plan, onCommit);
  }

  private rewrittenEntry(node: INode, path: string | null, newSize: number, content: InodeContent): StoredInodeEntry {
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

  private commitRewrite(node: INode, path: string | null, plan: TransactionPlan, onCommit?: () => void): void {
    if (path !== null) {
      this._writeBatchOnce({ plan, deletedInodes: [] }, { source: 'range-mutation', limitMode: 'bounded' }, onCommit);
      this.runContentMaintenanceSafely(1);
      return;
    }
    this.executeTransactionPlan(plan, { source: 'range-mutation', limitMode: 'bounded' }, onCommit, [node]);
    const entry = plan.inodes[0]!;
    node.size = entry.size;
    node.chunkId = entry.chunkId ?? null;
    node.contentId = entry.contentId ?? null;
    node.mtime = entry.mtime;
    node.ctime = entry.ctime!;
    this.runContentMaintenanceSafely(1);
  }

  /** The start offsets of a manifest's rows after `after`, read a page at a time on demand. */
  private manifestOffsets(contentId: number, after: number): { has(offset: number): boolean } {
    let loaded = after;
    let done = false;
    const offsets = new Set<number>();
    return {
      has: (offset: number): boolean => {
        while (!done && loaded < offset) {
          const rows = [...this.sql.exec(
            'SELECT off FROM vfs_content_chunks WHERE content_id = ? AND off > ? ORDER BY off LIMIT ?',
            contentId,
            loaded,
            MANIFEST_PAGE_ROWS,
          )];
          for (const row of rows) offsets.add(Number(row.off));
          if (rows.length < MANIFEST_PAGE_ROWS) done = true;
          if (rows.length > 0) loaded = Number(rows[rows.length - 1]!.off);
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
  private chunkUnshared(node: INode, path: string): boolean {
    const chunkId = node.chunkId!;
    if (node.gen <= this._pinGen) return false;
    for (const opened of this.openNodes) {
      if (opened.inode.chunkId === chunkId && opened.path !== path) return false;
    }
    return [...this.sql.exec(
      `SELECT 1 FROM vfs_inodes WHERE chunk_id = ? AND path != ?
       UNION ALL SELECT 1 FROM vfs_content_chunks WHERE chunk_id = ?
       UNION ALL SELECT 1 FROM vfs_inode_history WHERE chunk_id = ?
       LIMIT 1`,
      chunkId,
      path,
      chunkId,
      chunkId,
    )].length === 0;
  }

  /** The manifest counterpart of chunkUnshared: the CoW guard for large files. */
  private contentUnshared(node: INode, path: string): boolean {
    const contentId = node.contentId!;
    if (node.gen <= this._pinGen) return false;
    for (const opened of this.openNodes) {
      if (opened.inode.contentId === contentId && opened.path !== path) return false;
    }
    return [...this.sql.exec(
      `SELECT 1 FROM vfs_inodes WHERE content_id = ? AND path != ?
       UNION ALL SELECT 1 FROM vfs_inode_history WHERE content_id = ?
       LIMIT 1`,
      contentId,
      path,
      contentId,
    )].length === 0;
  }

  private newPlan(commitRow = false): TransactionPlanBuilder {
    return new TransactionPlanBuilder(this._pinGen > 0, commitRow);
  }

  /** Create a state-0 content in its own transaction and hold it live. */
  private beginStaging(): StagingContent {
    const staging: StagingContent = { id: 0, size: 0, count: 0, hashed: true, digest: new ManifestDigest() };
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
  private stageManifestCopy(staging: StagingContent, source: number, lo: number, hi: number): void {
    staging.hashed = false;
    let cursor = lo;
    while (cursor < hi) {
      const page = [...this.sql.exec(
        `SELECT off, len FROM vfs_content_chunks WHERE content_id = ? AND off >= ? AND off < ? ORDER BY off LIMIT ?`,
        source,
        cursor,
        hi,
        MANIFEST_PAGE_ROWS,
      )];
      if (page.length === 0) break;
      const last = page[page.length - 1]!;
      const next = Number(last.off) + Number(last.len);
      this.executeMeasuredTransaction(
        this.metricsOnlyPlan({ blobBytes: 0, logicalRows: page.length, sqlExecs: 1, affectedPaths: 0 }),
        { source: 'content-stage', limitMode: 'bounded' },
        () => {
          this.sql.exec(
            `INSERT INTO vfs_content_chunks (content_id, off, len, chunk_id)
             SELECT ?, off, len, chunk_id FROM vfs_content_chunks WHERE content_id = ? AND off >= ? AND off < ?`,
            staging.id,
            source,
            cursor,
            next,
          );
        },
      );
      staging.count += page.length;
      cursor = next;
    }
    staging.size = hi;
  }

  /** A staging content that will never publish: queue it now. */
  private abandonStaging(staging: StagingContent): void {
    this.activeStagingContentIds.delete(staging.id);
    try {
      this.transactionSync(() => {
        this.sql.exec('INSERT OR IGNORE INTO vfs_gc_queue (kind, id) VALUES (?, ?)', GC_CONTENT, staging.id);
      });
    } catch { /* the open-time sweep queues every state-0 content */ }
    this.maintenancePending = true;
  }

  private readFileString(path: string, cred: VfsCred): string {
    return dec.decode(this.readFile(path, cred));
  }

  private stat(path: string, cred: VfsCred, followLeaf: boolean): VfsStat {
    const resolved = this.checkAccess(path, 0, cred, { followLeaf });
    const inode = resolved.inode;
    if (!inode) throw vfsError('ENOENT', path);
    return this.statOf(inode);
  }

  /** A linked inode's stat, for `stat` and for the entries `list` reports. */
  private statOf(inode: INode): VfsStat {
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
  private publishMetadata(
    inode: INode,
    fields: { atime?: number; mtime?: number; mode?: number; uid?: number; gid?: number; defaultAcl?: number | null },
  ): void {
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
      defaultAcl: fields.defaultAcl,
    });
    this._writeBatchOnce({ plan: builder.build(), deletedInodes: [] }, { source: 'range-mutation', limitMode: 'bounded' });
  }

  private utimes(
    path: string,
    atimeMs: number | null | undefined,
    mtimeMs: number | null | undefined,
    cred: VfsCred,
    followLeaf = true,
  ): void {
    const resolved = this.checkAccess(path, 0, cred, { followLeaf });
    const inode = resolved.inode;
    if (!inode) throw vfsError('ENOENT', path);
    this.assertMutationsAllowed([inode.path]);
    // Nothing explicit: only now (null) and omit (undefined).
    const useNow = typeof atimeMs !== 'number' && typeof mtimeMs !== 'number';
    if (useNow) {
      if (!this.accessInode(inode, 0o2, cred)) throw vfsError('EACCES', resolved.path);
    } else if (cred.uid !== 0 && cred.uid !== inode.uid) {
      throw vfsError('EPERM', resolved.path);
    }
    const at = (value: number | null | undefined, kept: number): number => (
      value === undefined ? kept : value !== null && Number.isFinite(value) ? Math.trunc(value) : this.now());
    const atime = at(atimeMs, inode.atime);
    const mtime = at(mtimeMs, inode.mtime);
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
  private chmod(path: string, mode: number, cred: VfsCred): void {
    const resolved = this.checkAccess(path, 0, cred);
    const inode = resolved.inode;
    if (!inode) throw vfsError('ENOENT', path);
    this.chmodInode(inode, mode, cred, resolved.path);
  }

  private chmodInode(inode: INode, mode: number, cred: VfsCred, path: string | null): void {
    if (cred.uid !== 0 && cred.uid !== inode.uid) throw vfsError('EPERM', path ?? 'detached inode');
    const shared = path === null ? undefined : this.sharedDirectory(path);
    if (shared && cred.uid !== 0 && cred.gid !== shared.gid && !cred.groups.includes(shared.gid)) throw vfsError('EPERM', path + ': shared group membership required');
    let gid = inode.gid;
    if (shared) {
      const delegated = 0o070 | (inode.isDir ? 0o2000 : 0);
      this.assertConfinedModeChange(inode, (mode & ~delegated) | (inode.mode & delegated), cred, path ?? 'detached inode');
      mode = this.sharedMode(mode, inode.isDir);
      gid = shared.gid;
    } else this.assertConfinedModeChange(inode, mode, cred, path ?? 'detached inode');
    mode = inodeTypeBits(inode.kind) | (mode & 0o7777);
    if (path === null) { inode.mode = mode; inode.ctime = this.now(); return; }
    this.assertMutationsAllowed([path]);
    this.publishMetadata(inode, { mode, gid });
  }

  private setDefaultAcl(path: string, perms: number | null, cred: VfsCred): void {
    const resolved = this.checkAccess(path, 0, cred);
    const inode = resolved.inode;
    if (!inode) throw vfsError('ENOENT', path);
    if (!inode.isDir) throw vfsError('ENOTDIR', resolved.path);
    if (cred.uid !== 0 && cred.uid !== inode.uid) throw vfsError('EPERM', resolved.path);
    if (perms !== null && (!Number.isSafeInteger(perms) || perms < 0 || perms > 0o777)) {
      throw vfsError('EINVAL', `default ACL ${String(perms)}`);
    }
    this.assertMutationsAllowed([inode.path]);
    this.publishMetadata(inode, { defaultAcl: perms });
  }

  private getDefaultAcl(path: string, cred: VfsCred): number | null {
    const inode = this.checkAccess(path, 0, cred).inode;
    if (!inode) throw vfsError('ENOENT', path);
    return inode.isDir ? inode.defaultAcl : null;
  }

  private chown(
    path: string,
    uid: number | null,
    gid: number | null,
    cred: VfsCred,
    followLeaf: boolean,
  ): void {
    const resolved = this.checkAccess(path, 0, cred, { followLeaf });
    const inode = resolved.inode;
    if (!inode) throw vfsError('ENOENT', path);
    if (uid !== null && (!Number.isSafeInteger(uid) || uid < 0)) throw vfsError('EINVAL', `invalid uid ${uid}`);
    if (gid !== null && (!Number.isSafeInteger(gid) || gid < 0)) throw vfsError('EINVAL', `invalid gid ${gid}`);
    const owner = cred.uid === inode.uid;
    if (uid !== null && uid !== inode.uid && cred.uid !== 0) throw vfsError('EPERM', resolved.path);
    if (uid !== null && uid === inode.uid && cred.uid !== 0 && !owner) throw vfsError('EPERM', resolved.path);
    if (gid !== null && gid !== inode.gid && cred.uid !== 0 && (!owner || !cred.groups.includes(gid))) {
      throw vfsError('EPERM', resolved.path);
    }
    if (gid !== null && gid === inode.gid && cred.uid !== 0 && !owner) throw vfsError('EPERM', resolved.path);
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
  private list(
    after: string | null,
    limit: number,
    cred: VfsCred,
  ): VfsListPage {
    // Before the walk, deliberately — see VfsListPage.
    const epoch = this._epoch;
    const rev = this._revision;
    const from = after === null || after === undefined ? '' : this.storageKey(after, cred);
    const entries: VfsListEntry[] = [];
    // The page is bounded by its encoded bytes, not only its row count: a full
    // page of long, escaped names or link targets can exceed the RPC frame.
    const fits = listPageBudget(epoch, rev);
    const pageEnding = (): VfsListPage => {
      const last = entries[entries.length - 1];
      return { epoch, rev, entries, next: last === undefined ? null : last.path };
    };
    let cursor = from;
    // Rows arrive in path order, so a run of entries in one directory shares
    // one check of the directories above it.
    let checkedParent: string | null = null;
    let parentReachable = false;
    for (;;) {
      const rows = this.sql.exec(
        `SELECT ${INODE_SELECT_COLUMNS_AS_I}, c.hash AS chunk_hash, ct.digest AS content_digest
         FROM vfs_inodes i
         LEFT JOIN vfs_chunks c ON c.id = i.chunk_id
         LEFT JOIN vfs_contents ct ON ct.id = i.content_id
         WHERE i.path > ? ORDER BY i.path LIMIT ?`,
        cursor,
        limit + 1,
      );
      let visited = 0;
      let lastStoragePath = cursor;
      for (const row of rows) {
        visited++;
        lastStoragePath = String(row.path);
        if (entries.length >= limit) return pageEnding();
        const path = String(row.path);
        // Reported in the caller's OWN path space. Enumerating raw storage keys
        // would name a private root the caller cannot address and does not know
        // it has, and a caller feeding such a path back would be asking about
        // someone else's tree. `null` means the path has no name for this
        // caller, which is the same OMIT the access check below performs.
        const logical = this.logicalPath(path, cred);
        if (logical === null) continue;
        // What checkAccess(path, 0, cred, { followLeaf: false }) asks of an
        // entry that exists: every directory above it, as the caller names
        // them, is traversable. A confined caller's /tmp answers for its own
        // root, never for the storage directories that happen to hold it.
        const parent = this.parentPath(logical);
        if (parent !== checkedParent) {
          checkedParent = parent;
          try {
            if (parent !== '') this.checkAccess(parent, 0o1, cred);
            parentReachable = true;
          } catch {
            parentReachable = false;
          }
        }
        if (!parentReachable) continue;
        // Read from the row rather than through the cache: one page of an
        // enumeration says nothing about which inodes will be used next.
        const inode = this.inodes.peek(path) ?? this.inodeFromRow(row);
        // The storage key's revision, the one revision() reports for the name
        // this entry is listed under: a confined caller's /tmp/x is its own
        // file, not the shared one at the same name.
        const pathRevision = this.pathRevision(path, inode);
        const entry: VfsListEntry = {
          path: logical,
          kind: inode.kind,
          size: inode.size,
          rev: pathRevision,
          stat: { ...this.statOf(inode), revision: pathRevision },
          // The row's own target. Re-resolving the listed name would follow the
          // directories above it, and a row they no longer lead to (one left
          // under a link) made the whole enumeration throw ENOENT.
          ...(inode.kind === 'symlink' ? { linkTarget: dec.decode(this.readInodeBytes(path, inode)) } : {}),
          ...(inode.kind === 'file' ? { contentKey: this.listedContentKey(inode, row) } : {}),
        };
        if (!fits(entry)) return pageEnding();
        entries.push(entry);
      }
      if (visited <= limit) return { epoch, rev, entries, next: null };
      cursor = lastStoragePath;
    }
  }

  private acquire(
    epoch: string | null,
    cursor: number,
    cred: VfsCred,
    options: VfsAcquireOptions | undefined,
  ): VfsAcquireResult {
    // The caller's own view: names it could list, a hidden change reported
    // at the nearest directory it may see (invalidatedSince).
    const delta = this.invalidatedSince(epoch, cursor, cred);
    if (!options?.namespace || delta.poison) return delta;
    const root = this.confinedTmpRoots.get(cred.uid);
    const paths: VfsInvalidatedPath[] = [];
    const roots = (options.push?.roots ?? []).map((pushRoot) => normalizeVfsPath(pushRoot));
    const exclude = new Set(options.push?.exclude ?? []);
    // One answer carries at most what one batch read may: a bound on the
    // message, not on the data — an omitted file is fetched by range.
    let pushBudget = FS_READ_BATCH_REQUEST_BYTES;
    const pushable = (name: string): boolean => roots.some((pushRoot) => (
      (pushRoot === '' || name === pushRoot || name.startsWith(pushRoot + '/'))
      && !name.slice(pushRoot.length).split('/').some((segment) => exclude.has(segment))
    ));
    // The directories above every reported name passed the view check, so
    // the row at its key is what the caller would stat.
    for (const entry of delta.paths) {
      const key = this.keyOfName(entry.path, root);
      const inode = this.inodes.get(key);
      if (inode === undefined) {
        paths.push({ ...entry, stat: null });
        continue;
      }
      const reported: VfsInvalidatedPath = {
        ...entry,
        stat: { ...this.statOf(inode), revision: this.pathRevision(key, inode) },
        ...(inode.kind === 'symlink' ? { linkTarget: dec.decode(this.readInodeBytes(key, inode)) } : {}),
        // Content identity, as list() reports it: a holder of equal bytes keeps them.
        ...(inode.kind === 'file' ? { contentKey: this.contentKeyOf(inode) } : {}),
      };
      if (inode.kind === 'file' && roots.length > 0 && pushable(entry.path)) {
        if (inode.size > pushBudget) {
          reported.bytesOmitted = true;
        } else if (this.accessInode(inode, 0o4, cred)) {
          try {
            reported.bytes = this.readContent(inode, 0, inode.size, false);
            pushBudget -= reported.bytes.byteLength;
          } catch (error) {
            // Bytes a lazy import has not brought yet (N17): the holder reads
            // them on demand, as for a file over the budget.
            if (!isPendingChunkError(error)) throw error;
            reported.bytesOmitted = true;
          }
        }
      }
      paths.push(reported);
    }
    return { epoch: delta.epoch, rev: delta.rev, paths, poison: false, namespace: true };
  }

  private readdir(path: string, cred: VfsCred): { name: string; type: VfsInodeKind }[] {
    const np = this.storageKey(path, cred);
    const resolved = np ? this.checkAccess(np, 0o4, cred) : { path: '', inode: undefined };
    const inode = resolved.inode;
    if (inode && inode.kind !== 'directory') throw vfsError('ENOTDIR', path);
    // One seek of the parent index. The entries are read, not cached: naming
    // a directory's entries says nothing about which of them will be used.
    // They are the entries of the directory the name resolved to, the one
    // the permission was checked on: through a link, its target's.
    const results: { name: string; type: VfsInodeKind }[] = [];
    for (const row of this.sql.exec('SELECT path, kind FROM vfs_inodes WHERE parent_path = ?', resolved.path)) {
      const child = String(row.path);
      results.push({ name: child.slice(child.lastIndexOf('/') + 1), type: inodeKindFromCode(Number(row.kind)) });
    }
    // Sorted by UTF-16 code unit: callers that walk a listing (the prefetch
    // closure walk among them) rely on a stable order. SQLite's byte order
    // differs from it for names outside the Basic Multilingual Plane.
    results.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    return results;
  }

  private unlink(path: string, cred: VfsCred): void {
    this.assertMutationsAllowed([path]);
    const resolved = this.checkAccess(path, 0, cred, { followLeaf: false });
    const inode = resolved.inode;
    if (!inode) throw vfsError('ENOENT', path);
    this.checkParentAccess(resolved.path, cred);
    this.checkStickyParentMutation(resolved.path, inode, cred);
    if (inode.isDir) throw vfsError('EISDIR', resolved.path);
    this.writeBatch({ inodes: [], chunks: [], deletePaths: [resolved.path] }, cred);
  }

  private rmdir(path: string, cred: VfsCred): void {
    this.assertMutationsAllowed([path]);
    const np = this.storageKey(path, cred);
    // Everything below acts on the directory the name resolves to, the one
    // whose permissions are checked.
    const resolved = this.checkAccess(np, 0, cred, { followLeaf: false });
    this.checkParentAccess(resolved.path, cred);
    const inode = resolved.inode;
    if (!inode) throw vfsError('ENOENT', path);
    this.checkStickyParentMutation(resolved.path, inode, cred);
    // Empty is one seek of the parent index.
    if ([...this.sql.exec('SELECT 1 FROM vfs_inodes WHERE parent_path = ? LIMIT 1', resolved.path)].length > 0) {
      throw vfsError('ENOTEMPTY', path);
    }
    if (!inode.isDir) throw vfsError('ENOTDIR', path);
    this.writeBatch({ inodes: [], chunks: [], deletePaths: [resolved.path] }, cred);
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
  private removeRecursive(path: string, cred: VfsCred): number {
    this.assertMutationsAllowed([path]);
    const resolved = this.checkAccess(path, 0, cred, { followLeaf: false });
    if (!resolved.inode) throw vfsError('ENOENT', normalizeVfsPath(path));
    this.checkParentAccess(resolved.path, cred);
    this.checkStickyParentMutation(resolved.path, resolved.inode, cred);

    // The directories the recursive walk used to enumerate are exactly the
    // directory inodes of the subtree, and enumerating one needed read
    // permission. Answering from the index would otherwise skip that check.
    // All of them pass before the first group commits.
    for (const inode of this.subtreeDescending(resolved.path, resolved.inode, true)) {
      if (!this.accessInode(inode, 0o4, cred)) throw vfsError('EACCES', inode.path);
    }

    let removed = 0;
    let group: string[] = [];
    let budget = this.newPlan();
    const flush = (): void => {
      if (group.length === 0) return;
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
      if (budget.wouldExceedDeletion() !== null) flush();
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
  private *subtreeDescending(root: string, rootInode: INode, directoriesOnly: boolean): Generator<INode> {
    const range = subtreeRange(root);
    const kind = directoriesOnly ? ` AND kind = ${INODE_KIND_DIRECTORY}` : '';
    let below = range.upper;
    for (;;) {
      const rows = [...(below === null
        ? this.sql.exec(
          `SELECT ${INODE_SELECT_COLUMNS} FROM vfs_inodes WHERE path > ?${kind} ORDER BY path DESC LIMIT ?`,
          range.lower,
          SUBTREE_PAGE_ROWS,
        )
        : this.sql.exec(
          `SELECT ${INODE_SELECT_COLUMNS} FROM vfs_inodes WHERE path > ? AND path < ?${kind} ORDER BY path DESC LIMIT ?`,
          range.lower,
          below,
          SUBTREE_PAGE_ROWS,
        ))];
      for (const row of rows) yield this.inodes.peek(String(row.path)) ?? this.inodeFromRow(row);
      if (rows.length < SUBTREE_PAGE_ROWS) break;
      below = String(rows[rows.length - 1]!.path);
    }
    if (!directoriesOnly || rootInode.isDir) yield rootInode;
  }

  private rename(oldPath: string, newPath: string, cred: VfsCred): void {
    this.assertMutationsAllowed([oldPath, newPath]);
    // Resolve private /tmp names to storage keys before reading or mutating.
    const source = this.checkAccess(oldPath, 0, cred, { followLeaf: false });
    const inode = source.inode;
    if (!inode) throw vfsError('ENOENT', oldPath);
    const target = this.checkAccess(newPath, 0, cred, { followLeaf: false, allowMissingLeaf: true });
    oldPath = source.path;
    newPath = target.path;
    // Linux order (do_renameat2, vfs_rename): the same entry is a no-op before
    // any permission; a tree into itself is EINVAL; then write on both parents,
    // the sticky bit, and what the destination is.
    if (oldPath === newPath) return;
    if (newPath.startsWith(`${oldPath}/`)) throw vfsError('EINVAL', `cannot move ${oldPath} inside itself`);
    this.checkParentAccess(oldPath, cred);
    this.checkParentAccess(newPath, cred);
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
      // POSIX replacement: a file never replaces a directory (EISDIR), a
      // directory never a file (ENOTDIR), and a directory replaces only an
      // empty one (ENOTEMPTY, below, with the moved-directory check first).
      if (destInode.isDir && !inode.isDir) throw vfsError('EISDIR', newPath);
      if (!destInode.isDir && inode.isDir) throw vfsError('ENOTDIR', newPath);
    }
    // A directory moved to another parent has its `..` rewritten: that needs
    // write permission on the directory itself (Linux may_delete/may_create).
    if (inode.isDir && this.parentPath(oldPath) !== this.parentPath(newPath) && !this.accessInode(inode, 0o2, cred)) {
      throw vfsError('EACCES', oldPath);
    }
    if (destInode?.isDir && this.collectSubtreeInodes([newPath]).some((entry) => entry.path !== newPath)) {
      throw vfsError('ENOTEMPTY', newPath);
    }

    // Both questions a rename asks — what moves, and what is already at the
    // destination — are subtree queries, and the index answers them in the
    // size of those subtrees. Scanning every inode twice made an atomic write
    // (write temp, rename over) cost the whole filesystem per call.
    const moving = this.collectSubtreeInodes([oldPath]).reverse();
    const movingPaths = new Set(moving.map((entry) => entry.path));
    const targetPaths = new Set(
      moving.map((entry) => newPath + entry.path.substring(oldPath.length)),
    );
    for (const existing of this.collectSubtreeInodes([newPath])) {
      if (movingPaths.has(existing.path) || existing.path === destInode?.path) continue;
      if (targetPaths.has(existing.path) || existing.path.startsWith(`${newPath}/`)) {
        throw vfsError('ENOTEMPTY', `rename target subtree conflicts at ${existing.path}`);
      }
    }
    // `moving` is shallowest-first, which is the order publication needs: a
    // parent directory exists before the children that name it. Retiring the
    // source needs the opposite.
    const retiring = [...moving].reverse();
    const touchedPaths = new Set<string>();
    const commit = (builder: TransactionPlanBuilder): void => {
      if (builder.empty) return;
      const plan = builder.build();
      this.assertTransactionFits(plan.metrics);
      // Before executing: a commit that throws after it is durable is reported too.
      for (const path of plan.affectedPaths) touchedPaths.add(path);
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
      const stored: StoredInodeEntry = {
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
        defaultAcl: entry.defaultAcl,
        // Only the moved inode itself changes; its descendants keep their ctime.
        ctime: entry.path === oldPath ? undefined : entry.ctime,
      };
      this.normalizeSharedEntry(stored, cred, entry.uid);
      if (stored.mode !== entry.mode || stored.gid !== entry.gid || stored.defaultAcl !== entry.defaultAcl) stored.ctime = undefined;
      return { entry, stored };
    });
    this.revokeSharedDirectories(oldPath);
    this.revokeSharedDirectories(newPath);
    const committed: StoredInodeEntry[] = [];
    let group: StoredInodeEntry[] = [];
    const flushPublished = (): void => {
      if (builder.empty) return;
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
        if (builder.wouldExceedInode() !== null) flushPublished();
        builder.addInode(stored);
        group.push(stored);
      }
      flushPublished();
    } catch (error) {
      this.unpublishRenameDestination(committed);
      if (touchedPaths.size > 0) this.bumpRevision([...touchedPaths]);
      throw error;
    }
    // The superseded occupant goes first: it shares its path with the entry
    // published over it, exactly as the transaction deleted before inserting.
    if (destInode) {
      for (const opened of this.openNodes) if (opened.path === destInode.path) opened.path = null;
      destInode.ctime = this.now();
      this.inodes.delete(destInode.path);
      this._totalFiles--;
      this._usedBytes -= destInode.size;
    }
    for (const { entry, stored } of renamed) {
      for (const opened of this.openNodes) if (opened.path === entry.path) opened.path = stored.path;
      // The cache holds what was written: a move into a shared directory
      // changed the mode, group and default ACL of the rows it published.
      const moved: INode = {
        ...entry,
        path: stored.path,
        parentPath: stored.parentPath,
        mode: stored.mode,
        gid: stored.gid,
        defaultAcl: stored.defaultAcl ?? null,
        ctime: stored.ctime!,
        gen: stored.gen!,
      };
      this.inodes.set(moved.path, moved);
      if (moved.isDir) this._totalDirs++;
      else { this._totalFiles++; this._usedBytes += moved.size; }
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
    let retired: INode[] = [];
    const retire = (): void => {
      commit(builder);
      for (const entry of retired) {
        this.inodes.delete(entry.path);
        if (entry.isDir) this._totalDirs--;
        else { this._totalFiles--; this._usedBytes -= entry.size; }
      }
      retired = [];
      builder = this.newPlan();
    };
    try {
      for (const entry of retiring) {
        if (builder.wouldExceedDeletion() !== null) retire();
        builder.addDeletedPath(entry.path, entry, false);
        retired.push(entry);
      }
      retire();
    } catch (error) {
      // What committed is visible, so it is published before the error goes.
      this.bumpRevision([...touchedPaths]);
      throw error;
    }

    // Every source directory went from its old name, and a reader holding
    // anything under one must let it go.
    this.bumpRevision([...touchedPaths], removedDirectories(retiring));
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
  private unpublishRenameDestination(published: readonly StoredInodeEntry[]): void {
    if (published.length === 0) return;
    const deepestFirst = [...published].reverse();
    let builder = this.newPlan();
    const flush = (): void => {
      if (builder.empty) return;
      const plan = builder.build();
      builder = this.newPlan();
      this.assertTransactionFits(plan.metrics);
      this.executeTransactionPlan(plan, { source: 'content-publish', limitMode: 'bounded' });
    };
    try {
      for (const stored of deepestFirst) {
        if (builder.wouldExceedDeletion() !== null) flush();
        // The source still holds these references, so none is queued.
        builder.addDeletedPath(stored.path, undefined, false);
      }
      flush();
    } catch { /* the source is intact; report the original failure */ }
  }

  /**
   * Copy a file by reference: one inode row naming the source's chunk or
   * manifest. No byte is read or written; a later write to either side
   * copies on write (rewriteFile's sharing probes).
   */
  private copyFile(src: string, dest: string, cred: VfsCred): void {
    const source = this.checkAccess(src, 0o4, cred);
    const inode = source.inode;
    if (!inode) throw vfsError('ENOENT', src);
    if (inode.kind === 'directory') throw vfsError('EISDIR', source.path);
    if (inode.kind !== 'file') throw vfsError('EINVAL', `${source.path} is not a regular file`);
    this.assertMutationsAllowed([dest]);
    const target = this.checkAccess(dest, 0, cred, { allowMissingLeaf: true });
    const prior = target.inode;
    if (prior?.kind === 'directory') throw vfsError('EISDIR', target.path);
    if (prior && prior.kind !== 'file') throw vfsError('EINVAL', `${target.path} is not a regular file`);
    if (prior && !this.accessInode(prior, 0o2, cred)) throw vfsError('EACCES', target.path);
    if (!prior) this.checkParentAccess(target.path, cred);
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
      mode: prior ? prior.mode : this.creationAttrs(target.path, 0o666, cred, false).mode,
      uid: prior?.uid ?? cred.uid,
      gid: prior?.gid ?? this.creationAttrs(target.path, 0o666, cred, false).gid,
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
  private planCopyTree(src: string, dst: string, cred: VfsCred, options: { preserve?: boolean; at?: string } = {}): CopyTreeJob {
    this.assertMutationsAllowed([dst]);
    const atGen = options.at === undefined ? undefined : this.requireSnapshot(options.at);
    if (atGen !== undefined) this.assertSnapshotLocal(atGen, normalizeVfsPath(src), options.at!);
    const tree: InodeLookup = atGen === undefined ? this.inodes : { get: (path) => this.inodeAt(path, atGen) };
    const source = this.checkAccess(src, 0o4, cred, { followLeaf: false, tree });
    const root = source.inode!;
    const target = this.checkAccess(dst, 0, cred, { followLeaf: false, allowMissingLeaf: true });
    if (target.inode) throw vfsError('EEXIST', target.path);
    this.checkParentAccess(target.path, cred);
    const sharing = this.sharedDirectory(target.path);
    if (sharing && cred.uid !== 0 && cred.gid !== sharing.gid && !cred.groups.includes(sharing.gid)) throw vfsError('EPERM', target.path + ': shared group membership required');
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
    // N18: the whole copy is admitted before its first row, and reserved when
    // it starts; its slices draw from the reservation, so no writer between
    // them can leave it without room.
    let rows = 1;
    if (root.isDir) {
      if (atGen === undefined) {
        const range = subtreeRange(source.path);
        rows += Number([...(range.upper === null
          ? this.sql.exec('SELECT COUNT(*) AS n FROM vfs_inodes WHERE path > ?', range.lower)
          : this.sql.exec('SELECT COUNT(*) AS n FROM vfs_inodes WHERE path > ? AND path < ?', range.lower, range.upper))][0]!.n);
      } else {
        for (const _ of this.subtreeAt(source.path, atGen)) rows++;
      }
    }
    // Each page's transaction also writes the generation and the job's cursor.
    rows += 2 * (Math.ceil(rows / COPY_PAGE_ROWS) + 1);
    this.ledger.admit(rows * LEDGER_ROW_BYTES);
    const job: CopyTreeJob = {
      rows,
      src: source.path,
      dst: target.path,
      uid: cred.uid,
      gid: cred.gid,
      clearBits: options.preserve ? 0 : (cred.umask & 0o777) | 0o6000,
      preserveOwner: options.preserve === true && cred.uid === 0,
      preserveTimes: options.preserve === true,
      ...(atGen === undefined ? {} : { at: options.at, atGen }),
    };
    return job;
  }

  private async copyTreeInSlices(job: CopyTreeJob, owner?: string): Promise<number> {
    const reservation = this.reserveCopy(job);
    const run = (id: number | null) => this.withMutationOwner(owner, () => this.withReservation(reservation, () => this.runCopyTree(job, id, JOB_SLICE_PAGES)));
    try {
      let slice = run(null);
      let copied = slice.copied;
      while (!slice.done) {
        await yieldToStorage();
        slice = run(slice.id);
        copied += slice.copied;
      }
      return copied;
    } finally {
      this.ledger.release(reservation);
    }
  }

  /** A whole copy in one turn: its reservation is drawn and then released. */
  private copyTreeNow(job: CopyTreeJob): number {
    const reservation = this.reserveCopy(job);
    try {
      return this.withReservation(reservation, () => this.runCopyTree(job, null)).copied;
    } finally {
      this.ledger.release(reservation);
    }
  }

  /** Reserve a planned copy's rows in the ledger (N18); its slices draw from it. */
  private reserveCopy(job: CopyTreeJob): string {
    const id = crypto.randomUUID();
    this.ledger.reserve(id, (job.rows ?? 0) * LEDGER_ROW_BYTES);
    return id;
  }

  /** Every entry strictly under `root` as of generation `g`, a page at a time. */
  private *subtreeAt(root: string, g: number): Generator<INode> {
    const range = subtreeRange(root);
    let cursor = range.lower;
    for (;;) {
      const page = this.pageAt(g, cursor, SUBTREE_PAGE_ROWS);
      for (const inode of page) {
        if (range.upper !== null && inode.path >= range.upper) return;
        yield inode;
      }
      if (page.length < SUBTREE_PAGE_ROWS) return;
      cursor = page[page.length - 1]!.path;
    }
  }

  /**
   * Run a copyTree job to completion: the root row and the job row in the
   * first transaction, then one page per transaction, the cursor moving in
   * the transaction that copies the page. `id` resumes a recorded job.
   */
  private runCopyTree(job: CopyTreeJob, id: number | null, maxPages = Infinity): { copied: number; id: number | null; done: boolean } {
    const range = subtreeRange(job.src);
    const columns = 'path, parent_path, kind, size, atime, mtime, mode, uid, gid, chunk_id, content_id, dacl';
    // The rows copied: the live tree, or the snapshot's (live rows it still
    // sees, plus the history rows covering it). Generations are integers.
    const source = job.atGen === undefined
      ? 'vfs_inodes'
      : `(SELECT ${columns} FROM vfs_inodes WHERE gen <= ${job.atGen}
          UNION ALL SELECT ${columns} FROM vfs_inode_history WHERE gen_to > ${job.atGen} AND gen_from <= ${job.atGen})`;
    let jobId = id;
    let cursor = jobId === null ? null : String([...this.sql.exec('SELECT cursor FROM vfs_jobs WHERE id = ?', jobId)][0]!.cursor);
    let copied = 0;
    let pages = 0;
    for (;;) {
      const now = this.now();
      const page = cursor === null
        ? [...this.sql.exec(`SELECT path, kind, size FROM ${source} WHERE path = ?`, job.src)]
        : [...(range.upper === null
          ? this.sql.exec(`SELECT path, kind, size FROM ${source} WHERE path > ? ORDER BY path LIMIT ?`, cursor, COPY_PAGE_ROWS)
          : this.sql.exec(
            `SELECT path, kind, size FROM ${source} WHERE path > ? AND path < ? ORDER BY path LIMIT ?`,
            cursor,
            range.upper,
            COPY_PAGE_ROWS,
          ))];
      const last = page.length > 0 ? String(page[page.length - 1]!.path) : null;
      const done = cursor !== null && page.length < COPY_PAGE_ROWS;
      let gen = 0;
      this.executeMeasuredTransaction(
        this.metricsOnlyPlan({ blobBytes: 0, logicalRows: page.length + 2, sqlExecs: 4, affectedPaths: page.length }),
        { source: 'content-publish', limitMode: 'bounded' },
        () => {
          const state = [...this.sql.exec(
            'UPDATE vfs_state SET gen = gen + 1 WHERE slot = 1 RETURNING gen, next_ino',
          )][0]!;
          gen = Number(state.gen);
          const firstIno = Number(state.next_ino);
          if (!Number.isSafeInteger(firstIno + page.length)) throw vfsError('ENOSPC', 'inode identity space exhausted');
          if (page.length > 0) {
            const lower = cursor === null ? job.src : cursor;
            const tail = job.src.length + 1;
            const shared = this.sharedDirectory(job.dst);
            const copiedMode = shared
              ? '((mode & ~' + job.clearBits + ' & ~56) | ((mode & ~' + job.clearBits + ' & 448) >> 3) | CASE WHEN kind = ' + INODE_KIND_DIRECTORY + ' THEN 1024 ELSE 0 END)'
              : '(mode & ~' + job.clearBits + ')';
            this.sql.exec(
              `INSERT OR IGNORE INTO vfs_inodes
                 (path, parent_path, kind, size, atime, mtime, ctime, mode, uid, gid, ino, gen, chunk_id, content_id, dacl)
               SELECT ? || substr(path, ?),
                      CASE WHEN path = ? THEN ? ELSE ? || substr(parent_path, ?) END,
                      kind, size,
                      CASE WHEN ? THEN atime ELSE ? END, CASE WHEN ? THEN mtime ELSE ? END, ?,
                      CASE WHEN kind = ${INODE_KIND_SYMLINK} THEN mode ELSE ${copiedMode} END,
                      CASE WHEN ? THEN uid ELSE ? END,
                      ${shared ? 'CASE WHEN kind = ' + INODE_KIND_SYMLINK + ' THEN CASE WHEN ? THEN gid ELSE ? END ELSE ' + shared.gid + ' END' : 'CASE WHEN ? THEN gid ELSE ? END'},
                      ? + row_number() OVER (ORDER BY path) - 1, ?, chunk_id, content_id,
                      ${shared ? 'CASE WHEN kind = ' + INODE_KIND_DIRECTORY + ' THEN ' + shared.acl + ' ELSE dacl END' : 'dacl'}
               FROM ${source} WHERE path ${cursor === null ? '=' : '>'} ? AND path <= ? ORDER BY path`,
              job.dst, tail,
              job.src, this.parentPath(job.dst), job.dst, tail,
              job.preserveTimes ? 1 : 0, now, job.preserveTimes ? 1 : 0, now, now,
              job.preserveOwner ? 1 : 0, job.uid, job.preserveOwner ? 1 : 0, job.gid,
              firstIno, gen,
              lower, last,
            );
            this.sql.exec('UPDATE vfs_state SET next_ino = ? WHERE slot = 1', firstIno + page.length);
          }
          if (jobId === null) {
            jobId = Number([...this.sql.exec(
              `INSERT INTO vfs_jobs (kind, args, cursor, start_gen, created_at) VALUES ('copyTree', ?, ?, ?, ?) RETURNING id`,
              JSON.stringify(job),
              job.src === '' ? '' : `${job.src}/`,
              gen,
              now,
            )][0]!.id);
          } else if (done) {
            this.sql.exec('DELETE FROM vfs_jobs WHERE id = ?', jobId);
          } else {
            this.sql.exec('UPDATE vfs_jobs SET cursor = ? WHERE id = ?', last, jobId);
          }
        },
      );
      this._gen = gen;
      const published: string[] = [];
      for (const row of page) {
        const path = job.dst + String(row.path).slice(job.src.length);
        published.push(path);
        if (!this._countersLoaded) continue;
        if (Number(row.kind) === INODE_KIND_DIRECTORY) this._totalDirs++;
        else { this._totalFiles++; this._usedBytes += Number(row.size); }
      }
      copied += page.length;
      if (published.length > 0) this.bumpRevision(published);
      // One event for the tree, as rename emits: events queue until the
      // turn ends, and one per copied row would hold the whole tree.
      if (cursor === null) this.emitMutation(Number(page[0]?.kind) === INODE_KIND_DIRECTORY ? 'addDir' : 'add', job.dst);
      if (cursor === null) {
        cursor = job.src === '' ? '' : `${job.src}/`;
        if (Number(page[0]?.kind) !== INODE_KIND_DIRECTORY) {
          // A file or symlink is its own whole tree: its job ends with it.
          this.transactionSync(() => { this.sql.exec('DELETE FROM vfs_jobs WHERE id = ?', jobId); });
          return { copied, id: jobId, done: true };
        }
        continue;
      }
      if (done) return { copied, id: jobId, done: true };
      cursor = last!;
      if (++pages >= maxPages) return { copied, id: jobId, done: false };
    }
  }

  /**
   * Continue every job a reset interrupted, from its cursor: one slice now,
   * at open, and the rest in slices with a yield between, so a job of any
   * size never holds one synchronous turn.
   */
  private resumeJobs(): void {
    const pending: number[] = [];
    for (const row of [...this.sql.exec("SELECT id FROM vfs_jobs WHERE kind <> 'import' ORDER BY id")]) {
      const id = Number(row.id);
      if (!this.resumeSlice(id)) pending.push(id);
    }
    if (pending.length === 0) return;
    void (async () => {
      for (const id of pending) {
        do await yieldToStorage(); while (!this.resumeSlice(id));
      }
    })();
  }

  /**
   * One slice of an interrupted copy (N18). Its first slice after an open
   * reserves what is left to copy, as a copy does when it starts, so no
   * writer between the slices can leave it without room. Refused, the job
   * ends: what it had copied is removed (a pure removal, never refused) and
   * its row goes, so it is never half-applied.
   */
  private resumeCopySlice(id: number, job: CopyTreeJob): boolean {
    const reservation = `copy-job:${id}`;
    if (!this.resumedCopies.has(id)) {
      try {
        this.ledger.reserve(reservation, this.remainingCopyRows(id, job) * LEDGER_ROW_BYTES);
      } catch (error) {
        if ((error as { code?: string }).code !== 'ENOSPC') throw error;
        console.error(`[sqlite-vfs] copy of ${job.src} to ${job.dst} ended: ${this.errorMessage(error)}`);
        if (this.inodes.get(job.dst) !== undefined) this.removeRecursive(job.dst, CRED_KERNEL);
        this.transactionSync(() => { this.sql.exec('DELETE FROM vfs_jobs WHERE id = ?', id); });
        return true;
      }
      this.resumedCopies.add(id);
    }
    let done = true;
    try {
      done = this.withReservation(reservation, () => this.runCopyTree(job, id, JOB_SLICE_PAGES)).done;
      return done;
    } finally {
      if (done) {
        this.resumedCopies.delete(id);
        this.ledger.release(reservation);
      }
    }
  }

  /** Rows a copy job has left: the source's rows past its cursor, and each page's two. */
  private remainingCopyRows(id: number, job: CopyTreeJob): number {
    const cursor = String([...this.sql.exec('SELECT cursor FROM vfs_jobs WHERE id = ?', id)][0]!.cursor);
    const range = subtreeRange(job.src);
    let rows = 0;
    if (job.atGen === undefined) {
      rows = Number([...(range.upper === null
        ? this.sql.exec('SELECT COUNT(*) AS n FROM vfs_inodes WHERE path > ?', cursor)
        : this.sql.exec('SELECT COUNT(*) AS n FROM vfs_inodes WHERE path > ? AND path < ?', cursor, range.upper))][0]!.n);
    } else {
      for (const inode of this.subtreeAt(job.src, job.atGen)) if (inode.path > cursor) rows++;
    }
    return rows + 2 * (Math.ceil(rows / COPY_PAGE_ROWS) + 1);
  }

  /** One slice of job `id`; true once it is done (or gone, or failed). */
  private resumeSlice(id: number): boolean {
    const row = [...this.sql.exec('SELECT kind, args, start_gen FROM vfs_jobs WHERE id = ?', id)][0];
    if (row === undefined) return true;
    try {
      const args = JSON.parse(String(row.args));
      if (row.kind === 'copyTree') return this.resumeCopySlice(id, args as CopyTreeJob);
      if (row.kind === 'restore') return this.runRestore(id, args as RestoreJob, Number(row.start_gen), JOB_SLICE_PAGES).done;
      if (row.kind === 'drop') return this.runDrop(id, Number((args as { g: number }).g), JOB_SLICE_PAGES).done;
      throw new Error(`unknown job kind ${String(row.kind)}`);
    } catch (error) {
      console.error(`[sqlite-vfs] job ${id} (${String(row.kind)}) failed to resume:`, this.errorMessage(error));
      return true;
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
  snapshots(): SnapshotInfo[] {
    return [...this.sql.exec('SELECT name, gen, created_at FROM vfs_snapshots ORDER BY gen, id')]
      .map((row) => ({ name: String(row.name), gen: Number(row.gen), createdAt: Number(row.created_at) }));
  }

  /**
   * Pin the current tree under `name`: one row and pin_gen, in one
   * transaction, whatever the tree's size. Every synchronous operation runs
   * inside one turn, so it cannot interleave with one; a `writeStream` spans
   * awaits, and without `quiesce` the snapshot holds its committed groups, the
   * state a reset would leave. `quiesce` waits for every stream first.
   */
  snapshot(name: string): SnapshotInfo;
  snapshot(name: string, options: { quiesce: true }): Promise<SnapshotInfo>;
  snapshot(name: string, options: { quiesce?: boolean } = {}): SnapshotInfo | Promise<SnapshotInfo> {
    if (typeof name !== 'string' || name === '' || name.length > 256) throw vfsError('EINVAL', 'invalid snapshot name');
    if (!options.quiesce) return this.pinSnapshot(name);
    return this.quiesced(() => this.pinSnapshot(name));
  }

  /**
   * Run `pin` once nothing spans awaits and no exclusive lease is held: the
   * check and `pin` run in one turn, so nothing can start between them. New
   * spanning work waits behind the gate until then (Kinu N14: await, never
   * EBUSY). A lease is synchronous and cannot wait, so one taken meanwhile
   * is waited out too.
   */
  private quiesced<T>(pin: () => T): Promise<T> {
    const previous = this.quiesceGate ?? Promise.resolve();
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const chained = previous.then(() => gate);
    this.quiesceGate = chained;
    return (async () => {
      try {
        await previous;
        for (;;) {
          if (this.activeWork.size > 0) { await Promise.allSettled([...this.activeWork]); continue; }
          if (this.exclusiveMutationLeases.size > 0) { await yieldToStorage(); continue; }
          return pin();
        }
      } finally {
        open();
        if (this.quiesceGate === chained) this.quiesceGate = null;
      }
    })();
  }

  /**
   * Spanning work: held behind a quiescing snapshot, and awaited by the next
   * one. Work under a live exclusive lease (`owner`) is part of what the
   * snapshot already waits for, the lease, so it is never held: holding it
   * would hold the lease forever (a clone streaming its batches).
   */
  private spanning<T>(start: () => Promise<T>, owner?: string): Promise<T> {
    // Tracked once started: the snapshot waits for running work, never for
    // work it is itself holding back.
    const begin = (): Promise<T> => {
      const run = start();
      this.activeWork.add(run);
      const settled = (): void => { this.activeWork.delete(run); };
      run.then(settled, settled);
      return run;
    };
    const gate = this.quiesceGate;
    if (gate === null || (owner !== undefined && this.exclusiveMutationLeases.has(owner))) return begin();
    return gate.then(begin);
  }

  private pinSnapshot(name: string): SnapshotInfo {
    if (this.snapshotGen(name) !== undefined) throw vfsError('EEXIST', `snapshot ${name}`);
    const createdAt = this.now();
    let gen = 0;
    this.transactionSync(() => {
      gen = Number([...this.sql.exec('SELECT gen FROM vfs_state WHERE slot = 1')][0]!.gen);
      this.sql.exec('INSERT INTO vfs_snapshots (name, gen, created_at) VALUES (?, ?, ?)', name, gen, createdAt);
      this.sql.exec('UPDATE vfs_state SET pin_gen = ? WHERE slot = 1', gen);
    });
    this._pinGen = gen;
    this.snapshotGens?.set(name, gen);
    return { name, gen, createdAt };
  }

  private snapshotGen(name: string): number | undefined {
    if (this.snapshotGens === null) {
      this.snapshotGens = new Map(this.snapshots().map((snap) => [snap.name, snap.gen]));
    }
    return this.snapshotGens.get(name);
  }

  private requireSnapshot(name: string): number {
    const gen = this.snapshotGen(name);
    if (gen === undefined) throw vfsError('ENOENT', `snapshot ${name}`);
    return gen;
  }

  /** The inode at `path` as of generation `g`: its live row if unchanged since, else the history row covering `g`. */
  private inodeAt(path: string, g: number): INode | undefined {
    const live = [...this.sql.exec(`SELECT ${INODE_SELECT_COLUMNS} FROM vfs_inodes WHERE path = ? AND gen <= ?`, path, g)][0];
    if (live !== undefined) return this.inodeFromRow(live);
    const past = [...this.sql.exec(
      `SELECT ${HISTORY_SELECT_COLUMNS} FROM vfs_inode_history
       WHERE path = ? AND gen_to > ? AND gen_from <= ? ORDER BY gen_to LIMIT 1`,
      path,
      g,
      g,
    )][0];
    return past === undefined ? undefined : this.inodeFromRow(past);
  }

  /** The children of `dir` as of generation `g`, in UTF-16 name order (readdir's). */
  private childrenAt(dir: string, g: number): INode[] {
    const out = new Map<string, INode>();
    for (const row of this.sql.exec(`SELECT ${INODE_SELECT_COLUMNS} FROM vfs_inodes WHERE parent_path = ? AND gen <= ?`, dir, g)) {
      out.set(String(row.path), this.inodeFromRow(row));
    }
    for (const row of this.sql.exec(
      `SELECT ${HISTORY_SELECT_COLUMNS} FROM vfs_inode_history WHERE parent_path = ? AND gen_to > ? AND gen_from <= ?`,
      dir,
      g,
      g,
    )) out.set(String(row.path), this.inodeFromRow(row));
    return [...out.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  /**
   * One keyset page of the tree as of `g`, in SQLite's path order (UTF-8 bytes,
   * the order `path > ?` keysets use): live and history merged in SQL, so the
   * page boundary and the cursor never disagree. A JS `<` on strings orders by
   * UTF-16 code units and would place U+10000 before U+E000.
   */
  private pageAt(g: number, after: string, limit: number, upper: string | null = null): INode[] {
    const below = upper === null ? '' : ' AND path < ?';
    const bound = upper === null ? [] : [upper];
    return [...this.sql.exec(
      `SELECT * FROM (
         SELECT ${INODE_SELECT_COLUMNS} FROM vfs_inodes WHERE path > ?${below} AND gen <= ? ORDER BY path LIMIT ?
       ) UNION ALL SELECT * FROM (
         SELECT ${HISTORY_SELECT_COLUMNS} FROM vfs_inode_history WHERE path > ?${below} AND gen_to > ? AND gen_from <= ? ORDER BY path LIMIT ?
       ) ORDER BY path LIMIT ?`,
      after, ...bound, g, limit,
      after, ...bound, g, g, limit,
      limit,
    )].map((row) => this.inodeFromRow(row));
  }

  /** SQLite's `ORDER BY path` (UTF-8 bytes) for JS strings: keyset cursors compare in this order. */
  private static comparePaths(a: string, b: string): number {
    const x = enc.encode(a), y = enc.encode(b);
    let i = 0;
    for (const byte of x) {
      const other = y[i++];
      if (other === undefined) return 1;
      if (byte !== other) return byte - other;
    }
    return i === y.length ? 0 : -1;
  }

  /**
   * A read-only view of snapshot `name` for `cred`: the same methods, the
   * same permission checks and symlink resolution, over the tree the
   * snapshot pinned. Mutators throw EROFS; every call after the snapshot is
   * dropped throws ESTALE (its history may already be collected).
   */
  at(name: string, cred: VfsCred = CRED_KERNEL): CredentialedVfs {
    const g = this.requireSnapshot(name);
    const bound = Object.freeze({
      uid: cred.uid,
      gid: cred.gid,
      groups: Object.freeze([...cred.groups]),
      umask: cred.umask & 0o777,
    });
    // A snapshot's rows never change, so the view caches lookups (bounded;
    // directories dominate, since every resolution walks them).
    const seen = new Map<string, INode | null>();
    const tree: InodeLookup = {
      get: (path) => {
        const hit = seen.get(path);
        if (hit !== undefined) return hit ?? undefined;
        const inode = this.inodeAt(path, g);
        if (seen.size >= SNAPSHOT_VIEW_CACHE_ENTRIES) seen.clear();
        seen.set(path, inode ?? null);
        return inode;
      },
    };
    const pinned = (): void => {
      if (this.snapshotGen(name) !== g) throw vfsError('ESTALE', `snapshot ${name} was dropped`);
    };
    const readOnly = (): never => { throw vfsError('EROFS', `snapshot ${name} is read-only`); };
    const resolve = (path: string, want: number, followLeaf = true) => {
      pinned();
      return this.checkAccess(path, want, bound, { followLeaf, tree });
    };
    const probe = (path: string): INode | undefined => {
      pinned();
      try {
        return this.checkAccess(path, 0, bound, { followLeaf: false, allowMissingLeaf: true, tree }).inode;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
        throw error;
      }
    };
    const file = (path: string): INode => {
      const resolved = resolve(path, 0o4);
      const inode = resolved.inode!;
      if (inode.kind === 'directory') throw vfsError('EISDIR', resolved.path);
      if (inode.kind !== 'file') throw vfsError('EINVAL', `${resolved.path} is not a regular file`);
      return inode;
    };
    const range = (path: string, offset: number, length: number): Uint8Array => {
      const inode = file(path);
      const start = clampNonNegativeInt(offset);
      const end = Math.min(inode.size, start + clampNonNegativeInt(length));
      return this.readContent(inode, start, end, true);
    };
    const readlink = (path: string): string => {
      const inode = resolve(path, 0, false).inode!;
      if (inode.kind !== 'symlink') throw vfsError('EINVAL', `${path} is not a symlink`);
      return dec.decode(this.readContent(inode, 0, inode.size, true));
    };
    return {
      cred: bound,
      exists: (path) => probe(path) !== undefined,
      isDirectory: (path) => probe(path)?.kind === 'directory',
      isFile: (path) => probe(path)?.kind === 'file',
      isSymlink: (path) => probe(path)?.kind === 'symlink',
      kind: (path) => probe(path)?.kind ?? null,
      access: (path, mode) => { resolve(path, mode); },
      mkdir: readOnly,
      writeFile: readOnly,
      symlink: readOnly,
      readlink,
      resolveSymlink: (path) => {
        pinned();
        try {
          return this.resolvePath(path, bound, true, false, tree).path;
        } catch (error) {
          if ((error as { code?: string }).code === 'ELOOP') return null;
          throw error;
        }
      },
      resolveName: (path, followLeaf, stop) => { pinned(); return this.resolveName(path, bound, followLeaf, stop, tree); },
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
      stat: (path) => this.statOf(resolve(path, 0).inode!),
      lstat: (path) => this.statOf(resolve(path, 0, false).inode!),
      utimes: readOnly,
      chmod: readOnly,
      setDefaultAcl: readOnly,
      getDefaultAcl: (path) => { const inode = resolve(path, 0).inode!; return inode.isDir ? inode.defaultAcl : null; },
      chown: readOnly,
      readdir: (path) => {
        const np = this.storageKey(path, bound);
        if (np !== '') {
          const inode = resolve(np, 0o4).inode!;
          if (inode.kind !== 'directory') throw vfsError('ENOTDIR', path);
        } else pinned();
        return this.childrenAt(np, g).map((child) => ({
          name: child.path.slice(child.path.lastIndexOf('/') + 1),
          type: child.kind,
        }));
      },
      list: (after, limit) => {
        pinned();
        const pageLimit = Math.min(Math.max(1, Math.trunc(limit ?? FS_LIST_PAGE_LIMIT)), FS_LIST_PAGE_LIMIT);
        const from = after === null || after === undefined ? '' : this.storageKey(after, bound);
        const entries: VfsListEntry[] = [];
        const searchableDirs = new Map<string, boolean>();
        let cursor = from;
        for (;;) {
          const page = this.pageAt(g, cursor, pageLimit + 1);
          for (const inode of page) {
            if (entries.length >= pageLimit) return { epoch: this._epoch, rev: g, entries, next: entries[entries.length - 1]!.path };
            const logical = this.logicalPath(inode.path, bound);
            if (logical === null) continue;
            const parent = this.parentPath(inode.path);
            if (parent !== '' && bound.uid !== 0) {
              let searchable = searchableDirs.get(parent);
              if (searchable === undefined) {
                try { this.checkAccess(parent, 0o1, bound, { tree }); searchable = true; } catch { searchable = false; }
                searchableDirs.set(parent, searchable);
              }
              if (!searchable) continue;
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
          if (page.length <= pageLimit) return { epoch: this._epoch, rev: g, entries, next: null };
          cursor = page[page.length - 1]!.path;
        }
      },
      // A snapshot never changes: a cursor at it has nothing to learn, and any
      // other cursor cannot be answered by a delta from here.
      acquire: (epoch, cursor) => ({
        epoch: this._epoch, rev: g, paths: [], poison: epoch !== this._epoch || cursor !== g,
      }),
      invalidatedSince: (epoch, cursor) => ({
        epoch: this._epoch, rev: g, paths: [], poison: epoch !== this._epoch || cursor !== g,
      }),
      storageKey: (path) => this.storageKey(path, bound),
      // Nothing under a snapshot ever changes, so a watch never fires.
      subscribe: () => () => {},
      unlink: readOnly,
      rmdir: readOnly,
      removeRecursive: readOnly,
      rename: readOnly,
      copyFile: readOnly,
      copyTree: readOnly,
      copyTreeAsync: readOnly,
      writeBatch: readOnly,
      writeStream: readOnly,
      mkdirBatch: readOnly,
      revision: () => g,
      contentKey: (path) => {
        const inode = resolve(path, 0o4).inode!;
        if (inode.kind === 'directory') throw vfsError('EISDIR', path);
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
  restore(name: string, options: { subtree?: string } = {}): { restored: number } {
    const { id, job, startGen } = this.restoreJob(name, options);
    return { restored: this.runRestore(id, job, startGen).restored };
  }

  /**
   * restore in slices with a yield between, for a restore of any size in
   * workerd. `mutationOwner`: the live exclusive lease it runs under (its
   * holder awaits it), so it restores inside the lease and a quiescing
   * snapshot never holds it.
   */
  restoreAsync(name: string, options: { subtree?: string; mutationOwner?: string } = {}): Promise<{ restored: number }> {
    return this.spanning(() => this.restoreInSlices(name, options), options.mutationOwner);
  }

  private async restoreInSlices(name: string, options: { subtree?: string; mutationOwner?: string }): Promise<{ restored: number }> {
    const owner = options.mutationOwner;
    const { id, job, startGen } = this.withMutationOwner(owner, () => this.restoreJob(name, options));
    let restored = 0;
    for (;;) {
      const slice = this.withMutationOwner(owner, () => this.runRestore(id, job, startGen, JOB_SLICE_PAGES));
      restored += slice.restored;
      if (slice.done) return { restored };
      await yieldToStorage();
    }
  }

  /** The restore job for (name, subtree): the one a reset or a cold chunk stopped, or a new one. */
  private restoreJob(name: string, options: { subtree?: string }): { id: number; job: RestoreJob; startGen: number } {
    const g = this.requireSnapshot(name);
    const subtree = options.subtree === undefined ? '' : normalizeVfsPath(options.subtree);
    if (subtree !== '') this.assertMutationsAllowed([subtree]);
    else {
      // A full restore changes everything: only the caller's own global lease may be live.
      const owner = this.activeMutationOwner;
      const others = [...this.exclusiveMutationLeases].filter(([id, root]) => id !== owner || root !== '');
      if (others.length > 0) throw vfsError('EBUSY', 'an exclusive filesystem mutation is active');
    }
    this.assertSnapshotLocal(g, subtree, name);
    this.revokeSharedDirectories(subtree);
    // A restore a reset or a cold chunk stopped continues rather than starting over.
    for (const row of [...this.sql.exec("SELECT id, args, start_gen FROM vfs_jobs WHERE kind = 'restore'")]) {
      const pending = JSON.parse(String(row.args)) as RestoreJob;
      if (pending.name === name && pending.subtree === subtree) {
        return { id: Number(row.id), job: pending, startGen: Number(row.start_gen) };
      }
    }
    // A restore rewinds what an import under it wrote, and can bring back
    // the very inodes it began at, where its cursor would then run ahead of
    // the rows: every import whose tree the restore touches ends with it.
    const rewound: number[] = [];
    for (const row of this.sql.exec("SELECT id, args FROM vfs_jobs WHERE kind = 'import'")) {
      const dst = ImportJobArgsSchema.parse(JSON.parse(String(row.args))).dst;
      const within = (inner: string, outer: string): boolean => outer === '' || inner === outer || inner.startsWith(`${outer}/`);
      if (within(dst, subtree) || within(subtree, dst)) rewound.push(Number(row.id));
    }
    let id = 0;
    let startGen = 0;
    this.transactionSync(() => {
      startGen = Number([...this.sql.exec('SELECT gen FROM vfs_state WHERE slot = 1')][0]!.gen) + 1;
      id = Number([...this.sql.exec(
        `INSERT INTO vfs_jobs (kind, args, cursor, start_gen, created_at) VALUES ('restore', ?, '', ?, ?) RETURNING id`,
        JSON.stringify({ name, g, subtree }),
        startGen,
        this.now(),
      )][0]!.id);
      // Without a recorded parent a job is never placed (importPlaced); the sweep reclaims it.
      for (let i = 0; i < rewound.length; i += KEYS_PER_SQL_EXEC) {
        const batch = rewound.slice(i, i + KEYS_PER_SQL_EXEC);
        this.sql.exec(`UPDATE vfs_jobs SET args = json_remove(args, '$.parentIno') WHERE id IN (${batch.map(() => '?').join(',')})`, ...batch);
      }
    });
    if (rewound.length > 0) this.importSweepPending = true;
    return { id, job: { name, g, subtree }, startGen };
  }

  private runRestore(id: number, job: RestoreJob, startGen: number, maxPages = Infinity): { restored: number; done: boolean } {
    this.assertSnapshotLocal(job.g, job.subtree, job.name);
    this.revokeSharedDirectories(job.subtree);
    const range = subtreeRange(job.subtree);
    // Path filter for both tables, as SQL plus its parameters.
    const within = job.subtree === ''
      ? { sql: '', params: [] as unknown[] }
      : { sql: ' AND (path = ? OR (path > ? AND path < ?))', params: [job.subtree, range.lower, range.upper] };
    let restored = 0;
    // Revived paths go in path order, so the next page starts past the last:
    // what it skipped already has a live row, and a write after the restore
    // began wins over it. Kept in the job row across slices.
    let revivedAfter = String([...this.sql.exec('SELECT cursor FROM vfs_jobs WHERE id = ?', id)][0]?.cursor ?? '');
    for (let pages = 0; ; pages++) {
      if (pages >= maxPages) {
        this.transactionSync(() => { this.sql.exec('UPDATE vfs_jobs SET cursor = ? WHERE id = ?', revivedAfter, id); });
        return { restored, done: false };
      }
      const changed = [...this.sql.exec(
        `SELECT ${INODE_SELECT_COLUMNS} FROM vfs_inodes WHERE gen > ? AND gen < ?${within.sql} ORDER BY gen LIMIT ?`,
        job.g,
        startGen,
        ...within.params,
        RESTORE_PAGE_ROWS,
      )].map((row) => this.inodeFromRow(row));
      const revived = changed.length < RESTORE_PAGE_ROWS
        ? [...this.sql.exec(
          `SELECT ${HISTORY_SELECT_COLUMNS} FROM vfs_inode_history AS h
           WHERE path > ? AND gen_to > ? AND gen_from <= ?${within.sql}
             AND NOT EXISTS (SELECT 1 FROM vfs_inodes i WHERE i.path = h.path)
           ORDER BY path LIMIT ?`,
          revivedAfter,
          job.g,
          job.g,
          ...within.params,
          RESTORE_PAGE_ROWS - changed.length,
        )].map((row) => this.inodeFromRow(row))
        : [];
      if (changed.length === 0 && revived.length === 0) {
        this.transactionSync(() => { this.sql.exec('DELETE FROM vfs_jobs WHERE id = ?', id); });
        return { restored, done: true };
      }
      const builder = this.newPlan();
      const deletedInodes: INode[] = [];
      const restoredRow = (past: INode): StoredInodeEntry => {
        const entry: StoredInodeEntry = {
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
          defaultAcl: past.defaultAcl,
        };
        this.normalizeSharedEntry(entry, CRED_KERNEL);
        return entry;
      };
      for (const live of changed) {
        const past = this.historyAt(live.path, job.g);
        if (past === undefined) {
          builder.addDeletedPath(live.path, live);
          deletedInodes.push(live);
        } else builder.addInode(restoredRow(past));
      }
      for (const past of revived) builder.addInode(restoredRow(past));
      if (revived.length > 0) revivedAfter = revived[revived.length - 1]!.path;
      this._writeBatchOnce({ plan: builder.build(), deletedInodes }, { source: 'content-publish', limitMode: 'bounded' });
      restored += changed.length + revived.length;
    }
  }

  /** The history row covering generation `g` at `path`, if any. */
  private historyAt(path: string, g: number): INode | undefined {
    const row = [...this.sql.exec(
      `SELECT ${HISTORY_SELECT_COLUMNS} FROM vfs_inode_history
       WHERE path = ? AND gen_to > ? AND gen_from <= ? ORDER BY gen_to LIMIT 1`,
      path,
      g,
      g,
    )][0];
    return row === undefined ? undefined : this.inodeFromRow(row);
  }

  /**
   * Drop snapshot `name`: its row and pin_gen in one transaction, then the
   * history rows no remaining snapshot covers, a page per transaction, each
   * page queuing the references it drops. Refused while a restore or a
   * copy reads from it. Returns the history rows removed.
   */
  dropSnapshot(name: string): { dropped: number } {
    const { id, g } = this.dropJob(name);
    const dropped = this.runDrop(id, g).dropped;
    this.runContentMaintenanceSafely(2);
    return { dropped };
  }

  /** dropSnapshot in slices with a yield between. */
  async dropSnapshotAsync(name: string): Promise<{ dropped: number }> {
    const { id, g } = this.dropJob(name);
    let dropped = 0;
    for (;;) {
      const slice = this.runDrop(id, g, JOB_SLICE_PAGES);
      dropped += slice.dropped;
      if (slice.done) break;
      await yieldToStorage();
    }
    this.runContentMaintenanceSafely(2);
    return { dropped };
  }

  private dropJob(name: string): { id: number; g: number } {
    const g = this.requireSnapshot(name);
    for (const job of [...this.sql.exec("SELECT args FROM vfs_jobs WHERE kind IN ('restore', 'copyTree')")]) {
      const args = JSON.parse(String(job.args)) as { name?: string; at?: string };
      if (args.name === name || args.at === name) throw vfsError('EBUSY', `snapshot ${name} is in use by a job`);
    }
    let id = 0;
    let pinGen = 0;
    this.transactionSync(() => {
      this.sql.exec('DELETE FROM vfs_snapshots WHERE name = ?', name);
      pinGen = Number([...this.sql.exec('SELECT COALESCE(MAX(gen), 0) AS g FROM vfs_snapshots')][0]!.g);
      this.sql.exec('UPDATE vfs_state SET pin_gen = ? WHERE slot = 1', pinGen);
      id = Number([...this.sql.exec(
        `INSERT INTO vfs_jobs (kind, args, cursor, start_gen, created_at) VALUES ('drop', ?, ?, 0, ?) RETURNING id`,
        JSON.stringify({ g }),
        JSON.stringify([g, '']),
        this.now(),
      )][0]!.id);
    });
    this._pinGen = pinGen;
    this.snapshotGens?.delete(name);
    this.hotSnapshotGens.delete(name);
    return { id, g };
  }

  private runDrop(id: number, g: number, maxPages = Infinity): { dropped: number; done: boolean } {
    let [afterGen, afterPath] = JSON.parse(String([...this.sql.exec('SELECT cursor FROM vfs_jobs WHERE id = ?', id)][0]!.cursor)) as [number, string];
    const kept = this.snapshots().map((snap) => snap.gen);
    let dropped = 0;
    for (let pages = 0; ; pages++) {
      if (pages >= maxPages) return { dropped, done: false };
      const page = [...this.sql.exec(
        `SELECT path, gen_to, gen_from, chunk_id, content_id FROM vfs_inode_history
         WHERE (gen_to, path) > (?, ?) ORDER BY gen_to, path LIMIT ?`,
        afterGen,
        afterPath,
        DROP_PAGE_ROWS,
      )];
      const done = page.length < DROP_PAGE_ROWS;
      // Only rows that covered the dropped generation can have lost their last snapshot.
      const dead = page.filter((row) => {
        const from = Number(row.gen_from);
        const to = Number(row.gen_to);
        return from <= g && !kept.some((s) => from <= s && s < to);
      });
      if (page.length > 0) {
        const last = page[page.length - 1]!;
        afterGen = Number(last.gen_to);
        afterPath = String(last.path);
      }
      this.executeMeasuredTransaction(
        this.metricsOnlyPlan({ blobBytes: 0, logicalRows: dead.length * 2 + 1, sqlExecs: 8, affectedPaths: 0 }),
        { source: 'content-gc', limitMode: 'bounded' },
        () => {
          for (let i = 0; i < dead.length; i += KEYS_PER_SQL_EXEC / 2) {
            const batch = dead.slice(i, i + KEYS_PER_SQL_EXEC / 2);
            this.sql.exec(
              `DELETE FROM vfs_inode_history WHERE (path, gen_to) IN (VALUES ${batch.map(() => '(?, ?)').join(',')})`,
              ...batch.flatMap((row) => [row.path, row.gen_to]),
            );
          }
          const queue = new GcQueue();
          for (const row of dead) {
            if (row.chunk_id !== null) queue.add(GC_CHUNK, Number(row.chunk_id));
            if (row.content_id !== null) queue.add(GC_CONTENT, Number(row.content_id));
          }
          this.insertRows('vfs_gc_queue (kind, id)', GC_ROW_COLUMNS, queue.rows(), 'INSERT OR IGNORE');
          if (done) this.sql.exec('DELETE FROM vfs_jobs WHERE id = ?', id);
          else this.sql.exec('UPDATE vfs_jobs SET cursor = ? WHERE id = ?', JSON.stringify([afterGen, afterPath]), id);
        },
      );
      dropped += dead.length;
      if (dead.length > 0) this.maintenancePending = true;
      if (done) return { dropped, done: true };
    }
  }

  /**
   * What changed between two trees of this filesystem: snapshots by name, or
   * `null` for the live tree. Only paths some generation between the two
   * wrote are examined — O(changes), not O(tree) — and content is compared by
   * key, so an equal key proves equal bytes. One page in path order.
   */
  diff(
    from: string | null,
    to: string | null,
    options: { after?: string; limit?: number } = {},
  ): { entries: VfsDiffEntry[]; next: string | null } {
    const ga = from === null ? this._gen : this.requireSnapshot(from);
    const gb = to === null ? this._gen : this.requireSnapshot(to);
    const lo = Math.min(ga, gb);
    const hi = Math.max(ga, gb);
    const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? FS_LIST_PAGE_LIMIT)), FS_LIST_PAGE_LIMIT);
    const after = options.after ?? '';
    const candidates = [...this.sql.exec(
      `SELECT path FROM (
         SELECT path FROM vfs_inodes WHERE gen > ? AND gen <= ?
         UNION SELECT path FROM vfs_inode_history WHERE gen_to > ? AND gen_to <= ?
         UNION SELECT path FROM vfs_inode_history WHERE gen_from > ? AND gen_from <= ?
       ) WHERE path > ? ORDER BY path LIMIT ?`,
      lo, hi, lo, hi, lo, hi,
      after,
      limit + 1,
    )].map((row) => String(row.path));
    const at = (path: string, g: number): INode | undefined => (
      g === this._gen ? this.inodes.get(path) : this.inodeAt(path, g)
    );
    const entries: VfsDiffEntry[] = [];
    for (const path of candidates.slice(0, limit)) {
      const a = at(path, ga);
      const b = at(path, gb);
      if (a === undefined && b === undefined) continue;
      if (a === undefined) { entries.push({ path, change: 'added', type: b!.kind }); continue; }
      if (b === undefined) { entries.push({ path, change: 'removed', type: a.kind }); continue; }
      const sameMeta = a.kind === b.kind && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid && a.size === b.size
        && (a.defaultAcl ?? null) === (b.defaultAcl ?? null);
      const sameRef = a.chunkId === b.chunkId && a.contentId === b.contentId;
      if (sameMeta && (sameRef || a.kind === 'directory' || this.contentKeyOf(a) === this.contentKeyOf(b))) continue;
      entries.push({ path, change: 'modified', type: b.kind });
    }
    return { entries, next: candidates.length > limit ? candidates[limit - 1]! : null };
  }

  /** Jobs in flight: what a reset would resume at the next open. */
  jobs(): { id: number; kind: string; args: unknown; cursor: string }[] {
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
  } {
    const one = (query: string): number => Number([...this.sql.exec(query)][0]!.n);
    return {
      chunks: one('SELECT COUNT(*) AS n FROM vfs_chunks'),
      chunkBytes: one('SELECT COALESCE(SUM(size), 0) AS n FROM vfs_chunks'),
      contents: one('SELECT COUNT(*) AS n FROM vfs_contents'),
      historyRows: one('SELECT COUNT(*) AS n FROM vfs_inode_history'),
      gcQueued: one('SELECT COUNT(*) AS n FROM vfs_gc_queue'),
      snapshots: one('SELECT COUNT(*) AS n FROM vfs_snapshots'),
      jobs: one('SELECT COUNT(*) AS n FROM vfs_jobs'),
      databaseBytes: one('SELECT page_count * page_size AS n FROM pragma_page_count(), pragma_page_size()'),
      ledger: this.ledger.view(),
    };
  }
  /** Bounded rows and manifest fragments; cursors are opaque (path, byte offset) positions. */
  exportPage(options: { at: string; root?: string; after?: string | null; limit?: number }): VfsExportPage {
    const g = this.requireSnapshot(options.at);
    const nextIno = Number([...this.sql.exec('SELECT next_ino FROM vfs_state WHERE slot = 1')][0]!.next_ino);
    const source = `${this._epoch}:${g}`;
    const root = normalizeVfsPath(options.root ?? '');
    const after = options.after ?? null;
    const start = readExportCursor(after);
    const limit = Math.max(1, Math.min(EXPORT_PAGE_ROWS, Math.trunc(options.limit ?? EXPORT_PAGE_ROWS)));
    const range = subtreeRange(root);
    const rows: VfsExportRow[] = [];
    const envelopeBytes = enc.encode(JSON.stringify({ schema: VFS_EXPORT_SCHEMA, source, root, nextIno, after, rows, next: null })).byteLength;
    let rowBytes = 0;
    let pieces = 0;
    let next: string | null = null;
    let lastPath = start === null ? root : (start[0] === '' ? root : (root === '' ? start[0] : `${root}/${start[0]}`));
    let partial = false;
    const take = (inode: INode, offset = 0): boolean => {
      if (rows.length === limit) return false;
      const relative = inode.path === root ? '' : (root === '' ? inode.path : inode.path.slice(root.length + 1));
      const cursorBytes = enc.encode(JSON.stringify(exportCursor(relative, Math.max(10, inode.size)))).byteLength;
      const allowance = EXPORT_FRAME_BYTES - envelopeBytes - rowBytes - (rows.length > 0 ? 1 : 0) - (cursorBytes - 4);
      const fragment = this.exportRow(inode, relative, offset, EXPORT_PAGE_PIECES - pieces, allowance);
      if (fragment === null) {
        if (rows.length === 0) throw vfsError('E2BIG', `${inode.path}: export metadata cannot fit one frame`);
        return false;
      }
      rowBytes += fragment.bytes + (rows.length > 0 ? 1 : 0);
      rows.push(fragment.row);
      pieces += fragment.row.pieces.length;
      partial = fragment.offset < inode.size;
      next = exportCursor(relative, partial ? fragment.offset : -1);
      lastPath = inode.path;
      return true;
    };
    if (start !== null && start[1] >= 0) {
      const inode = this.inodeAt(lastPath, g);
      if (inode === undefined || inode.isDir) throw vfsError('EINVAL', 'manifest cursor does not name a file');
      take(inode, start[1]);
      if (partial) return { schema: VFS_EXPORT_SCHEMA, source, root, nextIno, after, rows, next };
    } else if (root !== '' && start === null) {
      const inode = this.inodeAt(root, g);
      if (inode === undefined) throw vfsError('ENOENT', root);
      take(inode);
      if (partial) return { schema: VFS_EXPORT_SCHEMA, source, root, nextIno, after, rows, next };
      if (!inode.isDir) return { schema: VFS_EXPORT_SCHEMA, source, root, nextIno, after, rows, next: null };
    }
    const key = SqliteVFS.comparePaths(lastPath, range.lower) < 0 ? range.lower : lastPath;
    let exhausted = true;
    for (const inode of this.pageAt(g, key, limit + 1, range.upper)) {
      if (!take(inode)) { exhausted = false; break; }
      if (partial) { exhausted = false; break; }
    }
    return { schema: VFS_EXPORT_SCHEMA, source, root, nextIno, after, rows, next: exhausted ? null : next };
  }

  private exportRow(inode: INode, path: string, offset: number, maximum: number, byteLimit: number): { row: VfsExportRow; bytes: number; offset: number } | null {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > inode.size) throw vfsError('EINVAL', 'invalid manifest offset');
    const row: VfsExportRow = {
      path, ino: inode.ino, kind: inode.kind, size: inode.size, mode: inode.mode,
      uid: inode.uid, gid: inode.gid, defaultAcl: inode.defaultAcl ?? null,
      atime: inode.atime, mtime: inode.mtime, contentKey: inode.isDir ? null : this.contentKeyOf(inode),
      manifest: inode.contentId !== null, pieceOffset: offset, pieces: [],
    };
    let bytes = enc.encode(JSON.stringify(row)).byteLength;
    if (bytes > byteLimit) return null;
    let position = offset;
    const append = (hash: string, length: number): boolean => {
      const cost = hash.length + String(length).length + 5 + (row.pieces.length > 0 ? 1 : 0);
      if (row.pieces.length === maximum || bytes + cost > byteLimit) return false;
      row.pieces.push([hash, length]);
      bytes += cost;
      position += length;
      return true;
    };
    if (inode.chunkId !== null) {
      if (offset !== 0) throw vfsError('EINVAL', 'chunk cursor must start at zero');
      const chunk = [...this.sql.exec('SELECT hash, size FROM vfs_chunks WHERE id = ?', inode.chunkId)][0];
      if (!chunk) throw vfsError('EIO', `${inode.path}: missing chunk`);
      if (!append(hex(this.blobToUint8Array(chunk.hash)), Number(chunk.size))) return null;
    } else if (inode.contentId !== null) {
      for (const piece of this.sql.exec(
        `SELECT cc.off, cc.len, c.hash FROM vfs_content_chunks cc JOIN vfs_chunks c ON c.id = cc.chunk_id
         WHERE cc.content_id = ? AND cc.off >= ? ORDER BY cc.off LIMIT ?`, inode.contentId, offset, maximum + 1,
      )) {
        if (Number(piece.off) !== position) throw vfsError('EINVAL', 'manifest cursor is not at a chunk boundary');
        if (!append(hex(this.blobToUint8Array(piece.hash)), Number(piece.len))) break;
      }
      if (position === offset && offset < inode.size) return null;
    }
    if (position > inode.size) throw vfsError('EIO', `${inode.path}: manifest exceeds file size`);
    return { row, bytes, offset: position };
  }

  /**
   * sha256 over a page's rows (path, metadata, chunk hashes): equal digests
   * mean equal trees for that page, so two databases compare page by page
   * and only a differing page is compared row by row. Memoized by snapshot
   * generation, since a snapshot's rows never change.
   */
  pageDigest(options: { at: string; root?: string; after?: string | null; limit?: number }): { digest: string; next: string | null } {
    const g = this.requireSnapshot(options.at);
    const key = JSON.stringify([g, normalizeVfsPath(options.root ?? ''), options.after ?? null, options.limit ?? EXPORT_PAGE_ROWS]);
    const memo = this.pageDigests.get(key);
    if (memo !== undefined) return memo;
    const page = this.exportPage(options);
    const hash = createHash('sha256');
    for (const row of page.rows) {
      hash.update(enc.encode(`${JSON.stringify([row.path, row.kind, row.size, row.mode, row.uid, row.gid, row.mtime, row.defaultAcl, row.contentKey, row.pieceOffset, row.pieces])}\n`));
    }
    const result = { digest: hex(new Uint8Array(hash.digest())), next: page.next };
    if (this.pageDigests.size >= PAGE_DIGEST_MEMO_ENTRIES) this.pageDigests.clear();
    this.pageDigests.set(key, result);
    return result;
  }

  /** The chunk hashes a page names that this database does not hold. */
  wantChunks(page: VfsExportPage): string[] {
    const named = new Set<string>();
    for (const row of page.rows) for (const [hash] of row.pieces) named.add(hash);
    return this.absentChunks([...named]);
  }

  private absentChunks(hashes: readonly string[]): string[] {
    const present = new Set<string>();
    for (let i = 0; i < hashes.length; i += KEYS_PER_SQL_EXEC) {
      const batch = hashes.slice(i, i + KEYS_PER_SQL_EXEC);
      for (const row of this.sql.exec(
        `SELECT hash FROM vfs_chunks WHERE state = ${CHUNK_LOCAL} AND hash IN (${batch.map(() => '?').join(',')})`,
        ...batch.map(unhex),
      )) present.add(hex(this.blobToUint8Array(row.hash)));
    }
    return hashes.filter((hash) => !present.has(hash));
  }

  /**
   * The bytes of chunks by hash, up to `maxBytes` (at least one chunk) and at
   * most EXPORT_PAGE_PIECES chunks (a page names no more, so tiny chunks cannot
   * make an object frame past the reference budget); `rest` is what did not
   * fit. ENOENT for a hash this database lacks.
   */
  exportChunks(hashes: readonly string[], maxBytes = EXPORT_FRAME_BYTES): { chunks: VfsExportChunk[]; rest: string[] } {
    const chunks: VfsExportChunk[] = [];
    let bytes = 0;
    let index = 0;
    for (const hash of hashes) {
      if (chunks.length === EXPORT_PAGE_PIECES) break;
      const row = [...this.sql.exec('SELECT size, data, state FROM vfs_chunks WHERE hash = ?', unhex(hash))][0];
      if (!row) throw vfsError('ENOENT', `chunk ${hash}`);
      if (Number(row.state) !== CHUNK_LOCAL) throw coldChunkError(`chunk ${hash}`);
      if (chunks.length > 0 && bytes + Number(row.size) > maxBytes) break;
      const data = this.blobToUint8Array(row.data);
      chunks.push({ hash, data });
      bytes += data.byteLength;
      index++;
    }
    return { chunks, rest: hashes.slice(index) };
  }

  /**
   * Where an import into `dst` stands: the relative path of the last row
   * committed (resume with exportPage({ after })), '' when only the root
   * is, null when nothing is. Rows commit in path order, so this is exact
   * after a reset.
   */
  importCursor(dst: string): string | null {
    const target = normalizeVfsPath(dst);
    const job = this.importJob(target);
    if (job !== undefined) {
      if (job.cursor === '') return null;
      return job.cursor;
    }
    // Nothing an unreachable dst holds is an import's progress.
    if (target !== '' && !this.reachable(target)) return null;
    const range = subtreeRange(target);
    const last = range.upper === null
      ? [...this.sql.exec('SELECT MAX(path) AS path FROM vfs_inodes')][0]
      : [...this.sql.exec('SELECT MAX(path) AS path FROM vfs_inodes WHERE path > ? AND path < ?', range.lower, range.upper)][0];
    if (last?.path !== null && last?.path !== undefined) {
      const path = String(last.path);
      return exportCursor(target === '' ? path : path.slice(target.length + 1));
    }
    return this.inodes.get(target) ? exportCursor('') : null;
  }

  /**
   * Write one exported page under `dst`. The first page of an import needs
   * `dst` absent or an empty directory, and records a vfs_jobs row naming
   * its export (`page.source`); later pages of that export continue it, and
   * rows at or before importCursor(dst) are skipped, so a page replayed
   * after a reset is harmless. A page of another export is refused while the
   * import is open. Removing dst, or a directory above it, abandons the
   * import in the same transaction: its job and staging go, a new import
   * into dst starts clean, and a later page of the old one is refused. Every
   * chunk given is re-hashed before anything is written; if the page names a
   * chunk neither given nor stored, nothing is written and `want` lists what
   * to send. Files too large for one transaction stage across several.
   */
  importPage(
    dst: string,
    page: VfsExportPage,
    chunks: Iterable<VfsExportChunk> = [],
    options: { lazy?: boolean } = {},
  ): { imported: number; want: string[]; done: boolean; pending: string[] } {
    // N18: the page's rows and the bytes it brings are admitted and reserved
    // before its first transaction, which then draw from the reservation.
    // Collected under the frame bound as it is pulled: bytes against the frame,
    // objects against the page's own reference budget (a page names at most
    // EXPORT_PAGE_PIECES chunks, so a valid frame never carries more), and an
    // empty chunk is not a chunk. An iterable larger than that, or one that
    // never ends, stops at the first chunk past the budget.
    const pieces = Array.isArray(page?.rows) ? page.rows.reduce((sum, row) => sum + (row.pieces?.length ?? 0), 0) : 0;
    if (pieces > EXPORT_PAGE_PIECES) throw vfsError('E2BIG', 'import metadata frame exceeds its budget');
    const given: VfsExportChunk[] = [];
    let bytes = 0;
    for (const chunk of chunks) {
      if (chunk.data.byteLength === 0) throw vfsError('EINVAL', `chunk ${chunk.hash} is empty`);
      bytes += chunk.data.byteLength;
      if (bytes > EXPORT_FRAME_BYTES || given.length === pieces) throw vfsError('E2BIG', 'import chunk frame exceeds its budget');
      given.push(chunk);
    }
    const rows = (Array.isArray(page?.rows) ? page.rows.length : 0) + pieces + 2;
    const reservation = crypto.randomUUID();
    this.ledger.reserve(reservation, bytes + rows * LEDGER_ROW_BYTES);
    try {
      return this.withReservation(reservation, () => this.importPageNow(dst, page, given, options.lazy === true));
    } finally {
      this.ledger.release(reservation);
    }
  }

  private importPageNow(dst: string, page: VfsExportPage, chunks: Iterable<VfsExportChunk>, lazy: boolean): { imported: number; want: string[]; done: boolean; pending: string[] } {
    if (page.schema !== VFS_EXPORT_SCHEMA) throw vfsError('EINVAL', `export schema ${page.schema}, expected ${VFS_EXPORT_SCHEMA}`);
    if (page.rows.length > EXPORT_PAGE_ROWS || page.rows.reduce((n, row) => n + row.pieces.length, 0) > EXPORT_PAGE_PIECES
        || enc.encode(JSON.stringify(page)).byteLength > EXPORT_FRAME_BYTES) throw vfsError('E2BIG', 'import metadata frame exceeds its budget');
    const target = normalizeVfsPath(dst);
    this.assertMutationsAllowed([target]);
    if (!Number.isSafeInteger(page.nextIno) || page.nextIno < 2 || typeof page.root !== 'string'
        || typeof page.source !== 'string' || page.source === '') throw vfsError('EINVAL', 'invalid import identity header');
    const job = this.importJob(target);
    // Every page of an import comes from the export its first page did. A job
    // no page has written yet (importChunks began it) takes the first page's.
    if (job !== undefined && job.source !== page.source && (job.source !== undefined || job.cursor !== '')) {
      throw vfsError('EINVAL', `${target}: an import of another export is open here; remove it to import again`);
    }
    const storedCursor = job === undefined && page.after === null ? null : this.importCursor(target);
    const cursor = readExportCursor(storedCursor);
    const from = readExportCursor(page.after);
    const full = (path: string): string => path === '' ? target : (target === '' ? path : `${target}/${path}`);
    const compare = (a: [string, number] | null, b: [string, number] | null): number => {
      if (a === null || b === null) return a === b ? 0 : a === null ? -1 : 1;
      const byPath = SqliteVFS.comparePaths(a[0], b[0]);
      if (byPath !== 0) return byPath;
      const x = a[1] === -1 ? Infinity : a[1], y = b[1] === -1 ? Infinity : b[1];
      return x === y ? 0 : x < y ? -1 : 1;
    };
    if (compare(from, cursor) > 0) throw vfsError('EINVAL', 'import page skips uncommitted progress');
    const rows = page.rows.filter((row) => cursor === null || SqliteVFS.comparePaths(row.path, cursor[0]) > 0 || (row.path === cursor[0] && cursor[1] >= 0));
    // A continued page writes only into an open import. Without one, dst holds
    // a finished import (whose replay writes nothing) or whatever replaced an
    // abandoned one, which is not that import's to write into.
    if (job === undefined && page.after !== null && rows.length > 0) throw vfsError('EINVAL', `${target}: no import is open here to continue`);
    if (job === undefined && page.after === null) this.assertImportTarget(target);
    const identity = this.importIdentity(target, page, job, rows);
    const given = new Map<string, Uint8Array>();
    for (const chunk of chunks) {
      if (hex(chunkHash(chunk.data)) !== chunk.hash) throw vfsError('EINVAL', `chunk ${chunk.hash} does not hash to its name`);
      given.set(chunk.hash, chunk.data);
    }
    const lengths = new Map<string, number>();
    const finalDigests = new Map<string, Uint8Array>();
    let pending = job?.pending;
    let lastPath: string | undefined;
    for (const row of page.rows) {
      if (lastPath !== undefined && SqliteVFS.comparePaths(row.path, lastPath) <= 0) throw vfsError('EINVAL', 'import rows are not strictly ordered');
      lastPath = row.path;
      if (!Number.isSafeInteger(row.size) || row.size < 0 || !Number.isSafeInteger(row.pieceOffset) || row.pieceOffset < 0
          || row.pieceOffset > row.size || (row.kind === 'directory' ? row.contentKey !== null : !/^[0-9a-f]{64}$/.test(row.contentKey ?? ''))) {
        throw vfsError('EINVAL', `${row.path}: invalid manifest metadata`);
      }
      let end = row.pieceOffset;
      for (const [hash, length] of row.pieces) {
        const known = lengths.get(hash), supplied = given.get(hash);
        if (!/^[0-9a-f]{64}$/.test(hash) || !Number.isSafeInteger(length) || length <= 0
            || (known !== undefined && known !== length)) throw vfsError('EINVAL', `${row.path}: invalid chunk reference`);
        if (supplied !== undefined && supplied.byteLength !== length) throw vfsError('EINVAL', `${row.path}: chunk size differs`);
        lengths.set(hash, length);
        end += length;
      }
      if (!Number.isSafeInteger(end) || end > row.size || (end === row.pieceOffset && end !== row.size)
          || (row.kind === 'directory' && (row.size !== 0 || row.pieces.length !== 0 || row.manifest))
          || (!row.manifest && (row.pieceOffset !== 0 || end !== row.size || row.pieces.length > 1 || row.size > CHUNK_SIZE))) {
        throw vfsError('EINVAL', `${row.path}: invalid manifest extent`);
      }
      const already = cursor !== null && (SqliteVFS.comparePaths(row.path, cursor[0]) < 0 || (row.path === cursor[0] && cursor[1] === -1));
      if (already) {
        const inode = this.inodes.get(full(row.path));
        const expected = this.importedEntry(full(row.path), row, { type: 'none' });
        if (!inode || inode.kind !== row.kind || inode.size !== row.size || (inode.mode & 0o7777) !== (expected.mode & 0o7777)
            || inode.uid !== row.uid || inode.gid !== expected.gid || inode.mtime !== row.mtime
            || (inode.defaultAcl ?? null) !== expected.defaultAcl || (row.kind !== 'directory' && this.contentKeyOf(inode) !== row.contentKey)) {
          throw vfsError('EINVAL', `${row.path}: replay metadata differs`);
        }
        continue;
      }
      if (pending !== undefined && (pending.path !== row.path || pending.meta !== importRowMeta(row))) throw vfsError('EINVAL', 'pending manifest metadata changed');
      const committed = pending?.offset ?? 0;
      if (row.pieceOffset > committed) throw vfsError('EINVAL', `${row.path}: manifest fragment is out of order`);
      let position = row.pieceOffset;
      if (pending !== undefined && position < committed) {
        const old = [...this.sql.exec(
          `SELECT cc.off, cc.len, c.hash FROM vfs_content_chunks cc JOIN vfs_chunks c ON c.id = cc.chunk_id
           WHERE cc.content_id = ? AND cc.off >= ? AND cc.off < ? ORDER BY cc.off LIMIT ?`, pending.content, position, Math.min(end, committed), EXPORT_PAGE_PIECES + 1,
        )];
        let index = 0;
        for (const [hash, length] of row.pieces) {
          if (position >= committed) break;
          const prior = old[index++];
          if (!prior || Number(prior.off) !== position || Number(prior.len) !== length || hex(this.blobToUint8Array(prior.hash)) !== hash
              || position + length > committed) throw vfsError('EINVAL', `${row.path}: replayed manifest differs`);
          position += length;
        }
        if (index !== old.length) throw vfsError('EINVAL', `${row.path}: replay extent differs`);
      }
      if (end === row.size) {
        if (row.manifest) {
          const digest = pending === undefined ? new ManifestDigest() : this.manifestDigest(pending.content);
          let at = row.pieceOffset;
          for (const [hash, length] of row.pieces) { if (at >= committed) digest.add(unhex(hash)); at += length; }
          const bytes = digest.digest(row.size);
          if (hex(bytes) !== row.contentKey) throw vfsError('EINVAL', `${row.path}: manifest digest differs`);
          finalDigests.set(row.path, bytes);
        } else if (row.kind !== 'directory' && (row.pieces[0]?.[0] ?? hex(EMPTY_CONTENT_KEY)) !== row.contentKey) {
          throw vfsError('EINVAL', `${row.path}: content key differs`);
        }
        pending = undefined;
      } else {
        if (row !== page.rows[page.rows.length - 1] || page.next === null) throw vfsError('EINVAL', 'incomplete manifest must end a continued page');
      }
    }
    const keys = [...lengths.keys()];
    for (let offset = 0; offset < keys.length; offset += KEYS_PER_SQL_EXEC) {
      const batch = keys.slice(offset, offset + KEYS_PER_SQL_EXEC);
      for (const row of this.sql.exec(`SELECT hash, size FROM vfs_chunks WHERE hash IN (${batch.map(() => '?').join(',')})`, ...batch.map(unhex))) {
        if (lengths.get(hex(this.blobToUint8Array(row.hash))) !== Number(row.size)) throw vfsError('EINVAL', 'stored chunk size differs');
      }
    }
    if (page.next !== null) {
      const last = page.rows[page.rows.length - 1];
      if (!last) throw vfsError('EINVAL', 'continued page has no rows');
      const end = last.pieceOffset + last.pieces.reduce((n, piece) => n + piece[1], 0);
      if (page.next !== exportCursor(last.path, end < last.size ? end : -1)) throw vfsError('EINVAL', 'page cursor differs from its rows');
    }
    if (rows.length === 0 && job === undefined && page.after !== null) return { imported: 0, want: [], done: page.next === null, pending: [] };
    const wanted = this.absentChunks(keys);
    const missing: { hash: string; size: number }[] = [];
    for (const hash of wanted) {
      const size = lengths.get(hash);
      if (size !== undefined && !given.has(hash)) missing.push({ hash, size });
    }
    if (missing.length && !lazy) return { imported: 0, want: missing.map(({ hash }) => hash), done: false, pending: [] };
    this.revokeSharedDirectories(target);
    if (lazy) this.insertPendingChunks(missing);
    const jobId = job?.id ?? this.beginImport(target);
    const placement = job ?? this.importPlacement(target);
    const state: z.infer<typeof ImportJobArgsSchema> = {
      dst: target, source: page.source, parentIno: placement.parentIno, dstIno: placement.dstIno,
      ...identity, ...(job?.pending === undefined ? {} : { pending: job.pending }), ...(job?.ahead === undefined ? {} : { ahead: job.ahead }),
    };
    // The entry that creates dst, if this page does: its inode is recorded
    // with the commit that makes it (importPlaced).
    let dstEntry: StoredInodeEntry | undefined;
    if (job?.sourceNextIno === undefined) this.transactionSync(() => {
      if (identity.preserveInos) {
        this.ensureImportIdentityIndexes();
        this.sql.exec('UPDATE vfs_state SET next_ino = MAX(next_ino, ?) WHERE slot = 1', identity.sourceNextIno);
      }
      this.sql.exec('UPDATE vfs_jobs SET args = ? WHERE id = ?', JSON.stringify(state), jobId);
    });
    let progress = storedCursor;
    let imported = 0;
    const save = (): void => {
      if (state.dstIno === undefined && dstEntry?.ino !== undefined) state.dstIno = dstEntry.ino;
      this.sql.exec('UPDATE vfs_jobs SET args = ?, cursor = ? WHERE id = ?', JSON.stringify(state), progress ?? '', jobId);
    };
    const commit = (plan: TransactionPlan): void => {
      this.assertTransactionFits(withCommitRowMetrics(plan.metrics));
      if (plan.inodes.length) this._writeBatchOnce({ plan, deletedInodes: [] }, { source: 'content-publish', limitMode: 'bounded' }, save);
      else this.executeTransactionPlan(plan, { source: 'content-stage', limitMode: 'bounded' }, save);
    };
    if (target !== '' && this.inodes.get(target) === undefined && !rows.some((row) => row.path === '')) {
      const root = this.newPlan(true);
      dstEntry = this.importedEntry(target, { path: '', ino: ROOT_INODE, kind: 'directory', size: 0, mode: 0o755, uid: 0, gid: 0,
        defaultAcl: null, atime: this.now(), mtime: this.now(), manifest: false, contentKey: null, pieceOffset: 0, pieces: [] }, { type: 'none' });
      root.addInode(dstEntry);
      commit(root.build());
    }
    for (const row of rows) {
      const path = full(row.path);
      const occupied = this.inodes.get(path);
      if (occupied && row.path !== '' && (!identity.preserveInos || occupied.ino !== row.ino)) throw vfsError('EEXIST', `${path}: import path became occupied`);
      const previous = state.pending;
      const already = previous?.offset ?? 0;
      let position = row.pieceOffset;
      const pieces: ImportedPiece[] = [];
      for (const [hash, size] of row.pieces) {
        if (position >= already) pieces.push({ hash: unhex(hash), size, data: given.get(hash) ?? null });
        position += size;
      }
      const complete = position === row.size;
      const digest = finalDigests.get(row.path);
      if (row.manifest && complete && digest === undefined) throw vfsError('EIO', `${row.path}: completed manifest has no verified digest`);
      const blobBytes = pieces.reduce((n, piece) => n + (piece.data?.byteLength ?? 0), 0);
      if (row.manifest && (previous !== undefined || !complete || pieces.length > IMPORT_INLINE_PIECES || blobBytes > MAX_TX_BLOB_BYTES / 2)) {
        const staging: StagingContent = { id: previous?.content ?? 0, size: previous?.offset ?? 0,
          count: previous?.count ?? 0, hashed: false, digest: new ManifestDigest(), durable: true };
        let part = this.newPlan(true);
        const flush = (): void => {
          if (part.empty) return;
          const plan = part.build(); part = this.newPlan(true);
          const prior = state.pending;
          this.assertTransactionFits(withCommitRowMetrics(plan.metrics));
          this.executeTransactionPlan(plan, { source: 'content-stage', limitMode: 'bounded' }, () => {
            state.pending = { path: row.path, meta: importRowMeta(row), content: staging.id, offset: staging.size, count: staging.count };
            progress = exportCursor(row.path, staging.size);
            save();
          });
          if (prior && prior.content !== staging.id) throw vfsError('EIO', 'import staging identity changed');
        };
        for (const piece of pieces) {
          if (part.wouldExceedPieces(piece.data?.byteLength ?? 0, 1) !== null) flush();
          part.addStagedImport(staging, piece, path);
        }
        flush();
        if (!complete) continue;
        const publish = this.newPlan(true);
        const entry = this.importedEntry(path, row, { type: 'staged', content: staging, digest }, identity.preserveInos ? row.ino : undefined);
        if (row.path === '') dstEntry = entry;
        publish.addInode(entry);
        state.pending = undefined; progress = exportCursor(row.path);
        commit(publish.build());
      } else {
        const plan = this.newPlan(true);
        const content: InodeContent = row.kind === 'directory' || row.size === 0 ? { type: 'none' }
          : { type: 'imported', pieces, size: row.size, manifest: row.manifest, digest: digest ?? null };
        const entry = this.importedEntry(path, row, content, identity.preserveInos ? row.ino : undefined);
        if (row.path === '') dstEntry = entry;
        plan.addInode(entry);
        progress = exportCursor(row.path);
        commit(plan.build());
      }
      imported++;
    }
    if (page.next === null && state.pending !== undefined) throw vfsError('EINVAL', 'import ends inside a manifest');
    const done = page.next === null;
    if (done) {
      this.transactionSync(() => {
        this.sql.exec('DELETE FROM vfs_jobs WHERE id = ?', jobId);
        // The chunks sent ahead are named by the rows now, or collected.
        if (state.ahead !== undefined) this.sql.exec('INSERT OR IGNORE INTO vfs_gc_queue (kind, id) VALUES (?, ?)', GC_CONTENT, state.ahead);
        this.dropUnusedImportIdentityIndexes();
      });
      if (state.ahead !== undefined) this.maintenancePending = true;
    }
    this.runContentMaintenanceSafely(1);
    return { imported, want: [], done, pending: missing.map(({ hash }) => hash) };
  }

  private ensureImportIdentityIndexes(): void {
    const names = new Set([...this.sql.exec("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('vfs_inodes_ino', 'vfs_history_ino')")].map((row) => String(row.name)));
    if (!names.has('vfs_inodes_ino')) {
      if ([...this.sql.exec('SELECT 1 FROM vfs_inodes LIMIT 1')].length) throw vfsError('EIO', 'active import lost its inode index');
      this.sql.exec('CREATE INDEX vfs_inodes_ino ON vfs_inodes(ino)');
    }
    if (!names.has('vfs_history_ino')) {
      if ([...this.sql.exec('SELECT 1 FROM vfs_inode_history LIMIT 1')].length) throw vfsError('EIO', 'active import lost its history index');
      this.sql.exec('CREATE INDEX vfs_history_ino ON vfs_inode_history(ino)');
    }
  }

  private dropUnusedImportIdentityIndexes(): void {
    if ([...this.sql.exec("SELECT 1 FROM vfs_jobs WHERE kind = 'import' AND json_extract(args, '$.preserveInos') = 1 LIMIT 1")].length) return;
    this.sql.exec('DROP INDEX IF EXISTS vfs_inodes_ino');
    this.sql.exec('DROP INDEX IF EXISTS vfs_history_ino');
  }

  private importIdentity(target: string, page: VfsExportPage, job: ReturnType<SqliteVFS["importJob"]>, rows: VfsExportRow[]): { sourceRoot: string; sourceNextIno: number; preserveInos: boolean } {
    const full = (path: string): string => path === "" ? target : (target === "" ? path : target + "/" + path);
    const sourceRoot = normalizeVfsPath(page.root);
    const sourceNextIno = job?.sourceNextIno ?? page.nextIno;
    if (page.nextIno < sourceNextIno || (job?.sourceRoot !== undefined && sourceRoot !== job.sourceRoot)) {
      throw vfsError('EINVAL', 'import source identity changed');
    }
    const stateNextIno = Number([...this.sql.exec('SELECT next_ino FROM vfs_state WHERE slot = 1')][0]!.next_ino);
    const preserveInos = job?.preserveInos ?? (target === '' && sourceRoot === '' && stateNextIno === 2
      && this.openNodes.size === 0
      && [...this.sql.exec('SELECT 1 FROM vfs_inodes LIMIT 1')].length === 0
      && [...this.sql.exec('SELECT 1 FROM vfs_inode_history LIMIT 1')].length === 0
      && [...this.sql.exec('SELECT 1 FROM vfs_snapshots LIMIT 1')].length === 0
      && [...this.sql.exec('SELECT 1 FROM vfs_jobs WHERE id != ? LIMIT 1', job?.id ?? -1)].length === 0);
    const ids = new Set<number>();
    for (const row of page.rows) {
      if (row.defaultAcl !== null && (row.kind !== 'directory' || !Number.isSafeInteger(row.defaultAcl) || row.defaultAcl < 0 || row.defaultAcl > 0o777)) {
        throw vfsError('EINVAL', `${row.path}: invalid default ACL`);
      }
      if (!Number.isSafeInteger(row.ino) || row.ino <= ROOT_INODE || row.ino >= sourceNextIno || ids.has(row.ino)
          || (preserveInos && row.path === '')) throw vfsError('EINVAL', `${row.path}: invalid or duplicate import inode`);
      ids.add(row.ino);
    }
    if (preserveInos) {
      const byId = new Map(rows.map((row) => [row.ino, full(row.path)]));
      for (const opened of this.openNodes) {
        const path = byId.get(opened.inode.ino);
        if (path !== undefined && opened.path !== path) throw vfsError('EEXIST', `import inode ${opened.inode.ino} is held by another open description`);
      }
      const entries = [...byId];
      const perBatch = Math.floor(KEYS_PER_SQL_EXEC / 2);
      for (let offset = 0; offset < entries.length; offset += perBatch) {
        const batch = entries.slice(offset, offset + perBatch);
        const values: (number | string)[] = [];
        for (const [ino, path] of batch) values.push(ino, path);
        const supplied = `WITH incoming(ino, path) AS (VALUES ${batch.map(() => '(?, ?)').join(',')})`;
        for (const existing of this.sql.exec(
          `${supplied} SELECT v.ino FROM incoming i JOIN vfs_inodes v ON v.ino = i.ino WHERE v.path != i.path LIMIT 1`, ...values,
        )) throw vfsError('EEXIST', `import inode ${String(existing.ino)} already names another path`);
        for (const pinned of this.sql.exec(
          `${supplied} SELECT h.ino FROM incoming i JOIN vfs_inode_history h ON h.ino = i.ino WHERE h.path != i.path
           AND EXISTS (SELECT 1 FROM vfs_snapshots s WHERE s.gen >= h.gen_from AND s.gen < h.gen_to) LIMIT 1`, ...values,
        )) throw vfsError('EEXIST', `import inode ${String(pinned.ino)} is pinned at another path`);
      }
      for (const row of rows) {
        const existing = this.inodes.get(full(row.path));
        if (existing !== undefined && existing.ino !== row.ino) throw vfsError('EEXIST', `${row.path}: another inode occupies the import path`);
      }
    }
    if (!Number.isSafeInteger(Math.max(stateNextIno, preserveInos ? sourceNextIno : 2) + rows.length + 1)) {
      throw vfsError('EINVAL', 'import inode high-water leaves no safe allocator range');
    }
    return { sourceRoot, sourceNextIno, preserveInos };
  }

  /**
   * Rows for chunks a lazy import names without bytes (N17): hash and size,
   * no data, state pending. Each is queued for collection too, so one that
   * no committed row comes to name is not kept.
   */
  private insertPendingChunks(chunks: readonly { hash: string; size: number }[]): void {
    for (let i = 0; i < chunks.length; i += KEYS_PER_SQL_EXEC) {
      const batch = chunks.slice(i, i + KEYS_PER_SQL_EXEC);
      this.executeMeasuredTransaction(
        this.metricsOnlyPlan({ blobBytes: 0, logicalRows: batch.length * 2 + 1, sqlExecs: batch.length * 2 + 1, affectedPaths: 0 }),
        { source: 'content-stage', limitMode: 'bounded' },
        () => {
          const state = [...this.sql.exec('UPDATE vfs_state SET next_chunk = next_chunk + ? WHERE slot = 1 RETURNING next_chunk', batch.length)][0]!;
          let id = Number(state.next_chunk) - batch.length;
          for (const chunk of batch) {
            const inserted = [...this.sql.exec(
              `INSERT OR IGNORE INTO vfs_chunks (id, hash, size, data, state) VALUES (?, ?, ?, x'', ${CHUNK_PENDING}) RETURNING id`,
              id++, unhex(chunk.hash), chunk.size,
            )];
            if (inserted.length > 0) this.sql.exec('INSERT OR IGNORE INTO vfs_gc_queue (kind, id) VALUES (?, ?)', GC_CHUNK, Number(inserted[0]!.id));
          }
        },
      );
    }
  }

  /**
   * Store the bytes of pending chunks (N17), each re-hashed first. A chunk
   * whose bytes do not hash to its name is not stored and is reported in
   * `invalid`; the rest of the batch is stored. A chunk that is not pending
   * (stored already, or collected) is skipped.
   */
  hydrateChunks(chunks: Iterable<VfsExportChunk>): { stored: string[]; invalid: string[] } {
    const stored: string[] = [];
    const invalid: string[] = [];
    let group: VfsExportChunk[] = [];
    let groupBytes = 0;
    const flush = (): void => {
      if (group.length === 0) return;
      const rows = group;
      this.executeMeasuredTransaction(
        this.metricsOnlyPlan({ blobBytes: groupBytes, logicalRows: rows.length, sqlExecs: rows.length, affectedPaths: 0 }),
        { source: 'content-stage', limitMode: 'bounded' },
        () => {
          for (const row of rows) {
            const done = [...this.sql.exec(
              `UPDATE vfs_chunks SET data = ?, state = ${CHUNK_LOCAL} WHERE hash = ? AND state = ${CHUNK_PENDING} RETURNING 1`,
              row.data, unhex(row.hash),
            )].length > 0;
            if (done) stored.push(row.hash);
          }
        },
      );
      group = [];
      groupBytes = 0;
    };
    for (const chunk of chunks) {
      if (hex(chunkHash(chunk.data)) !== chunk.hash) { invalid.push(chunk.hash); continue; }
      if (group.length > 0 && (groupBytes + chunk.data.byteLength > MAX_TX_BLOB_BYTES || group.length >= MAX_TX_SQL_EXECS - 4)) flush();
      group.push(chunk);
      groupBytes += chunk.data.byteLength;
    }
    flush();
    return { stored, invalid };
  }

  /** Which of `hashes` (hex) are pending chunks (N17). */
  pendingOf(hashes: readonly string[]): string[] {
    const pending = new Set<string>();
    for (let i = 0; i < hashes.length; i += KEYS_PER_SQL_EXEC) {
      const batch = hashes.slice(i, i + KEYS_PER_SQL_EXEC);
      for (const row of this.sql.exec(
        `SELECT hash FROM vfs_chunks WHERE state = ${CHUNK_PENDING} AND hash IN (${batch.map(() => '?').join(',')})`,
        ...batch.map(unhex),
      )) pending.add(hex(this.blobToUint8Array(row.hash)));
    }
    return hashes.filter((hash) => pending.has(hash));
  }

  /**
   * The pending chunks (N17) `path`'s bytes name, in the file's order (a
   * hash once per file), as hex; none for a path with none, or no file.
   */
  pendingChunksOf(path: string): string[] {
    const inode = this.inodes.get(normalizeVfsPath(path));
    if (inode === undefined || inode.kind !== 'file') return [];
    const rows = inode.contentId !== null && inode.contentId !== undefined
      ? [...this.sql.exec(
        `SELECT c.hash FROM vfs_content_chunks m JOIN vfs_chunks c ON c.id = m.chunk_id WHERE m.content_id = ? AND c.state = ${CHUNK_PENDING} ORDER BY m.off`,
        inode.contentId,
      )]
      : inode.chunkId !== null && inode.chunkId !== undefined
        ? [...this.sql.exec(`SELECT hash FROM vfs_chunks WHERE id = ? AND state = ${CHUNK_PENDING}`, inode.chunkId)]
        : [];
    return [...new Set(rows.map((row) => hex(this.blobToUint8Array(row.hash))))];
  }

  /**
   * Store chunks for an import into `dst` ahead of its pages, a bounded
   * transaction at a time, so no page has to carry bytes and a file of any
   * size imports in frames. Each chunk is re-hashed first. They are held by
   * a staging content the import's job names (`ahead`), until its last page
   * or until the import ends.
   */
  importChunks(dst: string, chunks: Iterable<VfsExportChunk>): { stored: number } {
    const target = normalizeVfsPath(dst);
    this.assertMutationsAllowed([target]);
    const given = new Map<string, Uint8Array>();
    for (const chunk of chunks) {
      if (hex(chunkHash(chunk.data)) !== chunk.hash) throw vfsError('EINVAL', `chunk ${chunk.hash} does not hash to its name`);
      given.set(chunk.hash, chunk.data);
    }
    const job = this.importJob(target);
    let jobId = job?.id;
    if (jobId === undefined) {
      this.assertImportTarget(target);
      jobId = this.beginImport(target);
    }
    const id = jobId;
    // The staging the job names, as its rows stand: nothing about it is kept in memory.
    const staging: StagingContent = { id: 0, size: 0, count: 0, hashed: false, digest: new ManifestDigest(), durable: true };
    if (job?.ahead !== undefined) {
      const row = [...this.sql.exec(
        'SELECT COUNT(*) AS count, COALESCE(MAX(off + len), 0) AS size FROM vfs_content_chunks WHERE content_id = ?', job.ahead,
      )][0]!;
      Object.assign(staging, { id: job.ahead, size: Number(row.size), count: Number(row.count) });
    }
    let builder = this.newPlan(true);
    const flush = (): void => {
      if (builder.empty) return;
      const plan = builder.build();
      builder = this.newPlan(true);
      this.assertTransactionFits(plan.metrics);
      // The job names the staging in the transaction that makes it.
      this.executeTransactionPlan(plan, { source: 'content-stage', limitMode: 'bounded' }, () => {
        this.sql.exec("UPDATE vfs_jobs SET args = json_set(args, '$.ahead', ?) WHERE id = ?", staging.id, id);
      });
    };
    let stored = 0;
    for (const hash of this.absentChunks([...given.keys()])) {
      const data = given.get(hash)!;
      if (builder.wouldExceedPieces(data.byteLength, 1) !== null) flush();
      builder.addStagedPiece(staging, { data, hash: unhex(hash) }, target);
      stored++;
    }
    flush();
    return { stored };
  }

  /** The import open at `target`: one still where it began. A stale one is nobody's to continue. */
  private importJob(target: string): (z.infer<typeof ImportJobArgsSchema> & { id: number; cursor: string }) | undefined {
    for (const row of [...this.sql.exec("SELECT id, args, cursor FROM vfs_jobs WHERE kind = 'import'")]) {
      const args = ImportJobArgsSchema.parse(JSON.parse(String(row.args)));
      if (args.dst === target && this.importPlaced(args)) return { ...args, id: Number(row.id), cursor: String(row.cursor) };
    }
    return undefined;
  }

  /** What an import beginning at `target` now records of where it stands (ImportJobArgsSchema). */
  private importPlacement(target: string): { parentIno?: number; dstIno?: number } {
    if (target === '') return { parentIno: ROOT_INODE };
    const parent = this.parentPath(target);
    const parentIno = parent === '' ? ROOT_INODE : this.inodes.get(parent)?.ino;
    const dstIno = this.inodes.get(target)?.ino;
    return { ...(parentIno === undefined ? {} : { parentIno }), ...(dstIno === undefined ? {} : { dstIno }) };
  }

  /** Whether every directory above `path` is one, from the root down: a path an import can reach. */
  private reachable(path: string): boolean {
    for (let at = this.parentPath(path); at !== ''; at = this.parentPath(at)) {
      if (!this.inodes.get(at)?.isDir) return false;
    }
    return true;
  }

  /**
   * Whether an import is still where it began: every directory above dst is
   * one, dst's parent path resolves to the directory it began in, and dst
   * to the inode the import made or found there (or to nothing, before it
   * has one). A removal of dst or of any directory above it (mid-way through
   * a sliced restore too), a rename of either away, a directory made or
   * renamed in its place: each leaves a path resolving elsewhere, so the
   * removal that commits is what ends the import. A job that records no
   * parent (one from before this was recorded) is never placed.
   */
  private importPlaced(job: z.infer<typeof ImportJobArgsSchema>): boolean {
    if (job.parentIno === undefined) return false;
    if (job.dst === '') return true;
    if (!this.reachable(job.dst)) return false;
    const parent = this.parentPath(job.dst);
    if ((parent === '' ? ROOT_INODE : this.inodes.get(parent)!.ino) !== job.parentIno) return false;
    const here = this.inodes.get(job.dst);
    return job.dstIno === undefined ? here === undefined : here?.ino === job.dstIno;
  }

  /**
   * Staging contents GC must step over: those a live operation is still
   * assembling, and those an import's job names (its pending manifest, its
   * chunks sent ahead), read from the job rows as they stand.
   */
  private stagingPins(): Set<number> {
    const pins = new Set<number>(this.activeStagingContentIds);
    for (const row of this.sql.exec("SELECT args FROM vfs_jobs WHERE kind = 'import'")) {
      const job = ImportJobArgsSchema.parse(JSON.parse(String(row.args)));
      if (job.pending !== undefined) pins.add(job.pending.content);
      if (job.ahead !== undefined) pins.add(job.ahead);
    }
    return pins;
  }

  /**
   * End every import no longer where it began (importPlaced): its row goes,
   * and what it staged (a pending manifest, chunks sent ahead) is queued for
   * collection, in bounded transactions. Such an import is already invisible
   * to every page, frame and cursor; this reclaims what it held, in at most
   * `maxTransactions` transactions, the rest at the next sweep. Never inside
   * an embedder's transaction, whose rollback brings the removal back.
   * Returns the transactions it ran.
   */
  private sweepStaleImports(maxTransactions: number): number {
    if (!this.importSweepPending || this.transactionPublication !== null || maxTransactions <= 0) return 0;
    const stale: { id: number; contents: number[] }[] = [];
    const open = [...this.sql.exec("SELECT id, args FROM vfs_jobs WHERE kind = 'import'")];
    for (const row of open) {
      const job = ImportJobArgsSchema.parse(JSON.parse(String(row.args)));
      if (this.importPlaced(job)) continue;
      const contents = new Set<number>();
      if (job.pending !== undefined) contents.add(job.pending.content);
      if (job.ahead !== undefined) contents.add(job.ahead);
      stale.push({ id: Number(row.id), contents: [...contents] });
    }
    let transactions = 0;
    for (let i = 0; i < stale.length && transactions < maxTransactions; i += STALE_IMPORTS_PER_TX) {
      const batch = stale.slice(i, i + STALE_IMPORTS_PER_TX);
      const queued = batch.flatMap((job) => job.contents.flatMap((id) => [GC_CONTENT, id]));
      this.executeMeasuredTransaction(
        this.metricsOnlyPlan({
          blobBytes: 0, logicalRows: batch.length + queued.length / 2,
          sqlExecs: 1 + groupedSqlExecs(queued.length / 2, GC_ROWS_PER_SQL_EXEC), affectedPaths: 0,
        }),
        { source: 'content-gc', limitMode: 'bounded' },
        () => {
          this.sql.exec(`DELETE FROM vfs_jobs WHERE id IN (${batch.map(() => '?').join(',')})`, ...batch.map((job) => job.id));
          this.insertRows('vfs_gc_queue (kind, id)', GC_ROW_COLUMNS, queued, 'INSERT OR IGNORE');
        },
      );
      transactions++;
      if (queued.length > 0) this.maintenancePending = true;
    }
    const swept = Math.min(stale.length, transactions * STALE_IMPORTS_PER_TX);
    // Stale jobs left for the next sweep keep it pending.
    this.importSweepPending = swept < stale.length;
    this.importJobsExist = open.length > swept;
    return transactions;
  }

  /** An import starts into an absent path or an empty directory under an existing one. */
  private assertImportTarget(target: string): void {
    const existing = this.inodes.get(target);
    if (target !== '' && existing !== undefined) {
      if (!existing.isDir) throw vfsError('EEXIST', target);
      if (this.hasChildren(target)) throw vfsError('ENOTEMPTY', target);
    } else if (target === '' && this.hasChildren('')) throw vfsError('ENOTEMPTY', '/');
    // Every directory above it, not only its parent: a sliced restore removes a directory before what it held.
    if (target !== '' && !this.reachable(target)) throw vfsError('ENOENT', this.parentPath(target));
  }

  /** A job for a new import into `target`, recording where it stands (importPlaced). */
  private beginImport(target: string): number {
    this.importJobsExist = true;
    let id = 0;
    this.transactionSync(() => {
      id = Number([...this.sql.exec(
        `INSERT INTO vfs_jobs (kind, args, cursor, start_gen, created_at) VALUES ('import', ?, '', 0, ?) RETURNING id`,
        JSON.stringify({ dst: target, ...this.importPlacement(target) }),
        this.now(),
      )][0]!.id);
    });
    return id;
  }

  private hasChildren(dir: string): boolean {
    return [...this.sql.exec('SELECT 1 FROM vfs_inodes WHERE parent_path = ? LIMIT 1', dir)].length > 0;
  }

  private importedEntry(path: string, row: VfsExportRow, content: InodeContent, ino?: number): StoredInodeEntry {
    const kind = row.kind;
    if (kind !== 'file' && kind !== 'directory' && kind !== 'symlink') throw vfsError('EINVAL', `${row.path}: kind ${String(kind)}`);
    if (kind === 'directory' && (content.type !== 'none' || row.size !== 0)) {
      throw vfsError('EINVAL', `${row.path}: a directory with content`);
    }
    const entry: StoredInodeEntry = {
      path,
      parentPath: this.parentPath(path),
      kind,
      isDir: kind === 'directory',
      ino,
      size: row.size,
      atime: row.atime,
      mtime: row.mtime,
      mode: row.mode,
      uid: row.uid,
      gid: row.gid,
      defaultAcl: row.defaultAcl,
      content,
    };
    this.normalizeSharedEntry(entry, CRED_KERNEL);
    return entry;
  }

  // ── Cold tier: chunks only snapshots reference (P6) ───────────────────
  //
  // A chunk that no live row, live manifest or staging content names, only
  // history, may move to the cold store: uploaded by hash, then its data
  // emptied and state set cold in a transaction that probes the live
  // references again. No live row ever names a cold chunk, so no synchronous
  // read of the live tree can meet one. A snapshot's reads, a restore and a
  // copyTree from it are preceded by prepareSnapshot, which brings its
  // chunks back.

  /**
   * Move up to `maxChunks` snapshot-only chunks to the cold store, and
   * delete the cold objects GC released. One pass walks the chunk table from
   * where the last stopped. Returns what it moved.
   */
  async tierColdChunks(maxChunks = TIER_PAGE_CHUNKS): Promise<{ tiered: number; bytes: number; deleted: number; done: boolean }> {
    const store = this.requireColdStore();
    const pinned = new Set<number>();
    for (const opened of this.openNodes) if (opened.inode.chunkId !== null) pinned.add(opened.inode.chunkId);
    const pinnedContents = [...this.stagingPins()];
    for (const opened of this.openNodes) if (opened.inode.contentId !== null) pinnedContents.push(opened.inode.contentId);
    const hot = [...this.hotSnapshotGens.values()];
    const hotHistory = hot.length === 0 ? '' : `
      AND NOT EXISTS (SELECT 1 FROM vfs_inode_history h WHERE (h.chunk_id = c.id
            OR h.content_id IN (SELECT content_id FROM vfs_content_chunks WHERE chunk_id = c.id))
          AND (${hot.map(() => '(h.gen_from <= ? AND ? < h.gen_to)').join(' OR ')}))`;
    const pinnedContent = pinnedContents.length === 0 ? '' : `
      AND NOT EXISTS (SELECT 1 FROM vfs_content_chunks WHERE chunk_id = c.id AND content_id IN (${pinnedContents.map(() => '?').join(',')}))`;
    // A window of chunk ids after the cursor; candidates in it up to maxChunks.
    const window = [...this.sql.exec(
      'SELECT MAX(id) AS id FROM (SELECT id FROM vfs_chunks WHERE id > ? ORDER BY id LIMIT ?)',
      this.tierCursor,
      TIER_SCAN_ROWS,
    )][0];
    const windowEnd = window?.id === null || window?.id === undefined ? null : Number(window.id);
    const candidates = windowEnd === null ? [] : [...this.sql.exec(
      `SELECT c.id, c.hash, c.data FROM vfs_chunks c
       WHERE c.id > ? AND c.id <= ? AND c.state = ${CHUNK_LOCAL}
         AND (EXISTS (SELECT 1 FROM vfs_inode_history WHERE chunk_id = c.id)
           OR EXISTS (SELECT 1 FROM vfs_content_chunks cc JOIN vfs_inode_history h ON h.content_id = cc.content_id WHERE cc.chunk_id = c.id))
         ${LIVE_CHUNK_UNREFERENCED}${hotHistory}${pinnedContent}
       ORDER BY c.id LIMIT ?`,
      this.tierCursor,
      windowEnd,
      ...hot.flatMap((g) => [g, g]),
      ...pinnedContents,
      maxChunks,
    )];
    const reachedEnd = candidates.length < maxChunks ? windowEnd : Number(candidates[candidates.length - 1]!.id);
    let bytes = 0;
    const uploaded: { id: number; hash: Uint8Array }[] = [];
    for (const row of candidates) {
      if (pinned.has(Number(row.id))) continue;
      const hash = this.blobToUint8Array(row.hash);
      const data = this.blobToUint8Array(row.data);
      await store.put(hex(hash), data);
      uploaded.push({ id: Number(row.id), hash });
      bytes += data.byteLength;
    }
    let tiered = 0;
    for (let i = 0; i < uploaded.length; i += KEYS_PER_SQL_EXEC) {
      const batch = uploaded.slice(i, i + KEYS_PER_SQL_EXEC);
      this.executeMeasuredTransaction(
        this.metricsOnlyPlan({ blobBytes: 0, logicalRows: batch.length, sqlExecs: 1, affectedPaths: 0 }),
        { source: 'content-gc', limitMode: 'bounded' },
        () => {
          // The probes again, inside the transaction: across the awaits a
          // write may have named one of these chunks, or a prepareSnapshot
          // claimed its snapshot.
          const hotNow = [...this.hotSnapshotGens.values()];
          const hotClause = hotNow.length === 0 ? '' : `
            AND NOT EXISTS (SELECT 1 FROM vfs_inode_history h WHERE (h.chunk_id = c.id
                  OR h.content_id IN (SELECT content_id FROM vfs_content_chunks WHERE chunk_id = c.id))
                AND (${hotNow.map(() => '(h.gen_from <= ? AND ? < h.gen_to)').join(' OR ')}))`;
          tiered += [...this.sql.exec(
            `UPDATE vfs_chunks AS c SET data = x'', state = ${CHUNK_COLD}
             WHERE id IN (${batch.map(() => '?').join(',')}) AND state = ${CHUNK_LOCAL}${LIVE_CHUNK_UNREFERENCED}${hotClause}
             RETURNING id`,
            ...batch.map((entry) => entry.id),
            ...hotNow.flatMap((g) => [g, g]),
          )].length;
        },
      );
      for (const entry of batch) this.cacheEvict(entry.id);
    }
    this.tierCursor = reachedEnd ?? 0;
    const deleted = await this.drainColdTrash();
    return { tiered, bytes, deleted, done: reachedEnd === null };
  }

  /** Delete from the cold store what GC released, a page at a time. */
  private async drainColdTrash(): Promise<number> {
    const store = this.requireColdStore();
    let deleted = 0;
    for (;;) {
      const page = [...this.sql.exec('SELECT hash FROM vfs_cold_trash LIMIT ?', KEYS_PER_SQL_EXEC)]
        .map((row) => this.blobToUint8Array(row.hash));
      if (page.length === 0) return deleted;
      await store.delete(page.map(hex));
      this.transactionSync(() => {
        this.sql.exec(`DELETE FROM vfs_cold_trash WHERE hash IN (${page.map(() => '?').join(',')})`, ...page);
      });
      deleted += page.length;
    }
  }

  /**
   * Bring back every cold chunk snapshot `name` references under `root`,
   * and keep them local until releaseSnapshot(name): after this, at(name),
   * restore(name) and copyTree(..., { at: name }) read synchronously.
   * O(history rows covering the snapshot), since only those can be cold.
   */
  async prepareSnapshot(name: string, options: { root?: string } = {}): Promise<{ hydrated: number; bytes: number }> {
    const g = this.requireSnapshot(name);
    this.hotSnapshotGens.set(name, g);
    const root = normalizeVfsPath(options.root ?? '');
    let hydrated = 0;
    let bytes = 0;
    for (;;) {
      const cold = this.coldChunksAt(g, root, KEYS_PER_SQL_EXEC);
      if (cold.length === 0) return { hydrated, bytes };
      const result = await this.hydrate(cold);
      hydrated += result.hydrated;
      bytes += result.bytes;
    }
  }

  /** Let tiering move snapshot `name`'s chunks again. */
  releaseSnapshot(name: string): void {
    this.hotSnapshotGens.delete(name);
  }

  /** Hashes of cold chunks the history rows covering `g` under `root` reference. */
  private coldChunksAt(g: number, root: string, limit: number): Uint8Array[] {
    const range = subtreeRange(root);
    const within = root === '' ? '' : ' AND (h.path = ? OR (h.path > ? AND h.path < ?))';
    const bounds = root === '' ? [] : [root, range.lower, range.upper];
    return [...this.sql.exec(
      `SELECT c.hash FROM vfs_chunks c WHERE c.state = ${CHUNK_COLD} AND c.id IN (
         SELECT h.chunk_id FROM vfs_inode_history h WHERE h.chunk_id IS NOT NULL AND h.gen_from <= ? AND ? < h.gen_to${within}
         UNION SELECT cc.chunk_id FROM vfs_inode_history h JOIN vfs_content_chunks cc ON cc.content_id = h.content_id
           WHERE h.content_id IS NOT NULL AND h.gen_from <= ? AND ? < h.gen_to${within})
       LIMIT ?`,
      g, g, ...bounds, g, g, ...bounds, limit,
    )].map((row) => this.blobToUint8Array(row.hash));
  }

  /** Fetch cold chunks by hash, re-hash them, and store them local again. */
  private async hydrate(hashes: readonly Uint8Array[]): Promise<{ hydrated: number; bytes: number }> {
    const store = this.requireColdStore();
    const fetched: { hash: Uint8Array; data: Uint8Array }[] = [];
    for (const hash of hashes) {
      const object = await store.get(hex(hash));
      if (object === null) throw vfsError('EIO', `cold chunk ${hex(hash)} is missing from the cold store`);
      const data = new Uint8Array(await object.arrayBuffer());
      if (hex(chunkHash(data)) !== hex(hash)) throw vfsError('EIO', `cold chunk ${hex(hash)} does not hash to its name`);
      fetched.push({ hash, data });
    }
    let hydrated = 0;
    let bytes = 0;
    let group: typeof fetched = [];
    let groupBytes = 0;
    const flush = (): void => {
      if (group.length === 0) return;
      const rows = group;
      this.executeMeasuredTransaction(
        this.metricsOnlyPlan({ blobBytes: groupBytes, logicalRows: rows.length, sqlExecs: rows.length, affectedPaths: 0 }),
        { source: 'content-stage', limitMode: 'bounded' },
        () => {
          for (const row of rows) {
            hydrated += [...this.sql.exec(
              `UPDATE vfs_chunks SET data = ?, state = ${CHUNK_LOCAL} WHERE hash = ? AND state = ${CHUNK_COLD} RETURNING 1`,
              row.data,
              row.hash,
            )].length;
          }
        },
      );
      for (const row of rows) bytes += row.data.byteLength;
      group = [];
      groupBytes = 0;
    };
    for (const row of fetched) {
      if (group.length > 0 && (groupBytes + row.data.byteLength > MAX_TX_BLOB_BYTES || group.length >= MAX_TX_SQL_EXECS - 4)) flush();
      group.push(row);
      groupBytes += row.data.byteLength;
    }
    flush();
    return { hydrated, bytes };
  }

  /** Throw ENODATA if a restore or copy from generation `g` under `root` would publish a cold chunk. */
  private assertSnapshotLocal(g: number, root: string, name: string): void {
    if (this.coldStore === null) return;
    if (this.coldChunksAt(g, root, 1).length > 0) throw coldChunkError(`snapshot ${name}`);
  }

  private requireColdStore(): VfsColdStore {
    if (this.coldStore === null) throw vfsError('EINVAL', 'no cold store is configured');
    return this.coldStore;
  }

  // ── Batch write (npm install fast path) ───────────────────────────────

  /**
   * Where a new entry at storage key `key` goes: its parent as it resolves
   * (links followed) plus its own name, as writeFile/unlink/rename place
   * theirs. A parent that does not exist yet (made in the same batch or
   * mkdir -p) is placed the same way, recursively. `memo` shares that work
   * across one operation.
   */
  private createdPath(key: string, cred: VfsCred, memo: Map<string, string> = new Map()): string {
    const known = memo.get(key);
    if (known !== undefined) return known;
    const parent = this.parentPath(key);
    let placed = key;
    if (parent !== '') {
      const name = key.slice(parent.length + 1);
      let resolvedParent: string;
      try {
        resolvedParent = this.resolvePath(parent, cred, true, false).path;
      } catch (error) {
        if ((error as { code?: string }).code !== 'ENOENT') throw error;
        resolvedParent = this.createdPath(parent, cred, memo);
      }
      placed = resolvedParent ? `${resolvedParent}/${name}` : name;
    }
    memo.set(key, placed);
    return placed;
  }

  private normalizeBatchInode(
    entry: BatchInodeEntry,
    cred: VfsCred,
    memo?: Map<string, string>,
    staged?: Map<string, { mode: number; gid: number; defaultAcl: number | null }>,
  ): NormalizedBatchInodeEntry {
    const literal = this.storageKey(entry.path, cred);
    // The entry must name its own parent, as the caller wrote it; placement
    // (links followed) comes after.
    const namedParent = this.storageKey(entry.parentPath, cred);
    if (namedParent !== this.parentPath(literal)) {
      throw vfsError('EINVAL', `${literal}: parentPath ${namedParent} does not match ${this.parentPath(literal)}`);
    }
    const path = this.createdPath(literal, cred, memo);
    const prior = this.inodes.get(path);
    const directory = inodeKind(entry) === 'directory';
    const made = prior ? undefined : this.creationAttrs(path, entry.mode, cred, directory, staged);
    const newUid = cred.uid === 0 ? (entry.uid ?? 1000) : cred.uid;
    // The kernel restoring a tree names its groups; anyone else gets the rule.
    const newGid = cred.uid === 0 && entry.gid !== undefined ? entry.gid : (made?.gid ?? cred.gid);
    // ctime is the commit's clock, never the caller's.
    const { ctime: _unsettable, ...fields } = entry as BatchInodeEntry & { ctime?: unknown };
    const normalized: NormalizedBatchInodeEntry = {
      ...fields,
      path,
      parentPath: this.parentPath(path),
      // A record replacing an inode of another kind (a directory over a link) takes none of its mode.
      mode: prior && prior.kind === inodeKind(entry)
        ? prior.mode
        : inodeKind(entry) === 'symlink'
          ? inodeTypeBits('symlink') | 0o777
          : made?.mode ?? this.creationMode(entry.mode, cred),
      uid: prior?.uid ?? newUid,
      gid: prior?.gid ?? newGid,
      ...(made && directory ? { defaultAcl: made.defaultAcl } : {}),
    };
    staged?.set(path, { mode: normalized.mode, gid: normalized.gid, defaultAcl: made?.defaultAcl ?? prior?.defaultAcl ?? null });
    return normalized;
  }

  private authorizeBatch(payload: BatchWritePayload, cred: VfsCred): BatchWritePayload {
    const placed = new Map<string, string>();
    const staged = new Map<string, { mode: number; gid: number; defaultAcl: number | null }>();
    const inodes = payload.inodes.map((entry) => this.normalizeBatchInode(entry, cred, placed, staged));
    const pending = new Map(inodes.map((entry) => [entry.path, entry]));
    // A batch writes each row at its literal key, so the permission it checks
    // for a row it places has to be the permission of that place: resolving
    // the key must end at the key. A link on the way would check the link's
    // target and put the row under the link, in a directory the caller may
    // not be able to write, and where no lookup ever reaches it. Deletions
    // keep the rule they had: they remove rows, wherever they were left.
    const unplaceable = (key: string): Error => vfsError('ENOTDIR', `${key} is not a directory the entry can be placed in`);
    const checkedParents = new Set<string>();
    const placedParents = new Set<string>();
    const checkParent = (path: string, placing: boolean): void => {
      const parent = this.parentPath(path);
      if (parent === '') { this.checkRootWritable(path, cred); return; }
      const checked = placing ? placedParents : checkedParents;
      if (checked.has(parent)) return;
      checked.add(parent);
      const existing = this.inodes.get(parent);
      if (existing) {
        if (placing && existing.kind !== 'directory') throw unplaceable(parent);
        const resolved = this.checkAccess(parent, 0o3, cred);
        if (placing && resolved.path !== parent) throw unplaceable(parent);
        return;
      }
      const staged = pending.get(parent);
      if (!staged || !staged.isDir) throw vfsError('ENOENT', parent);
      checkParent(parent, placing);
      if (!this.accessMode(staged.mode, staged.uid ?? 1000, staged.gid ?? 1000, 0o3, cred)) {
        throw vfsError('EACCES', parent);
      }
    };
    const replaced = (key: string): void => {
      const resolved = this.checkAccess(key, 0o2, cred, { followLeaf: false });
      if (resolved.path !== key) throw unplaceable(this.parentPath(key));
    };

    // A row left at its literal key (under a link's own name, by an older
    // build) is removed where it is; otherwise the name is where it resolves.
    const deleted = (path: string): string => {
      const key = this.storageKey(path, cred);
      return this.inodes.get(key) ? key : this.createdPath(key, cred, placed);
    };
    for (const path of payload.deletePaths ?? []) {
      const normalized = deleted(path);
      const existing = this.checkAccess(normalized, 0, cred, {
        followLeaf: false,
        allowMissingLeaf: true,
      }).inode;
      if (existing) checkParent(normalized, false);
    }
    for (const entry of inodes) {
      if (this.inodes.get(entry.path)) replaced(entry.path);
      else checkParent(entry.path, true);
    }
    // Chunks name their inode by path, so they take the inodes' storage keys.
    const chunks = payload.chunks.map((chunk) => {
      const key = this.storageKey(chunk.path, cred);
      const path = this.inodes.get(key) ? key : this.createdPath(key, cred, placed);
      if (!pending.has(path)) replaced(path);
      return path === chunk.path ? chunk : { ...chunk, path };
    });
    return {
      ...payload,
      inodes,
      chunks,
      deletePaths: payload.deletePaths?.map(deleted),
    };
  }

  /**
   * Atomic bulk write: ALL inodes + chunks in ONE transactionSync().
   *
   * The complete mutation is preflighted against the Stage 2 transaction
   * limits, then executed in one transaction with 9-inode / 33-chunk SQL
   * grouping. Oversized strict calls fail with E2BIG before mutation.
   */
  private writeBatch(
    payload: BatchWritePayload,
    cred: VfsCred,
    onCommit?: () => void,
  ): { inodes: number; chunks: number } {
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
  private commitBatch(
    payload: BatchWritePayload,
    cred: VfsCred,
    onCommit?: () => void,
  ): { inodes: number; chunks: number } {
    const normalized = this.authorizeBatch(payload, cred);
    this.assertMutationsAllowed(batchMutationPaths(normalized));
    return this._writeBatchWithRetry(
      normalized,
      { source: 'strict-batch', limitMode: 'bounded' },
      true,
      onCommit,
    );
  }

  /**
   * Write a file too large for one transaction: its FastCDC chunks stage into
   * a state-0 content over bounded transactions, and one more publishes it.
   * Until then no inode names the content and GC steps over it (active).
   */
  private replaceFileWithStagedContent(
    inode: BatchInodeEntry,
    data: Uint8Array,
    onCommit?: () => void,
  ): { inodes: number; chunks: number } {
    this.validateInodeContentShape(inode);
    if (inode.size !== data.byteLength) {
      throw vfsError('EINVAL', `${inode.path}: ${data.byteLength} bytes for size ${inode.size}`);
    }
    const staging: StagingContent = { id: 0, size: 0, count: 0, hashed: true, digest: new ManifestDigest() };
    let builder = this.newPlan();
    const flush = (): void => {
      if (builder.empty) return;
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
        if (builder.wouldExceedPieces(piece.byteLength, 1) !== null) flush();
        builder.addStagedPiece(staging, { data: piece, hash: chunkHash(piece) }, inode.path);
      }
      flush();
      const result = this.publishStagedFile(inode, staging, onCommit);
      this.runContentMaintenanceSafely(1);
      return result;
    } catch (error) {
      if (staging.id !== 0) this.abandonStaging(staging);
      this.runContentMaintenanceSafely(1);
      throw error;
    }
  }

  /**
   * The inode row publishing `inode` with `content`. Ownership is inherited
   * from what the path already holds; the reference it replaces is queued by
   * the transaction that commits it.
   */
  private fileEntry(inode: BatchInodeEntry, content: InodeContent): StoredInodeEntry {
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

  private publishStagedFile(
    inode: BatchInodeEntry,
    staging: StagingContent,
    onCommit?: () => void,
  ): { inodes: number; chunks: number } {
    const builder = this.newPlan();
    builder.addInode(this.fileEntry(inode, { type: 'staged', content: staging }));
    const plan = builder.build();
    this.assertTransactionFits(onCommit ? withCommitRowMetrics(plan.metrics) : plan.metrics);
    const result = this._writeBatchOnce(
      { plan, deletedInodes: [] },
      { source: 'content-publish', limitMode: 'bounded' },
      onCommit,
    );
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
  private writeStream(
    stream: ReadableStream<Uint8Array>,
    options: { decodeDrainStartedAt?: number; signal?: AbortSignal; mutationOwner?: string } = {},
    cred: VfsCred,
  ): Promise<WriteBatchStreamResult> {
    return this.spanning(() => this.consumeStream(stream, options, cred), options.mutationOwner);
  }

  private async consumeStream(
    stream: ReadableStream<Uint8Array>,
    options: { decodeDrainStartedAt?: number; signal?: AbortSignal; mutationOwner?: string },
    cred: VfsCred,
  ): Promise<WriteBatchStreamResult> {
    const decodeDrainStartedAt = options.decodeDrainStartedAt ?? performance.now();
    const decodeDrainToken = {};
    this._decodeDrainStarts.set(decodeDrainToken, decodeDrainStartedAt);
    let decodeDrainFinished = false;
    let decodeDrainWaitMs = Math.max(0, performance.now() - decodeDrainStartedAt);
    let recordIterator: AsyncIterator<W7DecodedRecord> | null = null;
    let recordIteratorFinished = false;
    let decodedRecordLease: CreditLease | null = null;
    /** Staging contents this stream created and has not yet published. */
    const ownedStaging = new Set<StagingContent>();
    let activeFile: {
      streamContentId: string;
      /** The path the stream names it by; `inode.path` is where it lands. */
      named: string;
      inode: BatchInodeEntry;
      /** Bytes received and the next positional chunk expected. */
      received: number;
      nextChunk: number;
      cutter: ContentCutter;
      /** Whole-file mode: the file commits in one group, its chunks held until file-end. */
      held: Piece[] | null;
      heldLeases: CreditLease[];
      /** Staged mode: chunks go to this content as groups flush. */
      staging: StagingContent | null;
      stagedBytes: number;
    } | null = null;
    const progress: WriteBatchStreamProgress = {
      committedGroupSequence: 0,
      committedPathCount: 0,
      inodes: 0,
      chunks: 0,
    };
    let phase: WriteBatchStreamFailurePhase = 'decode';

    // The pending publish group. Everything reset by a flush lives here.
    let group = this.newPlan();
    let groupLeases: CreditLease[] = [];
    let groupInodes: string[] = [];
    let groupPublishedChunks = 0;
    let groupPaths = 0;
    let groupStagedBytes = 0;
    // Directory upserts batch on their own: authorising a file consults the
    // committed inode tree for its parent, so directories flush before the
    // first file record rather than sharing the file group.
    let pendingDirectories: BatchInodeEntry[] = [];

    const flushGroup = (): void => {
      if (group.empty) return;
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
          if (activeFile) activeFile.stagedBytes += plan.metrics.blobBytes;
          return;
        }
        this.assertTransactionFits(plan.metrics);
        // Re-check the mutation guard here rather than only where each file
        // was accepted: a group commits after the records that follow it, so
        // this is the check that is contemporaneous with the write.
        const result = this.withMutationOwner(options.mutationOwner, () => {
          this.assertMutationsAllowed(inodes);
          return this._writeBatchOnce(
            { plan, deletedInodes: [] },
            { source: 'content-publish', limitMode: 'bounded' },
          );
        });
        let activeStaged = 0;
        for (const staged of plan.staged) {
          if (staged.content === activeFile?.staging) activeStaged += staged.piece.data.byteLength;
        }
        if (activeFile) activeFile.stagedBytes += activeStaged;
        this._stagedStreamBytes = Math.max(0, this._stagedStreamBytes + activeStaged - stagedBytes);
        for (const entry of plan.inodes) {
          if (entry.content.type === 'staged') ownedStaging.delete(entry.content.content);
        }
        progress.committedGroupSequence++;
        progress.committedPathCount += paths;
        progress.inodes += result.inodes;
        progress.chunks += publishedChunks;
      } finally {
        for (const lease of leases) lease.release();
      }
    };

    const flushDirectories = (): void => {
      if (pendingDirectories.length === 0) return;
      const inodes = pendingDirectories;
      pendingDirectories = [];
      const result = this.withMutationOwner(options.mutationOwner, () => (
        this.writeBatch({ inodes, chunks: [] }, cred)
      ));
      progress.committedGroupSequence++;
      progress.committedPathCount += inodes.length;
      progress.inodes += result.inodes;
    };

    const stagePiece = (file: NonNullable<typeof activeFile>, piece: Piece): void => {
      if (file.held !== null) {
        file.held.push(piece);
        return;
      }
      if (file.staging === null) {
        file.staging = { id: 0, size: 0, count: 0, hashed: true, digest: new ManifestDigest() };
        ownedStaging.add(file.staging);
      }
      if (group.wouldExceedPieces(piece.data.byteLength, 1) !== null) flushGroup();
      group.addStagedPiece(file.staging, piece, file.inode.path);
    };

    const retainChunk = async (byteLength: number, signal?: AbortSignal): Promise<CreditLease> => {
      if (group.wouldExceedPieces(byteLength, 1) !== null) flushGroup();
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
        } finally {
          this._creditWaitStarts.delete(waitToken);
          this.recordDuration(this._creditWaitDuration, performance.now() - waitStartedAt);
        }
      }

      let supervisorLease: CreditLease;
      const waitToken = {};
      const waitStartedAt = performance.now();
      this._creditWaitStarts.set(waitToken, waitStartedAt);
      try {
        supervisorLease = await acquireSupervisorAllocation(byteLength, signal);
      } catch (error) {
        writeLease.release();
        throw error;
      } finally {
        this._creditWaitStarts.delete(waitToken);
        this.recordDuration(this._creditWaitDuration, performance.now() - waitStartedAt);
      }

      let released = false;
      return {
        bytes: byteLength,
        release: () => {
          if (released) return;
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
        let next: IteratorResult<W7DecodedRecord>;
        try {
          next = await recordIterator.next();
        } finally {
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
            if (pendingDirectories.length >= MAX_TX_LOGICAL_ROWS) flushDirectories();
            break;
          }
          case 'file-begin': {
            if (activeFile) throw vfsError('EINVAL', `nested streamed file ${record.inode.path}`);
            phase = 'validation';
            this.validateInodeContentShape(record.inode);
            phase = 'publish';
            // Authorising a file reads its parent from the committed inode
            // tree, so pending directories become visible first.
            flushDirectories();
            phase = 'validation';
            // The file lands where its name resolves (links followed, as a
            // batch places it), and that is the path its lease is checked on.
            const placedInode = this.withMutationOwner(options.mutationOwner, () => {
              const [placed] = this.authorizeBatch({ inodes: [record.inode], chunks: [] }, cred).inodes;
              this.assertMutationsAllowed([placed!.path]);
              return placed!;
            });
            phase = 'stage';
            // Close the group before the file that would overflow it, so a
            // file either fits whole or begins a group of its own; one too
            // large for any group stages across several.
            if (group.wouldExceedFile(record.inode.size) !== null) flushGroup();
            const whole = group.wouldExceedFile(record.inode.size) === null;
            activeFile = {
              streamContentId: record.streamContentId,
              named: record.inode.path,
              inode: placedInode,
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
              || record.path !== file.named) {
              throw vfsError('EINVAL', `streamed chunk ownership mismatch: ${record.path}`);
            }
            if (record.chunkId !== file.nextChunk || file.received + record.data.byteLength > file.inode.size) {
              throw vfsError('EINVAL', `${record.path}: chunk ${record.chunkId} out of order or past size`);
            }
            file.nextChunk++;
            file.received += record.data.byteLength;
            phase = 'stage';
            if (file.inode.size <= CHUNK_SIZE) {
              // One chunk is the whole file; CDC starts only above CHUNK_SIZE.
              file.held!.push({ data: record.data, hash: new Uint8Array(0) });
            } else {
              for (const data of file.cutter.push(record.data)) stagePiece(file, { data, hash: chunkHash(data) });
            }
            if (file.held !== null) file.heldLeases.push(record.retention);
            else groupLeases.push(record.retention);
            decodedRecordLease = null;
            break;
          }
          case 'file-end': {
            phase = 'validation';
            const file = activeFile;
            if (!file || record.streamContentId !== file.streamContentId) {
              throw vfsError('EINVAL', `streamed file-end ownership mismatch: ${record.path}`);
            }
            if (file.received !== file.inode.size) {
              throw vfsError('EINVAL', `${record.path}: received ${file.received} of ${file.inode.size} bytes`);
            }
            phase = 'publish';
            const inode = this.normalizeBatchInode(file.inode, cred);
            let content: InodeContent;
            if (file.inode.size === 0) content = { type: 'none' };
            else if (file.inode.size <= CHUNK_SIZE) {
              const parts = file.held!;
              const data = parts.length === 1 ? parts[0]!.data : concatBytes(parts.map((part) => part.data));
              content = { type: 'small', piece: { data, hash: chunkHash(data) } };
            } else {
              for (const data of file.cutter.finish()) stagePiece(file, { data, hash: chunkHash(data) });
              if (file.held !== null) {
                const digest = new ManifestDigest();
                for (const piece of file.held) digest.add(piece.hash);
                content = { type: 'large', pieces: file.held, size: file.inode.size, digest: digest.digest(file.inode.size) };
              } else {
                content = { type: 'staged', content: file.staging! };
              }
            }
            const overflows = file.held !== null
              ? group.wouldExceedFile(file.inode.size)
              : group.wouldExceedInode();
            if (overflows !== null) flushGroup();
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
            if (recordIterator.return) await recordIterator.return();
            recordIteratorFinished = true;
            this._decodeDrainStarts.delete(decodeDrainToken);
            this.recordDuration(this._decodeDrainDuration, decodeDrainWaitMs);
            decodeDrainFinished = true;
            return { ok: true, ...progress };
        }
      }
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
      decodedRecordLease?.release();
      for (const lease of groupLeases) lease.release();
      for (const lease of activeFile?.heldLeases ?? []) lease.release();
      groupLeases = [];
      if (!recordIteratorFinished && recordIterator?.return) {
        try { await recordIterator.return(); } catch { /* preserve the primary stream result */ }
      }
      if (!decodeDrainFinished) {
        this._decodeDrainStarts.delete(decodeDrainToken);
        this.recordDuration(this._decodeDrainDuration, decodeDrainWaitMs);
      }
      // Staged bytes belonging to work that never reached a commit: the
      // file in flight, plus any completed file still pending in the group.
      const abandonedStagedBytes = (activeFile?.stagedBytes ?? 0) + groupStagedBytes;
      this._stagedStreamBytes = Math.max(0, this._stagedStreamBytes - abandonedStagedBytes);
      for (const staging of ownedStaging) if (staging.id !== 0) this.abandonStaging(staging);
      this.runContentMaintenanceSafely(2);
    }
  }

  private _writeBatchWithRetry(
    payload: BatchWritePayload,
    execution: TransactionExecution,
    enforceLimits: boolean,
    onCommit?: () => void,
  ): { inodes: number; chunks: number } {
    const prepared = this.prepareBatchTransaction(payload);
    if (prepared.plan.inodes.length === 0 && prepared.plan.deletes.length === 0) return { inodes: 0, chunks: 0 };
    if (enforceLimits) {
      this.assertTransactionFits(
        onCommit ? withCommitRowMetrics(prepared.plan.metrics) : prepared.plan.metrics,
      );
    }
    const chunks = payload.chunks.length;
    try {
      return { inodes: this._writeBatchOnce(prepared, execution, onCommit).inodes, chunks };
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
      return { inodes: this._writeBatchOnce(prepared, execution, onCommit).inodes, chunks };
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
  withTransaction<T>(callback: () => T): T {
    if (this.transactionPublication !== null) {
      throw new Error('[sqlite-vfs] nested embedder transactions are not supported');
    }
    const storage = this.ctx?.storage;
    if (!storage) throw new Error('[sqlite-vfs] atomic storage operation requires transactionSync');
    const publication = {
      paths: new Set<string>(),
      events: new Array<{ type: VfsEventType; path: string; oldPath?: string }>(),
      structural: new Map<string, StructuralChange>(),
      removedDirectories: new Array<INode>(),
    };
    const maintenancePending = this.maintenancePending;
    const openBefore = new Map([...this.openNodes].map(opened => [opened, { path: opened.path, inode: opened.inode }]));
    this.transactionPublication = publication;
    let result: T;
    try {
      result = storage.transactionSync(() => {
        const value = callback();
        if (value !== null && (typeof value === 'object' || typeof value === 'function')
            && 'then' in value && typeof value.then === 'function') {
          throw new TypeError('[sqlite-vfs] transaction callback must be synchronous');
        }
        return value;
      });
    } catch (error) {
      this.evictAll();
      this.maintenancePending = maintenancePending;
      try {
        this.inodes.clear();
        this._countersLoaded = false;
        this.contentKeyMemo.clear();
        this.manifestWindows.clear();
        // Generations the rollback discarded are reissued; nothing published them.
        const state = [...this.sql.exec('SELECT gen, pin_gen FROM vfs_state WHERE slot = 1')][0]!;
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
      } catch (reloadError) {
        throw new AggregateError([error, reloadError], '[sqlite-vfs] transaction rollback reload failed', { cause: error });
      }
      throw new Error('[sqlite-vfs] embedder transaction rolled back', { cause: error });
    } finally {
      this.transactionPublication = null;
    }
    if (publication.paths.size > 0) this.bumpRevision([...publication.paths], publication.structural);
    this.deliverEvents(publication.removedDirectories, () => {
      for (const event of publication.events) {
        this.emitMutation(event.type, event.path, event.oldPath);
      }
    });
    this.runContentMaintenanceSafely(1);
    return result;
  }

  /**
   * Deliver a mutation's events while the directories it removed are still
   * known by their modes (watchedName). Inside an embedder transaction the
   * events wait for its publication, and so do the directories.
   */
  private deliverEvents(removed: readonly INode[], emit: () => void): void {
    if (this.transactionPublication) {
      for (const inode of removed) if (inode.isDir) this.transactionPublication.removedDirectories.push(inode);
      emit();
      return;
    }
    const directories = removed.filter((inode) => inode.isDir);
    if (directories.length === 0) { emit(); return; }
    this.removedForEvents = new Map(directories.map((inode) => [inode.path, inode]));
    try {
      emit();
    } finally {
      this.removedForEvents = null;
    }
  }

  private emitMutation(type: VfsEventType, path: string, oldPath?: string): void {
    if (this.transactionPublication) {
      this.transactionPublication.events.push({ type, path, oldPath });
    } else {
      // Synchronous path listeners are callers, not part of the lease holder's mutation.
      const owner = this.activeMutationOwner;
      this.activeMutationOwner = null;
      try { this.events.emit(type, path, oldPath); }
      finally { this.activeMutationOwner = owner; }
    }
  }

  private transactionSync(callback: () => void): void {
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
  private executeTransactionPlan(
    plan: TransactionPlan,
    execution: TransactionExecution,
    onCommit?: () => void,
    priors?: readonly (INode | undefined)[],
  ): void {
    const committedAt = this.now();
    const deletedPaths = new Set<string>();
    for (const entry of plan.deletes) deletedPaths.add(entry.path);
    // Identity and the reference a row replaces are decided by the state
    // before this transaction: a path it both deletes and republishes keeps
    // its number, as it did when every inode was resident.
    const prior = plan.inodes.map((inode, index) => (
      inode.detached ?? (priors ? priors[index] : this.inodes.peek(inode.path) ?? this.loadInode(inode.path))
    ));
    const deletedPrior = new Map<string, INode | undefined>();
    for (const entry of plan.deletes) deletedPrior.set(entry.path, entry.prior);
    if (this.sharedDirectories.size > 0) {
      for (const entry of plan.deletes) this.revokeSharedDirectories(entry.path);
      for (const entry of plan.inodes) {
        const registration = this.sharedDirectories.get(entry.path);
        if (registration && (entry.kind !== 'directory' || entry.uid !== 0 || entry.gid !== registration.gid
            || (entry.ino !== undefined && entry.ino !== registration.ino) || (entry.mode & registration.mode) !== registration.mode
            || (entry.defaultAcl !== undefined && (entry.defaultAcl === null || (entry.defaultAcl & registration.acl) !== registration.acl)))) {
          this.sharedDirectories.delete(entry.path);
        }
      }
    }
    let gen = 0;
    let pinGen = 0;
    const rewritten: number[] = [];
    const created: StagingContent[] = [];
    const published: StagingContent[] = [];
    try {
      this.executeMeasuredTransaction(plan, execution, () => {
        // One statement for the generation and every id this transaction
        // may allocate: it reserves as many as the plan could use, and an
        // unused one is a gap, never a reuse.
        const reserve = planIdReservation(plan);
        const state = [...this.sql.exec(
          `UPDATE vfs_state SET gen = gen + 1, next_ino = next_ino + ?, next_chunk = next_chunk + ?, next_content = next_content + ?
           WHERE slot = 1 RETURNING gen, pin_gen, next_ino, next_chunk, next_content`,
          reserve.inos,
          reserve.chunks,
          reserve.contents,
        )][0]!;
        gen = Number(state.gen);
        pinGen = Number(state.pin_gen);
        const inodeLimit = Number(state.next_ino);
        if (!Number.isSafeInteger(inodeLimit)) throw vfsError('ENOSPC', 'inode identity space exhausted');
        let nextIno = inodeLimit - reserve.inos;
        let nextChunk = Number(state.next_chunk) - reserve.chunks;
        let nextContent = Number(state.next_content) - reserve.contents;
        const limits = { ino: nextIno + reserve.inos, chunk: nextChunk + reserve.chunks, content: nextContent + reserve.contents };
        const queue = new GcQueue();

        // Before-images for every row this transaction replaces or removes
        // that a snapshot can see (gen <= pin_gen). None without a snapshot.
        if (pinGen > 0) {
          const paths = [...plan.inodes.filter((entry) => !entry.detached).map((entry) => entry.path), ...deletedPaths];
          for (let i = 0; i < paths.length; i += KEYS_PER_SQL_EXEC) {
            const batch = paths.slice(i, i + KEYS_PER_SQL_EXEC);
            this.sql.exec(
              `INSERT OR IGNORE INTO vfs_inode_history
                 (path, gen_to, gen_from, parent_path, kind, size, atime, mtime, ctime, mode, uid, gid, ino, chunk_id, content_id, dacl)
               SELECT path, ?, gen, parent_path, kind, size, atime, mtime, ctime, mode, uid, gid, ino, chunk_id, content_id, dacl
               FROM vfs_inodes WHERE gen <= ? AND path IN (${batch.map(() => '?').join(',')})`,
              gen,
              pinGen,
              ...batch,
            );
          }
        }

        const deletes = [...deletedPaths];
        for (let i = 0; i < deletes.length; i += KEYS_PER_SQL_EXEC) {
          const batch = deletes.slice(i, i + KEYS_PER_SQL_EXEC);
          this.sql.exec(`DELETE FROM vfs_inodes WHERE path IN (${batch.map(() => '?').join(',')})`, ...batch);
        }
        this.insertRows(
          'vfs_tombstones (path, gen)',
          2,
          deletes.flatMap((path) => [path, gen]),
          'INSERT OR REPLACE',
        );
        if (deletes.length > 0) {
          if (this._tombstoneRows !== null) this._tombstoneRows += deletes.length;
          if (this.tombstoneRows() > this.tombstoneRetain) this.maintenancePending = true;
        }
        for (const entry of plan.deletes) {
          if (!entry.dereference || !entry.prior) continue;
          if (entry.prior.chunkId !== null) queue.add(GC_CHUNK, entry.prior.chunkId);
          if (entry.prior.contentId !== null) queue.add(GC_CONTENT, entry.prior.contentId);
        }

        if (plan.stagingCreated.length > 0) {
          const rows: unknown[] = [];
          for (const staging of plan.stagingCreated) {
            staging.id = nextContent++;
            created.push(staging);
            rows.push(staging.id, 0, 0, null, CONTENT_STAGING, committedAt);
          }
          this.insertRows('vfs_contents (id, size, chunk_count, digest, state, created_at)', CONTENT_ROW_COLUMNS, rows);
        }

        // ── Chunks, by hash ───────────────────────────────────────────────
        const pieces: Piece[] = [];
        const rewrites: { entry: StoredInodeEntry; chunkId: number; piece: Piece }[] = [];
        for (const entry of plan.inodes) {
          const content = entry.content;
          if (content.type === 'small') pieces.push(content.piece);
          else if (content.type === 'large') pieces.push(...content.pieces);
          else if (content.type === 'edit') for (const edit of content.pieces) pieces.push(edit.piece);
          else if (content.type === 'rewrite') {
            pieces.push(content.piece);
            rewrites.push({ entry, chunkId: content.chunkId, piece: content.piece });
          }
        }
        for (const staged of plan.staged) if (!staged.named) pieces.push(staged.piece);
        const chunkIds = new Map<string, number>();
        const wanted = new Map<string, Piece>();
        for (const piece of pieces) wanted.set(hashKey(piece.hash), piece);
        // Imported chunks named without bytes must already be stored.
        const named = new Map<string, Uint8Array>();
        for (const staged of plan.staged) {
          if (staged.named && !wanted.has(hashKey(staged.piece.hash))) named.set(hashKey(staged.piece.hash), staged.piece.hash);
        }
        for (const entry of plan.inodes) {
          if (entry.content.type !== 'imported') continue;
          for (const piece of entry.content.pieces) {
            const key = hashKey(piece.hash);
            if (piece.data !== null) wanted.set(key, { hash: piece.hash, data: piece.data });
            else if (!wanted.has(key)) named.set(key, piece.hash);
          }
        }
        for (const key of wanted.keys()) named.delete(key);
        const lookup = new Map<string, Uint8Array>(named);
        const remote = new Set<string>();
        const pending = new Set<string>();
        for (const [key, piece] of wanted) lookup.set(key, piece.hash);
        const keys = [...lookup.keys()];
        for (let i = 0; i < keys.length; i += KEYS_PER_SQL_EXEC) {
          const batch = keys.slice(i, i + KEYS_PER_SQL_EXEC);
          for (const row of this.sql.exec(
            `SELECT id, hash, state FROM vfs_chunks WHERE hash IN (${batch.map(() => '?').join(',')})`,
            ...batch.map((key) => lookup.get(key)!),
          )) {
            const key = hashKey(this.blobToUint8Array(row.hash));
            chunkIds.set(key, Number(row.id));
            if (Number(row.state) !== CHUNK_LOCAL) remote.add(key);
            if (Number(row.state) === CHUNK_PENDING) pending.add(key);
          }
        }
        for (const [key, hash] of named) {
          // A pending chunk (a lazy import's, N17) is named as it stands.
          if (!chunkIds.has(key) || (remote.has(key) && !pending.has(key))) throw vfsError('EIO', `import names chunk ${hex(hash)}, which is not stored`);
        }
        // A write whose bytes a cold chunk already names brings them back:
        // no live row ever names a chunk that is not local.
        for (const key of remote) {
          const piece = wanted.get(key);
          if (piece === undefined) continue;
          this.sql.exec(`UPDATE vfs_chunks SET data = ?, state = ${CHUNK_LOCAL} WHERE id = ?`, piece.data, chunkIds.get(key)!);
        }
        // An unshared chunk is rewritten in place unless its new bytes
        // already exist. A piece that deduplicated onto its old bytes must
        // not follow them, so the old hash stops resolving to it.
        for (const rewrite of rewrites) {
          const key = hashKey(rewrite.piece.hash);
          if (chunkIds.has(key)) continue;
          for (const [other, id] of chunkIds) if (id === rewrite.chunkId) chunkIds.delete(other);
          this.sql.exec(
            'UPDATE vfs_chunks SET hash = ?, size = ?, data = ? WHERE id = ?',
            rewrite.piece.hash,
            rewrite.piece.data.byteLength,
            rewrite.piece.data,
            rewrite.chunkId,
          );
          chunkIds.set(key, rewrite.chunkId);
          rewritten.push(rewrite.chunkId);
        }
        const inserts: unknown[] = [];
        for (const [key, piece] of wanted) {
          if (chunkIds.has(key)) continue;
          const id = nextChunk++;
          chunkIds.set(key, id);
          inserts.push(id, piece.hash, piece.data);
        }
        this.insertChunkRows(inserts);
        const chunkOf = (piece: Piece): number => chunkIds.get(hashKey(piece.hash))!;

        // ── Manifests ─────────────────────────────────────────────────────
        const manifest: unknown[] = [];
        for (const staged of plan.staged) {
          manifest.push(staged.content.id, staged.off, staged.size, chunkOf(staged.piece));
        }
        // Whole large files and published stagings resolve by digest first:
        // identical bytes written twice share one content.
        const digests = new Map<string, Uint8Array>();
        const stagedDigests = new Map<StagingContent, Uint8Array>();
        for (const entry of plan.inodes) {
          if (entry.content.type === 'large') digests.set(hex(entry.content.digest), entry.content.digest);
          else if (entry.content.type === 'imported' && entry.content.digest !== null) {
            digests.set(hex(entry.content.digest), entry.content.digest);
          }
          else if (entry.content.type === 'staged') {
            const digest = entry.content.digest ?? (entry.content.content.hashed ? entry.content.content.digest.digest(entry.size) : undefined);
            if (digest !== undefined) {
              stagedDigests.set(entry.content.content, digest);
              digests.set(hex(digest), digest);
            }
          }
        }
        const contentByDigest = new Map<string, number>();
        const digestKeys = [...digests.keys()];
        for (let i = 0; i < digestKeys.length; i += KEYS_PER_SQL_EXEC) {
          const batch = digestKeys.slice(i, i + KEYS_PER_SQL_EXEC);
          for (const row of this.sql.exec(
            `SELECT id, digest FROM vfs_contents WHERE digest IN (${batch.map(() => '?').join(',')})`,
            ...batch.map((key) => digests.get(key)!),
          )) contentByDigest.set(hex(this.blobToUint8Array(row.digest)), Number(row.id));
        }
        const contentRows: unknown[] = [];
        for (const entry of plan.inodes) {
          const content = entry.content;
          let chunkId: number | null = null;
          let contentId: number | null = null;
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
            case 'imported': {
              if (!content.manifest) {
                chunkId = chunkIds.get(hashKey(content.pieces[0]!.hash))!;
                break;
              }
              const key = hex(content.digest!);
              contentId = contentByDigest.get(key) ?? null;
              if (contentId === null) {
                contentId = nextContent++;
                contentByDigest.set(key, contentId);
                contentRows.push(contentId, content.size, content.pieces.length, content.digest, CONTENT_LIVE, committedAt);
                let off = 0;
                for (const piece of content.pieces) {
                  manifest.push(contentId, off, piece.size, chunkIds.get(hashKey(piece.hash))!);
                  off += piece.size;
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
              } else {
                contentId = staging.id;
                if (digest !== null) contentByDigest.set(hex(digest), staging.id);
                this.sql.exec(
                  'UPDATE vfs_contents SET state = ?, digest = ?, size = ?, chunk_count = ? WHERE id = ?',
                  CONTENT_LIVE,
                  digest,
                  entry.size,
                  staging.count,
                  staging.id,
                );
              }
              published.push(staging);
              break;
            }
            case 'edit': {
              contentId = content.contentId;
              const removed = [...this.sql.exec(
                'SELECT chunk_id FROM vfs_content_chunks WHERE content_id = ? AND off >= ? AND off < ?',
                contentId,
                content.from,
                content.to,
              )];
              for (const row of removed) queue.add(GC_CHUNK, Number(row.chunk_id));
              this.sql.exec(
                'DELETE FROM vfs_content_chunks WHERE content_id = ? AND off >= ? AND off < ?',
                contentId,
                content.from,
                content.to,
              );
              for (const { off, piece } of content.pieces) {
                manifest.push(contentId, off, piece.data.byteLength, chunkOf(piece));
              }
              this.sql.exec(
                'UPDATE vfs_contents SET size = ?, chunk_count = chunk_count - ? + ?, digest = NULL WHERE id = ?',
                entry.size,
                removed.length,
                content.pieces.length,
                contentId,
              );
              this.contentKeyMemo.delete(contentId);
              this.manifestWindows.delete(contentId);
              break;
            }
          }
          entry.chunkId = chunkId;
          entry.contentId = contentId;
        }
        this.insertRows('vfs_contents (id, size, chunk_count, digest, state, created_at)', CONTENT_ROW_COLUMNS, contentRows);
        this.insertManifestRows(manifest);

        // ── Inodes ────────────────────────────────────────────────────────
        const rows: unknown[] = [];
        for (let i = 0; i < plan.inodes.length; i++) {
          const inode = plan.inodes[i]!;
          const before = prior[i];
          // Identity order: an explicit ino travels with moves and metadata
          // changes; an existing row at this path keeps its number (write
          // preserves identity, unlink+recreate allocates fresh); anything
          // else takes the counter.
          inode.ino ??= before?.ino ?? nextIno++;
          inode.gen = gen;
          if (inode.defaultAcl === undefined) inode.defaultAcl = before?.defaultAcl ?? null;
          inode.ctime ??= committedAt;
          if (before) {
            if (before.chunkId !== null && before.chunkId !== inode.chunkId) queue.add(GC_CHUNK, before.chunkId);
            if (before.contentId !== null && before.contentId !== inode.contentId) queue.add(GC_CONTENT, before.contentId);
          }
          if (inode.detached) {
            // Nothing durable names it; GC steps over it while it is pinned.
            if (inode.chunkId !== null && inode.chunkId !== undefined) queue.add(GC_CHUNK, inode.chunkId);
            if (inode.contentId !== null && inode.contentId !== undefined) queue.add(GC_CONTENT, inode.contentId);
            continue;
          }
          rows.push(
            inode.path,
            inode.parentPath,
            inodeKindCode(inode.kind),
            inode.size,
            inode.atime !== undefined && Number.isFinite(inode.atime) ? inode.atime : inode.mtime,
            inode.mtime,
            inode.ctime,
            inode.mode,
            inode.uid,
            inode.gid,
            inode.ino,
            gen,
            inode.chunkId,
            inode.contentId,
            inode.defaultAcl,
          );
        }
        this.insertRows(
          'vfs_inodes (path, parent_path, kind, size, atime, mtime, ctime, mode, uid, gid, ino, gen, chunk_id, content_id, dacl)',
          INODE_ROW_COLUMNS,
          rows,
          'INSERT OR REPLACE',
        );

        const queued = queue.rows();
        this.insertRows('vfs_gc_queue (kind, id)', GC_ROW_COLUMNS, queued, 'INSERT OR IGNORE');
        if (queued.length > 0) this.maintenancePending = true;
        onCommit?.();
        if (nextIno > limits.ino || nextChunk > limits.chunk || nextContent > limits.content) {
          throw new Error('[sqlite-vfs] a transaction allocated more ids than it reserved');
        }
      });
    } catch (error) {
      for (const staging of created) staging.id = 0;
      throw error;
    }
    this._gen = gen;
    for (const staging of created) if (!staging.durable) this.activeStagingContentIds.add(staging.id);
    for (const staging of published) this.activeStagingContentIds.delete(staging.id);
    for (const chunkId of rewritten) this.cacheEvict(chunkId);
    // A removal, or a write where an import has no destination yet, may
    // leave an import's path leading elsewhere: the next sweep ends it.
    if (this.importJobsExist && (plan.deletes.length > 0 || plan.inodes.length > 0)) this.importSweepPending = true;
  }

  /** Multi-row INSERT of `values`, `columns` per row, in statements under the bound-parameter limit. */
  /**
   * Chunk rows as (id, hash, data) triples; size is length(data), so a row
   * binds three parameters, not four: 33 rows a statement instead of 25.
   * The statement count is what an unshared large write pays per
   * transaction (measured in workerd, where it dominated).
   */
  private insertChunkRows(values: readonly unknown[]): void {
    const perExec = Math.floor(SQL_MAX_BOUND_PARAMETERS / 3) * 3;
    for (let i = 0; i < values.length; i += perExec) {
      const batch = values.slice(i, i + perExec);
      const rows: string[] = [];
      for (let k = 0; k < batch.length; k += 3) rows.push(`(?${k + 1}, ?${k + 2}, length(?${k + 3}), ?${k + 3})`);
      this.sql.exec(`INSERT INTO vfs_chunks (id, hash, size, data) VALUES ${rows.join(',')}`, ...batch);
    }
  }

  /**
   * Manifest rows as (content_id, off, len, chunk_id) quadruples, a run of
   * one content binding its id once: 33 rows a statement for one file's
   * manifest, and never fewer than 25.
   */
  private insertManifestRows(values: readonly unknown[]): void {
    let params: unknown[] = [];
    let rows: string[] = [];
    let shared = 0;
    let sharedId: unknown;
    const flush = (): void => {
      if (rows.length === 0) return;
      this.sql.exec(`INSERT INTO vfs_content_chunks (content_id, off, len, chunk_id) VALUES ${rows.join(',')}`, ...params);
      params = [];
      rows = [];
      shared = 0;
    };
    for (let i = 0; i < values.length; i += 4) {
      const reuse = shared > 0 && values[i] === sharedId;
      if (params.length + (reuse ? 3 : 4) > SQL_MAX_BOUND_PARAMETERS) flush();
      if (shared === 0 || values[i] !== sharedId) {
        params.push(values[i]);
        shared = params.length;
        sharedId = values[i];
      }
      params.push(values[i + 1], values[i + 2], values[i + 3]);
      const n = params.length;
      rows.push(`(?${shared}, ?${n - 2}, ?${n - 1}, ?${n})`);
    }
    flush();
  }

  private insertRows(target: string, columns: number, values: readonly unknown[], verb = 'INSERT'): void {
    const perExec = Math.floor(SQL_MAX_BOUND_PARAMETERS / columns) * columns;
    const row = `(${Array.from({ length: columns }, () => '?').join(',')})`;
    for (let i = 0; i < values.length; i += perExec) {
      const batch = values.slice(i, i + perExec);
      this.sql.exec(
        `${verb} INTO ${target} VALUES ${Array.from({ length: batch.length / columns }, () => row).join(',')}`,
        ...batch,
      );
    }
  }

  /**
   * N18: a transaction that can grow the database is admitted by the
   * session's ledger before it runs (ENOSPC, nothing written, when it would
   * cross the storage limit). Collection and pure removals only free, and are
   * never refused.
   */
  private admitTransaction(plan: TransactionPlan, execution: TransactionExecution): { id: string; take: number } | null {
    if (execution.source === 'content-gc') return null;
    const grows = plan.inodes.length > 0 || plan.staged.length > 0 || plan.stagingCreated.length > 0
      || plan.metrics.blobBytes > 0 || plan.deletes.length === 0;
    if (!grows) return null;
    const need = plan.metrics.blobBytes + plan.metrics.logicalRows * LEDGER_ROW_BYTES;
    const id = this.activeReservation;
    if (id === null) {
      this.ledger.admit(need, this.privileged);
      return null;
    }
    return { id, take: this.ledger.draw(id, need, this.privileged) };
  }

  /**
   * Run `fn` (synchronous, so nothing interleaves) as the operation that
   * holds reservation `id`: its transactions draw from it.
   */
  private withReservation<T>(id: string | undefined, fn: () => T): T {
    if (id === undefined) return fn();
    const prior = this.activeReservation;
    this.activeReservation = id;
    try {
      return fn();
    } finally {
      this.activeReservation = prior;
    }
  }

  /** The bytes this database occupies on the host (workerd's databaseSize; SQLite's pages elsewhere). */
  databaseBytes(): number {
    return databaseBytesOf(this.sql);
  }

  private executeMeasuredTransaction(
    plan: TransactionPlan,
    execution: TransactionExecution,
    callback: () => void,
  ): void {
    if (this._activeTransaction !== null) {
      throw new Error('[sqlite-vfs] nested transaction plan execution is not supported');
    }
    const drawn = this.admitTransaction(plan, execution);
    const startedAt = performance.now();
    this._activeTransaction = { startedAt, plan, execution };
    try {
      this.transactionSync(callback);
    } catch (error) {
      if (drawn !== null) this.ledger.refund(drawn.id, drawn.take);
      throw error;
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
  runContentMaintenance(maxTransactions = 4): { transactions: number } {
    const maximum = clampNonNegativeInt(maxTransactions);
    // Ending stale imports first: what they held is collected in this pass.
    let transactions = this.sweepStaleImports(maximum);
    while (transactions < maximum && this.legacyTables.length > 0) {
      this.legacyJanitorPage();
      transactions++;
    }
    const pinnedChunks = new Set<number>();
    const pinnedContents = this.stagingPins();
    for (const opened of this.openNodes) {
      if (opened.inode.chunkId !== null) pinnedChunks.add(opened.inode.chunkId);
      if (opened.inode.contentId !== null) pinnedContents.add(opened.inode.contentId);
    }
    let contentsIdle = false;
    let chunksIdle = false;
    let wrapped = false;
    while (transactions < maximum) {
      const page = this.gcPage(GC_CONTENT, pinnedContents);
      if (page === null) {
        if (wrapped || this.gcCursor[GC_CONTENT] === 0) { contentsIdle = true; break; }
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
        if (wrapped || this.gcCursor[GC_CHUNK] === 0) { chunksIdle = true; break; }
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
  private tombstoneRows(): number {
    if (this._tombstoneRows === null) {
      this._tombstoneRows = Number([...this.sql.exec('SELECT COUNT(*) AS n FROM vfs_tombstones')][0]!.n);
    }
    return this._tombstoneRows;
  }

  /** Drop the oldest page of tombstones and raise the floor to the newest dropped. */
  private pruneTombstones(): void {
    const edge = [...this.sql.exec(
      'SELECT gen FROM vfs_tombstones ORDER BY gen LIMIT 1 OFFSET ?',
      Math.min(TOMBSTONE_PRUNE_PAGE_ROWS, Math.max(1, this.tombstoneRows() - this.tombstoneRetain)) - 1,
    )][0];
    if (edge === undefined) { this._tombstoneRows = null; return; }
    const floor = Number(edge.gen);
    let removed = 0;
    this.executeMeasuredTransaction(
      this.metricsOnlyPlan({ blobBytes: 0, logicalRows: TOMBSTONE_PRUNE_PAGE_ROWS * 2 + 1, sqlExecs: 3, affectedPaths: 0 }),
      { source: 'content-gc', limitMode: 'bounded' },
      () => {
        removed = [...this.sql.exec('DELETE FROM vfs_tombstones WHERE gen <= ? RETURNING 1', floor)].length;
        this.sql.exec('UPDATE vfs_state SET tomb_floor = MAX(tomb_floor, ?) WHERE slot = 1', floor);
      },
    );
    this._tombstoneFloor = Math.max(this._tombstoneFloor, floor);
    this._tombstoneRows = Math.max(0, this.tombstoneRows() - removed);
    // A path whose tombstone went reports the floor (pathRevision), which
    // must cover its removal. Every tombstone was published by the operation
    // that wrote it before maintenance could run, so the clock bound never binds.
    if (floor > this._revisionFloor) this.dropPathRevisionsThrough(Math.min(floor, this._revision));
  }

  /**
   * The next page of queued ids of `kind` past the cursor, pinned ones
   * stepped over (the cursor moves past them; they stay queued). Null when
   * the queue has nothing past the cursor.
   */
  private gcPage(kind: typeof GC_CHUNK | typeof GC_CONTENT, pinned: ReadonlySet<number>): number[] | null {
    const rows = [...this.sql.exec(
      'SELECT id FROM vfs_gc_queue WHERE kind = ? AND id > ? ORDER BY id LIMIT ?',
      kind,
      this.gcCursor[kind],
      KEYS_PER_SQL_EXEC,
    )];
    if (rows.length === 0) return null;
    this.gcCursor[kind] = Number(rows[rows.length - 1]!.id);
    const ids: number[] = [];
    for (const row of rows) {
      const id = Number(row.id);
      if (!pinned.has(id)) ids.push(id);
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
  private collectContents(ids: readonly number[], pinnedChunks: ReadonlySet<number>): void {
    const list = ids.map(() => '?').join(',');
    const freed: number[] = [];
    this.executeMeasuredTransaction(
      this.metricsOnlyPlan({ blobBytes: 0, logicalRows: GC_MANIFEST_ROWS * 2 + ids.length, sqlExecs: 13, affectedPaths: 0 }),
      { source: 'content-gc', limitMode: 'bounded' },
      () => {
        const dead = [...this.sql.exec(
          `SELECT id FROM vfs_contents AS c WHERE id IN (${list})
             AND NOT EXISTS (SELECT 1 FROM vfs_inodes WHERE content_id = c.id)
             AND NOT EXISTS (SELECT 1 FROM vfs_inode_history WHERE content_id = c.id)`,
          ...ids,
        )].map((row) => Number(row.id));
        const finished = new Set(ids);
        if (dead.length > 0) {
          const deadList = dead.map(() => '?').join(',');
          this.sql.exec(
            `UPDATE vfs_contents SET state = ${CONTENT_DYING}, digest = NULL WHERE id IN (${deadList}) AND state != ${CONTENT_DYING}`,
            ...dead,
          );
          const rows = [...this.sql.exec(
            `SELECT content_id, off, chunk_id FROM vfs_content_chunks WHERE content_id IN (${deadList})
             ORDER BY content_id, off LIMIT ?`,
            ...dead,
            GC_MANIFEST_ROWS,
          )];
          // A full page may have stopped inside its last content: that one
          // keeps its unread rows and its queue row for the next pass.
          const partial = rows.length === GC_MANIFEST_ROWS ? rows[rows.length - 1]! : null;
          const drained = dead.filter((id) => partial === null || id < Number(partial.content_id));
          if (partial !== null) {
            const id = Number(partial.content_id);
            for (const other of dead) if (other >= id) finished.delete(other);
            this.sql.exec(
              'DELETE FROM vfs_content_chunks WHERE content_id = ? AND off <= ?',
              id,
              Number(partial.off),
            );
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
            for (const row of this.sql.exec(
              `DELETE FROM vfs_chunks AS c WHERE id IN (${collectable.map(() => '?').join(',')})
                 AND NOT EXISTS (SELECT 1 FROM vfs_inodes WHERE chunk_id = c.id)
                 AND NOT EXISTS (SELECT 1 FROM vfs_content_chunks WHERE chunk_id = c.id)
                 AND NOT EXISTS (SELECT 1 FROM vfs_inode_history WHERE chunk_id = c.id)
               RETURNING id, hash, state`,
              ...collectable,
            )) {
              freed.push(Number(row.id));
              if (Number(row.state) === CHUNK_COLD) this.sql.exec('INSERT OR IGNORE INTO vfs_cold_trash (hash) VALUES (?)', row.hash);
            }
          }
          // What something may still name goes on the queue: its last
          // reference, when it goes, dereferences it again anyway.
          const gone = new Set(freed);
          const queued: number[] = [];
          for (const id of released) if (!gone.has(id) && pinnedChunks.has(id)) queued.push(GC_CHUNK, id);
          this.insertRows('vfs_gc_queue (kind, id)', GC_ROW_COLUMNS, queued, 'INSERT OR IGNORE');
        }
        const done = [...finished];
        if (done.length > 0) {
          this.sql.exec(
            `DELETE FROM vfs_gc_queue WHERE kind = ${GC_CONTENT} AND id IN (${done.map(() => '?').join(',')})`,
            ...done,
          );
        }
      },
    );
    for (const id of freed) this.cacheEvict(id);
  }

  /** Delete queued chunks that no inode, manifest or history row names. */
  private collectChunks(ids: readonly number[]): void {
    const list = ids.map(() => '?').join(',');
    const freed: number[] = [];
    this.executeMeasuredTransaction(
      this.metricsOnlyPlan({ blobBytes: 0, logicalRows: ids.length * 2, sqlExecs: 2, affectedPaths: 0 }),
      { source: 'content-gc', limitMode: 'bounded' },
      () => {
        for (const row of this.sql.exec(
          `DELETE FROM vfs_chunks AS c WHERE id IN (${list})
             AND NOT EXISTS (SELECT 1 FROM vfs_inodes WHERE chunk_id = c.id)
             AND NOT EXISTS (SELECT 1 FROM vfs_content_chunks WHERE chunk_id = c.id)
             AND NOT EXISTS (SELECT 1 FROM vfs_inode_history WHERE chunk_id = c.id)
           RETURNING id, hash, state`,
          ...ids,
        )) {
          freed.push(Number(row.id));
          if (Number(row.state) === CHUNK_COLD) this.sql.exec('INSERT OR IGNORE INTO vfs_cold_trash (hash) VALUES (?)', row.hash);
        }
        this.sql.exec(`DELETE FROM vfs_gc_queue WHERE kind = ${GC_CHUNK} AND id IN (${list})`, ...ids);
      },
    );
    for (const id of freed) this.cacheEvict(id);
  }

  /**
   * One page of the reference audit: queue every chunk and content in the
   * page that nothing names: chunks first, then contents. It finds only what
   * a bug leaked, so it walks once per lifetime, a page per maintenance run,
   * and stops.
   */
  private auditPage(pinnedContents: ReadonlySet<number>): void {
    const audit = this.auditCursor!;
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
    if (page.length === KEYS_PER_SQL_EXEC) this.auditCursor = { kind: audit.kind, id: page[page.length - 1]! };
    else this.auditCursor = audit.kind === GC_CHUNK ? { kind: GC_CONTENT, id: 0 } : null;
  }

  /** Queue rows (kind, id pairs) for the chunks and contents given that nothing names. */
  private unreferenced(chunks: readonly number[], contents: readonly number[]): number[] {
    const out: number[] = [];
    for (let i = 0; i < chunks.length; i += KEYS_PER_SQL_EXEC) {
      const batch = chunks.slice(i, i + KEYS_PER_SQL_EXEC);
      for (const row of this.sql.exec(
        `SELECT id FROM vfs_chunks AS c WHERE id IN (${batch.map(() => '?').join(',')})
           AND NOT EXISTS (SELECT 1 FROM vfs_inodes WHERE chunk_id = c.id)
           AND NOT EXISTS (SELECT 1 FROM vfs_content_chunks WHERE chunk_id = c.id)
           AND NOT EXISTS (SELECT 1 FROM vfs_inode_history WHERE chunk_id = c.id)`,
        ...batch,
      )) out.push(GC_CHUNK, Number(row.id));
    }
    for (let i = 0; i < contents.length; i += KEYS_PER_SQL_EXEC) {
      const batch = contents.slice(i, i + KEYS_PER_SQL_EXEC);
      for (const row of this.sql.exec(
        `SELECT id FROM vfs_contents AS c WHERE id IN (${batch.map(() => '?').join(',')})
           AND NOT EXISTS (SELECT 1 FROM vfs_inodes WHERE content_id = c.id)
           AND NOT EXISTS (SELECT 1 FROM vfs_inode_history WHERE content_id = c.id)`,
        ...batch,
      )) out.push(GC_CONTENT, Number(row.id));
    }
    return out;
  }

  /**
   * Debug-only: walk every chunk and content and report what nothing names
   * and the queue does not hold. Zero after GC means no leak. O(store); tests
   * and diagnostics only.
   */
  _auditContentStore(): { chunks: number; contents: number } {
    let chunks = 0;
    let contents = 0;
    const pinned = this.stagingPins();
    for (const opened of this.openNodes) if (opened.inode.contentId !== null) pinned.add(opened.inode.contentId);
    for (let cursor = 0; ;) {
      const page = [...this.sql.exec('SELECT id FROM vfs_chunks WHERE id > ? ORDER BY id LIMIT ?', cursor, KEYS_PER_SQL_EXEC)]
        .map((row) => Number(row.id));
      const leaked = this.unreferenced(page, []);
      for (let i = 1; i < leaked.length; i += 2) {
        if ([...this.sql.exec('SELECT 1 FROM vfs_gc_queue WHERE kind = ? AND id = ?', GC_CHUNK, leaked[i]!)].length === 0) chunks++;
      }
      if (page.length < KEYS_PER_SQL_EXEC) break;
      cursor = page[page.length - 1]!;
    }
    for (let cursor = 0; ;) {
      const page = [...this.sql.exec('SELECT id FROM vfs_contents WHERE id > ? ORDER BY id LIMIT ?', cursor, KEYS_PER_SQL_EXEC)]
        .map((row) => Number(row.id));
      const leaked = this.unreferenced([], page.filter((id) => !pinned.has(id)));
      for (let i = 1; i < leaked.length; i += 2) {
        if ([...this.sql.exec('SELECT 1 FROM vfs_gc_queue WHERE kind = ? AND id = ?', GC_CONTENT, leaked[i]!)].length === 0) contents++;
      }
      if (page.length < KEYS_PER_SQL_EXEC) break;
      cursor = page[page.length - 1]!;
    }
    return { chunks, contents };
  }

  /** Delete one page of the first legacy table's rows; drop it once empty. */
  private legacyJanitorPage(): void {
    const table = this.legacyTables[0]!;
    const rows = [...this.sql.exec(`SELECT rowid AS r FROM ${table} LIMIT ?`, MAX_TX_LOGICAL_ROWS)];
    this.executeMeasuredTransaction(
      this.metricsOnlyPlan({ blobBytes: 0, logicalRows: rows.length, sqlExecs: 1, affectedPaths: 0 }),
      { source: 'content-gc', limitMode: 'bounded' },
      () => {
        if (rows.length === 0) this.sql.exec(`DROP TABLE ${table}`);
        else {
          this.sql.exec(
            `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} LIMIT ?)`,
            MAX_TX_LOGICAL_ROWS,
          );
        }
      },
    );
    if (rows.length === 0) this.legacyTables.shift();
  }

  private runContentMaintenanceSafely(maxTransactions: number, force = false): void {
    if (this.transactionPublication) return;
    if (!force && !this.maintenancePending && !this.importSweepPending) return;
    const startedAt = performance.now();
    try {
      this.runContentMaintenance(maxTransactions);
    } catch (error) {
      this.maintenancePending = true;
      console.error('[sqlite-vfs] content maintenance failed:', this.errorMessage(error));
    } finally {
      this.recordDuration(this._maintenanceDuration, performance.now() - startedAt);
    }
  }

  private metricsOnlyPlan(metrics: TransactionPlanMetrics): TransactionPlan {
    return {
      inodes: [],
      deletes: [],
      staged: [],
      stagingCreated: [],
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

  private currentRetainedWriteBytes(): number {
    return this.writeStreamCredits.stats.current;
  }

  /** Best-effort process.memoryUsage().heapUsed; 0 in DO contexts. */
  private _safeHeapUsed(): number {
    try {
      const mu = nodeHost.process?.memoryUsage?.();
      return Number(mu?.heapUsed) || 0;
    } catch {
      return 0;
    }
  }

  /**
   * The plan of one strict batch. Every file's positional wire chunks are
   * joined, cut and hashed here, before the transaction; the hashes resolve
   * to chunk ids inside it.
   */
  private prepareBatchTransaction(payload: BatchWritePayload): PreparedBatchTransaction {
    const deletedInodes = this.collectSubtreeInodes(payload.deletePaths ?? []);
    const deletedInodesByPath = new Map(deletedInodes.map((inode) => [inode.path, inode]));
    const builder = this.newPlan();
    const deletedPaths = new Set(payload.deletePaths ?? []);
    for (const inode of deletedInodes) deletedPaths.add(inode.path);
    for (const path of deletedPaths) builder.addDeletedPath(path, deletedInodesByPath.get(path));

    const normalizedInodes = new Map<string, NormalizedBatchInodeEntry>();
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
    const chunksByPath = new Map<string, BatchChunkEntry[]>();
    for (const chunk of payload.chunks) {
      if (!normalizedInodes.has(chunk.path)) {
        throw vfsError('EINVAL', `chunk has no regular file inode: ${chunk.path}`);
      }
      const entries = chunksByPath.get(chunk.path);
      if (entries) entries.push(chunk);
      else chunksByPath.set(chunk.path, [chunk]);
    }

    for (const entry of normalizedInodes.values()) {
      const kind = inodeKind(entry);
      let content: InodeContent = { type: 'none' };
      if (entry.isDir) {
        if ((chunksByPath.get(entry.path)?.length ?? 0) > 0) {
          throw vfsError('EINVAL', `directory batch entry has chunks: ${entry.path}`);
        }
      } else {
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
        defaultAcl: (entry as NormalizedBatchInodeEntry).defaultAcl,
      });
    }
    return { plan: builder.build(), deletedInodes };
  }

  private validateFileChunks(inode: BatchInodeEntry, chunks: readonly BatchChunkEntry[]): void {
    this.validateInodeContentShape(inode);
    if (inode.chunkCount !== chunks.length) {
      throw vfsError('EINVAL', `${inode.path}: expected ${inode.chunkCount} chunks, got ${chunks.length}`);
    }
    let total = 0;
    const ordered = [...chunks].sort((a, b) => a.chunkId - b.chunkId);
    for (let index = 0; index < ordered.length; index++) {
      const chunk = ordered[index];
      if (chunk.chunkId !== index) {
        throw vfsError('EINVAL', `${inode.path}: expected chunk ${index}, got ${chunk.chunkId}`);
      }
      const expected = Math.min(CHUNK_SIZE, inode.size - (index * CHUNK_SIZE));
      if (chunk.data.byteLength !== expected) {
        throw vfsError('EINVAL', `${inode.path}: chunk ${index} has ${chunk.data.byteLength} bytes; expected ${expected}`);
      }
      total += chunk.data.byteLength;
    }
    if (total !== inode.size) {
      throw vfsError('EINVAL', `${inode.path}: chunk bytes ${total} do not match size ${inode.size}`);
    }
  }

  private validateInodeContentShape(inode: BatchInodeEntry): void {
    const kind = inodeKind(inode);
    const expectedParent = this.parentPath(inode.path);
    if (inode.parentPath !== expectedParent) {
      throw vfsError('EINVAL', `${inode.path}: parentPath ${inode.parentPath} does not match ${expectedParent}`);
    }
    if (inode.isDir !== (kind === 'directory')) {
      throw vfsError('EINVAL', `${inode.path}: inode kind ${kind} conflicts with isDir=${inode.isDir}`);
    }
    if (!Number.isSafeInteger(inode.size) || inode.size < 0) {
      throw vfsError('EINVAL', `${inode.path}: invalid size ${inode.size}`);
    }
    if (!Number.isSafeInteger(inode.chunkCount) || inode.chunkCount < 0) {
      throw vfsError('EINVAL', `${inode.path}: invalid chunk count ${inode.chunkCount}`);
    }
    if (kind === 'directory' && inode.size !== 0) {
      throw vfsError('EINVAL', `${inode.path}: directory size must be zero`);
    }
    const expectedChunkCount = kind === 'directory' || inode.size === 0
      ? 0
      : Math.ceil(inode.size / CHUNK_SIZE);
    if (inode.chunkCount !== expectedChunkCount) {
      throw vfsError(
        'EINVAL',
        `${inode.path}: expected ${expectedChunkCount} chunks for ${inode.size} bytes, got ${inode.chunkCount}`,
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
    prepared: { plan: TransactionPlan; deletedInodes: readonly INode[] },
    execution: TransactionExecution,
    onCommit?: () => void,
  ): { inodes: number } {
    const { plan, deletedInodes } = prepared;
    // What stood at each published path before this transaction. Read now,
    // while it is still true: after the commit, a lookup finds the row the
    // commit wrote. Not admitted: replacing a file is not a use of it.
    const priors = plan.inodes.map((entry) => this.inodes.peek(entry.path) ?? this.loadInode(entry.path));
    try {
      this.executeTransactionPlan(plan, execution, onCommit, priors);
    } catch (error) {
      console.error('[sqlite-vfs] writeBatch failed:', this.errorMessage(error));
      throw error;
    }

    const postCommitStartedAt = performance.now();

    // 4. Publish the recursive deletions, then inode replacements.
    const deleted = new Set<string>();
    for (const inode of deletedInodes) {
      deleted.add(inode.path);
      this.inodes.delete(inode.path);
      if (inode.isDir) {
        this._totalDirs--;
      } else {
        this._totalFiles--;
        this._usedBytes -= inode.size;
      }
    }

    // B3: the running counters move by each published inode's delta against
    // what it replaced: nothing, for a path this batch deleted first, and the
    // earlier entry, for a path the batch publishes twice.
    const replacedPaths = new Set<string>();
    const published = new Map<string, INode>();
    for (let index = 0; index < plan.inodes.length; index++) {
      const entry = plan.inodes[index]!;
      const prior = published.get(entry.path) ?? (deleted.has(entry.path) ? undefined : priors[index]);
      if (prior !== undefined) replacedPaths.add(entry.path);
      const atime = entry.atime !== undefined && Number.isFinite(entry.atime) ? entry.atime : entry.mtime;
      if (entry.ino === undefined) {
        throw new Error(`[sqlite-vfs] committed inode ${entry.path} reached memory without an ino`);
      }
      const node: INode = {
        path: entry.path,
        parentPath: entry.parentPath,
        kind: entry.kind,
        isDir: entry.isDir,
        size: entry.size,
        atime,
        mtime: entry.mtime,
        ctime: entry.ctime!,
        mode: entry.mode,
        uid: entry.uid,
        gid: entry.gid,
        chunkId: entry.chunkId ?? null,
        contentId: entry.contentId ?? null,
        ino: entry.ino,
        gen: entry.gen!,
        defaultAcl: entry.defaultAcl ?? null,
      };
      this.inodes.set(entry.path, node);
      published.set(entry.path, node);

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
    this._sqlWrites += inodeCount + plan.deletes.length;
    this._batchWrites++;
    this._batchWriteRows += inodeCount + plan.deletes.length;
    // Every directory the batch deleted, or replaced with a file, went from
    // its name, and a reader holding anything under one must let it go; one
    // whose mode, owner or group changed changed who may enter it.
    const removed = deletedInodes.filter((inode) => inode.isDir);
    const structural = new Map<string, StructuralChange>();
    for (let index = 0; index < plan.inodes.length; index++) {
      const prior = priors[index];
      const entry = plan.inodes[index]!;
      if (!prior?.isDir || deleted.has(prior.path)) continue;
      if (!entry.isDir) removed.push(prior);
      else if (entry.mode !== prior.mode || entry.uid !== prior.uid || entry.gid !== prior.gid) {
        structural.set(prior.path, 'changed');
      }
    }
    for (const inode of removed) structural.set(inode.path, 'removed');
    if (inodeCount > 0 || plan.deletes.length > 0) {
      // One clock tick for the whole batch; stamp every touched path.
      this.bumpRevision([...plan.affectedPaths], structural);
    }

    // 5. Events observe the already-published metadata and revision.
    this.deliverEvents(removed, () => {
      for (const inode of deletedInodes) {
        this.emitMutation(inode.isDir ? 'unlinkDir' : 'unlink', inode.path);
      }
      for (const entry of plan.inodes) {
        this.emitMutation(entry.isDir ? 'addDir' : replacedPaths.has(entry.path) ? 'change' : 'add', entry.path);
      }
    });

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
  private collectSubtreeInodes(roots: readonly string[]): INode[] {
    if (roots.length === 0) return [];
    const collected: INode[] = [];
    const visited = new Set<string>();
    for (const root of roots) {
      const range = subtreeRange(root);
      const rows = [
        ...this.sql.exec(`SELECT ${INODE_SELECT_COLUMNS} FROM vfs_inodes WHERE path = ?`, root),
        ...(range.upper === null
          ? this.sql.exec(`SELECT ${INODE_SELECT_COLUMNS} FROM vfs_inodes WHERE path > ?`, range.lower)
          : this.sql.exec(
            `SELECT ${INODE_SELECT_COLUMNS} FROM vfs_inodes WHERE path > ? AND path < ?`,
            range.lower,
            range.upper,
          )),
      ];
      for (const row of rows) {
        const path = String(row.path);
        if (visited.has(path)) continue;
        visited.add(path);
        collected.push(this.inodes.peek(path) ?? this.inodeFromRow(row));
      }
    }
    // A child's path is always longer than its parent's, so length order
    // removes every descendant before the directory holding it. Ties break on
    // the path itself: nothing a delete publishes should depend on traversal
    // or insertion order.
    return collected.sort((a, b) => (
      b.path.length - a.path.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    ));
  }

  /**
   * Bulk mkdir: create all directories in a single transactionSync.
   * Pre-creates the full directory tree before file writes to avoid
   * per-file mkdir overhead.
   */
  private mkdirBatch(paths: string[], cred: VfsCred): number {
    this.assertMutationsAllowed(paths);
    const mtime = Date.now();
    const toCreate: BatchInodeEntry[] = [];
    const seen = new Set<string>();

    const placed = new Map<string, string>();
    for (const path of paths) {
      const parts = this.storageKey(path, cred).split('/').filter(Boolean);
      let current = '';
      for (const part of parts) {
        current = this.createdPath(current ? current + '/' + part : part, cred, placed);
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

    if (toCreate.length === 0) return 0;
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
  _verifyCounters(): null | { expected: { files: number; dirs: number; bytes: number }; actual: { files: number; dirs: number; bytes: number } } {
    this.ensureCounters();
    const durable = this.aggregateCounters();
    if (durable.files === this._totalFiles && durable.dirs === this._totalDirs && durable.bytes === this._usedBytes) return null;
    return {
      expected: { files: durable.files, dirs: durable.dirs, bytes: durable.bytes },
      actual: { files: this._totalFiles, dirs: this._totalDirs, bytes: this._usedBytes },
    };
  }

  /**
   * The root mount's df numbers. `size` is the Durable Object storage limit
   * this store is built to fit; `used` the bytes of file content stored;
   * `available` what the host can still take: the limit less the whole
   * database (content plus metadata, indexes and free pages) where the host
   * reports its size, else less the stored bytes.
   */
  /**
   * What df reports for the session's storage (N18): the limit, what the
   * ledger counts as used (this database, every facet's, the images and
   * reservations), and what a user may still write, the kernel's reserve
   * left out, as ext4's df leaves out root's reserved blocks.
   */
  storageUsage(): { size: number; used: number; available: number } {
    const view = this.ledger.view();
    return { size: view.limit, used: view.used, available: Math.max(0, view.limit - this.ledger.kernelReserve - view.used) };
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
      capacityBytes: DO_STORAGE_LIMIT_BYTES,
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
          decodeDrainWaitMs: durationSnapshot(
            this._decodeDrainDuration,
            activeDecodeDrainDuration,
          ),
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

function inodeKind(inode: Pick<BatchInodeEntry, 'kind' | 'isDir'>): VfsInodeKind {
  const kind = inode.kind ?? (inode.isDir ? 'directory' : 'file');
  if (kind !== 'file' && kind !== 'directory' && kind !== 'symlink') {
    throw vfsError('EINVAL', `invalid inode kind ${String(kind)}`);
  }
  return kind;
}

function inodeKindCode(kind: VfsInodeKind): number {
  if (kind === 'file') return INODE_KIND_FILE;
  if (kind === 'directory') return INODE_KIND_DIRECTORY;
  if (kind === 'symlink') return INODE_KIND_SYMLINK;
  throw vfsError('EINVAL', `invalid inode kind ${String(kind)}`);
}

function inodeKindFromCode(code: number): VfsInodeKind {
  if (code === INODE_KIND_FILE) return 'file';
  if (code === INODE_KIND_DIRECTORY) return 'directory';
  if (code === INODE_KIND_SYMLINK) return 'symlink';
  throw vfsError('EIO', `invalid durable inode kind ${code}`);
}

/** POSIX S_IFMT filetype bits for a stored st_mode (S_IFREG/S_IFDIR/S_IFLNK). */
function inodeTypeBits(kind: VfsInodeKind): number {
  if (kind === 'file') return 0o100000;
  if (kind === 'directory') return 0o040000;
  return 0o120000;
}

function batchMutationPaths(payload: BatchWritePayload): Set<string> {
  const paths = new Set<string>(payload.deletePaths ?? []);
  for (const inode of payload.inodes) paths.add(inode.path);
  for (const chunk of payload.chunks) paths.add(chunk.path);
  return paths;
}

function pathsOverlap(left: string, right: string): boolean {
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
function subtreeRange(root: string): { lower: string; upper: string | null } {
  return root === '' ? { lower: '', upper: null } : { lower: `${root}/`, upper: `${root}0` };
}

function vfsError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

const NO_BYTES = new Uint8Array(0);

/** Upper bounds on the inode numbers, chunk ids and content ids one plan allocates. */
function planIdReservation(plan: TransactionPlan): { inos: number; chunks: number; contents: number } {
  let chunks = 0;
  let contents = plan.stagingCreated.length;
  for (const staged of plan.staged) if (!staged.named) chunks++;
  for (const entry of plan.inodes) {
    const content = entry.content;
    switch (content.type) {
      case 'small': case 'rewrite': chunks++; break;
      case 'large': chunks += content.pieces.length; contents++; break;
      case 'edit': chunks += content.pieces.length; break;
      case 'imported':
        for (const piece of content.pieces) if (piece.data !== null) chunks++;
        if (content.manifest) contents++;
        break;
      default: break;
    }
  }
  return { inos: plan.inodes.length, chunks, contents };
}

/** Let the host settle storage writes between slices of a long job. */
function yieldToStorage(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Why a chunk that is not local cannot be read. */
function unreadableChunkError(state: number, path: string): Error & { code: string } {
  return state === CHUNK_PENDING ? pendingChunkError(path) : coldChunkError(path);
}

/**
 * A read of bytes a lazy import has not brought yet (N17): EIO naming the
 * path, and marked, so an asynchronous caller can wait for them instead.
 */
export function pendingChunkError(path: string): Error & { code: string; nimbusPending: true; path: string } {
  const shown = path.startsWith('/') ? path : `/${path}`;
  return Object.assign(new Error(`EIO: ${shown} is still being imported; its bytes arrive in the background`), {
    code: 'EIO', nimbusPending: true as const, path: shown,
  });
}

/**
 * Each listed entry's encoded bytes less its path's, as first measured. A
 * listing entry is not changed once listed except for its path (a lister
 * re-rooting it into another path space), so the same entry measured again
 * under another path costs only that path's encoding.
 */
const entryBytesBesidePath = new WeakMap<VfsListEntry, number>();

const ASCII = /^[\x00-\x7f]*$/;

/** The UTF-8 length of `text`: its length when it is ASCII, as a listing's JSON almost always is. */
function utf8Length(text: string): number {
  return ASCII.test(text) ? text.length : enc.encode(text).byteLength;
}

/**
 * The byte bound of one listing page (VfsListPage): the page's frame, each
 * entry's actual encoding (escaping included) and a comma, and the cursor
 * the last one leaves in `next` (its path in place of `null`). The returned
 * check admits an entry, listed under `path` (its own by default), while the
 * page still fits the RPC frame with it; an entry that cannot fit a page on
 * its own is E2BIG.
 */
export function listPageBudget(epoch: string, rev: number): (entry: VfsListEntry, path?: string) => boolean {
  const frameBytes = utf8Length(JSON.stringify({ epoch, rev, entries: [], next: null }));
  let entriesBytes = 0;
  let count = 0;
  return (entry, path = entry.path) => {
    const pathBytes = utf8Length(JSON.stringify(path));
    let beside = entryBytesBesidePath.get(entry);
    if (beside === undefined) {
      const ownPathBytes = path === entry.path ? pathBytes : utf8Length(JSON.stringify(entry.path));
      beside = utf8Length(JSON.stringify(entry)) - ownPathBytes;
      entryBytesBesidePath.set(entry, beside);
    }
    const bytes = beside + pathBytes;
    const cursorBytes = Math.max(4, pathBytes) - 4;
    if (frameBytes + entriesBytes + (count ? 1 : 0) + bytes + cursorBytes > MAX_RPC_SAFE_PAYLOAD_BYTES) {
      if (count === 0) throw vfsError('E2BIG', `${path}: listing entry exceeds the RPC byte budget`);
      return false;
    }
    entriesBytes += bytes + (count ? 1 : 0);
    count++;
    return true;
  };
}

/** Whether `error` is a read of bytes still being imported. */
export function isPendingChunkError(error: unknown): error is Error & { path: string } {
  return typeof error === 'object' && error !== null && (error as { nimbusPending?: unknown }).nimbusPending === true;
}

function coldChunkError(what: string): Error & { code: string } {
  return vfsError('ENODATA', `${what}: its bytes are in cold storage; await prepareSnapshot() first`);
}

function unhex(text: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(text)) throw vfsError('EINVAL', `not a sha256: ${text}`);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** A 32-byte hash as a Map key (one UTF-16 unit per byte). */
function hashKey(hash: Uint8Array): string {
  let key = '';
  for (let i = 0; i < hash.length; i++) key += String.fromCharCode(hash[i]!);
  return key;
}

/** The (kind, id) rows one transaction queues for GC, each once. */
class GcQueue {
  private readonly seen = new Set<string>();
  private readonly values: number[] = [];

  add(kind: typeof GC_CHUNK | typeof GC_CONTENT, id: number): void {
    const key = `${kind}:${id}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.values.push(kind, id);
  }

  rows(): readonly number[] {
    return this.values;
  }
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.byteLength;
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
function joinChunks(chunks: readonly BatchChunkEntry[]): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);
  const ordered = [...chunks].sort((a, b) => a.chunkId - b.chunkId).map((chunk) => chunk.data);
  if (ordered.length === 1) return ordered[0]!;
  const first = ordered[0]!;
  let end = first.byteOffset + first.byteLength;
  for (let i = 1; i < ordered.length; i++) {
    const next = ordered[i]!;
    if (next.buffer !== first.buffer || next.byteOffset !== end) return concatBytes(ordered);
    end += next.byteLength;
  }
  return new Uint8Array(first.buffer, first.byteOffset, end - first.byteOffset);
}

/** How a whole file's bytes are stored when they fit one transaction. */
function fileContent(data: Uint8Array): InodeContent {
  if (data.byteLength === 0) return { type: 'none' };
  if (data.byteLength <= CHUNK_SIZE) return { type: 'small', piece: { data, hash: chunkHash(data) } };
  const pieces: Piece[] = [];
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
