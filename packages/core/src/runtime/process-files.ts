/**
 * ProcessFiles: what binds the session's namespace to its processes.
 *
 * The namespace is a CompositeVFS rooted at the session's SQLite
 * filesystem, with `/proc` (ProcVFS) and `/dev` (DevVFS) mounted, and
 * whatever an embedder mounts. ProcessFiles owns the per-process state on
 * top of it: a descriptor scope per pid, retirement (`releaseProcess` →
 * ESTALE for later binds), append-writer capabilities, host leases, and the
 * mount listing df/mount/`/proc/mounts` read. Each bound bridge routes a
 * path the composite resolves to a mount other than `/` through the
 * composite, and everything on SQLite through the engine, which keeps its
 * receipts, leases and descriptors.
 *
 * It implements the process-binding contract (NimbusFilesystemAuthority),
 * which every consumer (supervisor RPC, facets, runners) already speaks.
 */

import { isPendingChunkError, listPageBudget } from '../vfs/sqlite-vfs.js';
import type { SqliteVFS, VfsExportChunk, VfsExportPage, WriteBatchStreamResult } from '../vfs/sqlite-vfs.js';
import { Hydrator, type HydratorOptions } from './hydration.js';
import type { VfsEvent } from '../vfs/events.js';
import type { BatchWritePayload } from '@nimbus-sh/platform/w7-frame.js';
import { CompositeVFS, isAsyncMountRefusal, normalizePath, runtimeStatOf, type MountWalk } from '../vfs/composite.js';
import { FS_LIST_PAGE_LIMIT, MOUNT_LIST_NAME_LIMIT } from '../constants.js';
import { DevVFS } from '../vfs/dev-vfs.js';
import { ProcVFS, standardProc } from '../vfs/proc-vfs.js';
import { sqliteFiles } from '../vfs/sqlite-files.js';
import { isVfsError, syscallError, toVfsError, VfsError } from '../vfs/vfs-error.js';
import { normalizeVfsPath } from '../vfs/path.js';
import { readDeclaredSource, readRangeOrWhole, readText } from '../vfs/vfs.js';
import type { VFS, VfsDirent, VfsRemoval, VfsRemovalFailure, VfsStat } from '../vfs/vfs.js';
import { formatProcMounts } from '../shell/mount-commands.js';
import {
  CRED_KERNEL,
  requireVfsCred,
  type NimbusFilesystemAuthority,
  type NimbusFilesystemBinding,
  type NimbusHostFilesystemLease,
  type NimbusMountEntry,
  type RuntimeFileHandle,
  type RuntimeFsBridge,
  type RuntimeFsPath,
  type RuntimeOpenFlags,
  type RuntimeReadOptions,
  type RuntimeSynchronousFs,
  type RuntimeVfsDirEntry,
  type RuntimeVfsStat,
  type VfsAcquireOptions,
  type VfsAcquireResult,
  type VfsCred,
  type VfsInvalidatedPath,
  type VfsListEntry,
  type VfsListPage,
  type VfsMutationReceipt,
} from './os-contracts.js';
import {
  createSqliteDescriptorScope,
  fsError,
  modeAllows,
  SqliteRuntimeFsBridge,
  type SqliteDescriptorScope,
  walkBeneath,
} from './sqlite-runtime-fs-bridge.js';

function immutableCredential(cred: Readonly<VfsCred>): VfsCred {
  const checked = requireVfsCred(cred, 'filesystem binding');
  return Object.freeze({ uid: checked.uid, gid: checked.gid, groups: Object.freeze([...checked.groups]), umask: checked.umask });
}

/**
 * Abort a stream commit when ANY of the given signals fires. AbortSignal.any
 * is not in every runtime this code ships to, so the combination is a small
 * linked controller instead.
 */
function linkedSignal(signals: readonly (AbortSignal | undefined)[]): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const listeners: Array<() => void> = [];
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) { controller.abort(signal.reason); break; }
    const onAbort = (): void => controller.abort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    listeners.push(() => signal.removeEventListener('abort', onAbort));
  }
  return { signal: controller.signal, dispose: () => { for (const remove of listeners) remove(); } };
}

/**
 * A process's bridge with three checks at the door: abort first (the caller
 * revoked), then a closed scope (EBADF, the POSIX answer for an operation on
 * a released descriptor table), then the append-process identity (a bound
 * process may only speak for its own pid).
 */
class GuardedProcessBridge implements RuntimeFsBridge {
  constructor(
    private readonly target: SqliteRuntimeFsBridge,
    private readonly scope: SqliteDescriptorScope,
    private readonly signal: AbortSignal | undefined,
    private readonly pid: number | undefined,
    /** N17: the lazy-import hydration job, when there is one. */
    private readonly hydrator: Hydrator | null,
  ) {}

  gateLaunch(named: readonly string[]): Promise<void> {
    return this.hydrator === null ? Promise.resolve() : this.hydrator.gate([...named]);
  }

  /** A read that met pending bytes moves them to the front of hydration, and still fails (EIO). */
  private reading<T>(read: () => T): T {
    try {
      return read();
    } catch (error) {
      if (this.hydrator !== null && isPendingChunkError(error)) {
        // Failed for good: say so, with the cause. Otherwise it goes first.
        const failure = this.hydrator.failureOf(error.path);
        if (failure !== null) throw failure;
        this.hydrator.missed(error.path);
      }
      throw error;
    }
  }

  get synchronous(): RuntimeSynchronousFs { return this; }

  private guard(): void {
    this.signal?.throwIfAborted();
    if (this.scope.closed) throw Object.assign(new Error('EBADF: filesystem scope closed'), { code: 'EBADF' });
  }

  private ownPid(pid: number): void {
    if (this.pid === undefined || pid !== this.pid) {
      throw Object.assign(new Error('EPERM: append process identity mismatch'), { code: 'EPERM' });
    }
  }

  stat(path: RuntimeFsPath, options?: { followSymlinks?: boolean }): RuntimeVfsStat | null { this.guard(); return this.target.stat(path, options); }
  readFile(path: RuntimeFsPath, options?: { followSymlinks?: boolean }): Uint8Array | null { this.guard(); return this.reading(() => this.target.readFile(path, options)); }
  writeFile(path: RuntimeFsPath, bytes: string | Uint8Array, options?: { createParents?: boolean; expectedRevision?: number }): number {
    this.guard(); return this.target.writeFile(path, bytes, options);
  }
  readRange(path: RuntimeFsPath, offset: number, length: number, options?: RuntimeReadOptions): Uint8Array | null {
    this.guard(); return this.reading(() => this.target.readRange(path, offset, length, options));
  }
  writeRange(path: RuntimeFsPath, offset: number, bytes: Uint8Array, options?: { createParents?: boolean; expectedRevision?: number }): VfsMutationReceipt {
    this.guard(); return this.target.writeRange(path, offset, bytes, options);
  }
  writeFileFrom(path: RuntimeFsPath, size: number, source: AsyncIterable<Uint8Array>): Promise<number> {
    this.guard();
    // A released process stops writing at the next piece, as a stream it
    // wrote would stop committing.
    const guard = () => this.guard();
    return this.target.writeFileFrom(path, size, (async function* () {
      for await (const piece of source) {
        guard();
        yield piece;
      }
      // Released after its last piece, before the file is published.
      guard();
    })());
  }
  truncate(path: RuntimeFsPath, size: number, options?: { followSymlinks?: boolean }): VfsMutationReceipt { this.guard(); return this.target.truncate(path, size, options); }
  utimes(path: RuntimeFsPath, atimeMs: number | null | undefined, mtimeMs: number | null | undefined, options?: { followSymlinks?: boolean }): VfsMutationReceipt {
    this.guard(); return this.target.utimes(path, atimeMs, mtimeMs, options);
  }
  chmod(path: RuntimeFsPath, mode: number): VfsMutationReceipt { this.guard(); return this.target.chmod(path, mode); }
  access(path: RuntimeFsPath, mode: number): void { this.guard(); return this.target.access(path, mode); }
  chown(path: RuntimeFsPath, uid: number, gid: number, options?: { followSymlinks?: boolean }): VfsMutationReceipt {
    this.guard(); return this.target.chown(path, uid, gid, options);
  }
  open(path: RuntimeFsPath, flags: RuntimeOpenFlags): RuntimeFileHandle { this.guard(); return this.target.open(path, flags); }
  read(handleId: number, offset: number | null, length: number): Uint8Array { this.guard(); return this.reading(() => this.target.read(handleId, offset, length)); }
  write(handleId: number, offset: number | null, bytes: Uint8Array): number { this.guard(); return this.target.write(handleId, offset, bytes); }
  close(handleId: number): void { return this.target.close(handleId); }
  readdir(path: RuntimeFsPath, options?: { followSymlinks?: boolean }): RuntimeVfsDirEntry[] { this.guard(); return this.target.readdir(path, options); }
  mkdir(path: RuntimeFsPath, options?: { recursive?: boolean; mode?: number }): void { this.guard(); return this.target.mkdir(path, options); }
  unlink(path: RuntimeFsPath): void { this.guard(); return this.target.unlink(path); }
  rmdir(path: RuntimeFsPath): void { this.guard(); return this.target.rmdir(path); }
  rename(from: RuntimeFsPath, to: RuntimeFsPath): void { this.guard(); return this.target.rename(from, to); }
  readlink(path: RuntimeFsPath): string | null { this.guard(); return this.target.readlink(path); }
  symlink(target: string, path: RuntimeFsPath): void { this.guard(); return this.target.symlink(target, path); }
  fsync(handleId?: number): void { this.guard(); return this.target.fsync(handleId); }
  revision(path?: RuntimeFsPath): number { this.guard(); return this.target.revision(path); }
  acquire(epoch: string | null, cursor: number, options?: VfsAcquireOptions): VfsAcquireResult { this.guard(); return this.target.acquire(epoch, cursor, options); }
  list(after?: string | null, limit?: number): VfsListPage { this.guard(); return this.target.list(after, limit); }
  subscribe(path: string, listener: (event: VfsEvent) => void): () => void {
    this.guard();
    const unsubscribe = this.target.subscribe(path, listener);
    const dispose = (): void => { unsubscribe(); this.scope.subscriptions.delete(dispose); };
    this.scope.subscriptions.add(dispose);
    return dispose;
  }
  realpath(path: RuntimeFsPath): string { this.guard(); return this.target.realpath(path); }
  remove(path: RuntimeFsPath, options?: { recursive?: boolean; force?: boolean }): void { this.guard(); return this.target.remove(path, options); }
  copyFile(from: RuntimeFsPath, to: RuntimeFsPath): void { this.guard(); return this.target.copyFile(from, to); }
  copyTree(from: RuntimeFsPath, to: RuntimeFsPath, options?: { preserve?: boolean }): number | Promise<number> {
    this.guard(); return this.target.copyTree(from, to, options);
  }
  fstat(handleId: number): RuntimeVfsStat { this.guard(); return this.target.fstat(handleId); }
  descriptorPath(handleId: number): string { this.guard(); return this.target.descriptorPath(handleId); }
  dup(handleId: number): RuntimeFileHandle { this.guard(); return this.target.dup(handleId); }
  seek(handleId: number, offset: number, whence: 'set' | 'current' | 'end'): number { this.guard(); return this.target.seek(handleId, offset, whence); }
  setStatus(handleId: number, status: { append?: boolean }): void { this.guard(); return this.target.setStatus(handleId, status); }
  readdirHandle(handleId: number): RuntimeVfsDirEntry[] { this.guard(); return this.target.readdirHandle(handleId); }
  ftruncate(handleId: number, size: number): void { this.guard(); return this.target.ftruncate(handleId, size); }
  fchmod(handleId: number, mode: number): void { this.guard(); return this.target.fchmod(handleId, mode); }
  fchown(handleId: number, uid: number, gid: number): void { this.guard(); return this.target.fchown(handleId, uid, gid); }
  futimes(handleId: number, atimeMs: number, mtimeMs: number): void { this.guard(); return this.target.futimes(handleId, atimeMs, mtimeMs); }
  appendOnce(path: RuntimeFsPath, pid: number, writerId: string, moduleId: string, operationId: number, digest: string, bytes: Uint8Array): number {
    this.guard(); this.ownPid(pid);
    return this.target.appendOnce(path, pid, writerId, moduleId, operationId, digest, bytes);
  }
  acknowledgeAppend(pid: number, writerId: string, moduleId: string, operationId: number): void {
    this.guard(); this.ownPid(pid);
    return this.target.acknowledgeAppend(pid, writerId, moduleId, operationId);
  }
  writeBatch(payload: BatchWritePayload): { inodes: number; chunks: number } { this.guard(); return this.target.writeBatch(payload); }
  writeStream(
    stream: ReadableStream<Uint8Array>,
    options?: { signal?: AbortSignal; mutationOwner?: string; decodeDrainStartedAt?: number },
  ): Promise<WriteBatchStreamResult> {
    this.guard();
    // Closing the scope cancels the commit, so a released process cannot keep
    // publishing groups into a filesystem it no longer holds descriptors on.
    const linked = linkedSignal([options?.signal, this.signal, this.scope.abort.signal]);
    return this.target.writeStream(stream, { ...options, signal: linked.signal }).finally(linked.dispose);
  }
  acquireExclusiveMutation(path: RuntimeFsPath, options?: { includeMissingAncestors?: boolean }): { root: string; owner: string } {
    this.guard(); return this.target.acquireExclusiveMutation(path, options);
  }
  releaseExclusiveMutation(owner: string): void { this.guard(); return this.target.releaseExclusiveMutation(owner); }
}

/** The session's namespace and the processes bound to it. */
export class ProcessFiles implements NimbusFilesystemAuthority {
  readonly namespace: string;
  /** The mount table: SQLite at `/`, `/proc`, `/dev`, and the embedder's. */
  readonly vfs: CompositeVFS;
  /** `/proc`: the host registers generated files here (`mounts` is ProcessFiles'). */
  readonly proc: ProcVFS;
  private readonly processes = new Map<number, SqliteDescriptorScope>();
  /** Each scope's descriptors on asynchronous mounts: a process's, whichever bridge it binds per call. */
  private readonly awaitedDescriptors = new WeakMap<SqliteDescriptorScope, AwaitedDescriptors>();
  private readonly namespaces = new Map<string, NamespaceFs>();
  private readonly retired = new Set<number>();
  /** Per process: where its listings of the mounts beyond SQLite stand (MountListing). */
  private readonly listings = new Map<number, MountListing>();
  /** Inode numbers for mounted entries whose backend keeps none: stable per path for the session. */
  /** N17: the lazy-import hydration job, when the embedder supplies a fetch. */
  readonly hydrator: Hydrator | null;

  /** Bytes one buffered mount handle holds before EFBIG (VFS-PF-001). */
  private readonly bufferedWriteBytes: number | undefined;

  constructor(readonly engine: SqliteVFS, options: { hydration?: HydratorOptions; bufferedWriteBytes?: number } = {}) {
    this.hydrator = options.hydration === undefined ? null : new Hydrator(engine, options.hydration);
    this.bufferedWriteBytes = options.bufferedWriteBytes;
    this.namespace = engine.namespace;
    this.vfs = new CompositeVFS(sqliteFiles(engine, CRED_KERNEL));
    this.proc = standardProc();
    this.proc.register('mounts', (cred) => formatProcMounts(this.mounts(cred ?? CRED_KERNEL)));
    this.vfs.mount('/proc', this.proc);
    this.vfs.mount('/dev', new DevVFS());
  }

  /**
   * An import page (N16); with `lazy` (N17) the chunks it lacks stay pending
   * and are queued for hydration, in the order the page names them.
   */
  importPage(dst: string, page: VfsExportPage, chunks: Iterable<VfsExportChunk> = [], options: { lazy?: boolean } = {}) {
    if (options.lazy && this.hydrator === null) throw syscallError('EINVAL', 'import', dst, { detail: 'a lazy import needs a hydration fetch (ProcessFiles hydration option)' });
    const result = this.engine.importPage(dst, page, chunks, options);
    if (result.pending.length > 0) {
      this.hydrator!.enqueue(result.pending);
      void this.hydrator!.run();
    }
    return result;
  }

  /**
   * N17: a launch that reads synchronously (WASI) waits for the paths it
   * names (program, argv paths, a cwd inside an import) to be local, at most
   * the hydration deadline; EIO naming the first that is not, after it. A
   * launch naming nothing pending starts at once.
   */
  /** Resolves once `path`'s bytes are hydrated (at once, for a path with none pending). */
  hydrated(path: string): Promise<void> {
    return this.hydrator === null ? Promise.resolve() : this.hydrator.whenLocal(path);
  }

  gateLaunch(named: readonly string[]): Promise<void> {
    return this.hydrator === null ? Promise.resolve() : this.hydrator.gate([...named]);
  }

  /**
   * What a process's launch names — its working directory, program and
   * arguments, the literal paths its code names, the files its module map
   * was read from — which is where its listing (`list`) walks mounts without
   * a change feed (CompositeFeed.walk, MOUNT_LIST_NAME_LIMIT). `names` is
   * asked only when the process's credential sees a mount beyond SQLite and
   * the kernel's, so a launch computes nothing for a namespace that is
   * SQLite alone. Adds to what was named.
   */
  nameLaunch({ pid, cred }: NimbusFilesystemBinding, names: () => Iterable<string>): void {
    if (this.retired.has(pid)) return;
    const view = this.vfs.as(immutableCredential(cred));
    if (!mountsBeyondSqlite(view)) return;
    const { named } = this.createListing(pid);
    for (const name of names()) {
      if (name === '') continue;
      const path = normalizePath(name.startsWith('/') ? name : `/${name}`);
      if (isEmbedderMount(view.mountOf(path))) named.add(path);
    }
  }

  /** Where `pid`'s listings of the mounts beyond SQLite stand (made when `create`), or undefined. */
  private listingOf(pid: number, create: boolean): MountListing | undefined {
    let listing = this.listings.get(pid);
    if (listing === undefined && create && !this.retired.has(pid)) {
      listing = this.createListing(pid);
    }
    return listing;
  }

  private createListing(pid: number): MountListing {
    let listing = this.listings.get(pid);
    if (listing === undefined) {
      listing = { named: new Set<string>(), table: null, held: null };
      this.listings.set(pid, listing);
    }
    return listing;
  }

  bind({ pid, cred, signal }: NimbusFilesystemBinding): RuntimeFsBridge {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('filesystem binding requires a process pid');
    if (this.retired.has(pid)) throw Object.assign(new Error('ESTALE: process released'), { code: 'ESTALE' });
    let scope = this.processes.get(pid);
    if (!scope) { scope = createSqliteDescriptorScope(); this.processes.set(pid, scope); }
    return this.bridgeFor(scope, immutableCredential(cred), signal, pid);
  }

  openHost(cred: Readonly<VfsCred>, options: { signal?: AbortSignal } = {}): NimbusHostFilesystemLease {
    const scope = createSqliteDescriptorScope();
    const fs = this.bridgeFor(scope, immutableCredential(cred), options.signal);
    return { fs, dispose: async () => this.closeScope(scope) };
  }

  /**
   * What a command sees: the namespace as `cred`, through this process's
   * bridge, so every mutation passes the lease check (EBUSY on another
   * owner's lease) and every path is routed as the process's own syscalls are.
   */
  view(binding: NimbusFilesystemBinding): ProcessView {
    return new ProcessView(this.bind(binding));
  }

  /**
   * The namespace as `cred`, synchronously, for host code that reads user
   * paths in one turn (git, the build services, vite's file shim, agent
   * tools). Mounted paths route to their mount (a mount without a
   * synchronous face answers ENOTSUP) and SQLite paths go to the engine,
   * exactly as a process's syscalls do. One per credential for the session.
   */
  namespaceFs(cred: Readonly<VfsCred>): NamespaceFs {
    const identity = immutableCredential(cred);
    const key = `${identity.uid}:${identity.gid}:${identity.groups.join(',')}:${identity.umask}`;
    let fs = this.namespaces.get(key);
    if (!fs) {
      const bridge = this.bridgeFor(createSqliteDescriptorScope(), identity);
      fs = new NamespaceFs(bridge.synchronous!, identity);
      this.namespaces.set(key, fs);
    }
    return fs;
  }

  /** Host work over a credentialed lease released when the work settles. */
  async withHost<T>(cred: Readonly<VfsCred>, use: (fs: RuntimeFsBridge) => Promise<T>): Promise<T> {
    const lease = this.openHost(cred);
    try {
      return await use(lease.fs);
    } finally {
      await lease.dispose();
    }
  }

  async releaseProcess(pid: number): Promise<void> {
    this.retired.add(pid);
    this.listings.delete(pid);
    const scope = this.processes.get(pid);
    if (scope) this.closeScope(scope);
    this.processes.delete(pid);
    this.engine.revokeAppendWriters(pid);
  }

  /**
   * The process died without closing its descriptors: nothing is flushed,
   * and what that loses is reported, the descriptors whose buffered writes
   * are gone. Later use of its descriptors is EBADF, as after a release.
   */
  killProcess(pid: number): { lost: number[] } {
    this.retired.add(pid);
    this.listings.delete(pid);
    const scope = this.processes.get(pid);
    this.processes.delete(pid);
    this.engine.revokeAppendWriters(pid);
    if (!scope || scope.closed) return { lost: [] };
    const lost: number[] = [];
    for (const [id, opened] of scope.handles) {
      if ((opened.node.pendingBytes?.() ?? 0) > 0) lost.push(id);
      // Dropped unflushed; a description another process still holds stays open.
      opened.refs--;
    }
    scope.handles.clear();
    this.awaitedDescriptors.get(scope)?.opened.clear();
    scope.closed = true;
    scope.abort.abort();
    for (const unsubscribe of scope.subscriptions) unsubscribe();
    scope.subscriptions.clear();
    return { lost };
  }

  async activateAppendWriter(pid: number, writerId: string): Promise<void> {
    if (this.retired.has(pid)) throw Object.assign(new Error('ESTALE: process released'), { code: 'ESTALE' });
    this.engine.activateAppendWriter(pid, writerId);
  }
  async revokeAppendWriter(pid: number, writerId: string): Promise<void> { this.engine.revokeAppendWriter(pid, writerId); }
  async revokeAppendWriters(pid: number): Promise<void> { this.engine.revokeAppendWriters(pid); }
  async revokeAppendWritersThrough(maxPid: number): Promise<void> { this.engine.revokeAppendWritersThrough(maxPid); }

  /** The mounts `cred` sees, root first: what df, mount and `/proc/mounts` list. */
  mounts(cred: Readonly<VfsCred>): readonly NimbusMountEntry[] {
    const engine = this.engine;
    return this.vfs.as(immutableCredential(cred)).mounts().map((mount) => {
      if (mount.point === '/') {
        return { mountPoint: '/', source: 'nimbus', type: 'nimbus-sqlite', options: ['rw'], usage: async () => engine.storageUsage() };
      }
      const described = mount.describe();
      return {
        mountPoint: mount.point,
        source: described.source,
        type: described.type,
        options: described.options,
        usage: () => mount.usage(),
      };
    });
  }

  private closeScope(scope: SqliteDescriptorScope): void {
    if (scope.closed) return;
    for (const opened of scope.handles.values()) {
      if (--opened.refs === 0) opened.node.close();
    }
    scope.handles.clear();
    this.awaitedDescriptors.get(scope)?.opened.clear();
    for (const dispose of scope.subscriptions) dispose();
    scope.subscriptions.clear();
    scope.closed = true;
    scope.abort.abort();
  }

  private bridgeFor(scope: SqliteDescriptorScope, cred: VfsCred, signal?: AbortSignal, pid?: number): RuntimeFsBridge {
    const view = this.vfs.as(cred);
    const target = new SqliteRuntimeFsBridge(this.engine.as(cred), this.engine, scope, view, this.bufferedWriteBytes);
    const guarded = new GuardedProcessBridge(target, scope, signal, pid, this.hydrator);
    // Every other method forwards to the guarded bridge.
    let awaited = this.awaitedDescriptors.get(scope);
    if (!awaited) { awaited = { opened: new Map(), next: AWAITED_DESCRIPTOR_BASE }; this.awaitedDescriptors.set(scope, awaited); }
    const listing = pid === undefined ? () => undefined : (create: boolean) => this.listingOf(pid, create);
    return new AwaitingProcessBridge(guarded, view, () => this.engine.revision(), cred, awaited, scope, listing, signal);
  }
}

/**
 * Where a process's listings of the mounts beyond SQLite stand: what they
 * walk, what mount table they began at, and the walk a listing in progress
 * took.
 */
interface MountListing {
  /** What its launch names (ProcessFiles.nameLaunch): where its listing walks. */
  readonly named: Set<string>;
  /**
   * The mount table its last listing from the start began at (FeedPosition's
   * `table`): an acquire across a change of it is a poison, since a mount
   * appearing or going is in no backend's feed.
   */
  table: string | null;
  /** The walk its listing in progress took, which only the page continuing it (`next`) reuses. */
  held: { walk: MountWalk; next: string } | null;
}

/** The kernel's own filesystems: never walked, and never in a process's listing, which is SQLite's and its embedder's. */
const KERNEL_MOUNT_POINTS: Record<string, true> = { '/proc': true, '/dev': true };

/** A mount an embedder made (a Drive, a container, a device). */
function isEmbedderMount(point: string): boolean {
  return point !== '/' && KERNEL_MOUNT_POINTS[point] !== true;
}

/** Whether `path` (absolute) is at or under /proc or /dev. */
function underKernelMount(path: string): boolean {
  const end = path.indexOf('/', 1);
  return KERNEL_MOUNT_POINTS[end === -1 ? path : path.slice(0, end)] === true;
}

/** Whether `view` shows a mount an embedder made: only then is a process's listing more than SQLite's. */
function mountsBeyondSqlite(view: CompositeVFS): boolean {
  return view.mounts().some((mount) => isEmbedderMount(mount.point));
}

/**
 * A process's asynchronous face (ProcessView, supervisor ops, RPC,
 * fs.promises): the guarded bridge, except that a path an asynchronous-only
 * mount refuses to a synchronous caller is answered by awaiting that mount,
 * through the namespace as the process's credential. `synchronous` (node's
 * sync fs, non-JSPI WASI, host reads that cannot wait) stays the guarded
 * bridge, where such a mount's refusal is the answer.
 */
/** Where descriptors on asynchronous mounts are numbered: clear of the scope's own. */
const AWAITED_DESCRIPTOR_BASE = 0x4000_0000;

/** An open file description on an asynchronous mount: what its descriptors (dups included) share. */
interface AwaitedDescription {
  readonly path: string;
  readonly flags: RuntimeFileHandle['flags'];
  position: number;
}

interface AwaitedDescriptors {
  readonly opened: Map<number, AwaitedDescription>;
  next: number;
}

class AwaitingProcessBridge implements RuntimeFsBridge {
  constructor(
    private readonly bridge: GuardedProcessBridge,
    private readonly namespace: CompositeVFS,
    private readonly clock: () => number,
    private readonly cred: VfsCred,
    private readonly descriptors: AwaitedDescriptors,
    private readonly scope: SqliteDescriptorScope,
    /** Where this process's listings of mounts beyond SQLite stand (made when `create`); undefined for a host lease. */
    private readonly listing: (create: boolean) => MountListing | undefined,
    private readonly signal?: AbortSignal,
  ) {}

  get synchronous(): RuntimeSynchronousFs { return this.bridge; }

  gateLaunch(named: readonly string[]): Promise<void> { return this.bridge.gateLaunch(named); }
  revision(path?: RuntimeFsPath): number { return this.bridge.revision(path); }
  subscribe(path: string, listener: (event: VfsEvent) => void): () => void { return this.bridge.subscribe(path, listener); }
  appendOnce(path: RuntimeFsPath, pid: number, writerId: string, moduleId: string, operationId: number, digest: string, bytes: Uint8Array): number {
    return this.bridge.appendOnce(path, pid, writerId, moduleId, operationId, digest, bytes);
  }
  acknowledgeAppend(pid: number, writerId: string, moduleId: string, operationId: number): void {
    return this.bridge.acknowledgeAppend(pid, writerId, moduleId, operationId);
  }
  writeBatch(payload: BatchWritePayload): { inodes: number; chunks: number } { return this.bridge.writeBatch(payload); }
  writeStream(
    stream: ReadableStream<Uint8Array>,
    options?: { signal?: AbortSignal; mutationOwner?: string; decodeDrainStartedAt?: number },
  ): Promise<WriteBatchStreamResult> { return this.bridge.writeStream(stream, options); }
  acquireExclusiveMutation(path: RuntimeFsPath, options?: { includeMissingAncestors?: boolean }): { root: string; owner: string } {
    return this.bridge.acquireExclusiveMutation(path, options);
  }
  releaseExclusiveMutation(owner: string): void { return this.bridge.releaseExclusiveMutation(owner); }

  /** As the guarded bridge's guard: a released or killed process's scope answers EBADF. */
  private live(): void {
    this.signal?.throwIfAborted();
    if (this.scope.closed) throw fsError('EBADF', 'fd', 'filesystem scope closed');
  }

  /**
   * One page of every name the process's view shows, in path order. SQLite
   * alone (no mount an embedder made): SQLite's own page, answered at once.
   * Otherwise the namespace's feed (CompositeFeed.list): SQLite's names less
   * what a mount covers, the directories the namespace makes, and each
   * mount's names where the process's launch named them (CompositeFeed.walk),
   * cut to a page by SQLite's own bound (listPageBudget). The kernel's /proc
   * and /dev are left out, as SQLite's page leaves them out. A mounted entry
   * carries revision 0: a mount never moves the SQLite clock.
   */
  list(after?: string | null, limit?: number): VfsListPage | Promise<VfsListPage> {
    if (!mountsBeyondSqlite(this.namespace)) {
      // A listing of SQLite alone from the start begins at no mount table.
      const listing = after === null || after === undefined ? this.listing(false) : undefined;
      if (listing) listing.table = null;
      return this.bridge.list(after, limit);
    }
    this.live();
    return this.listMounted(after ?? null, Math.min(Math.max(1, Math.trunc(limit ?? FS_LIST_PAGE_LIMIT)), FS_LIST_PAGE_LIMIT));
  }

  private async listMounted(after: string | null, want: number): Promise<VfsListPage> {
    const listing = this.listing(true);
    const feed = this.namespace.feed;
    // A page continuing a listing reuses the walk its earlier pages took; any other walks afresh.
    const held = listing?.held;
    const walk = after !== null && held && held.next === after
      ? held.walk
      : await feed.walk(listing?.named ?? [], MOUNT_LIST_NAME_LIMIT);
    this.live();
    // Read before the page, as SqliteVFS.list reads its cursor (VfsListPage).
    const position = feed.position();
    const root = position.feeds['/'];
    if (after === null && listing) listing.table = position.table;
    const page = feed.list(after === null ? null : `/${after}`, want, walk);
    // SQLite measured its own entries when it listed them; each is measured
    // here under the path the process sees, which only re-encodes that path.
    const fits = listPageBudget(root.epoch, root.cursor);
    const entries: VfsListEntry[] = [];
    let next = page.next === null ? null : page.next.slice(1);
    for (const entry of page.entries) {
      if (underKernelMount(entry.path)) continue;
      const path = entry.path.slice(1);
      if (!fits(entry, path)) { next = entries[entries.length - 1].path; break; }
      entries.push({ ...entry, path });
    }
    if (listing) listing.held = next === null ? null : { walk, next };
    return { epoch: root.epoch, rev: root.cursor, entries, next };
  }

  /**
   * What changed since the process's cursor. SQLite alone: SQLite's own
   * answer. Otherwise the namespace's feed (CompositeFeed.since), which
   * reports only what the namespace routes to SQLite (a write SQLite takes
   * under a mount point is none of the process's), and is a poison when the
   * mount table is not the one the process's last listing began at.
   */
  acquire(epoch: string | null, cursor: number, options?: VfsAcquireOptions): VfsAcquireResult {
    const listing = this.listing(false);
    if (!mountsBeyondSqlite(this.namespace) && (listing?.table ?? null) === null) return this.bridge.acquire(epoch, cursor, options);
    this.live();
    const feed = this.namespace.feed;
    const table = listing?.table ?? feed.position().table;
    // A null epoch (a caller with no cursor) is SQLite's poison, as ever.
    const answer = feed.since({ table, feeds: { '/': { epoch, cursor } } }, options);
    const root = answer.position.feeds['/'];
    const paths: VfsInvalidatedPath[] = [];
    for (const entry of answer.paths) {
      if (underKernelMount(entry.path)) continue;
      paths.push({ ...entry, path: entry.path.slice(1) });
    }
    return {
      epoch: root.epoch, rev: root.cursor, paths, poison: answer.poison,
      ...(options?.namespace === true && !answer.poison ? { namespace: true } : {}),
    };
  }

  /**
   * The guarded bridge's answer, as it gives it (synchronously when it can),
   * or on an asynchronous mount's refusal, `awaited`.
   */
  private either<T>(paths: RuntimeFsPath[], sync: () => T | Promise<T>, awaited: () => Promise<T>): T | Promise<T> {
    // Relative to one of this face's own descriptors: the bridge has never seen it.
    const settled = () => { this.live(); return awaited(); };
    if (paths.some((path) => typeof path !== 'string' && 'directory' in path && this.awaited.has(path.directory))) return settled();
    const refused = (error: unknown) => {
      if (!isAsyncMountRefusal(error)) throw error;
      return settled();
    };
    let answer: T | Promise<T>;
    try {
      answer = sync();
    } catch (error) {
      return refused(error);
    }
    return answer instanceof Promise ? answer.catch(refused) : answer;
  }


  /**
   * `path` as an absolute namespace path; a path beneath a root (a WASI
   * preopen) walked by `walkBeneath`, the synchronous bridge's own walk,
   * its lookups awaited through the namespace.
   */
  private async path(path: RuntimeFsPath, follow = true): Promise<string> {
    if (typeof path === 'string') return path;
    const base = 'root' in path ? '/' + normalizeVfsPath(path.root)
      : this.awaited.get(path.directory)?.path ?? this.bridge.descriptorPath(path.directory);
    if (!path.beneath) {
      if (path.path.startsWith('/')) return path.path;
      if ((await this.namespace.stat(base))?.type !== 'directory') throw fsError('ENOTDIR', 'path', path.path);
      return (base === '/' ? '' : base) + '/' + path.path;
    }
    const root = normalizeVfsPath(base);
    const walk = walkBeneath(root, path, follow, this.cred, (name, to) => this.namespace.resolvedByBackend(name, '/' + root, to));
    for (let step = walk.next(); ; ) {
      if (step.done) {
        if (step.value === null) throw fsError('ELOOP', 'path', path);
        return '/' + step.value;
      }
      const lookup = step.value;
      step = walk.next('readlink' in lookup
        ? this.namespace.linkLeadsTo(lookup.readlink, await this.namespace.readlink(lookup.readlink))
        : await this.namespace.stat(lookup.stat, { follow: false }));
    }
  }


  private receipt(): VfsMutationReceipt {
    const r = this.clock();
    return { before: r, after: r };
  }

  private absent<T>(read: () => Promise<T>): Promise<T | null> {
    return read().catch((error: unknown) => {
      if ((error as { code?: string })?.code === 'ENOENT') return null;
      throw error;
    });
  }

  stat(path: RuntimeFsPath, options?: { followSymlinks?: boolean }) {
    return this.either([path], () => this.bridge.stat(path, options), async () => {
      const follow = options?.followSymlinks !== false;
      let resolved: string;
      try {
        resolved = await this.path(path, follow);
      } catch (error) {
        // As the bridge's stat: a component missing on the way is "not there".
        if ((error as { code?: string })?.code === 'ENOENT') return null;
        throw error;
      }
      const stat = await this.namespace.stat(resolved, { follow });
      return stat === null ? null : runtimeStatOf(stat);
    });
  }
  readFile(path: RuntimeFsPath, options?: { followSymlinks?: boolean }) {
    return this.either([path], () => this.bridge.readFile(path, options), () => this.absent(async () => this.namespace.readFile((await this.path(path, options?.followSymlinks !== false)))));
  }
  readRange(path: RuntimeFsPath, offset: number, length: number, options?: RuntimeReadOptions) {
    return this.either([path], () => this.bridge.readRange(path, offset, length, options), () => this.absent(async () =>
      await readRangeOrWhole(this.namespace, await this.path(path), offset, length)));
  }
  writeFile(path: RuntimeFsPath, bytes: string | Uint8Array, options?: { createParents?: boolean; expectedRevision?: number }) {
    return this.either([path], () => this.bridge.writeFile(path, bytes, options), async () => {
      const p = (await this.path(path));
      if (options?.createParents) await this.namespace.mkdir(p.slice(0, p.lastIndexOf('/')) || '/', { recursive: true });
      await this.namespace.writeFile(p, typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes);
      return this.clock();
    });
  }
  writeRange(path: RuntimeFsPath, offset: number, bytes: Uint8Array, options?: { createParents?: boolean; expectedRevision?: number }) {
    return this.either([path], () => this.bridge.writeRange(path, offset, bytes, options), async () => {
      const p = await this.path(path);
      if (options?.createParents) await this.namespace.mkdir(p.slice(0, p.lastIndexOf('/')) || '/', { recursive: true });
      await this.namespace.writeRange(p, offset, bytes);
      return this.receipt();
    });
  }
  async writeFileFrom(path: RuntimeFsPath, size: number, source: AsyncIterable<Uint8Array>): Promise<number> {
    // The bridge refuses a path on an asynchronous mount before reading the source.
    return this.either([path], () => this.bridge.writeFileFrom(path, size, source), async () => {
      const p = await this.path(path);
      // An asynchronous mount takes the whole file in one write, as a
      // synchronous one does (SqliteRuntimeFsBridge.writeFileFrom), and not
      // for a process released while its source was read.
      const data = await readDeclaredSource(source, size, () => syscallError('EINVAL', 'write', p));
      this.live();
      await this.namespace.writeFile(p, data);
      return this.clock();
    });
  }
  truncate(path: RuntimeFsPath, size: number, options?: { followSymlinks?: boolean }) {
    return this.either([path], () => this.bridge.truncate(path, size, options), async () => {
      await this.namespace.truncate((await this.path(path)), size);
      return this.receipt();
    });
  }
  utimes(path: RuntimeFsPath, atimeMs: number | null | undefined, mtimeMs: number | null | undefined, options?: { followSymlinks?: boolean }) {
    return this.either([path], () => this.bridge.utimes(path, atimeMs, mtimeMs, options), async () => {
      const p = (await this.path(path, options?.followSymlinks !== false));
      const now = Date.now();
      const kept = atimeMs === undefined || mtimeMs === undefined ? await this.namespace.stat(p) : null;
      await this.namespace.utimes(p, atimeMs === undefined ? (kept?.atimeMs ?? now) : (atimeMs ?? now), mtimeMs === undefined ? (kept?.mtimeMs ?? now) : (mtimeMs ?? now));
      return this.receipt();
    });
  }
  chmod(path: RuntimeFsPath, mode: number) {
    return this.either([path], () => this.bridge.chmod(path, mode), async () => {
      await this.namespace.chmod((await this.path(path)), mode);
      return this.receipt();
    });
  }
  chown(path: RuntimeFsPath, uid: number, gid: number, options?: { followSymlinks?: boolean }) {
    return this.either([path], () => this.bridge.chown(path, uid, gid, options), async () => {
      await this.namespace.chown((await this.path(path, options?.followSymlinks !== false)), uid, gid);
      return this.receipt();
    });
  }
  access(path: RuntimeFsPath, mode: number) {
    return this.either([path], () => this.bridge.access(path, mode), async () => {
      const p = await this.path(path);
      const stat = await this.namespace.stat(p);
      if (stat === null) throw syscallError('ENOENT', 'access', p);
      if (!modeAllows(stat, mode, this.cred)) throw syscallError('EACCES', 'access', p);
    });
  }
  readdir(path: RuntimeFsPath, options?: { followSymlinks?: boolean }) {
    return this.either([path], () => this.bridge.readdir(path, options), async () =>
      (await this.namespace.readdir((await this.path(path, options?.followSymlinks !== false)))).map((entry) => ({ name: entry.name, type: entry.type })));
  }
  mkdir(path: RuntimeFsPath, options?: { recursive?: boolean; mode?: number }) {
    return this.either([path], () => this.bridge.mkdir(path, options), async () => this.namespace.mkdir((await this.path(path)), options));
  }
  unlink(path: RuntimeFsPath) {
    return this.either([path], () => this.bridge.unlink(path), async () => this.namespace.unlink((await this.path(path, false))));
  }
  rmdir(path: RuntimeFsPath) {
    return this.either([path], () => this.bridge.rmdir(path), async () => this.namespace.rmdir((await this.path(path, false))));
  }
  rename(from: RuntimeFsPath, to: RuntimeFsPath) {
    return this.either([from, to], () => this.bridge.rename(from, to), async () => this.namespace.rename((await this.path(from, false)), (await this.path(to, false))));
  }
  realpath(path: RuntimeFsPath) {
    return this.either([path], () => this.bridge.realpath(path), async () => this.namespace.realpathAsync(await this.path(path)));
  }
  readlink(path: RuntimeFsPath) {
    return this.either([path], () => this.bridge.readlink(path), () => this.absent(async () => this.namespace.readlink((await this.path(path, false)))));
  }
  symlink(target: string, path: RuntimeFsPath) {
    return this.either([path], () => this.bridge.symlink(target, path), async () => this.namespace.symlink(target, (await this.path(path, false))));
  }
  remove(path: RuntimeFsPath, options?: { recursive?: boolean; force?: boolean }) {
    return this.either([path], () => this.bridge.remove(path, options), async () => {
      const p = (await this.path(path, false));
      const stat = await this.namespace.stat(p, { follow: false });
      if (stat === null) {
        if (options?.force) return;
        throw syscallError('ENOENT', 'rm', p);
      }
      if (stat.type !== 'directory') return this.namespace.unlink(p);
      if (!options?.recursive) throw syscallError('EISDIR', 'rm', p);
      const report: VfsRemoval | undefined = await this.namespace.removeRecursive(p);
      const failed = report?.failures?.[0];
      if (failed) throw syscallError(failed.error.code, 'rm', failed.path);
    });
  }
  copyFile(from: RuntimeFsPath, to: RuntimeFsPath) {
    return this.either<void | number>([from, to], () => this.bridge.copyFile(from, to), async () => this.namespace.copy((await this.path(from)), (await this.path(to)), { recursive: false }));
  }
  copyTree(from: RuntimeFsPath, to: RuntimeFsPath, options?: { preserve?: boolean }) {
    return this.either([from, to], () => this.bridge.copyTree(from, to, options), async () => {
      await this.namespace.copy((await this.path(from)), (await this.path(to)), { recursive: true, preserve: options?.preserve });
      return 0;
    });
  }

  // ── descriptors on an asynchronous mount ─────────────────────────────
  // Held per descriptor scope, in an id range the scope never issues; a dup
  // shares the description (its offset and status flags). A write goes to
  // the mount at once (its writeRange, or the whole file rewritten where it
  // has none); an append lands at the end as it then is.
  private get awaited() { return this.descriptors.opened; }

  private issue(description: AwaitedDescription): RuntimeFileHandle {
    const id = this.descriptors.next++;
    this.awaited.set(id, description);
    return { id, path: description.path, flags: { ...description.flags }, position: description.position, closed: false };
  }

  open(path: RuntimeFsPath, flags: RuntimeOpenFlags) {
    return this.either([path], () => this.bridge.open(path, flags), async () => {
      const p = await this.path(path, flags.followSymlinks !== false);
      const stat = await this.namespace.stat(p, { follow: flags.followSymlinks !== false });
      if (stat !== null && flags.create && flags.exclusive) throw syscallError('EEXIST', 'open', p);
      if (stat === null && !flags.create) throw syscallError('ENOENT', 'open', p);
      if (stat !== null && stat.type === 'directory' && (flags.write || flags.truncate || flags.append)) throw syscallError('EISDIR', 'open', p);
      if (flags.directory && stat !== null && stat.type !== 'directory') throw syscallError('ENOTDIR', 'open', p);
      if (stat === null || flags.truncate) await this.namespace.writeFile(p, new Uint8Array(0), flags.mode === undefined ? undefined : { mode: flags.mode });
      return this.issue({
        path: p,
        flags: {
          read: !!flags.read, write: !!flags.write, append: !!flags.append, create: !!flags.create,
          exclusive: !!flags.exclusive, directory: !!flags.directory, truncate: !!flags.truncate,
          followSymlinks: flags.followSymlinks !== false,
        },
        position: 0,
      });
    });
  }

  private opened(handleId: number): AwaitedDescription {
    const opened = this.awaited.get(handleId);
    if (opened === undefined) throw fsError('EBADF', 'fd', String(handleId));
    return opened;
  }

  /** The bridge's own descriptor, or this one's `awaited` answer. */
  private on<T>(handleId: number, own: () => T, awaited: (description: AwaitedDescription) => Promise<T>): T | Promise<T> {
    const description = this.awaited.get(handleId);
    if (description === undefined) return own();
    this.live();
    return awaited(description);
  }

  read(handleId: number, offset: number | null, length: number) {
    return this.on(handleId, () => this.bridge.read(handleId, offset, length), async (d) => {
      if (!d.flags.read) throw fsError('EBADF', 'read', d.path);
      const start = offset ?? d.position;
      const bytes = await readRangeOrWhole(this.namespace, d.path, start, length);
      if (offset === null) d.position = start + bytes.byteLength;
      return bytes;
    });
  }

  write(handleId: number, offset: number | null, bytes: Uint8Array) {
    return this.on(handleId, () => this.bridge.write(handleId, offset, bytes), async (d) => {
      if (!d.flags.write) throw fsError('EBADF', 'write', d.path);
      const start = d.flags.append ? ((await this.namespace.stat(d.path))?.size ?? 0) : offset ?? d.position;
      this.live();
      try {
        await this.namespace.writeRange(d.path, start, bytes);
      } catch (error) {
        if (!(error instanceof VfsError && error.code === 'ENOTSUP')) throw error;
        const file = await this.namespace.readFile(d.path);
        const next = new Uint8Array(Math.max(file.byteLength, start + bytes.byteLength));
        next.set(file);
        next.set(bytes, start);
        await this.namespace.writeFile(d.path, next);
      }
      if (offset === null || d.flags.append) d.position = start + bytes.byteLength;
      return bytes.byteLength;
    });
  }

  close(handleId: number) {
    if (!this.awaited.delete(handleId)) return this.bridge.close(handleId);
  }

  fsync(handleId?: number) {
    if (handleId === undefined || !this.awaited.has(handleId)) return this.bridge.fsync(handleId);
  }

  fstat(handleId: number) {
    return this.on(handleId, () => this.bridge.fstat(handleId), async (d) => {
      const stat = await this.namespace.stat(d.path);
      if (stat === null) throw syscallError('ENOENT', 'fstat', d.path);
      return runtimeStatOf(stat);
    });
  }

  dup(handleId: number) {
    return this.on(handleId, () => this.bridge.dup(handleId), async (d) => this.issue(d));
  }

  seek(handleId: number, offset: number, whence: 'set' | 'current' | 'end') {
    return this.on(handleId, () => this.bridge.seek(handleId, offset, whence), async (d) => {
      const base = whence === 'set' ? 0 : whence === 'current' ? d.position : ((await this.namespace.stat(d.path))?.size ?? 0);
      if (base + offset < 0) throw syscallError('EINVAL', 'seek', d.path);
      d.position = base + offset;
      return d.position;
    });
  }

  setStatus(handleId: number, status: { append?: boolean }) {
    return this.on(handleId, () => this.bridge.setStatus(handleId, status), async (d) => {
      if (status.append !== undefined) d.flags.append = status.append;
    });
  }

  readdirHandle(handleId: number) {
    return this.on(handleId, () => this.bridge.readdirHandle(handleId), async (d) =>
      (await this.namespace.readdir(d.path)).map((entry) => ({ name: entry.name, type: entry.type })));
  }

  ftruncate(handleId: number, size: number) {
    return this.on(handleId, () => this.bridge.ftruncate(handleId, size), async (d) => {
      if (!d.flags.write) throw fsError('EINVAL', 'ftruncate', d.path);
      await this.namespace.truncate(d.path, size);
    });
  }

  fchmod(handleId: number, mode: number) {
    return this.on(handleId, () => this.bridge.fchmod(handleId, mode), async (d) => { await this.namespace.chmod(d.path, mode); });
  }

  fchown(handleId: number, uid: number, gid: number) {
    return this.on(handleId, () => this.bridge.fchown(handleId, uid, gid), async (d) => { await this.namespace.chown(d.path, uid, gid); });
  }

  futimes(handleId: number, atimeMs: number, mtimeMs: number) {
    return this.on(handleId, () => this.bridge.futimes(handleId, atimeMs, mtimeMs), async (d) => { await this.namespace.utimes(d.path, atimeMs, mtimeMs); });
  }
}

/** A command's view for a process binding, over any binding authority. */
export function bindProcessView(authority: NimbusFilesystemAuthority, binding: NimbusFilesystemBinding): ProcessView {
  return new ProcessView(authority.bind(binding));
}

/** Host-side work through a credentialed view whose lease is released when the work settles. */
export async function withHostView<T>(
  authority: NimbusFilesystemAuthority,
  cred: Readonly<VfsCred>,
  use: (view: ProcessView) => Promise<T>,
): Promise<T> {
  const lease = authority.openHost(cred);
  try {
    return await use(new ProcessView(lease.fs));
  } finally {
    await lease.dispose();
  }
}

/**
 * Where `path` is on `engine`, as `view` sees the namespace: its engine key
 * with every link resolved, or null when it is on a mount. A name not there
 * yet is placed by the nearest directory above it that is, where it would
 * be made. Host tools read and write a user's tree through `view`; they
 * take the engine's bulk paths (batched writes, pre-bundling, the dev
 * servers) only at this key, never at a lexical path a mount may shadow.
 */
export async function engineKey(
  view: Pick<ProcessView, 'realpath' | 'stat'>,
  engine: Pick<SqliteVFS, 'deviceId'>,
  path: string,
): Promise<string | null> {
  let at = '/' + normalizeVfsPath(path);
  let below = '';
  for (;;) {
    let real: string;
    try {
      real = await view.realpath(at);
    } catch (error) {
      if (at === '/' || (!isVfsError(error, 'ENOENT') && !isVfsError(error, 'ENOTDIR'))) throw error;
      const cut = at.lastIndexOf('/');
      below = below === '' ? at.slice(cut + 1) : `${at.slice(cut + 1)}/${below}`;
      at = at.slice(0, cut) || '/';
      continue;
    }
    // No link is left on `real`, so the device holding it holds the names below it too.
    if ((await view.stat(real, { follow: false }))?.dev !== engine.deviceId) return null;
    return normalizeVfsPath(below === '' ? real : `${real}/${below}`);
  }
}

/** POSIX access(2) modes. */
export const F_OK = 0, X_OK = 1, W_OK = 2, R_OK = 4;

/**
 * A process's namespace as a `VFS` over its bound bridge, plus the process
 * syscalls a `VFS` has no word for (access, realpath, append). Absent is
 * null from `stat`; every failure is a `VfsError`.
 */
export class ProcessView implements VFS {
  constructor(
    /** The bridge itself: what a runtime hands a guest as its syscall surface. */
    readonly process: RuntimeFsBridge,
  ) {}

  /** `run`, a bridge failure reported as Node's error for `syscall` on `path` (and `dest`). */
  private call<T>(syscall: string, path: string, run: () => T | Promise<T>, dest?: string): T | Promise<T> {
    try {
      const result = run();
      return result instanceof Promise ? result.catch((error) => { throw toVfsError(error, syscall, path, dest); }) : result;
    } catch (error) {
      throw toVfsError(error, syscall, path, dest);
    }
  }

  async stat(path: string, options?: { follow?: boolean }): Promise<ProcessStat | null> {
    const stat = await this.call(options?.follow === false ? 'lstat' : 'stat', path, () => this.process.stat(path, { followSymlinks: options?.follow !== false }));
    return stat === null ? null : vfsStatOf(stat);
  }
  /** Probes need only the bridge's type, not another converted stat object. */
  private async probe(path: string, follow: boolean): Promise<RuntimeVfsStat | null> {
    try {
      return await this.process.stat(path, { followSymlinks: follow });
    } catch (error) {
      const failure = toVfsError(error, follow ? 'stat' : 'lstat', path);
      if (isVfsError(failure, 'ENOTDIR')) return null;
      throw failure;
    }
  }
  /** Whether anything is at `path` (links followed). */
  async exists(path: string): Promise<boolean> { return (await this.probe(path, true)) !== null; }
  async isFile(path: string): Promise<boolean> { return (await this.probe(path, true))?.type === 'file'; }
  async isDirectory(path: string): Promise<boolean> { return (await this.probe(path, true))?.type === 'directory'; }
  /** Whether `path` itself is a symbolic link. */
  async isSymlink(path: string): Promise<boolean> { return (await this.probe(path, false))?.type === 'symlink'; }
  /** The file's bytes as UTF-8 text. */
  async readFileString(path: string): Promise<string> { return await readText(this, path); }
  async readFile(path: string): Promise<Uint8Array> {
    const bytes = await this.call('open', path, () => this.process.readFile(path));
    if (bytes === null) throw syscallError('ENOENT', 'open', path);
    return bytes;
  }
  /**
   * Text is written as UTF-8, as a process's write(2) of a string would.
   * `mode` applies only if this creates the file, and at creation
   * (open(O_CREAT|O_TRUNC, mode), then the bytes): an existing file keeps its
   * mode, and a new one is never visible at another mode.
   */
  async writeFile(path: string, data: Uint8Array | string, options?: { mode?: number }): Promise<void> {
    if (options?.mode === undefined) {
      await this.call('open', path, () => this.process.writeFile(path, data));
      return;
    }
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    await this.call('open', path, async () => {
      const handle = await this.process.open(path, { write: true, create: true, truncate: true, mode: options.mode });
      try {
        let offset = 0;
        while (offset < bytes.length) {
          const written = await this.process.write(handle.id, offset, bytes.subarray(offset));
          if (written <= 0) throw syscallError('EIO', 'write', path, { detail: 'short write' });
          offset += written;
        }
      } finally {
        await this.process.close(handle.id);
      }
    });
  }
  async readdir(path: string): Promise<VfsDirent[]> {
    const entries = await this.call('scandir', path, () => this.process.readdir(path));
    return entries.map((entry) => ({ name: entry.name, type: entry.type }));
  }
  async mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void> {
    await this.call('mkdir', path, () => this.process.mkdir(path, options));
  }
  async unlink(path: string): Promise<void> { await this.call('unlink', path, () => this.process.unlink(path)); }
  async rmdir(path: string): Promise<void> { await this.call('rmdir', path, () => this.process.rmdir(path)); }
  async rename(from: string, to: string): Promise<void> { await this.call('rename', from, () => this.process.rename(from, to), to); }
  async readRange(path: string, offset: number, length: number): Promise<Uint8Array> {
    const bytes = await this.call('open', path, () => this.process.readRange(path, offset, length));
    if (bytes === null) throw syscallError('ENOENT', 'open', path);
    return bytes;
  }
  /** A ranged read that neither consults nor fills the session's content cache. */
  async readRangeUncached(path: string, offset: number, length: number): Promise<Uint8Array> {
    const bytes = await this.call('open', path, () => this.process.readRange(path, offset, length, { cached: false }));
    if (bytes === null) throw syscallError('ENOENT', 'open', path);
    return bytes;
  }
  async writeRange(path: string, offset: number, bytes: Uint8Array): Promise<void> {
    await this.call('open', path, () => this.process.writeRange(path, offset, bytes));
  }
  /** writeFile of `size` bytes that arrive over time, published whole once they have (RuntimeFsBridge.writeFileFrom). */
  async writeFileFrom(path: string, size: number, source: AsyncIterable<Uint8Array>): Promise<void> {
    await this.call('open', path, () => this.process.writeFileFrom(path, size, source));
  }
  async truncate(path: string, size: number): Promise<void> { await this.call('open', path, () => this.process.truncate(path, size)); }
  /**
   * rm -r: what went, by the roots removed, what is still there, and why.
   * The engine removes a tree in one step or refuses it whole, so its report
   * is the operand or the refusal.
   */
  async removeRecursive(path: string): Promise<VfsRemoval> {
    try {
      await this.process.remove(path, { recursive: true });
      return { removed: [path], kept: [], failures: [] };
    } catch (error) {
      const converted = toVfsError(error, 'rm', path);
      if (!(converted instanceof VfsError) || converted.code === 'ENOENT') throw converted;
      const failure: VfsRemovalFailure = { path, error: converted };
      return { removed: [], kept: [path], failures: [failure] };
    }
  }
  async symlink(target: string, path: string): Promise<void> { await this.call('symlink', target, () => this.process.symlink(target, path), path); }
  async readlink(path: string): Promise<string> {
    const target = await this.call('readlink', path, () => this.process.readlink(path));
    if (target === null) throw syscallError('EINVAL', 'readlink', path);
    return target;
  }
  async chmod(path: string, mode: number): Promise<void> { await this.call('chmod', path, () => this.process.chmod(path, mode)); }
  /** chown(2): a null side keeps what the file has (chown -1). */
  async chown(path: string, uid: number | null, gid: number | null): Promise<void> {
    await this.call('chown', path, async () => {
      if (uid === null || gid === null) {
        const stat = await this.process.stat(path);
        if (stat === null) throw syscallError('ENOENT', 'chown', path);
        uid ??= stat.uid;
        gid ??= stat.gid;
      }
      await this.process.chown(path, uid, gid);
    });
  }
  /**
   * utimensat(2): null is now, undefined leaves that time (only those need
   * no more than write permission or ownership); an explicit time needs
   * ownership. `follow: false` sets a link's own times.
   */
  async utimes(path: string, atimeMs: number | null | undefined, mtimeMs: number | null | undefined, options?: { follow?: boolean }): Promise<void> {
    await this.call(options?.follow === false ? 'lutime' : 'utime', path, () => this.process.utimes(path, atimeMs, mtimeMs, { followSymlinks: options?.follow !== false }));
  }
  /** cp: a file, or with `recursive` a tree, onto a name that is not there. */
  async copy(from: string, to: string, options?: { recursive?: boolean; preserve?: boolean }): Promise<number> {
    return await this.call(options?.recursive ? 'cp' : 'copyfile', from, async () => {
      if (options?.recursive) return await this.process.copyTree(from, to, { preserve: options.preserve });
      await this.process.copyFile(from, to);
      return 1;
    }, to);
  }
  /** Create the file if absent, and set its times to now (touch). */
  async touch(path: string): Promise<void> {
    await this.call('open', path, async () => {
      const handle = await this.process.open(path, { write: true, create: true });
      await this.process.close(handle.id);
      // UTIME_NOW: write permission is enough, as for touch(1).
      await this.process.utimes(path, null, null);
    });
  }
  /** The file's bytes read around the session's content cache, re-checked for a change mid-read. */
  async readFileUncached(path: string): Promise<Uint8Array> {
    return new Uint8Array(await this.readArrayBufferUncached(path));
  }
  /** {@link readFileUncached} as the ArrayBuffer a wasm module map takes, so a runtime image is held once. */
  async readArrayBufferUncached(path: string): Promise<ArrayBuffer> {
    const stat = await this.stat(path);
    if (stat === null) throw syscallError('ENOENT', 'open', path);
    const buffer = new ArrayBuffer(stat.size);
    const result = new Uint8Array(buffer);
    for (let offset = 0; offset < result.length;) {
      const bytes = await this.readRangeUncached(path, offset, Math.min(65536, result.length - offset));
      if (bytes.length === 0) throw syscallError('ESTALE', 'read', path, { detail: 'changed during the read' });
      result.set(bytes, offset);
      offset += bytes.length;
    }
    return buffer;
  }
  /**
   * rm: a file, or with `recursive` a tree, whole or not at all; `force`
   * makes a missing path no error.
   */
  async remove(path: string, options: { recursive?: boolean; force?: boolean } = {}): Promise<void> {
    await this.call('rm', path, () => this.process.remove(path, options));
  }
  /** Each entry of a directory with its own stat (links not followed): ls -l, find, du. */
  async readdirStat(path: string): Promise<Array<ProcessStat & { name: string }>> {
    const entries = await this.readdir(path);
    const base = path.endsWith('/') ? path : `${path}/`;
    const out: Array<ProcessStat & { name: string }> = [];
    for (const entry of entries) {
      const stat = await this.stat(base + entry.name, { follow: false });
      if (stat !== null) out.push({ ...stat, name: entry.name });
    }
    return out;
  }
  /** access(2): `mode` is F_OK or any of R_OK, W_OK, X_OK. */
  async access(path: string, mode: number): Promise<void> { await this.call('access', path, () => this.process.access(path, mode)); }
  async realpath(path: string): Promise<string> { return await this.call('realpath', path, () => this.process.realpath(path)); }
  /** Append through an O_APPEND descriptor, so concurrent appenders never overwrite each other. */
  async appendFile(path: string, content: Uint8Array | string): Promise<void> {
    const data = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    await this.call('open', path, async () => {
      const handle = await this.process.open(path, { write: true, append: true, create: true });
      try {
        let offset = 0;
        while (offset < data.length) {
          const written = await this.process.write(handle.id, null, data.subarray(offset));
          if (written <= 0 || written > data.length - offset) throw syscallError('EIO', 'write', path, { detail: 'short append' });
          offset += written;
        }
      } finally {
        await this.process.close(handle.id);
      }
    });
  }
}

/** A process's stat: everything stat(2) answers, which the bridge always has. */
export interface ProcessStat extends VfsStat {
  mode: number;
  uid: number;
  gid: number;
  atimeMs: number;
  ctimeMs: number;
  ino: number;
  nlink: number;
  dev: number;
}

function vfsStatOf(stat: RuntimeVfsStat): ProcessStat {
  return {
    type: stat.type, size: stat.size, mode: stat.mode, uid: stat.uid, gid: stat.gid,
    mtimeMs: stat.mtime, atimeMs: stat.atime, ctimeMs: stat.ctime,
    ino: stat.ino, nlink: stat.nlink, dev: stat.dev, revision: stat.revision,
  };
}

/**
 * The namespace, synchronously, in the engine's call shape (the subset host
 * code uses): `stat` throws ENOENT when absent, paths may omit the leading
 * slash, and every failure carries its POSIX code.
 */
export class NamespaceFs {
  constructor(private readonly fs: RuntimeSynchronousFs, readonly cred: VfsCred) {}

  private probe(path: string, follow: boolean): RuntimeVfsStat | null {
    try {
      return this.fs.stat(path, { followSymlinks: follow });
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOTDIR') return null;
      throw error;
    }
  }
  exists(path: string): boolean { return this.probe(path, true) !== null; }
  isDirectory(path: string): boolean { return this.probe(path, true)?.type === 'directory'; }
  isFile(path: string): boolean { return this.probe(path, true)?.type === 'file'; }
  isSymlink(path: string): boolean { return this.probe(path, false)?.type === 'symlink'; }
  stat(path: string): RuntimeVfsStat {
    const stat = this.fs.stat(path, { followSymlinks: true });
    if (stat === null) throw syscallError('ENOENT', 'stat', path);
    return stat;
  }
  lstat(path: string): RuntimeVfsStat {
    const stat = this.fs.stat(path, { followSymlinks: false });
    if (stat === null) throw syscallError('ENOENT', 'lstat', path);
    return stat;
  }
  access(path: string, mode: number): void { this.fs.access(path, mode); }
  readFile(path: string): Uint8Array {
    const bytes = this.fs.readFile(path);
    if (bytes === null) throw syscallError('ENOENT', 'open', path);
    return bytes;
  }
  readFileString(path: string): string { return new TextDecoder().decode(this.readFile(path)); }
  readRange(path: string, offset: number, length: number): Uint8Array {
    const bytes = this.fs.readRange(path, offset, length);
    if (bytes === null) throw syscallError('ENOENT', 'open', path);
    return bytes;
  }
  /** `mode` applies only if this creates the file, at creation. */
  writeFile(path: string, content: string | Uint8Array, options?: { mode?: number }): void {
    if (options?.mode === undefined) { this.fs.writeFile(path, content); return; }
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    const handle = this.fs.open(path, { write: true, create: true, truncate: true, mode: options.mode });
    try {
      for (let offset = 0; offset < bytes.length;) {
        const written = this.fs.write(handle.id, offset, bytes.subarray(offset));
        if (written <= 0) throw syscallError('EIO', 'write', path, { detail: 'short write' });
        offset += written;
      }
    } finally {
      this.fs.close(handle.id);
    }
  }
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): void { this.fs.mkdir(path, options); }
  readdir(path: string): RuntimeVfsDirEntry[] { return this.fs.readdir(path); }
  unlink(path: string): void { this.fs.unlink(path); }
  rmdir(path: string): void { this.fs.rmdir(path); }
  removeRecursive(path: string): void { this.fs.remove(path, { recursive: true }); }
  rename(from: string, to: string): void { this.fs.rename(from, to); }
  symlink(target: string, path: string): void { this.fs.symlink(target, path); }
  readlink(path: string): string {
    const target = this.fs.readlink(path);
    if (target === null) throw syscallError('EINVAL', 'readlink', path);
    return target;
  }
  /** Where a path's links lead (links followed), or null for a cycle. */
  resolveSymlink(path: string): string | null {
    try {
      return this.fs.realpath(path).replace(/^\/+/, '');
    } catch (error) {
      if ((error as { code?: string }).code === 'ELOOP') return null;
      throw error;
    }
  }
  chmod(path: string, mode: number): void { this.fs.chmod(path, mode); }
  chown(path: string, uid: number | null, gid: number | null): void {
    if (uid === null || gid === null) {
      const stat = this.stat(path);
      uid ??= stat.uid;
      gid ??= stat.gid;
    }
    this.fs.chown(path, uid, gid);
  }
  utimes(path: string, atimeMs: number | null | undefined, mtimeMs: number | null | undefined, options?: { followSymlinks?: boolean }): void {
    this.fs.utimes(path, atimeMs, mtimeMs, options);
  }
  copyFile(from: string, to: string): void { this.fs.copyFile(from, to); }
  acquireExclusiveMutation(path: string, options?: { includeMissingAncestors?: boolean }): { root: string; owner: string } {
    return this.fs.acquireExclusiveMutation(path, options);
  }
  releaseExclusiveMutation(owner: string): void { this.fs.releaseExclusiveMutation(owner); }
}
