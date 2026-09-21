import type { SqliteVFS, WriteBatchStreamResult } from '../vfs/sqlite-vfs.js';
import type { VFS } from '../substrate/lifo/kernel/vfs/index.js';
import type { VfsEvent } from '../vfs/events.js';
import type { BatchWritePayload } from '@nimbus-sh/platform/w7-frame.js';
import {
  requireVfsCred,
  type NimbusFilesystemAuthority,
  type NimbusFilesystemBinding,
  type NimbusHostFilesystemLease,
  type RuntimeFileHandle,
  type RuntimeFsBridge,
  type RuntimeFsPath,
  type RuntimeOpenFlags,
  type RuntimeReadOptions,
  type RuntimeSynchronousFs,
  type RuntimeVfsDirEntry,
  type RuntimeVfsStat,
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
  const valid = requireVfsCred(cred, 'filesystem binding');
  return Object.freeze({ ...valid, groups: Object.freeze([...valid.groups]) });
}

/**
 * Abort a stream commit when ANY of the given signals fires. AbortSignal.any
 * is not in every runtime this code ships to, so the combination is a small
 * linked controller instead.
 */
function linkedSignal(signals: readonly (AbortSignal | undefined)[]): { signal: AbortSignal; dispose(): void } {
  const live = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  const controller = new AbortController();
  const fire = (): void => controller.abort(live.find(signal => signal.aborted)?.reason);
  for (const signal of live) {
    if (signal.aborted) { fire(); break; }
    signal.addEventListener('abort', fire, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => { for (const signal of live) signal.removeEventListener('abort', fire); },
  };
}

/**
 * The authority's per-binding view: same namespace, credentials and
 * descriptor scope as the wrapped bridge, with three checks at the door.
 * Abort first (the caller revoked), then a closed scope (EBADF, the POSIX
 * answer for an operation on a released descriptor table), then the
 * append-process identity check (a bound process may only speak for its own
 * pid). Explicit delegation, not a Proxy: the bridge contract is fixed and
 * the checks read where they run.
 */
class SqliteGuardedFsBridge implements RuntimeFsBridge {
  constructor(
    private readonly target: SqliteRuntimeFsBridge,
    private readonly scope: SqliteDescriptorScope,
    private readonly signal: AbortSignal | undefined,
    private readonly pid: number | undefined,
  ) {}

  get synchronous(): RuntimeSynchronousFs { return this; }

  private guard(): void {
    this.signal?.throwIfAborted();
    if (this.scope.closed) {
      throw Object.assign(new Error('EBADF: filesystem scope closed'), { code: 'EBADF' });
    }
  }

  stat(path: RuntimeFsPath, options?: { followSymlinks?: boolean }): RuntimeVfsStat | null {
    this.guard();
    return this.target.stat(path, options);
  }
  readFile(path: RuntimeFsPath, options?: { followSymlinks?: boolean }): Uint8Array | null {
    this.guard();
    return this.target.readFile(path, options);
  }
  writeFile(path: RuntimeFsPath, bytes: string | Uint8Array, options?: {
    createParents?: boolean;
    expectedRevision?: number;
  }): number {
    this.guard();
    return this.target.writeFile(path, bytes, options);
  }
  readRange(path: RuntimeFsPath, offset: number, length: number, options?: RuntimeReadOptions): Uint8Array | null {
    this.guard();
    return this.target.readRange(path, offset, length, options);
  }
  writeRange(path: RuntimeFsPath, offset: number, bytes: Uint8Array, options?: {
    createParents?: boolean;
    expectedRevision?: number;
  }): VfsMutationReceipt {
    this.guard();
    return this.target.writeRange(path, offset, bytes, options);
  }
  truncate(path: RuntimeFsPath, size: number, options?: { followSymlinks?: boolean }): VfsMutationReceipt {
    this.guard();
    return this.target.truncate(path, size, options);
  }
  utimes(path: RuntimeFsPath, atimeMs: number, mtimeMs: number, options?: { followSymlinks?: boolean }): VfsMutationReceipt {
    this.guard();
    return this.target.utimes(path, atimeMs, mtimeMs, options);
  }
  chmod(path: RuntimeFsPath, mode: number): VfsMutationReceipt {
    this.guard();
    return this.target.chmod(path, mode);
  }
  access(path: RuntimeFsPath, mode: number): void {
    this.guard();
    return this.target.access(path, mode);
  }
  chown(path: RuntimeFsPath, uid: number, gid: number, options?: { followSymlinks?: boolean }): VfsMutationReceipt {
    this.guard();
    return this.target.chown(path, uid, gid, options);
  }
  open(path: RuntimeFsPath, flags: RuntimeOpenFlags): RuntimeFileHandle {
    this.guard();
    return this.target.open(path, flags);
  }
  read(handleId: number, offset: number | null, length: number): Uint8Array {
    this.guard();
    return this.target.read(handleId, offset, length);
  }
  write(handleId: number, offset: number | null, bytes: Uint8Array): number {
    this.guard();
    return this.target.write(handleId, offset, bytes);
  }
  close(handleId: number): void {
    return this.target.close(handleId);
  }
  readdir(path: RuntimeFsPath, options?: { followSymlinks?: boolean }): RuntimeVfsDirEntry[] {
    this.guard();
    return this.target.readdir(path, options);
  }
  mkdir(path: RuntimeFsPath, options?: { recursive?: boolean; mode?: number }): void {
    this.guard();
    return this.target.mkdir(path, options);
  }
  unlink(path: RuntimeFsPath): void {
    this.guard();
    return this.target.unlink(path);
  }
  rmdir(path: RuntimeFsPath): void {
    this.guard();
    return this.target.rmdir(path);
  }
  rename(from: RuntimeFsPath, to: RuntimeFsPath): void {
    this.guard();
    return this.target.rename(from, to);
  }
  readlink(path: RuntimeFsPath): string | null {
    this.guard();
    return this.target.readlink(path);
  }
  symlink(target: string, path: RuntimeFsPath): void {
    this.guard();
    return this.target.symlink(target, path);
  }
  fsync(handleId?: number): void {
    this.guard();
    return this.target.fsync(handleId);
  }
  revision(path?: RuntimeFsPath): number {
    this.guard();
    return this.target.revision(path);
  }
  acquire(epoch: string | null, cursor: number): VfsAcquireResult {
    this.guard();
    return this.target.acquire(epoch, cursor);
  }
  list(after?: string | null, limit?: number): VfsListPage {
    this.guard();
    return this.target.list(after, limit);
  }
  subscribe(path: string, listener: (event: VfsEvent) => void): () => void {
    this.guard();
    const unsubscribe = this.target.subscribe(path, listener);
    const dispose = () => { unsubscribe(); this.scope.subscriptions.delete(dispose); };
    this.scope.subscriptions.add(dispose);
    return dispose;
  }
  realpath(path: RuntimeFsPath): string {
    this.guard();
    return this.target.realpath(path);
  }
  remove(path: RuntimeFsPath, options?: { recursive?: boolean; force?: boolean }): void {
    this.guard();
    return this.target.remove(path, options);
  }
  copyFile(from: RuntimeFsPath, to: RuntimeFsPath): void {
    this.guard();
    return this.target.copyFile(from, to);
  }
  fstat(handleId: number): RuntimeVfsStat {
    this.guard();
    return this.target.fstat(handleId);
  }
  dup(handleId: number): RuntimeFileHandle {
    this.guard();
    return this.target.dup(handleId);
  }
  seek(handleId: number, offset: number, whence: 'set' | 'current' | 'end'): number {
    this.guard();
    return this.target.seek(handleId, offset, whence);
  }
  setStatus(handleId: number, status: { append?: boolean }): void {
    this.guard();
    return this.target.setStatus(handleId, status);
  }
  readdirHandle(handleId: number): RuntimeVfsDirEntry[] {
    this.guard();
    return this.target.readdirHandle(handleId);
  }
  ftruncate(handleId: number, size: number): void {
    this.guard();
    return this.target.ftruncate(handleId, size);
  }
  fchmod(handleId: number, mode: number): void {
    this.guard();
    return this.target.fchmod(handleId, mode);
  }
  fchown(handleId: number, uid: number, gid: number): void {
    this.guard();
    return this.target.fchown(handleId, uid, gid);
  }
  futimes(handleId: number, atimeMs: number, mtimeMs: number): void {
    this.guard();
    return this.target.futimes(handleId, atimeMs, mtimeMs);
  }
  appendOnce(
    path: RuntimeFsPath,
    pid: number,
    writerId: string,
    moduleId: string,
    operationId: number,
    digest: string,
    bytes: Uint8Array,
  ): number {
    this.guard();
    if (this.pid === undefined || pid !== this.pid) {
      throw Object.assign(new Error('EPERM: append process identity mismatch'), { code: 'EPERM' });
    }
    return this.target.appendOnce(path, pid, writerId, moduleId, operationId, digest, bytes);
  }
  acknowledgeAppend(pid: number, writerId: string, moduleId: string, operationId: number): void {
    this.guard();
    if (this.pid === undefined || pid !== this.pid) {
      throw Object.assign(new Error('EPERM: append process identity mismatch'), { code: 'EPERM' });
    }
    return this.target.acknowledgeAppend(pid, writerId, moduleId, operationId);
  }
  writeBatch(payload: BatchWritePayload): { inodes: number; chunks: number } {
    this.guard();
    return this.target.writeBatch(payload);
  }
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
    this.guard();
    return this.target.acquireExclusiveMutation(path, options);
  }
  releaseExclusiveMutation(owner: string): void {
    this.guard();
    return this.target.releaseExclusiveMutation(owner);
  }
}

/** The default authority owns descriptor scopes, not the host's database lifetime. */
export class SqliteFilesystemAuthority implements NimbusFilesystemAuthority {
  readonly namespace: string;
  private readonly processes = new Map<number, SqliteDescriptorScope>();
  private readonly retired = new Set<number>();

  /** The disk this authority credentials; a host composing over the same
   *  session reads it here instead of tracking a second reference. */
  constructor(readonly vfs: SqliteVFS, private kernel?: VFS) {
    this.namespace = vfs.namespace;
  }

  attachKernel(kernel: VFS): void {
    this.kernel = kernel;
  }

  bind({ pid, cred, signal }: NimbusFilesystemBinding): RuntimeFsBridge {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('filesystem binding requires a process pid');
    if (this.retired.has(pid)) throw Object.assign(new Error('ESTALE: process released'), { code: 'ESTALE' });
    let scope = this.processes.get(pid);
    if (!scope) { scope = createSqliteDescriptorScope(); this.processes.set(pid, scope); }
    return this.view(scope, immutableCredential(cred), signal, pid);
  }

  openHost(cred: Readonly<VfsCred>, options: { signal?: AbortSignal } = {}): NimbusHostFilesystemLease {
    const scope = createSqliteDescriptorScope();
    const fs = this.view(scope, immutableCredential(cred), options.signal);
    return { fs, dispose: async () => this.closeScope(scope) };
  }

  async releaseProcess(pid: number): Promise<void> {
    this.retired.add(pid);
    const scope = this.processes.get(pid);
    if (scope) this.closeScope(scope);
    this.processes.delete(pid);
    this.vfs.revokeAppendWriters(pid);
  }

  async activateAppendWriter(pid: number, writerId: string): Promise<void> {
    if (this.retired.has(pid)) throw Object.assign(new Error('ESTALE: process released'), { code: 'ESTALE' });
    this.vfs.activateAppendWriter(pid, writerId);
  }
  async revokeAppendWriter(pid: number, writerId: string): Promise<void> { this.vfs.revokeAppendWriter(pid, writerId); }
  async revokeAppendWriters(pid: number): Promise<void> { this.vfs.revokeAppendWriters(pid); }
  async revokeAppendWritersThrough(maxPid: number): Promise<void> { this.vfs.revokeAppendWritersThrough(maxPid); }

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

  private view(scope: SqliteDescriptorScope, cred: VfsCred, signal?: AbortSignal, pid?: number): RuntimeFsBridge {
    const target = new SqliteRuntimeFsBridge(this.vfs.as(cred), this.vfs, scope, () => this.kernel?.as(cred));
    return new SqliteGuardedFsBridge(target, scope, signal, pid);
  }
}
