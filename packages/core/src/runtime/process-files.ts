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

import type { SqliteVFS, WriteBatchStreamResult } from '../vfs/sqlite-vfs.js';
import type { VfsEvent } from '../vfs/events.js';
import type { BatchWritePayload } from '@nimbus-sh/platform/w7-frame.js';
import { CompositeVFS } from '../vfs/composite.js';
import { DevVFS } from '../vfs/dev-vfs.js';
import { ProcVFS, standardProc } from '../vfs/proc-vfs.js';
import { sqliteFiles } from '../vfs/sqlite-files.js';
import { toVfsError, VfsError } from '../vfs/vfs-error.js';
import { exists, isDirectory, isFile, isSymlink, readText } from '../vfs/vfs.js';
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
  type VfsListPage,
  type VfsMutationReceipt,
} from './os-contracts.js';
import {
  createSqliteDescriptorScope,
  SqliteRuntimeFsBridge,
  type SqliteDescriptorScope,
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
  ) {}

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
  readFile(path: RuntimeFsPath, options?: { followSymlinks?: boolean }): Uint8Array | null { this.guard(); return this.target.readFile(path, options); }
  writeFile(path: RuntimeFsPath, bytes: string | Uint8Array, options?: { createParents?: boolean; expectedRevision?: number }): number {
    this.guard(); return this.target.writeFile(path, bytes, options);
  }
  readRange(path: RuntimeFsPath, offset: number, length: number, options?: RuntimeReadOptions): Uint8Array | null {
    this.guard(); return this.target.readRange(path, offset, length, options);
  }
  writeRange(path: RuntimeFsPath, offset: number, bytes: Uint8Array, options?: { createParents?: boolean; expectedRevision?: number }): VfsMutationReceipt {
    this.guard(); return this.target.writeRange(path, offset, bytes, options);
  }
  truncate(path: RuntimeFsPath, size: number, options?: { followSymlinks?: boolean }): VfsMutationReceipt { this.guard(); return this.target.truncate(path, size, options); }
  utimes(path: RuntimeFsPath, atimeMs: number, mtimeMs: number, options?: { followSymlinks?: boolean }): VfsMutationReceipt {
    this.guard(); return this.target.utimes(path, atimeMs, mtimeMs, options);
  }
  chmod(path: RuntimeFsPath, mode: number): VfsMutationReceipt { this.guard(); return this.target.chmod(path, mode); }
  access(path: RuntimeFsPath, mode: number): void { this.guard(); return this.target.access(path, mode); }
  chown(path: RuntimeFsPath, uid: number, gid: number, options?: { followSymlinks?: boolean }): VfsMutationReceipt {
    this.guard(); return this.target.chown(path, uid, gid, options);
  }
  open(path: RuntimeFsPath, flags: RuntimeOpenFlags): RuntimeFileHandle { this.guard(); return this.target.open(path, flags); }
  read(handleId: number, offset: number | null, length: number): Uint8Array { this.guard(); return this.target.read(handleId, offset, length); }
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
  private readonly retired = new Set<number>();
  /** Inode numbers for mounted entries whose backend keeps none: stable per path for the session. */
  private readonly mountedInos = new Map<string, number>();
  private readonly mountedIno = (path: string): number => {
    let ino = this.mountedInos.get(path);
    if (ino === undefined) this.mountedInos.set(path, ino = this.mountedInos.size + 1);
    return ino;
  };

  constructor(readonly engine: SqliteVFS) {
    this.namespace = engine.namespace;
    this.vfs = new CompositeVFS(sqliteFiles(engine, CRED_KERNEL));
    this.proc = standardProc();
    this.proc.register('mounts', (cred) => formatProcMounts(this.mounts(cred ?? CRED_KERNEL)));
    this.vfs.mount('/proc', this.proc);
    this.vfs.mount('/dev', new DevVFS());
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
    const scope = this.processes.get(pid);
    if (scope) this.closeScope(scope);
    this.processes.delete(pid);
    this.engine.revokeAppendWriters(pid);
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
    for (const dispose of scope.subscriptions) dispose();
    scope.subscriptions.clear();
    scope.closed = true;
    scope.abort.abort();
  }

  private bridgeFor(scope: SqliteDescriptorScope, cred: VfsCred, signal?: AbortSignal, pid?: number): RuntimeFsBridge {
    const target = new SqliteRuntimeFsBridge(this.engine.as(cred), this.engine, scope, this.vfs.as(cred), this.mountedIno);
    return new GuardedProcessBridge(target, scope, signal, pid);
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

  private async call<T>(path: string, run: () => T | Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw toVfsError(error, path);
    }
  }

  async stat(path: string, options?: { follow?: boolean }): Promise<ProcessStat | null> {
    const stat = await this.call(path, () => this.process.stat(path, { followSymlinks: options?.follow !== false }));
    return stat === null ? null : vfsStatOf(stat);
  }
  /** Whether anything is at `path` (links followed): access(F_OK). */
  async exists(path: string): Promise<boolean> { return await exists(this, path); }
  async isFile(path: string): Promise<boolean> { return await isFile(this, path); }
  async isDirectory(path: string): Promise<boolean> { return await isDirectory(this, path); }
  /** Whether `path` itself is a symbolic link. */
  async isSymlink(path: string): Promise<boolean> { return await isSymlink(this, path); }
  /** The file's bytes as UTF-8 text. */
  async readFileString(path: string): Promise<string> { return await readText(this, path); }
  async readFile(path: string): Promise<Uint8Array> {
    const bytes = await this.call(path, () => this.process.readFile(path));
    if (bytes === null) throw new VfsError('ENOENT', path);
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
      await this.call(path, () => this.process.writeFile(path, data));
      return;
    }
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    await this.call(path, async () => {
      const handle = await this.process.open(path, { write: true, create: true, truncate: true, mode: options.mode });
      try {
        let offset = 0;
        while (offset < bytes.length) {
          const written = await this.process.write(handle.id, offset, bytes.subarray(offset));
          if (written <= 0) throw new VfsError('EIO', 'short write', path);
          offset += written;
        }
      } finally {
        await this.process.close(handle.id);
      }
    });
  }
  async readdir(path: string): Promise<VfsDirent[]> {
    const entries = await this.call(path, () => this.process.readdir(path));
    return entries.map((entry) => ({ name: entry.name, type: entry.type }));
  }
  async mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void> {
    await this.call(path, () => this.process.mkdir(path, options));
  }
  async unlink(path: string): Promise<void> { await this.call(path, () => this.process.unlink(path)); }
  async rmdir(path: string): Promise<void> { await this.call(path, () => this.process.rmdir(path)); }
  async rename(from: string, to: string): Promise<void> { await this.call(from, () => this.process.rename(from, to)); }
  async readRange(path: string, offset: number, length: number): Promise<Uint8Array> {
    const bytes = await this.call(path, () => this.process.readRange(path, offset, length));
    if (bytes === null) throw new VfsError('ENOENT', path);
    return bytes;
  }
  /** A ranged read that neither consults nor fills the session's content cache. */
  async readRangeUncached(path: string, offset: number, length: number): Promise<Uint8Array> {
    const bytes = await this.call(path, () => this.process.readRange(path, offset, length, { cached: false }));
    if (bytes === null) throw new VfsError('ENOENT', path);
    return bytes;
  }
  async writeRange(path: string, offset: number, bytes: Uint8Array): Promise<void> {
    await this.call(path, () => this.process.writeRange(path, offset, bytes));
  }
  async truncate(path: string, size: number): Promise<void> { await this.call(path, () => this.process.truncate(path, size)); }
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
      const converted = toVfsError(error, path);
      if (!(converted instanceof VfsError) || converted.code === 'ENOENT') throw converted;
      const failure: VfsRemovalFailure = { path, error: converted };
      return { removed: [], kept: [path], failures: [failure] };
    }
  }
  async symlink(target: string, path: string): Promise<void> { await this.call(path, () => this.process.symlink(target, path)); }
  async readlink(path: string): Promise<string> {
    const target = await this.call(path, () => this.process.readlink(path));
    if (target === null) throw new VfsError('EINVAL', 'not a symbolic link', path);
    return target;
  }
  async chmod(path: string, mode: number): Promise<void> { await this.call(path, () => this.process.chmod(path, mode)); }
  /** chown(2): a null side keeps what the file has (chown -1). */
  async chown(path: string, uid: number | null, gid: number | null): Promise<void> {
    await this.call(path, async () => {
      if (uid === null || gid === null) {
        const stat = await this.process.stat(path);
        if (stat === null) throw new VfsError('ENOENT', path);
        uid ??= stat.uid;
        gid ??= stat.gid;
      }
      await this.process.chown(path, uid, gid);
    });
  }
  async utimes(path: string, atimeMs: number, mtimeMs: number): Promise<void> {
    await this.call(path, () => this.process.utimes(path, atimeMs, mtimeMs));
  }
  /** cp: a file, or with `recursive` a tree, onto a name that is not there. */
  async copy(from: string, to: string, options?: { recursive?: boolean; preserve?: boolean }): Promise<number> {
    return await this.call(from, async () => {
      if (options?.recursive) return await this.process.copyTree(from, to, { preserve: options.preserve });
      await this.process.copyFile(from, to);
      return 1;
    });
  }
  /** Create the file if absent, and set its times to now (touch). */
  async touch(path: string): Promise<void> {
    await this.call(path, async () => {
      const handle = await this.process.open(path, { write: true, create: true });
      await this.process.close(handle.id);
      const now = Date.now();
      await this.process.utimes(path, now, now);
    });
  }
  /** The file's bytes read around the session's content cache, re-checked for a change mid-read. */
  async readFileUncached(path: string): Promise<Uint8Array> {
    return new Uint8Array(await this.readArrayBufferUncached(path));
  }
  /** {@link readFileUncached} as the ArrayBuffer a wasm module map takes, so a runtime image is held once. */
  async readArrayBufferUncached(path: string): Promise<ArrayBuffer> {
    const stat = await this.stat(path);
    if (stat === null) throw new VfsError('ENOENT', path);
    const buffer = new ArrayBuffer(stat.size);
    const result = new Uint8Array(buffer);
    for (let offset = 0; offset < result.length;) {
      const bytes = await this.readRangeUncached(path, offset, Math.min(65536, result.length - offset));
      if (bytes.length === 0) throw new VfsError('ESTALE', 'changed during the read', path);
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
    await this.call(path, () => this.process.remove(path, options));
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
  async access(path: string, mode: number): Promise<void> { await this.call(path, () => this.process.access(path, mode)); }
  async realpath(path: string): Promise<string> { return await this.call(path, () => this.process.realpath(path)); }
  /** Append through an O_APPEND descriptor, so concurrent appenders never overwrite each other. */
  async appendFile(path: string, content: Uint8Array | string): Promise<void> {
    const data = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    await this.call(path, async () => {
      const handle = await this.process.open(path, { write: true, append: true, create: true });
      try {
        let offset = 0;
        while (offset < data.length) {
          const written = await this.process.write(handle.id, null, data.subarray(offset));
          if (written <= 0 || written > data.length - offset) throw new VfsError('EIO', 'short append', path);
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
