import type { VfsEvent } from '../vfs/events.js';

/**
 * A value SQLite can return in a row.
 *
 * `ArrayBufferView` is in the union because the host decides the blob
 * representation and the hosts disagree: workerd's SqlStorage hands back an
 * `ArrayBuffer`, `bun:sqlite` and `better-sqlite3` hand back a `Uint8Array`.
 * Both are read through `blobToUint8Array`, which has always accepted either.
 */
export type SqlValue = ArrayBuffer | ArrayBufferView | string | number | bigint | null;

export type SqlRow = Record<string, SqlValue>;

/**
 * The whole of the SQL surface the Nimbus filesystem needs.
 *
 * One method, because that is what the filesystem actually calls — 88 sites,
 * all `exec`, all consuming the result by spreading it. workerd's `SqlStorage`
 * satisfies this structurally, so the Durable Object path passes
 * `ctx.storage.sql` unchanged and pays nothing for the indirection.
 *
 * NOT named `SqlStorage`, deliberately. That name is an ambient global from
 * `@cloudflare/workers-types`: a port sharing it would still resolve in any
 * file that forgot the import, silently re-binding to workerd's type while
 * appearing decoupled. A distinct name makes the choice visible at the import.
 */
export interface SqlDatabase {
  exec(query: string, ...bindings: unknown[]): Iterable<SqlRow>;
  /**
   * Bytes the database occupies on the host, where the host reports it
   * (workerd's `SqlStorage.databaseSize`). Read only for free space: a host
   * without it gets free space reckoned from the bytes the filesystem stores.
   */
  readonly databaseSize?: number;
}

/**
 * Synchronous, all-or-nothing grouping of `exec` calls.
 *
 * Separate from {@link NimbusSqlDatabase} because it is a property of the
 * STORE, not of the statement runner, and because hosts expose it apart from
 * `exec`: workerd puts it on `ctx.storage`, `bun:sqlite` builds one with
 * `db.transaction(fn)`. The filesystem's atomicity guarantees rest entirely on
 * this being a real transaction — an implementation that merely calls the
 * callback silently converts every atomic write into a torn one.
 */
export interface SqlTransactions {
  transactionSync<T>(callback: () => T): T;
}

/** Host object carrying the transaction primitive (workerd: `ctx`). */
export interface TransactionHost {
  readonly storage?: SqlTransactions;
}

export interface VfsCred {
  readonly uid: number;
  readonly gid: number;
  readonly groups: readonly number[];
  readonly umask: number;
}

export const CRED_KERNEL: VfsCred = Object.freeze({
  uid: 0,
  gid: 0,
  groups: Object.freeze([0]),
  umask: 0o022,
});

/**
 * The session's unprivileged login identity — `user` in /etc/passwd, the
 * credential every process inherits unless it deliberately transitions.
 *
 * It is also the credential the embedder-facing surfaces act with: the SDK
 * filesystem API, the remote `/rpc` file ops, and the static asset server are
 * host callers, not processes, and files they create must be owned by the same
 * identity `exec` runs as. Never CRED_KERNEL — a pid-less caller must never
 * gain more authority than the shell it is writing files for.
 */
export const CRED_SESSION_USER: VfsCred = Object.freeze({
  uid: 1000,
  gid: 1000,
  groups: Object.freeze([1000]),
  umask: 0o022,
});

/** A POSIX id (or mask): an unsigned integer. */
function isCredId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Whether `value` is a credential: unsigned integer uid, gid, umask and supplementary groups. The one shape check. */
export function isVfsCred(value: unknown): value is VfsCred {
  if (typeof value !== 'object' || value === null) return false;
  const { uid, gid, groups, umask } = value as Record<string, unknown>;
  return isCredId(uid) && isCredId(gid) && isCredId(umask) && Array.isArray(groups) && groups.every(isCredId);
}

/** `value` as a credential of its own (its groups copied), or the refusal `source` makes without one. */
export function requireVfsCred(value: unknown, source: string): VfsCred {
  if (!isVfsCred(value)) throw new Error(`${source} requires process credentials`);
  return { uid: value.uid, gid: value.gid, groups: [...value.groups], umask: value.umask };
}

/** Whether two credentials are the same identity: the same ids, mask and groups, in order. */
export function sameCred(a: VfsCred, b: VfsCred): boolean {
  return a.uid === b.uid && a.gid === b.gid && a.umask === b.umask
    && a.groups.length === b.groups.length && a.groups.every((group, index) => group === b.groups[index]);
}

export type RuntimeFileType = 'file' | 'directory' | 'symlink';

export interface RuntimeVfsStat {
  dev: number;
  ino: number;
  nlink: number;
  type: RuntimeFileType;
  size: number;
  ctime: number;
  atime: number;
  mtime: number;
  mode: number;
  uid: number;
  gid: number;
  /** Per-path revision: changes iff this path (or its subtree) mutated. */
  revision: number;
}

/**
 * A directory entry's type, as readdir(3)'s d_type gives it: exact, so a
 * device, FIFO or socket is not called a regular file, and 'unknown' only
 * where the backend cannot tell without a stat (DT_UNKNOWN), which a caller
 * that needs the type then asks of stat for that entry alone.
 */
export type RuntimeDirentType = RuntimeFileType | 'character' | 'block' | 'fifo' | 'socket' | 'unknown';

export interface RuntimeVfsDirEntry {
  name: string;
  type: RuntimeDirentType;
}

export interface RuntimeOpenFlags {
  read?: boolean;
  write?: boolean;
  append?: boolean;
  create?: boolean;
  exclusive?: boolean;
  directory?: boolean;
  truncate?: boolean;
  followSymlinks?: boolean;
  /** Creation mode, masked by the binding's umask like mkdir's; ignored when the file exists. */
  mode?: number;
  expectedRevision?: number;
  /**
   * O_SYNC: each write is in the store before it returns. Without it an
   * append through the descriptor may be held a moment (SqliteVFS
   * appendThrough), unseen by anyone, and stored at fsync and close.
   */
  sync?: boolean;
}

export interface RuntimeFileHandle {
  id: number;
  path: string;
  flags: Required<Omit<RuntimeOpenFlags, 'expectedRevision' | 'mode' | 'sync'>> & {
    expectedRevision?: number;
  };
  position: number;
  closed: boolean;
}

export type Awaitable<T> = T | Promise<T>;
export type RuntimeFsPath = string
  | { readonly directory: number; readonly path: string; readonly beneath?: boolean }
  | { readonly root: string; readonly path: string; readonly beneath: true };

export interface RuntimeReadOptions {
  followSymlinks?: boolean;
  cached?: boolean;
  expectedEpoch?: string;
  expectedRevision?: number;
}

export interface NimbusFilesystemBinding {
  readonly pid: number;
  readonly cred: Readonly<VfsCred>;
  readonly signal?: AbortSignal;
}

export interface NimbusHostFilesystemLease {
  readonly fs: RuntimeFsBridge;
  dispose(): Promise<void>;
}

/** Bytes on one mount: its capacity, what it holds, and what can still be written. */
export interface NimbusMountUsage {
  readonly size: number;
  readonly used: number;
  readonly available: number;
}

/**
 * One entry of the mount table `df`, `mount` and `/proc/mounts` read.
 *
 * `source` is the device column (df's "Filesystem"), `type` the filesystem
 * type, `options` the mount options (default `rw`). `usage` answers `null`
 * for a mount with no meaningful capacity; `df` shows those only under `-a`
 * or when a path on them is named.
 */
export interface NimbusMountEntry {
  readonly mountPoint: string;
  readonly source: string;
  readonly type: string;
  readonly options?: readonly string[];
  usage(): Promise<NimbusMountUsage | null>;
}

export interface NimbusFilesystemAuthority {
  readonly namespace: string;
  bind(binding: NimbusFilesystemBinding): RuntimeFsBridge;
  openHost(cred: Readonly<VfsCred>, options?: { signal?: AbortSignal }): NimbusHostFilesystemLease;
  releaseProcess(pid: number): Promise<void>;
  /**
   * A run of the process ended and another of the same process starts in its
   * place: its descriptors close, and the next run opens its own, numbered
   * from the first as the run before's were. The pid stays live.
   */
  rewindProcess?(pid: number): Promise<void>;
  activateAppendWriter(pid: number, writerId: string): Promise<void>;
  revokeAppendWriter(pid: number, writerId: string): Promise<void>;
  revokeAppendWriters(pid: number): Promise<void>;
  revokeAppendWritersThrough(maxPid: number): Promise<void>;
  /**
   * The mounts `cred` sees, in mount order. Synchronous so `/proc/mounts`
   * can read it; only usage is async. A wrapper exposing its own mounts
   * overrides this and appends to `super.mounts(cred)`.
   */
  mounts?(cred: Readonly<VfsCred>): readonly NimbusMountEntry[];
  /**
   * N17: a launch that reads synchronously (WASI) waits here for the paths
   * it names (absolute) to be hydrated out of a lazy import, at most the
   * hydration deadline, then fails with EIO naming the first that is not.
   */
  gateLaunch?(named: readonly string[]): Promise<void>;
  /**
   * What a process's launch names — its working directory, program and
   * arguments, the literal paths its code names, the files its module map
   * was read from: where the process's listing (`bind(...).list`) walks the
   * mounts beyond SQLite (MOUNT_LIST_NAME_LIMIT). `names` is asked only when
   * its credential sees such a mount, so a launch computes nothing for SQLite
   * alone.
   */
  nameLaunch?(binding: NimbusFilesystemBinding, names: () => Iterable<string>): void;
}

/**
 * N17: a launch that reads synchronously waits for the paths it names (its
 * program, and each argument resolved against `cwd`; one that names nothing
 * pending costs nothing) to be hydrated. The error message when they are
 * not, by the deadline; null when the launch may start.
 */
export async function gateSyncLaunch(
  gate: { gateLaunch?(named: readonly string[]): Promise<void> },
  cwd: string,
  program: string | null,
  argv: readonly string[],
): Promise<string | null> {
  if (typeof gate.gateLaunch !== 'function') return null;
  try {
    await gate.gateLaunch(launchNamedPaths(cwd, program, argv));
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** The paths a synchronous-reading launch names (see {@link gateSyncLaunch}). */
export function launchNamedPaths(cwd: string, program: string | null, argv: readonly string[]): string[] {
  const anchor = (path: string) => {
    const joined = path.startsWith('/') ? path : `${cwd.replace(/\/+$/, '')}/${path}`;
    const out: string[] = [];
    for (const part of joined.split('/')) {
      if (part === '' || part === '.') continue;
      if (part === '..') out.pop(); else out.push(part);
    }
    return `/${out.join('/')}`;
  };
  const named = program === null ? [] : [anchor(program)];
  for (const arg of argv) if (arg !== '' && !arg.startsWith('-')) named.push(anchor(arg));
  return named;
}

/** A live view sharing namespace, credentials and descriptor state. */
export type RuntimeSynchronousFs = {
  // copyTree yields between slices, so it has no synchronous form; awaitRecall
  // is a long poll, waited for by the holder's own loop.
  [K in Exclude<keyof RuntimeFsBridge, 'synchronous' | 'subscribe' | 'writeStream' | 'writeFileFrom' | 'acquire' | 'copyTree' | 'gateLaunch' | 'awaitRecall'>]:
    RuntimeFsBridge[K] extends (...args: infer A) => infer R
      ? (...args: A) => Awaited<R> : never;
};

/**
 * The path's revision immediately before and after one mutation, read in
 * the same synchronous turn as the mutation. A caller holding the path's
 * content stamped at `before` (or later) knows its copy, with this
 * mutation's own local effect applied, is exactly what the authority
 * serves at `after`. A `before` past its stamp means someone else touched
 * the path in between, and the stamp must stay where it is.
 */
export interface VfsMutationReceipt { before: number; after: number }

/**
 * The exclusive mutation lease a write presents (acquireExclusiveMutation's
 * owner): a leased writer's own ranged writes, truncations and renames under
 * the leased root, as writeStream presents it for its batches. A trusted
 * binding carries it (SupervisorRPC props); a process never names one.
 */
export interface RuntimeMutationOwner {
  mutationOwner?: string;
}

export interface RuntimeFsBridge {
  readonly synchronous?: RuntimeSynchronousFs;
  /** N17: see {@link NimbusFilesystemAuthority.gateLaunch}; absent where nothing is ever imported lazily. */
  gateLaunch?(named: readonly string[]): Promise<void>;
  stat(path: RuntimeFsPath, options?: { followSymlinks?: boolean }): Awaitable<RuntimeVfsStat | null>;
  readFile(path: RuntimeFsPath, options?: { followSymlinks?: boolean }): Awaitable<Uint8Array | null>;
  /**
   * Whole-file write. Returns the revision the write produced, so a caller
   * holding the bytes it just sent can tell its own mutation apart from a
   * peer's when {@link RuntimeFsBridge.acquire} reports the path back.
   */
  writeFile(path: RuntimeFsPath, bytes: string | Uint8Array, options?: {
    /** Create missing parent directories (mkdir -p); otherwise a missing parent is ENOENT, as open(O_CREAT). */
    createParents?: boolean;
    expectedRevision?: number;
  }): Awaitable<number>;
  /**
   * Whole-file write of `size` bytes that arrive over time from `source`:
   * the file is published whole once they have, and not at all if the
   * source ends short, runs long or throws. The bytes are never held
   * together, which is the point: a large file read from the network is
   * written without holding it, and in one pass rather than a ranged write
   * per piece. Returns the revision the write produced, as writeFile does.
   * A host operation: an iterable does not cross RPC, so a program's
   * filesystem refuses it (ENOTSUP) and a program streams W7 instead.
   */
  writeFileFrom(path: RuntimeFsPath, size: number, source: AsyncIterable<Uint8Array>): Promise<number>;
  /** Stateless ranged read: clamped at EOF; null when the path is absent. */
  readRange(path: RuntimeFsPath, offset: number, length: number, options?: RuntimeReadOptions): Awaitable<Uint8Array | null>;
  /**
   * Stateless ranged write: updates only the chunks the range touches
   * (never a whole-file rewrite), zero-filling any gap past EOF.
   * Creates the file when missing. Every byte is written, so the receipt
   * carries the revisions rather than a byte count.
   */
  writeRange(path: RuntimeFsPath, offset: number, bytes: Uint8Array, options?: {
    createParents?: boolean;
    expectedRevision?: number;
  } & RuntimeMutationOwner): Awaitable<VfsMutationReceipt>;
  /** Truncate or zero-extend to `size`, touching only the boundary chunk. */
  truncate(path: RuntimeFsPath, size: number, options?: { followSymlinks?: boolean } & RuntimeMutationOwner): Awaitable<VfsMutationReceipt>;
  /** utimensat(2): null is now, undefined leaves that time; `followSymlinks: false` sets a link's own times. */
  utimes(path: RuntimeFsPath, atimeMs: number | null | undefined, mtimeMs: number | null | undefined, options?: { followSymlinks?: boolean }): Awaitable<VfsMutationReceipt>;
  /** Set permission bits (POSIX chmod — follows symlinks). */
  chmod(path: RuntimeFsPath, mode: number): Awaitable<VfsMutationReceipt>;
  /** Check access using the bridge's process credential. */
  access(path: RuntimeFsPath, mode: number): Awaitable<void>;
  /** Change stored ownership, optionally operating on a symlink itself. */
  chown(path: RuntimeFsPath, uid: number, gid: number, options?: { followSymlinks?: boolean }): Awaitable<VfsMutationReceipt>;
  open(path: RuntimeFsPath, flags: RuntimeOpenFlags): Awaitable<RuntimeFileHandle>;
  read(handleId: number, offset: number | null, length: number): Awaitable<Uint8Array>;
  write(handleId: number, offset: number | null, bytes: Uint8Array): Awaitable<number>;
  close(handleId: number): Awaitable<void>;
  readdir(path: RuntimeFsPath, options?: { followSymlinks?: boolean }): Awaitable<RuntimeVfsDirEntry[]>;
  mkdir(path: RuntimeFsPath, options?: { recursive?: boolean; mode?: number }): Awaitable<void>;
  unlink(path: RuntimeFsPath): Awaitable<void>;
  rmdir(path: RuntimeFsPath): Awaitable<void>;
  rename(from: RuntimeFsPath, to: RuntimeFsPath, options?: RuntimeMutationOwner): Awaitable<void>;
  readlink(path: RuntimeFsPath): Awaitable<string | null>;
  /**
   * Where the link at `path` (an absolute namespace path), whose text is
   * `link` (readlink's answer), leads in this namespace: the namespace's
   * link-root rule (CompositeVFS.linkLeadsTo), for a caller that follows a
   * link itself. On a mount whose backend resolves its own paths an absolute
   * target re-roots at the mount point; any other link leads to its text.
   */
  linkLeadsTo(path: string, link: string): Awaitable<string | null>;
  symlink(target: string, path: RuntimeFsPath): Awaitable<void>;
  fsync(handleId?: number): Awaitable<void>;
  /**
   * Without a path: the global VFS mutation watermark. With a path: a
   * per-path subtree watermark — it changes iff that path or anything
   * under it mutated, so consumers can cache without global invalidation.
   */
  revision(path?: RuntimeFsPath): Awaitable<number>;
  /**
   * The cache-coherence barrier. A caller holding a resident cache stamped
   * at `(epoch, cursor)` gets back every path mutated since, and re-stamps.
   *
   * `poison` means the view cannot be repaired incrementally — a different
   * supervisor incarnation, or a cursor older than the retained log — and
   * the caller must drop its entire resident set. That costs a cold cache;
   * the alternative would be serving a stale byte.
   */
  acquire(epoch: string | null, cursor: number, options?: VfsAcquireOptions): Awaitable<VfsAcquireResult>;
  /**
   * Enumerate every path this bridge's credential can see, one bounded page at
   * a time, resuming past `after`.
   *
   * {@link RuntimeFsBridge.acquire} tells a caller what CHANGED; this tells it
   * what EXISTS. A resident cache can be kept coherent with the barrier alone,
   * but it can only be made COMPLETE with this: every map a process is shipped
   * describes what it was GIVEN, so a cache enumerated from them can never
   * hold a path that was not already staged.
   */
  list(after?: string | null, limit?: number): Awaitable<VfsListPage>;
  subscribe?(path: string, listener: (event: VfsEvent) => void): () => void;
  realpath(path: RuntimeFsPath): Awaitable<string>;
  remove(path: RuntimeFsPath, options?: { recursive?: boolean; force?: boolean }): Awaitable<void>;
  copyFile(from: RuntimeFsPath, to: RuntimeFsPath): Awaitable<void | number>;
  /**
   * Copy the tree at `from` to the new path `to` (`cp -r`; `preserve` is
   * `-p`), returning the entries copied. Within one SQLite filesystem this
   * copies inode rows, never bytes; across mounts it fails EXDEV and the
   * caller copies entry by entry.
   */
  copyTree(from: RuntimeFsPath, to: RuntimeFsPath, options?: { preserve?: boolean }): Awaitable<number>;
  fstat(handleId: number): Awaitable<RuntimeVfsStat>;
  dup(handleId: number): Awaitable<RuntimeFileHandle>;
  seek(handleId: number, offset: number, whence: 'set' | 'current' | 'end'): Awaitable<number>;
  setStatus(handleId: number, status: { append?: boolean }): Awaitable<void>;
  readdirHandle(handleId: number): Awaitable<RuntimeVfsDirEntry[]>;
  ftruncate(handleId: number, size: number): Awaitable<void>;
  fchmod(handleId: number, mode: number): Awaitable<void>;
  fchown(handleId: number, uid: number, gid: number): Awaitable<void>;
  futimes(handleId: number, atimeMs: number, mtimeMs: number): Awaitable<void>;
  appendOnce(path: RuntimeFsPath, pid: number, writerId: string, moduleId: string, operationId: number, digest: string, bytes: Uint8Array): Awaitable<number>;
  acknowledgeAppend(pid: number, writerId: string, moduleId: string, operationId: number): Awaitable<void>;
  writeBatch(payload: import('@nimbus-sh/platform/w7-frame.js').BatchWritePayload): Awaitable<{ inodes: number; chunks: number }>;
  /**
   * `admit`, when given, is asked before the stream's first commit and every
   * later one; it throws to refuse them (a fenced write wave its writer has
   * since re-sent: SupervisorDeliveries.admitWave).
   */
  writeStream(stream: ReadableStream<Uint8Array>, options?: { signal?: AbortSignal; mutationOwner?: string; decodeDrainStartedAt?: number; admit?: () => void }): Promise<import('../vfs/sqlite-vfs.js').WriteBatchStreamResult>;
  /**
   * An exclusive-mutation lease on the subtree at `path`. With `delegate`,
   * a delegation: the process decides the subtree's operations itself and
   * sends them later under the lease, and another caller's access recalls
   * them (awaitRecall, recalled) rather than being refused; its answer says
   * how long the process has to answer a recall (recallTimeoutMs).
   */
  acquireExclusiveMutation(path: RuntimeFsPath, options?: ExclusiveMutationRequest): Awaitable<ExclusiveMutationGrant>;
  releaseExclusiveMutation(owner: string): Awaitable<void>;
  /** The next recall of the process's delegation `owner`; null when none is asked within `waitMs` (ask again), or once it has ended. */
  awaitRecall(owner: string, waitMs?: number): Awaitable<RecallKind | null>;
  /** The process has sent what it decided under `owner`, and done what recall `kind` asked. */
  recalled(owner: string, kind: RecallKind): Awaitable<void>;
}

/** What a lease is asked for (RuntimeFsBridge.acquireExclusiveMutation). */
export interface ExclusiveMutationRequest {
  readonly includeMissingAncestors?: boolean;
  /**
   * Delegate the subtree to the process. `reads`: another caller's reads
   * recall it too, not only its writes. `inos`: inode numbers to reserve for
   * what it makes (it numbers them itself); `bytes`: storage to reserve for
   * what it writes.
   */
  readonly delegate?: { readonly reads: boolean; readonly inos?: number; readonly bytes?: number };
}

/**
 * A lease granted: its root and owner, and for a delegation, how long a
 * recall waits for the holder, the inode numbers reserved for it [first,
 * end), and the storage bytes reserved for it.
 */
export interface ExclusiveMutationGrant {
  readonly root: string;
  readonly owner: string;
  readonly recallTimeoutMs?: number;
  readonly inos?: { readonly first: number; readonly end: number };
  readonly bytes?: number;
  /** The umask the session applies to what the holder creates (its process's): the holder decides creates with it. */
  readonly umask?: number;
}

/** What a recall asks of a delegation's holder: keep sending each operation ('share'), or give the subtree up ('revoke'). */
export type RecallKind = 'share' | 'revoke';

/**
 * One path in an {@link RuntimeFsBridge.acquire} delta, with the revision it
 * was last mutated at. The revision is what makes the delta usable by the
 * process that caused it: a caller holding the revision its own write
 * produced keeps that cell, while a peer's later write to the same path
 * reports a higher revision and still invalidates.
 *
 * Without either flag an entry covers `path` alone. With one, it covers
 * `path` and everything under it, and a reader applies the same rule to
 * every cell there: a cell stamped at or above `rev`, or holding the
 * reader's own unacknowledged bytes, stays, and every other one goes.
 */
export interface VfsInvalidatedPath {
  path: string;
  rev: number;
  /**
   * Something under `path` that the caller may not see changed. `path` is
   * the nearest directory above it that the caller may see, reported in its
   * place so that no name reaches a caller that could not list it.
   */
  subtree?: true;
  /**
   * `path` is a directory that was removed, renamed away, or given another
   * mode, owner or group, so what is held under it may be stale, or no
   * longer the caller's to read.
   */
  structural?: true;
  /**
   * With {@link VfsAcquireOptions.namespace}: the path's stat (lstat, not
   * following a final symlink) at the answer's `rev`, or null when the
   * caller's credential sees nothing there. Absent otherwise.
   */
  stat?: RuntimeVfsStat | null;
  linkTarget?: string;
  /** With a stat, for a file: its content identity, as {@link VfsListEntry.contentKey}. */
  contentKey?: string;
  /**
   * With {@link VfsAcquireOptions.push}: the file's bytes at the answer's
   * `rev`, for a regular file under one of the push roots. `bytesOmitted`
   * marks one that qualified but did not fit the answer; it is never
   * truncated.
   */
  bytes?: Uint8Array;
  bytesOmitted?: true;
}

/**
 * What a caller holding a namespace wants from {@link RuntimeFsBridge.acquire}
 * beyond names: each entry's stat at the answer's revision, in the caller's
 * own path space, so a synchronous view of what EXISTS can move forward with
 * the cursor instead of being re-listed.
 */
export interface VfsAcquireOptions {
  namespace?: boolean;
  /**
   * Carry the content of changed regular files under `roots` (caller path
   * space), skipping any path with a segment named in `exclude`. What a
   * process wrote after another launched is then readable synchronously by
   * it at its next resumption, without a round trip per file.
   */
  push?: { roots: string[]; exclude?: string[] };
}

/** Result of a {@link RuntimeFsBridge.acquire} barrier. */
export interface VfsAcquireResult {
  epoch: string;
  rev: number;
  paths: VfsInvalidatedPath[];
  poison: boolean;
  /** True when every entry carries `stat` ({@link VfsAcquireOptions.namespace}). */
  namespace?: boolean;
}

/**
 * One path in a {@link RuntimeFsBridge.list} page.
 *
 * `size` is here because the only consumer of an enumeration is a filler that
 * must then FETCH the bytes, and every batch read is bounded by a byte total
 * the caller has to compute before it asks. A list without sizes forces a stat
 * per path just to pack a request — the round trip the enumeration exists to
 * remove.
 *
 * `rev` is the path's own last-mutation revision for a file and a subtree
 * watermark for a directory ({@link RuntimeFsBridge.revision} semantics
 * unchanged). It is what lets a cached row be DATED, and an undated row is
 * exactly the row that can never be invalidated.
 */
export interface VfsListEntry {
  path: string;
  kind: RuntimeFileType;
  size: number;
  rev: number;
  stat: RuntimeVfsStat;
  linkTarget?: string;
  /** Files only: equal keys mean equal bytes (SqliteVFS.contentKey). */
  contentKey?: string;
  /**
   * A directory on a mount whose entries this listing does not name (the
   * launch did not name it, or it was past MOUNT_LIST_NAME_LIMIT): the mount
   * point it is on. A name under it is not absent, only not listed.
   */
  unlisted?: string;
}

/**
 * One page of {@link RuntimeFsBridge.list}.
 *
 * `next` is the resume key, and `null` means the listing is COMPLETE. That
 * distinction is the contract: a caller that cannot tell a truncated page from
 * a finished one treats a partial filesystem as the whole one — the same class
 * of defect as reading a truncated file as a complete one, which is why
 * `_rpcFsReadBatch` rejects rather than truncates.
 *
 * `epoch`/`rev` are read BEFORE the page is walked, for the same reason
 * `buildPrefetchBundle` reads its cursor before its walk: a mutation landing
 * during enumeration must be reported by the next ACQUIRE, never silently
 * missed. Dating rows at a cursor OLDER than their bytes costs a refetch;
 * dating them newer would serve a stale byte.
 */
export interface VfsListPage {
  epoch: string;
  rev: number;
  entries: VfsListEntry[];
  next: string | null;
}

export interface RuntimeProcessBridge {
  spawn(command: string, args: string[], options?: {
    cwd?: string;
    env?: Record<string, string>;
    tty?: RuntimeTtyOptions;
  }): Promise<{ pid: number }>;
  writeStdin(pid: number, bytes: string | Uint8Array): Promise<void>;
  endStdin(pid: number): Promise<void>;
  kill(pid: number, signal?: string): Promise<void>;
  wait(pid: number, timeoutMs?: number): Promise<{ exitCode: number | null }>;
}

export interface RuntimeTtyOptions {
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  stderrIsTTY?: boolean;
  columns?: number;
  rows?: number;
  raw?: boolean;
}

/**
 * Where a registered port's traffic goes: one process, reached by HTTP.
 *
 * Ordinary HTTP may cross Workers RPC as Request/Response values. A WebSocket
 * upgrade may not: its 101 Response owns a live socket, and RPC's
 * Request/Response transport reconstructs the value rather than handing over
 * the socket. So a target that can serve an upgrade exposes a separate
 * fetch-semantic entrypoint, and every hop of an upgrade stays on the HTTP
 * service-binding path. A target that omits it serves HTTP only.
 *
 * Lives here rather than beside the registry because both ends need it and
 * neither owns it: the port registry stores these, and the process fabric
 * hands one back for every resident process it starts. Defining it in either
 * would make the other import a peer's internals to name its own contract.
 */
export interface RouteableFacetTarget {
  handleHttpRequest(request: Request): Promise<Response>;
  handleWebSocketRequest?(request: Request): Promise<Response>;
}

export interface RuntimePortBridge {
  register(port: number, processId: number, handler: (request: Request) => Promise<Response>): Promise<void>;
  unregister(port: number, processId?: number): Promise<void>;
  list(): Promise<Array<{ port: number; processId: number; registeredAt: number }>>;
}

export const NIMBUS_OS_NAME = 'nimbus';
export const NIMBUS_ABI_TARGET = 'wasm32-wasi-nimbus';
export const NIMBUS_ABI_ID = NIMBUS_ABI_TARGET;

/** Canonical Pyodide package artifact ABI label. The single source of
 *  truth for the label — runtime manifests, the pip planner, and
 *  diagnostics all consume this constant. */
export const PYODIDE_PACKAGE_ABI = 'pyodide-emscripten-2025_0-wasm32';

/** Canonical artifact class for native platform binaries Nimbus cannot
 *  execute (Linux/Windows/macOS executables, .node bindings, native
 *  wheels/gems). */
export const NATIVE_UNSUPPORTED_ABI = 'native-unsupported';

/** File extensions of native binaries no Workers isolate can load. */
export const NATIVE_BIN_EXTENSIONS: readonly string[] = ['.exe', '.node'];

/** True when `path` (a bin target or file path, query/fragment allowed) is a native binary. */
export function isNativeBinPath(path: string, extensions: readonly string[] = NATIVE_BIN_EXTENSIONS): boolean {
  const clean = String(path || '').split(/[?#]/)[0];
  const name = clean.slice(clean.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 && extensions.includes(name.slice(dot).toLowerCase());
}

export type RuntimePackageAbi =
  | 'javascript'
  | typeof NIMBUS_ABI_TARGET
  | typeof PYODIDE_PACKAGE_ABI
  | 'py3-none-any'
  | 'python-source-pure'
  | 'pyodide'
  | 'ruby-wasm'
  | typeof NATIVE_UNSUPPORTED_ABI;

export const NIMBUS_RUNTIME_ABIS: Readonly<Record<string, RuntimePackageAbi>> = Object.freeze({
  bash: NIMBUS_ABI_TARGET,
  clang: NIMBUS_ABI_TARGET,
  python: 'pyodide',
  // The wasm32-wasi interpreter. It does have compiled packages — numpy, and
  // markupsafe's speedups — but they are linked into a prebuilt interpreter
  // variant rather than loaded at run time, so no wheel carrying a native
  // extension can be installed. See packages/worker/wasm/python/EXTENSIONS.md.
  cpython: NATIVE_UNSUPPORTED_ABI,
  ruby: 'ruby-wasm',
  node: 'javascript',
  bun: 'javascript',
});

/**
 * The runner key a bash manifest entrypoint names. Its number is the contract
 * between the bash preamble and the wasm build in `packages/worker/wasm/bash`:
 * the `nimbus_proc` imports, required guest exports and Asyncify allowlist.
 * A rebuild changing them takes the next number and a new catalog version, because the
 * catalog is shared by every deployment reading it and a workspace binds only
 * the build its preamble was written against.
 */
export const BASH_RUNNER = 'bash-runner@3';

/** Name-to-name package rewrite at the resolver/installer boundary. */
export interface PackageSwapEntry {
  /** Original package name the user (or a transitive dep) asked for. */
  from: string;
  /** Package name we install instead. */
  to: string;
  /**
   * The first version of `from` the swap stands in for; unset means every
   * version. Earlier versions install as published (rollup before 4 is plain
   * JavaScript, and @rollup/wasm-node publishes only 4.x): a lockfile pin is
   * swapped only at or above it, and a range only when the target publishes
   * a version it admits.
   */
  since?: string;
  /** One-line reason shown to the user. */
  reason: string;
  /**
   * 'drop-in' = `require(from)` and `require(to)` work identically — same
   *             export shape.
   * 'shim'    = (reserved) we write package.json `dependencies` so consumer
   *             imports `from`, gets `to`.
   * 'manual'  = (reserved) consumer code change required. Demoted to
   *             rejects because listing it here would silently break
   *             user code.
   */
  compat: 'drop-in' | 'shim' | 'manual';
}

/**
 * Staged-artifact entry: a package whose only published runnable form is
 * platform-native (so it would otherwise hit the native-artifact reject), but
 * for which Nimbus ships a prebuilt JS/WASM build in the static-assets layer.
 * At resolve time the package's native shards (optionalDependencies) and
 * platform allowlists are dropped. Two kinds, by what the native part is:
 *
 *   bin     — a native launcher. Its `bin` is rewritten to a Nimbus shim that
 *             runs the staged bundle (opencode).
 *   binding — a native N-API addon the package's own JavaScript `require`s.
 *             The package installs as published minus its shards; the node
 *             runtime answers the binding's `require` with the staged wasm
 *             build, for `version` exactly (rolldown).
 */
export type PackageStagedArtifactEntry = PackageStagedBinEntry | PackageStagedBindingEntry;

export interface PackageStagedBinEntry {
  kind: 'bin';
  /** Package name the user installs (e.g. `opencode-ai`). */
  from: string;
  /** Bin name the staged artifact provides (e.g. `opencode`). */
  bin: string;
  /** Stable artifact id the node runtime resolves to a staged asset path. */
  artifact: string;
  /** One-line reason shown to the user. */
  reason: string;
}

export interface PackageStagedBindingEntry {
  kind: 'binding';
  /** Package name the user installs (e.g. `rolldown`). */
  from: string;
  /** Stable artifact id the node runtime resolves to a staged asset path. */
  artifact: string;
  /** The one upstream version the staged binding is built from. */
  version: string;
  /** One-line reason shown to the user. */
  reason: string;
}

/** Deny-list entry with a helpful, always-actionable message. */
export interface PackageRejectEntry {
  from: string;
  reason: string;
  /** Optional swap-target suggestion shown inline. */
  suggest?: string;
  /**
   * 'fail' = hard-fail at any depth.
   * 'warn' = top-level hard-fails; transitive logs `[skip]` and drops the
   *          package from the resolved tree (matches genuinely-optional
   *          natives like fsevents).
   */
  transitive: 'fail' | 'warn';
}

/**
 * The one typed package-ABI policy. Defined once in supervisor code
 * (`facets/wasm-swap-registry.ts: PACKAGE_ABI_POLICY`) and serialized
 * verbatim into resolver/loader facet preambles — generated dynamic
 * Workers cannot import supervisor modules, so the policy travels as
 * JSON plus serialized policy functions. The preamble parity unit test
 * (`tests/unit/package-abi-policy.mjs`) extracts the injected policy and
 * asserts equality with this object so the two can never drift.
 */
export interface PackageAbiPolicy {
  /** Public compiled-artifact target string (`wasm32-wasi-nimbus`). */
  abiTarget: typeof NIMBUS_ABI_TARGET;
  /** Artifact classes Nimbus can install and execute. */
  acceptedArtifactClasses: readonly RuntimePackageAbi[];
  /** Artifact class assigned to rejected native platform artifacts. */
  nativeArtifactClass: typeof NATIVE_UNSUPPORTED_ABI;
  /** Drop-in name rewrites (native package → published WASM build). */
  swaps: readonly PackageSwapEntry[];
  /** Native-only packages Nimbus ships a prebuilt JS/WASM artifact for. */
  stagedArtifacts: readonly PackageStagedArtifactEntry[];
  /** Known-native deny list with per-entry transitive policy. */
  rejects: readonly PackageRejectEntry[];
  /** Build-only packages skipped at transitive depth. */
  skipPackages: readonly string[];
  /** Build-only package name prefixes skipped at transitive depth. */
  skipPrefixes: readonly string[];
  /** Packages exempted from skipPackages when a framework needs them. */
  frameworkRequiredPackages: readonly string[];
  /** Known native-shard name globs, matched as `prefix-…`. */
  nativeShardPrefixes: readonly string[];
  /** Exact names exempted from nativeShardPrefixes (pure WASM builds). */
  nativeShardExemptions: readonly string[];
  /** bin-target file extensions that mark a native executable. */
  nativeBinExtensions: readonly string[];
}

export type RuntimeAbiCapability =
  | 'wasi.snapshot-preview1'
  | 'wasi.unstable-import-alias'
  | 'vfs.snapshot-diff'
  | 'stdio'
  | 'argv'
  | 'env'
  | 'clock'
  | 'random'
  | 'path'
  | 'symlink'
  | 'hardlink'
  | 'poll'
  | 'outbound-tcp-devtcp'
  | 'wasi.threads';

export interface RuntimeAbiDescriptor {
  os: typeof NIMBUS_OS_NAME;
  target: typeof NIMBUS_ABI_TARGET;
  id: typeof NIMBUS_ABI_ID;
  env: Readonly<Record<string, string>>;
  capabilities: readonly RuntimeAbiCapability[];
}

export const WASM32_WASI_NIMBUS_ABI: RuntimeAbiDescriptor = {
  os: NIMBUS_OS_NAME,
  target: NIMBUS_ABI_TARGET,
  id: NIMBUS_ABI_ID,
  env: Object.freeze({
    NIMBUS_OS: NIMBUS_OS_NAME,
    NIMBUS_ABI: NIMBUS_ABI_ID,
    NIMBUS_ABI_TARGET,
  }),
  capabilities: Object.freeze([
    'wasi.snapshot-preview1',
    'wasi.unstable-import-alias',
    'vfs.snapshot-diff',
    'stdio',
    'argv',
    'env',
    'clock',
    'random',
    'path',
    'symlink',
    'hardlink',
    'poll',
    'outbound-tcp-devtcp',
    // Cooperative, correct, and not parallel — see runtime/wasi-threads.ts.
    'wasi.threads',
  ]),
};

export interface RuntimeCommandProvider {
  runtimeName: string;
  version: string;
  abi: RuntimePackageAbi;
  commands: string[];
  packageManagers?: string[];
  libraries?: string[];
}

export type RuntimeDiagnosticEvent =
  | { type: 'fs-cache'; hit: boolean; path: string; bytes?: number; revision?: number }
  | { type: 'fs-flush'; path?: string; bytes: number; durationMs: number }
  | { type: 'fs-invalidation'; path: string; revision: number; lagMs?: number }
  | { type: 'unsupported-abi'; packageName?: string; abi: string; message: string };
