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

import { LOCAL_PLACEMENT, type ProgramPlacement } from './program-start.js';
import { isPendingChunkError, listPageBudget } from '../vfs/sqlite-vfs.js';
import type { SqliteVFS, VfsExportChunk, VfsExportPage } from '../vfs/sqlite-vfs.js';
import { linkedSignal, type WriteBatchStreamResult, type WriteStreamOptions } from './wave-contracts.js';
import { namespaceWaveRouter } from './wave-router.js';
import { WaveIngest } from './wave-ingest.js';
import { Hydrator, type HydratorOptions } from './hydration.js';
import { Delegations, type DelegationRevoked } from './delegations.js';
import type { OutputGate } from './output-gate.js';
import type { FacetImage } from './facet-host.js';
import { withRecall } from '../vfs/recall.js';
import type { VfsEvent } from '../vfs/events.js';
import type { BatchWritePayload } from '@nimbus-sh/platform/w7-frame.js';
import { CompositeVFS, isAsyncMountRefusal, normalizePath, type MountWalk } from '../vfs/composite.js';
import { runtimeStatOf } from '../vfs/runtime-stat.js';
import { FS_LIST_PAGE_LIMIT, MOUNT_LIST_NAME_LIMIT } from '../constants.js';
import { DevVFS } from '../vfs/dev-vfs.js';
import { ProcVFS, standardProc } from '../vfs/proc-vfs.js';
import { PROC_MOUNT_POINT } from '../vfs/proc-files.js';
import { sqliteFiles } from '../vfs/sqlite-files.js';
import { isVfsError, syscallError, toVfsError, VfsError } from '../vfs/vfs-error.js';
import { beforeSubtree, normalizeVfsPath } from '../vfs/path.js';
import { abandon, andThen, readDeclaredSource, readRangeOrWhole, readText, type Awaitable } from '../vfs/vfs.js';
import type { VFS, VfsCopyOptions, VfsDirent, VfsRemoval, VfsRemovalFailure, VfsStat } from '../vfs/vfs.js';
import { formatProcMounts } from '../shell/mount-commands.js';
import {
  sameFileVersion,
  CRED_KERNEL,
  isVfsCred,
  requireVfsCred,
  type NimbusFilesystemAuthority,
  type NimbusFilesystemBinding,
  type NimbusHostFilesystemLease,
  type NimbusMountEntry,
  type RuntimeFileHandle,
  type RuntimeFsBridge,
  type RuntimeFsPath,
  type ExclusiveMutationGrant,
  type ExclusiveMutationRequest,
  type RecallKind,
  type RuntimeOpenFlags,
  type RuntimeReadFileOptions,
  type RuntimeReadOptions,
  type RuntimeOpenedFile,
  type RuntimeReopenTarget,
  type RuntimeSynchronousFs,
  type RuntimeVfsDirEntry,
  type RuntimeVfsStat,
  type VfsAcquireOptions,
  type VfsAcquireResult,
  type VfsCred,
  type VfsInvalidatedPath,
  type VfsListEntry,
  type VfsListOptions,
  type VfsListPage,
  type VfsMutationReceipt,
  type RuntimeMutationOwner,
} from './os-contracts.js';
import type { FsTime } from '@nimbus-sh/platform/w7-frame.js';
import { rootOf, samePosition, type FeedPosition } from './feed-position.js';
import { fsError, namespacePage, SqliteRuntimeFsBridge, walkBeneath } from './sqlite-runtime-fs-bridge.js';
import { modeAllows } from '../vfs/posix-access.js';
import { closeDescriptions, closeScopeSignal, createDescriptorScope, Descriptors, openFlags, processView, reportLost, scopeSignal, settleHeldAt, type Authority, type DescriptorScope } from './descriptors.js';
import { BUFFERED_WRITE_BYTES, openMounted, reopenMounted } from '../vfs/mounted-description.js';
import { flagsRefusal, openFollows } from '../vfs/open-rules.js';
import { registerDirectoryReadBridge, directoryReadHandleClosed } from './read-directory-batch.js';
import { readLeaseCovers, SESSION_KERNEL_ROOTS } from '../_shared/read-lease-cover.js';

function immutableCredential(cred: Readonly<VfsCred>): VfsCred {
  // One frozen whole already (a process table's: ProcessTable.credOf) is kept, not copied again.
  if (Object.isFrozen(cred) && Object.isFrozen(cred.groups) && isVfsCred(cred)) return cred;
  const checked = requireVfsCred(cred, 'filesystem binding');
  return Object.freeze({ uid: checked.uid, gid: checked.gid, groups: Object.freeze([...checked.groups]), umask: checked.umask });
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
    private readonly scope: DescriptorScope,
    private readonly signal: AbortSignal | undefined,
    private readonly pid: number | undefined,
    /** N17: the lazy-import hydration job, when there is one. */
    private readonly hydrator: Hydrator | null,
    /** The session's delegations: a process's own are granted, recalled and released here. */
    private readonly delegations: Delegations,
    /** The session's gate on the process's output (ProcessFiles.outputGate). */
    private readonly gate: Required<OutputGate>,
    /** Its binding's (ProcessFiles.bridgeFor): asked before each call, each answered in the caller's turn. */
    private readonly authority: Authority,
    /** Aborted when the binding ends while a recovery keeps its scope (ProcessFiles.recovery): its stream commits stop then. */
    private readonly revoked?: AbortSignal,
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
    this.authority();
  }

  private ownPid(pid: number): void {
    if (this.pid === undefined || pid !== this.pid) {
      throw Object.assign(new Error('EPERM: append process identity mismatch'), { code: 'EPERM' });
    }
  }

  stat(path: RuntimeFsPath, options?: { followSymlinks?: boolean }): RuntimeVfsStat | null { this.guard(); return this.target.stat(path, options); }
  readFile(path: RuntimeFsPath, options?: RuntimeReadFileOptions): Uint8Array | null { this.guard(); return this.reading(() => this.target.readFile(path, options)); }
  writeFile(path: RuntimeFsPath, bytes: string | Uint8Array, options?: { createParents?: boolean; expectedRevision?: number; umask?: number }): number {
    this.guard(); return this.target.writeFile(path, bytes, options);
  }
  readRange(path: RuntimeFsPath, offset: number, length: number, options?: RuntimeReadOptions): Uint8Array | null {
    this.guard(); return this.reading(() => this.target.readRange(path, offset, length, options));
  }
  writeRange(path: RuntimeFsPath, offset: number, bytes: Uint8Array, options?: { createParents?: boolean; expectedRevision?: number } & RuntimeMutationOwner): VfsMutationReceipt {
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
  truncate(path: RuntimeFsPath, size: number, options?: { followSymlinks?: boolean } & RuntimeMutationOwner): VfsMutationReceipt { this.guard(); return this.target.truncate(path, size, options); }
  utimes(path: RuntimeFsPath, atime: FsTime, mtime: FsTime, options?: { followSymlinks?: boolean }): VfsMutationReceipt {
    this.guard(); return this.target.utimes(path, atime, mtime, options);
  }
  chmod(path: RuntimeFsPath, mode: number): VfsMutationReceipt { this.guard(); return this.target.chmod(path, mode); }
  access(path: RuntimeFsPath, mode: number): void { this.guard(); return this.target.access(path, mode); }
  chown(path: RuntimeFsPath, uid: number | null, gid: number | null, options?: { followSymlinks?: boolean }): VfsMutationReceipt {
    this.guard(); return this.target.chown(path, uid, gid, options);
  }
  open(path: RuntimeFsPath, flags: RuntimeOpenFlags, options?: RuntimeMutationOwner): RuntimeOpenedFile { this.guard(); return this.target.open(path, flags, options); }
  reopen(target: RuntimeReopenTarget, flags: RuntimeOpenFlags, options?: RuntimeMutationOwner): RuntimeOpenedFile { this.guard(); return this.target.reopen(target, flags, options); }
  read(handleId: number, offset: number | null, length: number): Uint8Array { this.guard(); return this.reading(() => this.target.read(handleId, offset, length)); }
  write(handleId: number, offset: number | null, bytes: Uint8Array): number { this.guard(); return this.target.write(handleId, offset, bytes); }
  close(handleId: number): void { return this.target.close(handleId); }
  readdir(path: RuntimeFsPath, options?: { followSymlinks?: boolean }): RuntimeVfsDirEntry[] { this.guard(); return this.target.readdir(path, options); }
  mkdir(path: RuntimeFsPath, options?: { recursive?: boolean; mode?: number } & RuntimeMutationOwner): void { this.guard(); return this.target.mkdir(path, options); }
  unlink(path: RuntimeFsPath, options?: RuntimeMutationOwner): void { this.guard(); return this.target.unlink(path, options); }
  rmdir(path: RuntimeFsPath, options?: RuntimeMutationOwner): void { this.guard(); return this.target.rmdir(path, options); }
  rename(from: RuntimeFsPath, to: RuntimeFsPath, options?: RuntimeMutationOwner): void { this.guard(); return this.target.rename(from, to, options); }
  readlink(path: RuntimeFsPath): string | null { this.guard(); return this.target.readlink(path); }
  linkLeadsTo(path: string, link: string): string | null { this.guard(); return this.target.linkLeadsTo(path, link); }
  symlink(target: string, path: RuntimeFsPath): void { this.guard(); return this.target.symlink(target, path); }
  fsync(handleId?: number): void { this.guard(); return this.target.fsync(handleId); }
  revision(path?: RuntimeFsPath): number { this.guard(); return this.target.revision(path); }
  contentKey(path: RuntimeFsPath): string { this.guard(); return this.reading(() => this.target.contentKey(path)); }
  acquire(position: FeedPosition | null, options?: VfsAcquireOptions): VfsAcquireResult {
    this.guard();
    return this.withReadLease(this.target.acquire(position, options), options);
  }
  /**
   * `answer`, with the process's read lease when it asked for one: in the
   * turn the answer was made in, so it is granted at the revision the answer
   * reports (Delegations.readLease).
   */
  withReadLease(answer: VfsAcquireResult, options?: VfsAcquireOptions): VfsAcquireResult {
    if (options?.lease !== true || this.pid === undefined || answer.poison) return answer;
    let lease: { owner: string; trustMs: number } | null;
    try {
      lease = this.delegations.readLease(this.pid, (terms) => this.target.acquireReadLease(terms, rootOf(answer.position)), this.scope);
    } catch (error) {
      // A change being published (EAGAIN): this barrier is answered without one.
      if ((error as { code?: unknown } | null)?.code !== 'EAGAIN') throw error;
      lease = null;
    }
    return lease === null ? answer : { ...answer, readLease: lease };
  }
  list(after?: string | null, limit?: number, options?: VfsListOptions): VfsListPage { this.guard(); return this.target.list(after, limit, options); }
  realpath(path: RuntimeFsPath): string { this.guard(); return this.target.realpath(path); }
  remove(path: RuntimeFsPath, options?: { recursive?: boolean; force?: boolean; report?: boolean; keepVanishedAncestors?: boolean }): void | VfsRemoval { this.guard(); return this.target.remove(path, options); }
  copyFile(from: RuntimeFsPath, to: RuntimeFsPath, options?: { keepMode?: boolean; preserve?: boolean }): void { this.guard(); return this.target.copyFile(from, to, options); }
  copyTree(from: RuntimeFsPath, to: RuntimeFsPath, options?: { preserve?: boolean; follow?: boolean }): number | Promise<number> {
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
  fchown(handleId: number, uid: number | null, gid: number | null): void { this.guard(); return this.target.fchown(handleId, uid, gid); }
  futimes(handleId: number, atime: FsTime, mtime: FsTime): void { this.guard(); return this.target.futimes(handleId, atime, mtime); }
  writeBatch(payload: BatchWritePayload, options?: { signal?: AbortSignal }): Promise<{ inodes: number; chunks: number }> {
    this.guard();
    // As writeStream: closing the scope cancels the commit.
    const linked = linkedSignal([options?.signal, this.signal, this.revoked, scopeSignal(this.scope)]);
    return Promise.resolve(this.target.writeBatch(payload, { signal: linked.signal })).finally(linked.dispose);
  }
  writeStream(
    stream: ReadableStream<Uint8Array>,
    options?: WriteStreamOptions,
  ): Promise<WriteBatchStreamResult> {
    this.guard();
    // Closing the scope cancels the commit, so a released process cannot keep
    // publishing groups into a filesystem it no longer holds descriptors on.
    const linked = linkedSignal([options?.signal, this.signal, this.revoked, scopeSignal(this.scope)]);
    return this.target.writeStream(stream, { ...options, signal: linked.signal }).finally(linked.dispose);
  }
  acquireExclusiveMutation(path: RuntimeFsPath, options?: ExclusiveMutationRequest): ExclusiveMutationGrant {
    this.guard();
    const delegate = options?.delegate;
    if (this.pid === undefined) return this.target.acquireExclusiveMutation(path, options);
    // A delegation is the process's: it ends with the process's scope.
    if (delegate !== undefined) return this.delegations.grant(this.pid, delegate, (terms) => this.target.acquireExclusiveMutation(path, options, { terms }), this.scope);
    // So does a lease it takes for itself: a process that ends holding one
    // (killed, its host lost) leaves no subtree held behind it.
    const lease = this.target.acquireExclusiveMutation(path, options, {});
    const end = (): void => {
      this.scope.leases.delete(lease.owner);
      this.target.releaseExclusiveMutation(lease.owner);
    };
    this.scope.leases.set(lease.owner, end);
    this.scope.subscriptions.add(end);
    return lease;
  }
  releaseExclusiveMutation(owner: string): void {
    this.guard();
    if (this.pid !== undefined && this.delegations.holds(this.pid, owner)) {
      this.delegations.release(this.pid, owner);
      return;
    }
    const end = this.scope.leases.get(owner);
    if (end === undefined) {
      this.target.releaseExclusiveMutation(owner);
      return;
    }
    this.scope.subscriptions.delete(end);
    end();
  }
  awaitRecall(owner: string, waitMs?: number): Promise<RecallKind | null> {
    this.guard();
    if (this.pid === undefined) return this.target.awaitRecall(owner);
    return this.delegations.awaitRecall(this.pid, owner, waitMs);
  }
  recalled(owner: string, kind: RecallKind): void {
    this.guard();
    if (this.pid === undefined) this.target.recalled(owner);
    else this.delegations.recalled(this.pid, owner, kind);
  }
  published(options?: { escape?: boolean }): Promise<void> | void {
    this.guard();
    if (this.pid === undefined) return this.target.published();
    if (options?.escape === true) this.gate.escaped(this.pid);
    return this.gate.before(this.pid) ?? undefined;
  }
}

/** The session's namespace and the processes bound to it. */
export class ProcessFiles implements NimbusFilesystemAuthority {
  readonly namespace: string;
  /** The mount table: SQLite at `/`, `/proc`, `/dev`, and the embedder's. */
  readonly vfs: CompositeVFS;
  /** `/proc`: the host registers generated files here (`mounts` is ProcessFiles'). */
  readonly proc: ProcVFS;
  private readonly processes = new Map<number, DescriptorScope>();
  private readonly namespaces = new Map<string, NamespaceFs>();
  private readonly retired = new Set<number>();
  /** Per process: what ends its ordinary bindings at its release, whatever keeps its scope open after. */
  private readonly bound = new Map<number, AbortController>();
  /** Per process whose log is draining: its one recovery, and the release it defers until the drain ends. */
  private readonly recoveries = new Map<number, { release: { run(): Promise<void>; done: Promise<void> } | null }>();
  /** Per process: where its listings of the mounts beyond SQLite stand (MountListing). */
  private readonly listings = new Map<number, MountListing>();
  /** Inode numbers for mounted entries whose backend keeps none: stable per path for the session. */
  /** N17: the lazy-import hydration job, when the embedder supplies a fetch. */
  readonly hydrator: Hydrator | null;
  /** Subtrees delegated to processes (Delegations): each recalled through its holder's bridge. */
  readonly delegations: Delegations;

  /** Bytes one buffered mount handle holds before EFBIG (VFS-PF-001). */
  private readonly bufferedWriteBytes: number | undefined;
  /**
   * Every wave's ingestion, whoever streams it (a process's binding, or a
   * command holding the engine): its records placed by this namespace's
   * mutation lookup, those it places on a mount applied there by its own
   * operations (wave-router.ts).
   */
  readonly waves: WaveIngest;

  constructor(
    readonly engine: SqliteVFS,
    options: {
      hydration?: HydratorOptions;
      bufferedWriteBytes?: number;
      /** Told of a delegation's holder revoked for not answering a recall in time: the host stops it. */
      delegationRevoked?: (event: DelegationRevoked) => void;
      /** Told of a delegation's holder that ended still holding it (Delegations' orphaned): what it had not sent there is lost. */
      delegationOrphaned?: (event: { readonly pid: number; readonly root: string }) => void;
      delegationRecallTimeoutMs?: number;
    } = {},
  ) {
    this.hydrator = options.hydration === undefined ? null : new Hydrator(engine, options.hydration);
    this.delegations = new Delegations({
      release: (owner) => engine.releaseExclusiveMutation(owner),
      revoked: options.delegationRevoked,
      ...(options.delegationOrphaned === undefined ? {} : { orphaned: options.delegationOrphaned }),
      recallTimeoutMs: options.delegationRecallTimeoutMs,
    });
    this.bufferedWriteBytes = options.bufferedWriteBytes;
    this.namespace = engine.namespace;
    this.vfs = new CompositeVFS(sqliteFiles(engine, CRED_KERNEL));
    // An exclusive-mutation lease holds wherever a process's mutation lands,
    // on a mount as on SQLite: checked by the namespace on the route it
    // resolved, right before the backend is called.
    this.vfs.guardMutations((cred, path, owner) => engine.mutationRefusal(path, cred, owner));
    this.proc = standardProc();
    this.proc.register('mounts', (cred) => formatProcMounts(this.mounts(cred ?? CRED_KERNEL)));
    this.vfs.mount(PROC_MOUNT_POINT, this.proc);
    this.vfs.mount('/dev', new DevVFS());
    // A read lease vouches for what is the engine's, which a mount or an unmount moves.
    this.vfs.watchMounts(() => engine.breakReadLeases());
    // So does a delegation's certificate (its holder answers from its view): given up before the table moves.
    this.vfs.guardRouting((point) => engine.recallRouting(point));
    this.waves = new WaveIngest(namespaceWaveRouter(this.vfs, immutableCredential));
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
      listing = { named: new Set<string>(), held: null };
      this.listings.set(pid, listing);
    }
    return listing;
  }

  bind({ pid, cred, signal }: NimbusFilesystemBinding): RuntimeFsBridge {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('filesystem binding requires a process pid');
    if (this.retired.has(pid)) throw Object.assign(new Error('ESTALE: process released'), { code: 'ESTALE' });
    let bound = this.bound.get(pid);
    if (!bound) { bound = new AbortController(); this.bound.set(pid, bound); }
    return this.bridgeFor(this.scopeOf(pid), immutableCredential(cred), signal, pid, false, bound.signal);
  }

  recovery(pid: number, cred: Readonly<VfsCred>): NimbusHostFilesystemLease {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('filesystem recovery requires a process pid');
    if (this.retired.has(pid)) throw Object.assign(new Error('ESTALE: process released'), { code: 'ESTALE' });
    if (this.recoveries.has(pid)) throw Object.assign(new Error(`EBUSY: the log of process ${pid} is draining already`), { code: 'EBUSY' });
    const recovery: { release: { run(): Promise<void>; done: Promise<void> } | null } = { release: null };
    this.recoveries.set(pid, recovery);
    // Not ended by the release: the drain is what ends it.
    const fs = this.bridgeFor(this.scopeOf(pid), immutableCredential(cred), undefined, pid);
    return {
      fs,
      dispose: async () => {
        if (this.recoveries.get(pid) !== recovery) return;
        this.recoveries.delete(pid);
        await recovery.release?.run();
      },
    };
  }

  /** `pid`'s descriptor scope, made on its first binding. */
  private scopeOf(pid: number): DescriptorScope {
    let scope = this.processes.get(pid);
    if (!scope) { scope = createDescriptorScope(); this.processes.set(pid, scope); }
    return scope;
  }

  openHost(cred: Readonly<VfsCred>, options: { signal?: AbortSignal } = {}): NimbusHostFilesystemLease {
    const scope = createDescriptorScope();
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
   * exactly as a process's syscalls do. `landed`: its reads read what has
   * landed (VFS.as), asking no delegation's holder — a listing that runs on
   * every change (the editor's file tree). One per credential and option for
   * the session.
   */
  namespaceFs(cred: Readonly<VfsCred>, options: { landed?: boolean } = {}): NamespaceFs {
    const identity = immutableCredential(cred);
    const landed = options.landed === true;
    const key = `${identity.uid}:${identity.gid}:${identity.groups.join(',')}:${identity.umask}${landed ? ':landed' : ''}`;
    let fs = this.namespaces.get(key);
    if (!fs) {
      const bridge = this.bridgeFor(createDescriptorScope(), identity, undefined, undefined, landed);
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

  /**
   * What holds a process's output back: the publication of every commit of
   * its that another reader's recall holds (SqliteVFS.publishedFor). None
   * held, nothing waits.
   */
  readonly outputGate: Required<OutputGate> = {
    before: (pid) => {
      const holds = this.delegations.holdsAt(pid);
      return holds === undefined ? null : this.engine.publishedFor(holds);
    },
    escaped: (pid) => { this.continuing.delete(pid); },
  };
  /** Whether the session's process output waits at `outputGate` (holdOutput). */
  private outputHeld = false;
  /** The processes whose waves answer at their commit (continueAtCommit), until one escapes the gate. */
  private readonly continuing = new Set<number>();

  /**
   * Released `pid` writes nothing more: the set its calls were made by
   * (Delegations.holdsOf), by which the engine holds what it wrote for its
   * publication, goes once that is published. Until then the output its end
   * leaves still waits for it, whenever that is let out.
   */
  private retireWriter(pid: number): void {
    this.continuing.delete(pid);
    const holds = this.delegations.holdsAt(pid);
    if (holds === undefined) return;
    const held = this.engine.publishedFor(holds);
    if (held === null) this.delegations.retire(pid);
    else void held.then(() => this.delegations.retire(pid));
  }

  /**
   * From now on whatever `processes` lets out for a process (its log, pipes,
   * terminal and exit, the supervisor ops that leave the session, its ports'
   * answers: SessionProcessSupervisor.releaseOutput) waits at `outputGate`
   * for what it wrote to be published.
   */
  holdOutput(processes: { setOutputGate(gate: OutputGate | null): void }): void {
    processes.setOutputGate(this.outputGate);
    this.outputHeld = true;
  }

  /**
   * Process `pid`'s waves answer at their commit from now on, ahead of
   * their publication: the writer continues, and whatever it makes visible
   * waits for the publication instead. Only for a process whose every way
   * out does: what the session lets out for it at `outputGate` (holdOutput),
   * what leaves by its runtime's own network at that runtime's boundary
   * (RuntimeFsBridge.published, the node shims'), and a raw socket it opens
   * ending this (`escaped`).
   */
  continueAtCommit(pid: number): void {
    if (this.outputHeld) this.continuing.add(pid);
  }

  /** Process `pid` has ended (exited, killed, its host lost): see Delegations.endReads. */
  processEnded(pid: number): void {
    this.delegations.endReads(pid);
  }

  releaseProcess(pid: number): Promise<void> {
    this.retired.add(pid);
    this.listings.delete(pid);
    // Its bindings end now (EBADF, as a closed scope answers), every call
    // through them, a close too.
    this.bound.get(pid)?.abort(fsError('EBADF', 'fd', 'filesystem scope closed'));
    this.bound.delete(pid);
    const recovery = this.recoveries.get(pid);
    if (recovery === undefined) return this.closeProcess(pid);
    // Its log is draining: its scope is the recovery's, every description in
    // it, until the drain ends; then it is closed, each last close flushing,
    // and the release settles.
    if (recovery.release === null) {
      let run!: () => Promise<void>;
      const done = new Promise<void>((resolve, reject) => { run = () => this.closeProcess(pid).then(resolve, reject); });
      recovery.release = { run, done };
    }
    return recovery.release.done;
  }

  /** `pid`'s scope closed for good, its descriptors' last closes flushing, and its grants given up. */
  private async closeProcess(pid: number): Promise<void> {
    const scope = this.processes.get(pid);
    try {
      // Its descriptors' last closes flush; one whose flush fails is reported
      // once the process is released all the same.
      if (scope) await this.closeScope(scope);
    } finally {
      this.processes.delete(pid);
      this.retireWriter(pid);
    }
  }

  /** See NimbusFilesystemAuthority.rewindProcess. */
  async rewindProcess(pid: number): Promise<void> {
    if (this.retired.has(pid)) return;
    this.listings.delete(pid);
    const scope = this.processes.get(pid);
    try {
      if (scope) await this.closeScope(scope);
    } finally {
      this.processes.delete(pid);
    }
  }

  /**
   * The process died without closing its descriptors: nothing is flushed,
   * and what that loses is reported, the descriptors whose buffered writes
   * are gone. Later use of its descriptors is EBADF, as after a release.
   */
  killProcess(pid: number): { lost: number[] } {
    this.retired.add(pid);
    this.listings.delete(pid);
    this.bound.delete(pid);
    const scope = this.processes.get(pid);
    this.processes.delete(pid);
    const lost: number[] = [];
    try {
      if (scope && !scope.closed) {
        for (const [id, opened] of scope.handles) {
          if (opened.node.mounted && opened.node.pendingBytes() > 0) lost.push(id);
          // Dropped unflushed; a description another process still holds stays open.
          if (--opened.refs > 0) continue;
          const { node } = opened;
          // A mount's file its backend holds open is closed with nothing written
          // (MountedFileDescription.discard); the engine's is closed, so it pins
          // nothing (an unlinked file's content): what was written through it,
          // held appends included, is the file's already.
          abandon(node.mounted ? { close: () => node.discard() } : node);
        }
        scope.handles.clear();
        scope.held.clear();
        scope.waveDescriptions.clear();
        closeScopeSignal(scope);
        this.stopSubscriptions(scope);
      }
    } finally {
      // Its delegations end once its descriptions are closed, as closeProcess
      // orders it: a held append is written under them, not recalled from it.
      this.retireWriter(pid);
    }
    return { lost };
  }

  /** The mounts `cred` sees, root first: what df, mount and `/proc/mounts` list. */
  placeProgram(cred: Readonly<VfsCred>, cwd: string): ProgramPlacement | Promise<ProgramPlacement> {
    return this.vfs.placesPrograms() ? this.vfs.as(immutableCredential(cred)).placeProgram(cwd) : LOCAL_PLACEMENT;
  }

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

  /**
   * Closes `scope` for good: every descriptor (each last close flushing),
   * its subscriptions, and the scope itself (EBADF from then on, for every
   * bridge on it). A flush that fails (an aborted binding's, a mount's
   * refusal) loses its bytes and is reported after the scope is closed.
   */
  /** Every subscription of `scope` stopped, whichever of them fails to. */
  private stopSubscriptions(scope: DescriptorScope): void {
    for (const dispose of [...scope.subscriptions]) {
      try {
        dispose();
      } catch (error) {
        console.error('[process-files] a subscription could not be stopped:', error instanceof Error ? error.message : String(error));
      }
    }
    scope.subscriptions.clear();
  }

  private closeScope(scope: DescriptorScope): Awaitable<void> {
    if (scope.closed) return;
    const lost = closeDescriptions(scope);
    this.stopSubscriptions(scope);
    closeScopeSignal(scope);
    return andThen(lost, reportLost);
  }

  private bridgeFor(scope: DescriptorScope, cred: VfsCred, signal?: AbortSignal, pid?: number, landed = false, revoked?: AbortSignal): RuntimeFsBridge {
    // The binding's one Authority, asked right before each call of it reaches
    // a backend, after every await: by the namespace for its paths, the
    // descriptor table for its descriptions, the engine's bridge for its own.
    // A call still resolving when the process is released or killed (its
    // binding ended: `revoked`, or its scope closed), its caller's abort
    // come, or its lease disposed, does not land. `owned`: the same, its
    // caller's abort aside, for its closes.
    const owned: Authority = () => {
      revoked?.throwIfAborted();
      if (scope.closed) throw fsError('EBADF', 'fd', 'filesystem scope closed');
    };
    const authority: Authority = () => {
      signal?.throwIfAborted();
      owned();
    };
    // A process's calls are made by the delegations it holds: its own lookups
    // recall none of them, on SQLite and through the namespace alike.
    const holds = pid === undefined ? undefined : () => this.delegations.holdsOf(pid);
    const continues = pid === undefined ? undefined : () => this.continuing.has(pid);
    // The views and the bridges under the awaiting one, made at the binding's
    // first call on the filesystem: a process that makes none (a child that
    // runs `true`, `echo`) makes none of them. What a release, a kill or a
    // lease ends is the scope, made now.
    let made: ProcessBridgeParts | undefined;
    const parts = (): ProcessBridgeParts => {
      if (made !== undefined) return made;
      const namespace = this.vfs.as(cred, undefined, landed ? { landed } : undefined).scoped(authority, undefined, holds);
      const target = new SqliteRuntimeFsBridge(this.engine.as(cred, { holds, continues, ...(landed ? { landed } : {}) }), this.engine, scope, namespace, this.bufferedWriteBytes, this.waves, { authority, owned, ...(signal === undefined ? {} : { signal }) });
      made = { guarded: new GuardedProcessBridge(target, scope, signal, pid, this.hydrator, this.delegations, this.outputGate, authority, revoked), namespace };
      return made;
    };
    // Every other method forwards to the guarded bridge.
    const listing = pid === undefined ? () => undefined : (create: boolean) => this.listingOf(pid, create);
    const clock = () => this.engine.revision();
    const bridge = new AwaitingProcessBridge(parts, clock, cred, new Descriptors(scope, clock, authority, owned), scope, listing, this.bufferedWriteBytes, authority, signal);
    registerDirectoryReadBridge(bridge, scope, async (path) => {
      const real = await bridge.realpath(path);
      const view = parts().namespace;
      if (real === '/' || view.composes(real)) return null;
      const route = await view.route(real, { follow: true });
      const key = normalizeVfsPath(real);
      return route.point === '/' && route.source !== null && readLeaseCovers(key, true, SESSION_KERNEL_ROOTS) ? key : null;
    });
    return bridge;
  }
}

/**
 * Where a process's listings of the mounts beyond SQLite stand: what they
 * walk, and the walk a listing in progress took.
 */
interface MountListing {
  /** What its launch names (ProcessFiles.nameLaunch): where its listing walks. */
  readonly named: Set<string>;
  /** The walk its listing in progress took, which only the page continuing it (`next`) reuses. */
  held: { walk: MountWalk; next: string } | null;
}

/** The kernel's own filesystems: fed (their trees fixed: immutable-changes.ts), so never walked. */
const KERNEL_MOUNT_POINTS: Record<string, true> = { [PROC_MOUNT_POINT]: true, '/dev': true };

/**
 * Entries one page of ProcessView.scan reads in one slice of the thread.
 * Measured 2026-10-20 on armada (bun:sqlite, a 34,302-file tree): about
 * 2.5 µs an entry; a session's SQLite runs about 3–4× bun's, so about
 * 10 ms a page, well under the slice that ages the session's queue.
 */
const SCAN_PAGE = 1024;

/**
 * The engine's own timer, taken when this module is evaluated: a program
 * that shares the realm wraps the global one as a handle of its own.
 */
const engineSetTimeout = globalThis.setTimeout;

/** A mount an embedder made (a Drive, a container, a device). */
function isEmbedderMount(point: string): boolean {
  return point !== '/' && KERNEL_MOUNT_POINTS[point] !== true;
}

/** Whether the table declares an embedder mount, including one whose source is absent. */
function mountsBeyondSqlite(view: CompositeVFS): boolean {
  return view.someMountPoint(isEmbedderMount);
}

/**
 * A process's asynchronous face (ProcessView, supervisor ops, RPC,
 * fs.promises): the guarded bridge, except that a path an asynchronous-only
 * mount refuses to a synchronous caller is answered by awaiting that mount,
 * through the namespace as the process's credential. `synchronous` (node's
 * sync fs, non-JSPI WASI, host reads that cannot wait) stays the guarded
 * bridge, where such a mount's refusal is the answer.
 */
/** What a process's awaiting bridge forwards to: made at its first call (ProcessFiles.bridgeFor). */
interface ProcessBridgeParts {
  readonly guarded: GuardedProcessBridge;
  readonly namespace: CompositeVFS;
}

class AwaitingProcessBridge implements RuntimeFsBridge {
  private made: ProcessBridgeParts | undefined;

  constructor(
    private readonly parts: () => ProcessBridgeParts,
    private readonly clock: () => number,
    private readonly cred: VfsCred,
    private readonly descriptors: Descriptors,
    private readonly scope: DescriptorScope,
    /** Where this process's listings of mounts beyond SQLite stand (made when `create`); undefined for a host lease. */
    private readonly listing: (create: boolean) => MountListing | undefined,
    private readonly bufferedWriteBytes: number | undefined,
    /** Its binding's (ProcessFiles.bridgeFor): what its descriptions and namespace ask at each dispatch, asked here where a call commits to the scope itself. */
    private readonly authority: Authority,
    /** Its caller's abort: a description it opens is refused once it comes (MountedDescriptionContext.signal). */
    private readonly signal?: AbortSignal,
  ) {}

  private get bridge(): GuardedProcessBridge { return (this.made ??= this.parts()).guarded; }
  private get namespace(): CompositeVFS { return (this.made ??= this.parts()).namespace; }

  get synchronous(): RuntimeSynchronousFs { return this.bridge; }

  gateLaunch(named: readonly string[]): Promise<void> { return this.bridge.gateLaunch(named); }
  revision(path?: RuntimeFsPath): number { return this.bridge.revision(path); }
  contentKey(path: RuntimeFsPath) {
    return this.either([path], () => this.bridge.contentKey(path), async () => {
      throw syscallError('ENOTSUP', 'open', await this.path(path));
    });
  }
  /** The process's namespace's changes at `path` and under it (CompositeVFS.watchChanges), named as its listings name them; stopped with its scope. */
  subscribe(path: string, listener: (event: VfsEvent) => void, options?: { follow?: boolean }): () => void {
    this.authority();
    let stopped = false;
    const stop = this.namespace.watchChanges(path, (events) => {
      for (const event of events) {
        if (stopped) break;
        listener(event.oldPath === undefined
          ? { type: event.type, path: event.path.slice(1), timestamp: event.timestamp }
          : { type: event.type, path: event.path.slice(1), oldPath: event.oldPath.slice(1), timestamp: event.timestamp });
      }
    }, options);
    const dispose = (): void => {
      if (stopped) return;
      stopped = true;
      this.scope.subscriptions.delete(dispose);
      stop();
    };
    this.scope.subscriptions.add(dispose);
    return dispose;
  }
  writeBatch(payload: BatchWritePayload, options?: { signal?: AbortSignal }) { return this.bridge.writeBatch(payload, options); }
  writeStream(
    stream: ReadableStream<Uint8Array>,
    options?: WriteStreamOptions,
  ): Promise<WriteBatchStreamResult> { return this.bridge.writeStream(stream, options); }
  acquireExclusiveMutation(path: RuntimeFsPath, options?: ExclusiveMutationRequest): ExclusiveMutationGrant {
    return this.bridge.acquireExclusiveMutation(path, options);
  }
  releaseExclusiveMutation(owner: string): void { return this.bridge.releaseExclusiveMutation(owner); }
  awaitRecall(owner: string, waitMs?: number): Promise<RecallKind | null> { return this.bridge.awaitRecall(owner, waitMs); }
  recalled(owner: string, kind: RecallKind): void { return this.bridge.recalled(owner, kind); }
  published(options?: { escape?: boolean }): Promise<void> | void { return this.bridge.published(options); }


  /**
   * One page of every name the process's view shows (namespacePage), the
   * mounts without a feed walked where the process's launch named them
   * (CompositeFeed.walk). A mounted entry carries its own feed's revision,
   * 0 for one that never moves.
   */
  async list(after?: string | null, limit?: number, options?: VfsListOptions): Promise<VfsListPage> {
    this.authority();
    const listing = this.listing(true);
    // A page continuing a listing reuses the walk its earlier pages took; any other walks afresh.
    const held = listing?.held;
    const walk = after != null && held && held.next === after
      ? held.walk
      : await this.namespace.feed.walk(listing?.named ?? [], MOUNT_LIST_NAME_LIMIT);
    this.authority();
    const page = namespacePage(this.namespace, this.cred, after ?? null, limit, walk, options);
    if (listing) listing.held = page.next === null ? null : { walk, next: page.next };
    return page;
  }

  /**
   * What changed since the process's position (SqliteRuntimeFsBridge.acquire),
   * with its read lease where it asked one.
   */
  acquire(position: FeedPosition | null, options?: VfsAcquireOptions): VfsAcquireResult {
    this.authority();
    return this.bridge.acquire(position, options);
  }

  /**
   * The guarded bridge's answer, as it gives it (synchronously when it can),
   * or on an asynchronous mount's refusal, `awaited`.
   */
  private either<T>(paths: RuntimeFsPath[], sync: () => T | Promise<T>, awaited: () => Promise<T>): T | Promise<T> {
    // Relative to a descriptor whose description awaits: the bridge would refuse it.
    const settled = () => awaited();
    if (paths.some((path) => typeof path !== 'string' && 'directory' in path && this.awaits(path.directory))) return settled();
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
      : this.bridge.descriptorPath(path.directory);
    if (!path.beneath) {
      if (path.path.startsWith('/')) return path.path;
      if ((await this.namespace.stat(base))?.type !== 'directory') throw fsError('ENOTDIR', 'path', path.path);
      return (base === '/' ? '' : base) + '/' + path.path;
    }
    const root = normalizeVfsPath(base);
    // `base` is a mounted directory's own name where it has one (descriptorPath): lookups beneath it start there.
    const walk = walkBeneath(root, path, follow, this.cred, (name, to) => this.namespace.resolvedByBackend(name, '/' + root, to), base);
    for (let step = walk.next(); ; ) {
      if (step.done) {
        if (step.value === null) throw fsError('ELOOP', 'path', path);
        return step.value.spelling;
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
      if (stat === null) return null;
      const view = stat.type === 'file' ? await this.viewed(resolved, follow) : undefined;
      return view ? { ...runtimeStatOf(stat), size: view.byteLength } : runtimeStatOf(stat);
    });
  }
  readFile(path: RuntimeFsPath, options?: RuntimeReadFileOptions) {
    return this.either([path], () => this.bridge.readFile(path, options), () => this.absent(async () => {
      const follow = options?.followSymlinks !== false;
      const name = await this.path(path, follow);
      // Only SQLite bounds a whole read (SqliteRuntimeFsBridge.readFile): a mount answers EFBIG, unread.
      if (options?.maxBytes !== undefined) throw syscallError('EFBIG', 'read', name);
      // Nor does a mount keep content keys to read by.
      if (options?.contentKey !== undefined) throw syscallError('ENOTSUP', 'read', name);
      const bytes = (await this.viewed(name, follow)) ?? (await this.namespace.readFile(name));
      // An uncached read hands back bytes of its own, as SqliteRuntimeFsBridge's does.
      return options?.cached === false ? bytes.slice() : bytes;
    }));
  }
  readRange(path: RuntimeFsPath, offset: number, length: number, options?: RuntimeReadOptions) {
    return this.either([path], () => this.bridge.readRange(path, offset, length, options), () => this.absent(async () => {
      // A mounted file, as the synchronous bridge judges one: the engine's revisions name none, and
      // a listing's stat is checked before the read and after it, which an await comes between.
      if (options?.expectedEpoch !== undefined) throw fsError('ESTALE', 'read', path);
      const expected = options?.expectedFile;
      if (expected !== undefined && !sameFileVersion(await this.stat(path), expected)) throw fsError('ESTALE', 'read', path);
      const name = await this.path(path);
      const view = await this.viewed(name, true);
      const bytes = await (view ? view.slice(offset, offset + length) : readRangeOrWhole(this.namespace, name, offset, length));
      if (expected !== undefined && !sameFileVersion(await this.stat(path), expected)) throw fsError('ESTALE', 'read', path);
      return bytes;
    }));
  }

  /** A mounted file as this process sees it, its held writes applied (processView); undefined when it holds none for it. */
  private async viewed(name: string, follow: boolean): Promise<Uint8Array | undefined> {
    return processView(this.scope, () => this.namespace.pin(name, { follow, sync: false }));
  }

  /** Before a cut of `name` (a truncate, a whole-file write): the writes this process holds on its file, written (settleHeldAt). */
  private settleAt(name: string): Awaitable<void> {
    return settleHeldAt(this.scope, () => this.namespace.pin(name, { follow: true, sync: false }));
  }
  writeFile(path: RuntimeFsPath, bytes: string | Uint8Array, options?: { createParents?: boolean; expectedRevision?: number; umask?: number }) {
    return this.either([path], () => this.bridge.writeFile(path, bytes, options), async () => {
      // createParents makes the directories above where the write lands, in
      // the same lookup as the write (a link's target's, not the link's).
      const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
      const p = await this.path(path);
      await this.settleAt(p);
      await this.namespace.writeFile(p, data, { parents: options?.createParents === true });
      return this.clock();
    });
  }
  writeRange(path: RuntimeFsPath, offset: number, bytes: Uint8Array, options?: { createParents?: boolean; expectedRevision?: number } & RuntimeMutationOwner) {
    return this.either([path], () => this.bridge.writeRange(path, offset, bytes, options), async () => {
      await this.owned(options).writeRange(await this.path(path), offset, bytes, { parents: options?.createParents === true });
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
      await this.settleAt(p);
      await this.namespace.writeFile(p, data);
      return this.clock();
    });
  }
  truncate(path: RuntimeFsPath, size: number, options?: { followSymlinks?: boolean } & RuntimeMutationOwner) {
    return this.either([path], () => this.bridge.truncate(path, size, options), async () => {
      const p = await this.path(path);
      await this.settleAt(p);
      await this.owned(options).truncate(p, size);
      return this.receipt();
    });
  }
  utimes(path: RuntimeFsPath, atime: FsTime, mtime: FsTime, options?: { followSymlinks?: boolean }) {
    return this.either([path], () => this.bridge.utimes(path, atime, mtime, options), async () => {
      await this.namespace.utimes(await this.path(path, options?.followSymlinks !== false), atime, mtime);
      return this.receipt();
    });
  }
  chmod(path: RuntimeFsPath, mode: number) {
    return this.either([path], () => this.bridge.chmod(path, mode), async () => {
      await this.namespace.chmod((await this.path(path)), mode);
      return this.receipt();
    });
  }
  chown(path: RuntimeFsPath, uid: number | null, gid: number | null, options?: { followSymlinks?: boolean }) {
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
  mkdir(path: RuntimeFsPath, options?: { recursive?: boolean; mode?: number } & RuntimeMutationOwner) {
    return this.either([path], () => this.bridge.mkdir(path, options), async () => this.owned(options).mkdir((await this.path(path)), {
      ...(options?.recursive === undefined ? {} : { recursive: options.recursive }),
      ...(options?.mode === undefined ? {} : { mode: options.mode }),
    }));
  }
  /** The namespace presenting `options`' exclusive-mutation lease to its guard, for a mutation that carries one. */
  private owned(options?: RuntimeMutationOwner): CompositeVFS {
    return options?.mutationOwner === undefined ? this.namespace : this.namespace.scoped(() => {}, options.mutationOwner);
  }
  unlink(path: RuntimeFsPath, options?: RuntimeMutationOwner) {
    return this.either([path], () => this.bridge.unlink(path, options), async () => this.owned(options).unlink((await this.path(path, false))));
  }
  rmdir(path: RuntimeFsPath, options?: RuntimeMutationOwner) {
    return this.either([path], () => this.bridge.rmdir(path, options), async () => this.owned(options).rmdir((await this.path(path, false))));
  }
  rename(from: RuntimeFsPath, to: RuntimeFsPath, options?: RuntimeMutationOwner) {
    return this.either([from, to], () => this.bridge.rename(from, to, options), async () => this.owned(options).rename((await this.path(from, false)), (await this.path(to, false))));
  }
  realpath(path: RuntimeFsPath) {
    return this.either([path], () => this.bridge.realpath(path), async () => this.namespace.realpathAsync(await this.path(path)));
  }
  readlink(path: RuntimeFsPath) {
    return this.either([path], () => this.bridge.readlink(path), () => this.absent(async () => this.namespace.readlink((await this.path(path, false)))));
  }
  linkLeadsTo(path: string, link: string): string | null { return this.bridge.linkLeadsTo(path, link); }
  symlink(target: string, path: RuntimeFsPath) {
    return this.either([path], () => this.bridge.symlink(target, path), async () => this.namespace.symlink(target, (await this.path(path, false))));
  }
  remove(path: RuntimeFsPath, options?: { recursive?: boolean; force?: boolean; report?: boolean; keepVanishedAncestors?: boolean }) {
    return this.either([path], () => this.bridge.remove(path, options), async () => {
      const p = (await this.path(path, false));
      try {
        if (!options?.recursive) return await this.namespace.unlink(p);
        const report = await this.namespace.removeRecursive(p, { keepVanishedAncestors: options.keepVanishedAncestors });
        if (options.report) return report;
        const failed = report.failures[0];
        if (failed) throw failed.error;
      } catch (error) {
        if (!(options?.force && isVfsError(error, 'ENOENT'))) throw error;
      }
    });
  }
  copyFile(from: RuntimeFsPath, to: RuntimeFsPath, options?: { keepMode?: boolean; preserve?: boolean }) {
    return this.either<void | number>([from, to], () => this.bridge.copyFile(from, to, options), async () => this.namespace.copy((await this.path(from)), (await this.path(to)), { follow: true, keepMode: options?.keepMode, preserve: options?.preserve }));
  }
  copyTree(from: RuntimeFsPath, to: RuntimeFsPath, options?: { preserve?: boolean; follow?: boolean }) {
    return this.either([from, to], () => this.bridge.copyTree(from, to, options), async () => this.namespace.copy(await this.path(from, options?.follow === true), await this.path(to), { recursive: true, preserve: options?.preserve, follow: options?.follow }));
  }

  // ── descriptors on an asynchronous mount ─────────────────────────────
  // The scope's own descriptors (Descriptors), whose descriptions answer by
  // awaiting their mount; any other is the guarded bridge's.
  private awaits(handleId: number): boolean {
    return this.scope.handles.get(handleId)?.node.awaits === true;
  }

  open(path: RuntimeFsPath, flags: RuntimeOpenFlags, options?: RuntimeMutationOwner) {
    return this.either([path], () => this.bridge.open(path, flags, options), async () => {
      const opened = openFlags(flags);
      const flagged = flagsRefusal(opened);
      if (flagged !== null) throw syscallError(flagged, 'open', typeof path === 'string' ? path : path.path);
      const mutates = opened.write || opened.create || opened.truncate || opened.append;
      const name = await this.path(path, openFollows(opened));
      const files = this.owned(mutates ? options : undefined);
      const node = await openMounted({
        name, flags: opened, mode: flags.mode,
        refuse: (code, syscall) => syscallError(code, syscall, name), scope: this.scope,
        pin: (file, follow) => files.pin(file, { follow, sync: false }),
        sync: flags.sync === true, bufferedWriteBytes: this.bufferedWriteBytes ?? BUFFERED_WRITE_BYTES,
        ...(this.signal === undefined ? {} : { signal: this.signal }),
      });
      // Its descriptor goes in the scope only for a binding that may still act.
      try {
        this.authority();
      } catch (error) {
        abandon(node);
        throw error;
      }
      return this.descriptors.open(node, opened);
    });
  }

  reopen(target: RuntimeReopenTarget, flags: RuntimeOpenFlags, options?: RuntimeMutationOwner) {
    if (!this.awaits(target.handle)) return this.bridge.reopen(target, flags, options);
    // A file on a mount that answers by awaiting: reopened there, by the name it is held by.
    const held = this.descriptors.description(target.handle);
    if (!held.mounted) return this.bridge.reopen(target, flags, options);
    const opened = openFlags(flags);
    const name = held.path();
    const flagged = flagsRefusal(opened) ?? (opened.create && opened.exclusive ? 'EEXIST' : null);
    if (flagged !== null) throw syscallError(flagged, 'open', name);
    const files = this.owned(opened.write || opened.truncate || opened.append ? options : undefined);
    return andThen(reopenMounted(held, {
      flags: opened, mode: flags.mode, refuse: (code, syscall) => syscallError(code, syscall, name), scope: this.scope,
      pin: (file, follow) => files.pin(file, { follow, sync: false }),
      sync: flags.sync === true, bufferedWriteBytes: this.bufferedWriteBytes ?? BUFFERED_WRITE_BYTES,
      ...(this.signal === undefined ? {} : { signal: this.signal }),
    }), (node) => {
      try {
        this.authority();
      } catch (error) {
        abandon(node);
        throw error;
      }
      return this.descriptors.open(node, opened);
    });
  }

  /** The bridge's own descriptor, or this face's answer for one that awaits. */
  private on<T>(handleId: number, own: () => T, awaited: () => Awaitable<T>): T | Promise<T> {
    return this.awaits(handleId) ? awaited() : own();
  }

  read(handleId: number, offset: number | null, length: number) {
    return this.on(handleId, () => this.bridge.read(handleId, offset, length), () => this.descriptors.read(handleId, offset, length));
  }

  write(handleId: number, offset: number | null, bytes: Uint8Array) {
    return this.on(handleId, () => this.bridge.write(handleId, offset, bytes), () => this.descriptors.write(handleId, offset, bytes));
  }

  close(handleId: number) {
    // A prefetched directory's accounting ends with its description's id, however it closes.
    directoryReadHandleClosed(this.scope, handleId);
    return this.awaits(handleId) ? this.descriptors.close(handleId) : this.bridge.close(handleId);
  }

  fsync(handleId?: number) {
    return handleId !== undefined && this.awaits(handleId) ? this.descriptors.fsync(handleId) : this.bridge.fsync(handleId);
  }

  fstat(handleId: number) {
    return this.on(handleId, () => this.bridge.fstat(handleId), () => this.descriptors.fstat(handleId));
  }

  dup(handleId: number) { return this.bridge.dup(handleId); }

  seek(handleId: number, offset: number, whence: 'set' | 'current' | 'end') {
    return this.on(handleId, () => this.bridge.seek(handleId, offset, whence), () => this.descriptors.seek(handleId, offset, whence));
  }

  setStatus(handleId: number, status: { append?: boolean }) { return this.bridge.setStatus(handleId, status); }

  readdirHandle(handleId: number) {
    return this.on(handleId, () => this.bridge.readdirHandle(handleId), () => this.descriptors.readdir(handleId));
  }

  ftruncate(handleId: number, size: number) {
    return this.on(handleId, () => this.bridge.ftruncate(handleId, size), () => this.descriptors.ftruncate(handleId, size));
  }

  fchmod(handleId: number, mode: number) {
    return this.on(handleId, () => this.bridge.fchmod(handleId, mode), () => this.descriptors.fchmod(handleId, mode));
  }

  fchown(handleId: number, uid: number | null, gid: number | null) {
    return this.on(handleId, () => this.bridge.fchown(handleId, uid, gid), () => this.descriptors.fchown(handleId, uid, gid));
  }

  futimes(handleId: number, atime: FsTime, mtime: FsTime) {
    return this.on(handleId, () => this.bridge.futimes(handleId, atime, mtime), () => this.descriptors.futimes(handleId, atime, mtime));
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
export const F_OK = 0;
export const X_OK = 1;
export const W_OK = 2;
export const R_OK = 4;

/**
 * A process's namespace as a `VFS` over its bound bridge, plus the process
 * syscalls a `VFS` has no word for (access, realpath, append). Absent is
 * null from `stat`; every failure is a `VfsError`.
 */
/** A bridge's calls as a view that can wait makes them (ProcessView): each a promise, made again after a recall. */
type RecallingBridge = {
  [K in keyof RuntimeFsBridge]: NonNullable<RuntimeFsBridge[K]> extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;
};

/**
 * `bridge`, each call made again once a delegation it meets is recalled
 * (withRecall): one bridge call is one engine operation, refused before it
 * changes anything, so making it again is safe. A write from a source is
 * not made again (its source may be spent): the engine waits for a recall
 * itself before it reads the source.
 */
function recalling(bridge: RuntimeFsBridge): RecallingBridge {
  return new Proxy(bridge, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== 'function') return value;
      if (key === 'writeFileFrom') return (...args: unknown[]) => Promise.resolve(Reflect.apply(value, target, args));
      return (...args: unknown[]) => withRecall(() => Reflect.apply(value, target, args) as unknown);
    },
  }) as unknown as RecallingBridge;
}

export class ProcessView implements VFS {
  /** The bridge as this view calls it: each call made again once a delegation it meets is recalled. */
  private readonly fs: RecallingBridge;

  constructor(
    /** The bridge itself: what a runtime hands a guest as its syscall surface. */
    readonly process: RuntimeFsBridge,
  ) {
    this.fs = recalling(process);
  }

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
    const stat = await this.call(options?.follow === false ? 'lstat' : 'stat', path, () => this.fs.stat(path, { followSymlinks: options?.follow !== false }));
    return stat === null ? null : vfsStatOf(stat);
  }
  /** Probes need only the bridge's type, not another converted stat object. */
  private async probe(path: string, follow: boolean): Promise<RuntimeVfsStat | null> {
    try {
      return await this.fs.stat(path, { followSymlinks: follow });
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
  /** `maxBytes`: only a regular file of at most that many bytes, read whole; a larger one or a device is EFBIG, unread (RuntimeReadFileOptions). */
  async readFile(path: string, options?: { maxBytes?: number }): Promise<Uint8Array> {
    const bytes = await this.call('open', path, () => this.fs.readFile(path, options));
    if (bytes === null) throw syscallError('ENOENT', 'open', path);
    return bytes;
  }
  /**
   * Text is written as UTF-8, as a process's write(2) of a string would.
   * `mode` applies only if this creates the file, and at creation
   * (open(O_CREAT|O_TRUNC, mode), then the bytes): an existing file keeps its
   * mode, and a new one is never visible at another mode.
   */
  async writeFile(path: string, data: Uint8Array | string, options?: { mode?: number; exclusive?: boolean }): Promise<void> {
    if (options?.mode === undefined && options?.exclusive !== true) {
      await this.call('open', path, () => this.fs.writeFile(path, data));
      return;
    }
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    await this.call('open', path, async () => {
      const handle = await this.fs.open(path, { write: true, create: true, truncate: true, mode: options?.mode, exclusive: options?.exclusive });
      try {
        let offset = 0;
        while (offset < bytes.length) {
          const written = await this.fs.write(handle.id, offset, bytes.subarray(offset));
          if (written <= 0) throw syscallError('EIO', 'write', path, { detail: 'short write' });
          offset += written;
        }
      } finally {
        await this.fs.close(handle.id);
      }
    });
  }
  async readdir(path: string): Promise<VfsDirent[]> {
    const entries = await this.call('scandir', path, () => this.fs.readdir(path));
    return entries.map((entry) => ({ name: entry.name, type: entry.type }));
  }
  async mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void> {
    await this.call('mkdir', path, () => this.fs.mkdir(path, options));
  }
  async unlink(path: string): Promise<void> { await this.call('unlink', path, () => this.fs.unlink(path)); }
  async rmdir(path: string): Promise<void> { await this.call('rmdir', path, () => this.fs.rmdir(path)); }
  async rename(from: string, to: string): Promise<void> { await this.call('rename', from, () => this.fs.rename(from, to), to); }
  async readRange(path: string, offset: number, length: number): Promise<Uint8Array> {
    const bytes = await this.call('open', path, () => this.fs.readRange(path, offset, length));
    if (bytes === null) throw syscallError('ENOENT', 'open', path);
    return bytes;
  }
  /** A ranged read that neither consults nor fills the session's content cache. */
  async readRangeUncached(path: string, offset: number, length: number): Promise<Uint8Array> {
    const bytes = await this.call('open', path, () => this.fs.readRange(path, offset, length, { cached: false }));
    if (bytes === null) throw syscallError('ENOENT', 'open', path);
    return bytes;
  }
  async writeRange(path: string, offset: number, bytes: Uint8Array): Promise<void> {
    await this.call('open', path, () => this.fs.writeRange(path, offset, bytes));
  }
  /** writeFile of `size` bytes that arrive over time, published whole once they have (RuntimeFsBridge.writeFileFrom). */
  async writeFileFrom(path: string, size: number, source: AsyncIterable<Uint8Array>): Promise<void> {
    await this.call('open', path, () => this.fs.writeFileFrom(path, size, source));
  }
  async truncate(path: string, size: number): Promise<void> { await this.call('open', path, () => this.fs.truncate(path, size)); }
  /** rm -r's complete namespace report, including partial removal and vanished children. */
  async removeRecursive(path: string, options?: { keepVanishedAncestors?: boolean }): Promise<VfsRemoval> {
    const report = await this.call('rm', path, () => this.fs.remove(path, { recursive: true, report: true, keepVanishedAncestors: options?.keepVanishedAncestors }));
    if (report === undefined) throw syscallError('ENOTSUP', 'rm', path, { detail: 'the filesystem bridge does not return recursive removal facts' });
    return report;
  }
  async symlink(target: string, path: string): Promise<void> { await this.call('symlink', target, () => this.fs.symlink(target, path), path); }
  async readlink(path: string): Promise<string> {
    const target = await this.call('readlink', path, () => this.fs.readlink(path));
    if (target === null) throw syscallError('EINVAL', 'readlink', path);
    return target;
  }
  /** Where the link at `path`, reading `link`, leads in this namespace (RuntimeFsBridge.linkLeadsTo), for a caller following it itself. */
  async linkLeadsTo(path: string, link: string): Promise<string | null> { return await this.fs.linkLeadsTo(path, link); }
  async chmod(path: string, mode: number): Promise<void> { await this.call('chmod', path, () => this.fs.chmod(path, mode)); }
  /** chown(2): a null side keeps what the file has (chown -1), in the same change. `follow: false` is lchown(2), a link's own. */
  async chown(path: string, uid: number | null, gid: number | null, options?: { follow?: boolean }): Promise<void> {
    const followSymlinks = options?.follow !== false;
    await this.call(followSymlinks ? 'chown' : 'lchown', path, async () => {
      await this.fs.chown(path, uid, gid, { followSymlinks });
    });
  }
  /** utimensat(2), each time an FsTime; `follow: false` sets a link's own times. */
  async utimes(path: string, atime: FsTime, mtime: FsTime, options?: { follow?: boolean }): Promise<void> {
    await this.call(options?.follow === false ? 'lutime' : 'utime', path, () => this.fs.utimes(path, atime, mtime, { followSymlinks: options?.follow !== false }));
  }
  /** cp: a file (a link named as the source followed), or with `recursive` a tree, onto a name that is not there. */
  async copy(from: string, to: string, options?: VfsCopyOptions): Promise<number> {
    return await this.call(options?.recursive ? 'cp' : 'copyfile', from, async () => {
      if (options?.recursive) return await this.fs.copyTree(from, to, { preserve: options.preserve, follow: options.follow });
      await this.fs.copyFile(from, to, { keepMode: options?.keepMode, preserve: options?.preserve });
      return 1;
    }, to);
  }
  /** Create the file if absent, and set its times to now (touch). */
  async touch(path: string): Promise<void> {
    await this.call('open', path, async () => {
      const handle = await this.fs.open(path, { write: true, create: true });
      await this.fs.close(handle.id);
      // UTIME_NOW: write permission is enough, as for touch(1).
      await this.fs.utimes(path, 'now', 'now');
    });
  }
  /**
   * The file's bytes read around the session's content cache, re-checked for
   * a change mid-read: one whole-file read, so one coherent copy on every
   * backend, held once, and the caller's own: the read's buffer, never copied
   * again here. `maxBytes` as readFile's.
   */
  async readFileUncached(path: string, options?: { maxBytes?: number; contentKey?: string }): Promise<Uint8Array> {
    const bytes = await this.call('open', path, () => this.fs.readFile(path, { cached: false, maxBytes: options?.maxBytes, contentKey: options?.contentKey }));
    if (bytes === null) throw syscallError('ENOENT', 'open', path);
    return bytes;
  }
  /** The file's content key (RuntimeFsBridge.contentKey): equal keys, equal bytes; ENOTSUP where the filesystem keeps none. */
  async contentKey(path: string): Promise<string> {
    const { fs } = this;
    const contentKey = fs.contentKey;
    if (contentKey === undefined) throw syscallError('ENOTSUP', 'open', path);
    return await this.call('open', path, () => contentKey(path));
  }
  /** `path` as a wasm image a facet loads, read through this view when the host builds the facet (openFacetImage). */
  async image(path: string): Promise<FacetImage> {
    return await openFacetImage((use) => use(this), path);
  }
  /**
   * rm: a file, or with `recursive` a tree, whole or not at all; `force`
   * makes a missing path no error.
   */
  async remove(path: string, options: { recursive?: boolean; force?: boolean } = {}): Promise<void> {
    await this.call('rm', path, () => this.fs.remove(path, options));
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
  /**
   * Every entry strictly under directory `path` with its lstat, in path
   * order (which is a git index's order): one paged scan of the filesystem
   * (`list`, which recalls each delegation an lstat of an entry would)
   * instead of a listing per directory and a stat per entry. A directory a
   * walk by name would answer differently is marked `byName`, for the
   * caller to ask by name: one on a mount whose names the scan does not
   * list (`unlisted`), or one the caller may not read and search
   * (`unreadable`), whose readdir is refused. A subtree changed between the
   * first page and the last is refused EAGAIN, its pages not one tree: by
   * its revision, or where it keeps none (a mount under it: 0), by every
   * page's being of the filesystem's same revision. Between pages the thread is given up for a turn: a page of SCAN_PAGE
   * entries is one bounded slice of the session's thread.
   */
  async *scan(path: string): AsyncGenerator<ScannedEntry> {
    const key = normalizeVfsPath(path);
    const prefix = key === '' ? '' : `${key}/`;
    const revision = await this.call('scandir', path, () => this.fs.revision(path));
    let at: FeedPosition | null = null;
    let after: string | null = key === '' ? null : prefix;
    pages: for (;;) {
      const page = await this.call('scandir', path, () => this.fs.list(after, SCAN_PAGE, { revisions: false, contentKeys: false, linkTargets: false }));
      if (at === null) at = page.position;
      else if (revision === 0 && !samePosition(page.position, at)) throw syscallError('EAGAIN', 'scandir', path);
      for (const entry of page.entries) {
        const at = normalizeVfsPath(entry.path);
        if (at === key || beforeSubtree(at, key)) continue;
        if (!at.startsWith(prefix)) break pages;
        yield { path: at.slice(prefix.length), stat: vfsStatOf(entry.stat), byName: entry.unlisted !== undefined || entry.unreadable === true };
      }
      if (page.next === null) break;
      after = page.next;
      await new Promise((resolve) => engineSetTimeout(resolve, 0));
    }
    if (revision !== 0 && await this.call('scandir', path, () => this.fs.revision(path)) !== revision) throw syscallError('EAGAIN', 'scandir', path);
  }
  /** access(2): `mode` is F_OK or any of R_OK, W_OK, X_OK. */
  async access(path: string, mode: number): Promise<void> { await this.call('access', path, () => this.fs.access(path, mode)); }
  async realpath(path: string): Promise<string> { return await this.call('realpath', path, () => this.fs.realpath(path)); }
  /**
   * An open file description of this process on `path` (open(2)): its reads
   * and writes are the file the open found, whatever the name names after,
   * at its own position, until it is closed.
   */
  async open(path: string, flags: RuntimeOpenFlags): Promise<ProcessFile> {
    const opened = await this.call('open', path, () => this.fs.open(path, flags));
    return new ProcessFile(this.fs, path, opened.id, vfsStatOf(opened.stat), flags.write === true || flags.append === true);
  }

  /** Append through an O_APPEND descriptor, so concurrent appenders never overwrite each other. */
  async appendFile(path: string, content: Uint8Array | string): Promise<void> {
    const data = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    await this.call('open', path, async () => {
      const handle = await this.fs.open(path, { write: true, append: true, create: true });
      try {
        let offset = 0;
        while (offset < data.length) {
          const written = await this.fs.write(handle.id, null, data.subarray(offset));
          if (written <= 0 || written > data.length - offset) throw syscallError('EIO', 'write', path, { detail: 'short append' });
          offset += written;
        }
      } finally {
        await this.fs.close(handle.id);
      }
    });
  }
}

/** A process's open file description (ProcessView.open), by its descriptor; every failure is a `VfsError`. */
export class ProcessFile {
  #closed = false;

  constructor(
    private readonly fs: RecallingBridge,
    readonly path: string,
    private readonly handle: number,
    /** Its file as the open found it. */
    readonly stat: ProcessStat,
    /** Opened to write: what it wrote is synced before it closes (withOpenFiles). */
    readonly writes: boolean,
  ) {}

  /** Up to `length` bytes at `offset`, or (null) at its position, which then moves: none only at the end (readToEnd). */
  async read(length: number, offset: number | null = null): Promise<Uint8Array> {
    try { return await this.fs.read(this.handle, offset, length); }
    catch (error) { throw toVfsError(error, 'read', this.path); }
  }

  /** All of `bytes`, at `offset` or (null) at its position (its end, opened to append), which then moves. */
  async write(bytes: Uint8Array, offset: number | null = null): Promise<void> {
    try {
      for (let done = 0; done < bytes.length;) {
        const written = await this.fs.write(this.handle, offset === null ? null : offset + done, bytes.subarray(done));
        if (written <= 0 || written > bytes.length - done) throw syscallError('EIO', 'write', this.path, { detail: 'short write' });
        done += written;
      }
    } catch (error) { throw toVfsError(error, 'write', this.path); }
  }

  /** ftruncate(2): the file this description holds, whatever its name names now. */
  async truncate(size: number): Promise<void> {
    try { await this.fs.ftruncate(this.handle, size); }
    catch (error) { throw toVfsError(error, 'ftruncate', this.path); }
  }

  /** What the filesystem still holds for its file, written (fsync): a write it could not make fails here. */
  async sync(): Promise<void> {
    try { await this.fs.fsync(this.handle); }
    catch (error) { throw toVfsError(error, 'fsync', this.path); }
  }

  /** Whether it is closed: nothing is read, written or synced through it after. */
  get closed(): boolean { return this.#closed; }

  /** Closed once, whoever closes it first: a later close does nothing. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try { await this.fs.close(this.handle); }
    catch (error) { throw toVfsError(error, 'close', this.path); }
  }
}

/**
 * `file`'s bytes from `from`, `size` at a time, to a read that answers none
 * (its end: a read may answer fewer bytes than it asks and the file go on),
 * or until `limit` bytes.
 */
export async function* readToEnd(file: ProcessFile, size: number, { from = 0, limit = Number.POSITIVE_INFINITY }: { from?: number; limit?: number } = {}): AsyncGenerator<Uint8Array> {
  for (let done = 0; done < limit;) {
    const chunk = await file.read(Math.min(size, limit - done), from + done);
    if (chunk.length === 0) return;
    yield chunk;
    done += chunk.length;
  }
}

/** How withOpenFiles' `use` opens a description it holds. */
export type OpenFile = (path: string, flags: RuntimeOpenFlags) => Promise<ProcessFile>;

/**
 * `use`, with every description it opens through `open` closed when it ends,
 * however it ends: one opened to write synced first, then closed whether the
 * sync succeeded or not; one `use` closed itself is left as it is. What a
 * sync or a close fails with is told to `failed`, and the rest are closed all
 * the same, also when `failed` throws.
 */
export async function withOpenFiles<T>(
  view: ProcessView,
  use: (open: OpenFile) => Promise<T>,
  failed: (file: ProcessFile, error: unknown) => Promise<void>,
): Promise<T> {
  const opened: ProcessFile[] = [];
  try {
    return await use(async (path, flags) => {
      const file = await view.open(path, flags);
      opened.push(file);
      return file;
    });
  } finally {
    for (const file of opened) {
      if (file.closed) continue;
      try {
        try {
          if (file.writes) await file.sync();
        } finally {
          await file.close();
        }
      } catch (error) {
        try {
          await failed(file, error);
        } catch {
          // A report that cannot be made, at once or later, leaves no other description open.
        }
      }
    }
  }
}

/**
 * `path` as a wasm image a facet loads ({@link FacetImage}), each access made
 * through a view `through` hands for its duration: its content key and size
 * now, and its bytes only when the host builds the facet. The key is the
 * store's own record of the bytes (RuntimeFsBridge.contentKey), so the
 * image's identity, the key with the size, names the same bytes in every
 * session and store, and nothing is hashed. A read takes only the bytes the
 * key names, bounded at the size opened, both checked in the read's own turn,
 * and of exactly that size: whatever happened to the file, a facet loads
 * those bytes or none (ESTALE, EFBIG). A mount keeps no content keys, so an
 * image there is refused (ENOTSUP).
 */
async function openFacetImage(through: <T>(use: (view: ProcessView) => Promise<T>) => Promise<T>, path: string): Promise<FacetImage> {
  const { key, size } = await through(async (view) => {
    const opened = await view.stat(path);
    if (opened === null) throw syscallError('ENOENT', 'open', path);
    if (opened.type !== 'file') throw syscallError('EISDIR', 'open', path);
    return { key: await view.contentKey(path), size: opened.size };
  });
  return {
    path,
    // A key and its length: a small file's key hashes its bytes and a large one's its chunk list, so only the two together name one set of bytes.
    identity: `content:${key}:${size}`,
    size,
    peak: size,
    read: () => through(async (view) => {
      const bytes = await view.readFileUncached(path, { contentKey: key, maxBytes: size });
      if (bytes.byteLength !== size) throw syscallError('ESTALE', 'open', path);
      return bytes;
    }),
  };
}

/**
 * `path` as a wasm image a facet loads, read as `cred` through a host view
 * of its own at every load: for a facet that outlives the view it was opened
 * from (a shell's bash, a git that leaves its facet warm, a REPL).
 */
export async function hostImage(authority: NimbusFilesystemAuthority, cred: Readonly<VfsCred>, path: string): Promise<FacetImage> {
  return await openFacetImage((use) => withHostView(authority, cred, use), path);
}

/** An entry of ProcessView.scan: its path under the scanned directory, its lstat, and whether its entries must be asked by name. */
export interface ScannedEntry {
  path: string;
  stat: ProcessStat;
  byName: boolean;
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
  chown(path: string, uid: number | null, gid: number | null): void { this.fs.chown(path, uid, gid); }
  utimes(path: string, atime: FsTime, mtime: FsTime, options?: { followSymlinks?: boolean }): void {
    this.fs.utimes(path, atime, mtime, options);
  }
  copyFile(from: string, to: string): void { this.fs.copyFile(from, to); }
  acquireExclusiveMutation(path: string, options?: { includeMissingAncestors?: boolean }): { root: string; owner: string } {
    return this.fs.acquireExclusiveMutation(path, options);
  }
  releaseExclusiveMutation(owner: string): void { this.fs.releaseExclusiveMutation(owner); }
}
