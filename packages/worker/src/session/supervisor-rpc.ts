/**
 * supervisor-rpc.ts — WorkerEntrypoint for facet → supervisor IPC.
 *
 * Exported from index.ts. Facets receive `env.SUPERVISOR` service binding
 * pointing to this class via ctx.exports loopback binding.
 *
 * Props: { doId: string, pid: number, writerId: string, route: HostRoute, hostIncarnation?: string }
 *   doId — the supervisor DO's durable object ID (for routing)
 *   pid  — the process ID (for stdout/stderr routing)
 *   writerId — the active append-writer incarnation for this process
 *   route — the host namespace and dispatch method, minted with the binding
 *           in the host's isolate; this entrypoint may answer from another
 *   hostIncarnation — the host instance that minted the binding, present
 *           when that host applies delivered mutations once
 *           (@nimbus-sh/core/workspace/supervisor-delivery.js)
 *
 * Methods callable by facets via RPC:
 *   readFile(path) → string | null
 *   writeFile(path, content) → void
 *   stat(path) → { type, size, mtime, mode } | null
 *   readdir(path) → { name, type }[]
 *   exists(path) → boolean
 *   mkdir(path) → void
 *   unlink(path) → void
 *   fsOpen/fsRead/fsWrite/fsClose/readlink/symlink/rename/rmdir/fsRevision
 *   fsReadRange/fsWriteRange/fsAppend/fsAppendAck/fsTruncate
 *     → shared RuntimeFsBridge operations
 *   fsReadBatch(requests) → per-request results  (many reads and lstats, one round trip)
 *   fsList(after, limit) → one page of what EXISTS, with per-path revisions
 *   writeBatch(payload) → { inodes, chunks }  (bulk atomic write)
 *   stdout(data) → void  (pushed to WebSocket + ring buffer)
 *   stderr(data) → void
 *   reportExit(code, tail?) → void  (called from facet's finally block)
 *   prefetch(cwd, entryCode) → Record<string, string>
 *
 * Delivery: every call reaches the session over a Durable Object stub the
 * platform can drop ("Network connection lost.", `retryable`). Reads are
 * re-sent on a fresh stub, and hedged: one unanswered after
 * LOST_CALL_HEDGE_AFTER_MS is sent again while it stays in flight.
 * Filesystem mutations, on a binding that names its
 * host's incarnation, are re-sent under one delivery id that host applies at
 * most once (`_fsMutation`); on any other binding they are sent once.
 * Appends are re-sent under the append ledger's identity. Everything else is
 * sent once and a drop surfaces.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import type { HostRoute } from '@nimbus-sh/platform/composition.js';
import { traced } from '@nimbus-sh/platform/tracing.js';
import { hostNamespaceBinding, hostOpDispatch } from '@nimbus-sh/fabric/host-dispatch.js';
import { idempotent, type DoCallRetryPolicy } from '@nimbus-sh/fabric/do-calls.js';
import type { SupervisorOpEnvelope, SupervisorOpName, WriteFileStatAnswer } from '@nimbus-sh/core/workspace/supervisor-op.js';
import {
  SUPERVISOR_DELIVER_OP,
  type SupervisorDeliveredOpName,
  type SupervisorJoinedReadOpName,
} from '@nimbus-sh/core/workspace/supervisor-delivery.js';
import { VFS_DELIVERY_RETRY_WINDOW_MS } from '@nimbus-sh/core/constants.js';
// W5: OOM discriminator — record last-known RPC frame on writeBatch entry
import { setLastRpcFrame } from '@nimbus-sh/platform/oom-discriminator.js';
// Phase 2 A'.2 — supervisor in-flight RPC payload byte tracking.
import { rpcPayloadStart, rpcPayloadEnd } from '@nimbus-sh/platform/diag-counters.js';
// W4: R2 cross-tenant npm cache (tarballs + packuments)
import { R2CacheClient, MAX_R2_TARBALL_BYTES } from '../npm/r2-cache.js';
import type { PackumentReadThrough } from '../npm/r2-cache.js';
import { useRpcResource } from '@nimbus-sh/platform/rpc-dispose.js';
import type { VfsAcquireOptions, VfsAcquireResult, VfsListPage, VfsMutationReceipt, RuntimeFsBridge, RuntimeFsPath, RuntimeOpenFlags, RuntimeFileHandle } from '@nimbus-sh/core/runtime/os-contracts.js';
import {
  isSupervisorAnsweredMethod,
  supervisorAnswer,
  type SupervisorAnswer,
  type SupervisorAnsweredMethod,
} from '@nimbus-sh/core/runtime/vfs-supervisor.js';
import type { WriteBatchStreamResult } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import { fsReadBatchRequestBytes, type FsAcquireArgs, type FsAcquiredAnswer, type FsReadBatchEntry, type FsReadBatchRequest, type VfsDeliveredAcquire } from './rpc.js';
import { W7_MAX_RECORD_BYTES } from '@nimbus-sh/platform/w7-frame.js';
import { LOST_CALL_HEDGE_AFTER_MS } from '@nimbus-sh/platform/lost-call.js';
import type { WaveFence } from '@nimbus-sh/platform/wave-writer.js';
// cache metrics support: per-tier hit/miss counters.
//
// CRITICAL — SupervisorRPC is a WorkerEntrypoint (loopback service
// binding). It runs in a SEPARATE isolate from the DO it services, so
// bumping a module-scoped singleton here does NOT update the DO's
// /api/_diag/cache surface. We accumulate per-RPC and forward the
// batch back to the DO via _rpcRecordCacheStats at the end of each
// handler. Same pattern as recordR2RaceCounters / install-batch-facet.
import type { CacheTier, CacheKind } from '@nimbus-sh/core/_shared/cache-stats.js';

/**
 * Per-call cache-stat event surfaced from supervisor R2CacheClient to
 * the calling facet. Discriminated union so the facet can fold each
 * event into a structured-clone-safe wire format.
 *
 * cache-obs-2: lifted out of supervisor-rpc.ts and now part of the
 * RPC return shape (was drained-and-discarded in v1).
 */
export type SupervisorCacheStatEvent =
  | { kind: 'hit'; tier: CacheTier; cacheKind: CacheKind; bytes: number }
  | { kind: 'miss'; tier: CacheTier; cacheKind: CacheKind };

/**
 * Drain the per-call event list captured by R2CacheClient during this
 * SupervisorRPC call.
 *
 * cache-obs-2 (the v2 fold-side flip):
 *   We RETURN the drained events to the facet so they propagate via
 *   the install-batch-facet result -> installer.ts fold -> DO
 *   singleton path. No recursion (return-value flow, not subrequest).
 *
 * The R2CacheClient instance lives only for the duration of one RPC
 * call (constructed fresh in _r2()). Draining its event list at the
 * end of the call is the natural lifecycle boundary.
 */
function _drainCacheEvents(client: any): SupervisorCacheStatEvent[] {
  const drained = (client && Array.isArray(client._cacheEvents)) ? client._cacheEvents : [];
  if (client && Array.isArray(client._cacheEvents)) client._cacheEvents = [];
  return drained;
}

/**
 * W5 Lever 5: estimate the byte-cost of a writeBatch payload so the
 * /api/_diag/memory.rpc.lastFrame.payloadBytes field is meaningful.
 * Counts chunk data bytes + per-inode header overhead. Fast (no copy).
 */
function _estimateWriteBatchBytes(payload: any): number {
  if (!payload) return 0;
  let n = 0;
  const chunks = payload.chunks ?? [];
  for (const c of chunks) {
    n += (c?.data?.length ?? c?.data?.byteLength ?? 0);
  }
  const inodes = payload.inodes ?? [];
  for (const i of inodes) n += 80 + (i?.path?.length ?? 0);
  return n;
}

// The fabric mints `env.SUPERVISOR` bindings for the programs it hosts; the
// worker's composition root (src/index.ts) names this class to the fabric
// with composeFabric.

// A process's filesystem read (SupervisorRPC → session) still unanswered
// after LOST_CALL_HEDGE_AFTER_MS is sent again on a fresh stub, the first left
// running and the first answer taken (fabric do-calls `hedgeAfterMs`): the
// platform's lost call, measured and timed in @nimbus-sh/platform lost-call.ts.

export class SupervisorRPC extends WorkerEntrypoint {
  /**
   * A fresh stub for the host, by the route the binding carries, per call.
   * The platform serves this entrypoint from whichever isolate it likes; the
   * props were minted in the host's.
   */
  private _host(): object {
    const doId = (this.ctx.props as { doId?: unknown } | undefined)?.doId;
    if (typeof doId !== 'string' || doId.length === 0) {
      throw new Error('SupervisorRPC: missing doId in props');
    }
    const namespace = hostNamespaceBinding(this.env, 'SupervisorRPC', this._route());
    return namespace.get(namespace.idFromString(doId));
  }

  private _route(): HostRoute | undefined {
    return (this.ctx.props as { route?: HostRoute } | undefined)?.route;
  }

  private _op<T>(
    op: SupervisorOpName,
    args: readonly unknown[] = [],
    extra: Omit<SupervisorOpEnvelope, 'op' | 'args'> = {},
  ): Promise<T> {
    return hostOpDispatch(this._host(), 'SupervisorRPC', this._route())({ op, args, ...extra }) as Promise<T>;
  }

  /** Stamp filesystem credentials from the binding, not the supplied arguments. */
  private _fsOp<T>(op: SupervisorOpName, args: readonly unknown[] = []): Promise<T> {
    return this._op<T>(op, args, { pid: this._pid() });
  }

  /**
   * A filesystem read changes nothing on the host, so a call the platform
   * dropped on the way to it is repeated on a fresh stub. Measured: the
   * host's `stat` failing with "Network connection lost." (`retryable`) is
   * what failed CPython's start in about one fresh session in twenty.
   *
   * A read can also never answer: under concurrent sessions a burst of reads
   * from one facet left some attempts pending for minutes without reaching
   * the host, and the program waiting on them never exited
   * (preview/new/lucide-barrel-cache-widens). So a read still unanswered
   * after LOST_CALL_HEDGE_AFTER_MS is hedged: sent again on a fresh
   * stub, the first attempt left running, the first answer taken.
   *
   * A read can equally be slow at the session — queued behind the read
   * budget, a lazy import, a busy input gate — and a hedge must not make it
   * read again there. So every attempt carries the one read id minted here,
   * and the session joins a repeat to the read it is still serving
   * (`SupervisorDeliveries.joinRead`): a hedge that did arrive costs the
   * session nothing but a second copy of the answer. Mutations are not
   * hedged: their repeats stay bounded by the delivery retry window.
   */
  private _fsRead<T>(op: SupervisorJoinedReadOpName, args: readonly unknown[] = []): Promise<T> {
    return this._resent<T>(
      { op, args, pid: this._pid(), readId: crypto.randomUUID() },
      { kind: 'read' },
      { hedgeAfterMs: LOST_CALL_HEDGE_AFTER_MS },
    );
  }

  /**
   * A filesystem mutation, delivered exactly once. The platform drops this
   * hop too — measured: pip's `fsWrite` of a wheel member and a FileHandle
   * write loop, each failing "Network connection lost." (`retryable`) as
   * EIO — and a dropped mutation may or may not have run.
   *
   * So on a binding whose host names its incarnation, every attempt carries
   * the one delivery id minted here, under SUPERVISOR_DELIVER_OP, and that
   * host instance applies the id at most once: a repeat of a mutation that
   * ran is answered from its receipt and never applied again, even over
   * another writer's newer write; one that never arrived applies on the
   * repeat. Any other instance, and any host that predates delivery, refuses
   * the envelope outright, and that refusal is never repeated. Repeats stop
   * VFS_DELIVERY_RETRY_WINDOW_MS after the first attempt, inside the host's
   * receipt retention.
   *
   * A binding minted by a host that dedupes nothing names no incarnation,
   * and its mutations are sent once.
   *
   * The id is random because this entrypoint keeps nothing between calls and
   * may answer from any isolate; the pid still comes from the binding.
   */
  private _fsMutation<T>(op: SupervisorDeliveredOpName, args: NonNullable<SupervisorOpEnvelope['args']>): Promise<T> {
    const hostIncarnation = this._hostIncarnation();
    // A binding minted under an exclusive mutation lease presents it on every
    // mutation, as writeBatchStream does: the leased writer's own ranged
    // writes land under its root, and every other writer's are EBUSY.
    const mutationOwner = this._mutationOwner();
    const lease = mutationOwner === undefined ? {} : { mutationOwner };
    if (hostIncarnation === undefined) return this._op<T>(op, args, { pid: this._pid(), ...lease });
    const id = crypto.randomUUID();
    return this._resent<T>(
      { op: SUPERVISOR_DELIVER_OP, args, pid: this._pid(), delivery: { op, id, hostIncarnation }, ...lease },
      { kind: 'deliver', operationId: id },
      { retryWindowMs: VFS_DELIVERY_RETRY_WINDOW_MS },
    );
  }

  /**
   * `envelope`, re-sent as it is on a fresh stub while the platform drops it
   * retryably, in the span that classifies a lost call: `nimbus.supervisor.`
   * `trace.kind`, naming which process and writer sent which operation under
   * which id, how many attempts it took, whether a hedge fired, which
   * attempt answered, and how each lost one failed (fabric do-calls `span`).
   * The session's side of a delivery or a read is its `nimbus.session.*`
   * span, under the RPC span of the attempt that reached it.
   */
  private _resent<T>(
    envelope: SupervisorOpEnvelope,
    trace: { kind: 'deliver' | 'read' | 'append' | 'open'; operationId?: string },
    policy?: DoCallRetryPolicy,
  ): Promise<T> {
    const operation = envelope.delivery?.op ?? envelope.op;
    // The binding's props, minted by supervisorBindingProps: attribute values only, nothing trusted.
    const props = this.ctx.props;
    const doId = typeof props === 'object' && props !== null && 'doId' in props && typeof props.doId === 'string'
      ? props.doId : undefined;
    const writerId = typeof props === 'object' && props !== null && 'writerId' in props && typeof props.writerId === 'string'
      ? props.writerId : undefined;
    return traced(`nimbus.supervisor.${trace.kind}`, {
      'nimbus.op': operation,
      'nimbus.pid': envelope.pid,
      'nimbus.session_do': doId,
      'nimbus.writer_id': envelope.writerId ?? writerId,
      'nimbus.operation_id': trace.operationId,
      'nimbus.host_incarnation': envelope.delivery?.hostIncarnation,
      'nimbus.read_id': envelope.readId,
    }, (span) => idempotent(
      operation,
      () => this._host(),
      (host) => hostOpDispatch(host, 'SupervisorRPC', this._route())(envelope) as Promise<T>,
      { ...policy, span },
    ));
  }

  private _mutationOwner(): string | undefined {
    const props = this.ctx.props;
    if (typeof props !== 'object' || props === null || !('mutationOwner' in props)) return undefined;
    return typeof props.mutationOwner === 'string' ? props.mutationOwner : undefined;
  }

  private _hostIncarnation(): string | undefined {
    const props = this.ctx.props;
    if (typeof props !== 'object' || props === null || !('hostIncarnation' in props)) return undefined;
    const incarnation = props.hostIncarnation;
    return typeof incarnation === 'string' && incarnation.length > 0 ? incarnation : undefined;
  }

  private _reportingPid(): number {
    const pid = (this.ctx.props as { pid?: unknown } | undefined)?.pid;
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : 0;
  }

  private _call<T>(promise: Promise<T>): Promise<T> {
    return useRpcResource(promise, (value) => value);
  }

  private _pid(): number {
    const pid = (this.ctx as any).props?.pid;
    if (!Number.isInteger(pid) || typeof pid !== 'number' || pid <= 0) {
      throw new Error('SupervisorRPC: missing or invalid process pid in props');
    }
    return pid;
  }

  private _writerId(): string {
    const writerId = (this.ctx as any).props?.writerId;
    if (typeof writerId !== 'string' || writerId.length === 0) {
      throw new Error('SupervisorRPC: missing VFS writer incarnation');
    }
    return writerId;
  }

  // ── Filesystem RPC ────────────────────────────────────────────────────

  /**
   * The filesystem call `method` (one of SUPERVISOR_ANSWERED_METHODS), with a
   * refusal answered as a value: a facet's client (core vfs-supervisor.ts
   * answeringSupervisor) rethrows it as the error a throw would have
   * delivered. A refusal thrown from here was recorded by the platform as an
   * exception, "canceled ... your Worker's code had hung", although its
   * caller was answered at once. Anything without a code still throws.
   */
  async answer(method: SupervisorAnsweredMethod, args: unknown[]): Promise<SupervisorAnswer> {
    if (!isSupervisorAnsweredMethod(method) || !Array.isArray(args)) {
      throw new TypeError(`SupervisorRPC.answer: ${JSON.stringify(method)} is not a filesystem call`);
    }
    return supervisorAnswer(() => Reflect.apply(this[method], this, args));
  }

  async readFile(path: string): Promise<string | null> {
    return this._call(this._fsRead('readFile', [path]));
  }

  /**
   * Read a file as raw bytes. Used by the git network facet for binary
   * object/pack files where the text readFile would corrupt content.
   */
  async readFileBytes(path: RuntimeFsPath): Promise<Uint8Array | null> {
    return this._call(this._fsRead('readFileBytes', [path]));
  }

  async writeFile(path: RuntimeFsPath, content: string | Uint8Array): Promise<number> {
    // binary-fs wave: accept Uint8Array natively. Pre-fix this RPC was
    // string-only, which forced node-shims.ts:writeFileSync to UTF-8-
    // decode every Uint8Array write — mangling bytes ≥ 0x80 to U+FFFD
    // and corrupting binary content. RPC structured-clone handles
    // Uint8Array transparently; downstream _rpcWriteFile also accepts
    return this._call(this._fsMutation('writeFile', [path, content]));
  }

  /** writeFile, answering the revision and the path's stat after it (supervisor-op.ts writeFileStat). */
  async writeFileStat(path: RuntimeFsPath, content: string | Uint8Array): Promise<WriteFileStatAnswer> {
    return this._call(this._fsMutation('writeFileStat', [path, content]));
  }

  async stat(path: RuntimeFsPath, options?: { followSymlinks?: boolean }): Promise<Awaited<ReturnType<RuntimeFsBridge['stat']>>> {
    return this._call(this._fsRead('stat', [path, options]));
  }

  async lstat(path: string): Promise<any> {
    return this._call(this._fsRead('lstat', [path]));
  }

  async hasLegacySymlinkUnder(path: string): Promise<boolean> {
    return this._call(this._fsRead('hasLegacySymlinkUnder', [path]));
  }

  async utimes(path: RuntimeFsPath, atimeMs: number, mtimeMs: number): Promise<VfsMutationReceipt> {
    return this._call(this._fsMutation('utimes', [path, atimeMs, mtimeMs]));
  }

  async chmod(path: RuntimeFsPath, mode: number): Promise<VfsMutationReceipt> {
    return this._call(this._fsMutation('chmod', [path, mode]));
  }

  async access(path: RuntimeFsPath, mode: number): Promise<void> {
    return this._call(this._fsRead('access', [path, mode]));
  }

  async chown(
    path: RuntimeFsPath,
    uid: number,
    gid: number,
    options?: { followSymlinks?: boolean },
  ): Promise<VfsMutationReceipt> {
    return this._call(this._fsMutation('chown', [path, uid, gid, options]));
  }

  async setUmask(mask: number): Promise<number> {
    return this._call(this._fsOp('setUmask', [mask]));
  }

  async readdir(path: RuntimeFsPath): Promise<{ name: string; type: string }[]> {
    return this._call(this._fsRead('readdir', [path]));
  }

  async exists(path: string): Promise<boolean> {
    return this._call(this._fsRead('exists', [path]));
  }

  async mkdir(path: RuntimeFsPath, options?: Parameters<RuntimeFsBridge['mkdir']>[1]): Promise<void> {
    return this._call(this._fsMutation('mkdir', [path, options]));
  }

  async rmdir(path: RuntimeFsPath): Promise<void> {
    return this._call(this._fsMutation('rmdir', [path]));
  }

  async rename(from: RuntimeFsPath, to: RuntimeFsPath): Promise<void> {
    return this._call(this._fsMutation('rename', [from, to]));
  }

  async unlink(path: RuntimeFsPath): Promise<void> {
    return this._call(this._fsMutation('unlink', [path]));
  }

  async readlink(path: RuntimeFsPath): Promise<string | null> {
    return this._call(this._fsRead('readlink', [path]));
  }

  async symlink(target: string, path: RuntimeFsPath): Promise<void> {
    return this._call(this._fsMutation('symlink', [target, path]));
  }

  /**
   * ACQUIRE: the paths mutated since the facet's cursor, plus a fresh
   * cursor. The facet drops those cells from its resident set before
   * running further user code.
   *
   * A separate call rather than a field stamped onto every RPC reply:
   * SupervisorRPC runs in a different isolate from the DO that owns the
   * revision clock, so stamping here would cost its own round trip anyway,
   * and enveloping the existing returns would break `useRpcResource`
   * disposal, which targets the returned value. It only reads the
   * invalidation log, so a dropped call is repeated like any other read.
   */
  async fsAcquire(epoch: string | null, cursor: number, options?: VfsAcquireOptions): Promise<VfsAcquireResult> {
    return this._call(this._fsRead('fsAcquire', options === undefined ? [epoch, cursor] : [epoch, cursor, options]));
  }

  /** fsAcquire and one read in a single call (session/rpc.ts _rpcFsAcquired). */
  async fsAcquired(acquire: unknown, op: string, args: unknown[]): Promise<FsAcquiredAnswer> {
    return this._call(this._fsRead('fsAcquired', [acquire, op, args]));
  }

  async fsRevision(path?: string): Promise<number> {
    return this._call(this._fsRead('fsRevision', [path]));
  }

  /**
   * Enumerate the session filesystem, one bounded page at a time.
   *
   * ACQUIRE answers "what CHANGED"; this answers "what EXISTS", and nothing a
   * facet is shipped can. Its bundle is a capped prefetch, its metadata covers
   * that bundle plus ancestors, and its manifest carries child names only for
   * the directories the bundler happened to walk — measured, for a real tree,
   * as four entries, every one a directory. A resident cache enumerated from
   * those maps could only ever re-cache what it was already given, which is
   * the admission problem such a cache exists to delete.
   *
   * Paginated rather than capped-and-rejected the way `fsReadBatch` is: a
   * caller asking what exists cannot know the answer's size in advance, so
   * refusing a large filesystem would refuse exactly the filesystems worth
   * enumerating. `next === null` marks the final page, so a short page is
   * never mistaken for a complete listing.
   */
  /** N18: `bytes` more for this process's facet store, reporting what it measures. */
  async fsStorageGrant(facet: string, bytes: number, databaseSize: number): Promise<{ granted: number }> {
    return this._call(this._fsOp('fsStorageGrant', [facet, bytes, databaseSize]));
  }

  async fsList(after?: string | null, limit?: number | null): Promise<VfsListPage> {
    return this._call(this._fsRead('fsList', [after ?? null, limit ?? null]));
  }

  /**
   * WebSocket relay. A facet does not open its own sockets: the supervisor
   * terminates them and hands frames back through `wsPoll`, so an inbound
   * frame is a supervisor reply and the facet's frame handler can take the
   * same ACQUIRE every other supervisor-delivered resumption takes. Without
   * it a third party wakes the facet at a time of its own choosing and the
   * facet's next synchronous read serves bytes the authority has replaced.
   */
  async wsOpen(url: string, protocols: string[]): Promise<{ id: number; protocol: string }> {
    return this._call(this._fsOp('wsOpen', [url, protocols]));
  }

  async wsPoll(id: number, waitMs: number): Promise<unknown[]> {
    return this._call(this._fsOp('wsPoll', [id, waitMs]));
  }

  async wsSend(id: number, text: string | null, bytes: Uint8Array | null): Promise<void> {
    return this._call(this._fsOp('wsSend', [id, text, bytes]));
  }

  async wsClose(id: number, code?: number, reason?: string): Promise<void> {
    return this._call(this._fsOp('wsClose', [id, code, reason]));
  }

  async fsOpen(path: RuntimeFsPath, flags: RuntimeOpenFlags): Promise<RuntimeFileHandle> {
    return this._call(this._fsMutation('fsOpen', [path, flags]));
  }

  async fsRead(handleId: number, offset: number | null, length: number): Promise<Uint8Array> {
    return this._call(this._fsOp('fsRead', [handleId, offset, length]));
  }

  async fsWrite(handleId: number, offset: number | null, bytes: Uint8Array | ArrayBuffer | number[]): Promise<number> {
    return this._call(this._fsMutation('fsWrite', [handleId, offset, bytes]));
  }

  /** A descriptor's stat and its directory listing move nothing: re-sent like any read. */
  async fsFstat(...args: Parameters<RuntimeFsBridge['fstat']>): Promise<Awaited<ReturnType<RuntimeFsBridge['fstat']>>> {
    return this._call(this._fsRead('fsFstat', args));
  }
  async fsDup(...args: Parameters<RuntimeFsBridge['dup']>): Promise<Awaited<ReturnType<RuntimeFsBridge['dup']>>> {
    return this._call(this._fsMutation('fsDup', args));
  }
  async fsSeek(...args: Parameters<RuntimeFsBridge['seek']>): Promise<Awaited<ReturnType<RuntimeFsBridge['seek']>>> {
    return this._call(this._fsMutation('fsSeek', args));
  }
  async fsSetStatus(...args: Parameters<RuntimeFsBridge['setStatus']>): Promise<Awaited<ReturnType<RuntimeFsBridge['setStatus']>>> {
    return this._call(this._fsMutation('fsSetStatus', args));
  }
  async fsReaddirHandle(...args: Parameters<RuntimeFsBridge['readdirHandle']>): Promise<Awaited<ReturnType<RuntimeFsBridge['readdirHandle']>>> {
    return this._call(this._fsRead('fsReaddirHandle', args));
  }
  async fsFtruncate(...args: Parameters<RuntimeFsBridge['ftruncate']>): Promise<Awaited<ReturnType<RuntimeFsBridge['ftruncate']>>> {
    return this._call(this._fsMutation('fsFtruncate', args));
  }
  async fsFchmod(...args: Parameters<RuntimeFsBridge['fchmod']>): Promise<Awaited<ReturnType<RuntimeFsBridge['fchmod']>>> {
    return this._call(this._fsMutation('fsFchmod', args));
  }
  async fsFchown(...args: Parameters<RuntimeFsBridge['fchown']>): Promise<Awaited<ReturnType<RuntimeFsBridge['fchown']>>> {
    return this._call(this._fsMutation('fsFchown', args));
  }
  async fsFutimes(...args: Parameters<RuntimeFsBridge['futimes']>): Promise<Awaited<ReturnType<RuntimeFsBridge['futimes']>>> {
    return this._call(this._fsMutation('fsFutimes', args));
  }
  async fsSync(...args: Parameters<RuntimeFsBridge['fsync']>): Promise<Awaited<ReturnType<RuntimeFsBridge['fsync']>>> {
    return this._call(this._fsMutation('fsSync', args));
  }
  async fsRealpath(...args: Parameters<RuntimeFsBridge['realpath']>): Promise<Awaited<ReturnType<RuntimeFsBridge['realpath']>>> {
    return this._call(this._fsRead('fsRealpath', args));
  }
  async fsLinkLeadsTo(...args: Parameters<RuntimeFsBridge['linkLeadsTo']>): Promise<Awaited<ReturnType<RuntimeFsBridge['linkLeadsTo']>>> {
    return this._call(this._fsRead('fsLinkLeadsTo', args));
  }
  async fsRemove(...args: Parameters<RuntimeFsBridge['remove']>): Promise<Awaited<ReturnType<RuntimeFsBridge['remove']>>> {
    return this._call(this._fsMutation('fsRemove', args));
  }
  async fsCopyFile(...args: Parameters<RuntimeFsBridge['copyFile']>): Promise<Awaited<ReturnType<RuntimeFsBridge['copyFile']>>> {
    return this._call(this._fsMutation('fsCopyFile', args));
  }
  async fsCopyTree(...args: Parameters<RuntimeFsBridge['copyTree']>): Promise<Awaited<ReturnType<RuntimeFsBridge['copyTree']>>> {
    return this._call(this._fsMutation('fsCopyTree', args));
  }
  async fsAcquireExclusiveMutation(...args: Parameters<RuntimeFsBridge['acquireExclusiveMutation']>): Promise<Awaited<ReturnType<RuntimeFsBridge['acquireExclusiveMutation']>>> {
    return this._call(this._fsMutation('fsAcquireExclusiveMutation', args));
  }
  async fsReleaseExclusiveMutation(...args: Parameters<RuntimeFsBridge['releaseExclusiveMutation']>): Promise<Awaited<ReturnType<RuntimeFsBridge['releaseExclusiveMutation']>>> {
    return this._call(this._fsMutation('fsReleaseExclusiveMutation', args));
  }

  async fsClose(handleId: number): Promise<void> {
    return this._call(this._fsMutation('fsClose', [handleId]));
  }

  /**
   * Stateless ranged ops. Unlike fsOpen/fsRead/fsWrite they carry no
   * server-side handle state, so they stay correct across supervisor
   * hibernation and never rewrite whole files for partial updates.
   */
  async fsReadRange(path: string, offset: number, length: number): Promise<Uint8Array | null> {
    return this._call(this._fsRead('fsReadRange', [path, offset, length]));
  }

  /**
   * The same read with the session's content cache bypassed, for a boot spec's
   * by-path members. They are read once, in slices, straight into a module map;
   * caching one evicts the user's hot working set and pins tens of MiB in the
   * session's heap for the rest of its life.
   */
  async fsReadRangeUncached(path: string, offset: number, length: number): Promise<Uint8Array | null> {
    return this._call(this._fsRead('fsReadRangeUncached', [path, offset, length]));
  }

  /**
   * Read many ranges in ONE round trip — the read-side counterpart to
   * writeBatchStream, and for the same reason: a per-item round trip is the
   * whole cost of a filesystem workload, not the storage lookup behind it.
   * A file the caller knows is small is one entry; a large one is a run of
   * entries over the same path.
   *
   * A request may instead ask for a path's lstat, so a process learning the
   * metadata of many paths pays one round trip, not one per path.
   *
   * Entries come back positionally, each carrying exactly what the
   * equivalent fsReadRange or lstat would have returned. The batch is bounded by
   * FS_READ_BATCH_PATH_LIMIT paths and FS_READ_BATCH_REQUEST_BYTES of
   * requested range, and the supervisor rejects anything past either — never
   * a short result, which a caller could mistake for a short file.
   */
  async fsReadBatch(requests: FsReadBatchRequest[]): Promise<FsReadBatchEntry[]> {
    // The requested total is the batch's payload ceiling: every entry
    // returns at most the range asked for. Counting it keeps the
    // supervisor's heap estimate honest for the duration of the await, the
    // same accounting writeBatch does for its inbound payload.
    const payloadBytes = requests.reduce((total, request) => total + fsReadBatchRequestBytes(request), 0);
    setLastRpcFrame('fsReadBatch', payloadBytes);
    rpcPayloadStart(payloadBytes);
    try {
      return await this._call(this._fsRead('fsReadBatch', [requests]));
    } finally {
      rpcPayloadEnd(payloadBytes);
    }
  }

  async fsWriteRange(path: string, offset: number, bytes: Uint8Array | ArrayBuffer): Promise<VfsMutationReceipt> {
    return this._call(this._fsMutation('fsWriteRange', [path, offset, bytes]));
  }

  /**
   * An append and its acknowledgement carry the append ledger's own identity
   * (writer, module incarnation, operation sequence), whose receipt the host
   * keeps until the acknowledgement: a repeat of either applies nothing twice,
   * so a dropped one is simply re-sent.
   */
  async fsAppend(
    path: string,
    moduleId: string,
    operationId: string,
    bytes: Uint8Array | ArrayBuffer,
  ): Promise<number> {
    return this._call(
      this._resent(
        { op: 'fsAppend', args: [path, moduleId, operationId, bytes], pid: this._pid(), writerId: this._writerId() },
        { kind: 'append', operationId },
      ),
    );
  }

  async fsAppendAck(moduleId: string, operationId: string): Promise<void> {
    return this._call(
      this._resent(
        { op: 'fsAppendAck', args: [moduleId, operationId], pid: this._pid(), writerId: this._writerId() },
        { kind: 'append', operationId },
      ),
    );
  }

  async fsTruncate(path: string, size: number): Promise<VfsMutationReceipt> {
    return this._call(this._fsMutation('fsTruncate', [path, size]));
  }

  /**
   * Bulk-write all inodes + chunks in ONE transactionSync on the supervisor.
   * Used by facets that buffer writes locally (git clone/fetch/pull).
   *
   * payload shape:
   *   {
   *     inodes: Array<{path, parentPath, isDir, size, mtime, mode, chunkCount}>,
   *     chunks: Array<{path, chunkId, data: Uint8Array}>,
   *     deletePaths?: string[]
   *   }
   */
  async writeBatch(payload: any): Promise<{ inodes: number; chunks: number }> {
    // W5 Lever 5: record the frame on entry so /api/_diag/memory has
    // last-known-RPC context if the supervisor crashes mid-RPC.
    // Phase 2 A'.2: bump the in-flight RPC payload counter so the
    // supervisor's heap estimate accounts for the bytes claimed by
    // this RPC for the duration of the await.
    const payloadBytes = _estimateWriteBatchBytes(payload);
    setLastRpcFrame('writeBatch', payloadBytes);
    rpcPayloadStart(payloadBytes);
    try {
      return await this._call(this._fsMutation('writeBatch', [payload]));
    } finally {
      rpcPayloadEnd(payloadBytes);
    }
  }

  /**
   * W7 — Streaming bulk-write with path-atomic, committed-prefix semantics.
   * The argument is a ReadableStream<Uint8Array> in the W7 wire-protocol
   * (see src/_shared/w7-frame.ts). Bypasses the 32 MiB structured-clone
   * cap entirely; the byte stream traverses the RPC boundary with
   * automatic flow control per Cloudflare RPC docs.
   *
   *   - Install of 5GB monorepo doesn't hit 32 MiB wall.
   *   - Peak heap reduction 48 MiB → 30 MiB on the facet side.
   *
   * The RPC frame itself does NOT pre-clone the stream — workerd
   * transfers the byte stream's underlying-source ownership to the
   * receiver. From the OOM-discriminator's perspective, payloadBytes
   * is unknown up-front (-1 sentinel); it is the supervisor's
   * decoder that observes the actual byte count.
   */
  /**
   * A write-wave epoch from the host instance this binding names, or null
   * when that host fences nothing (it names no incarnation) and waves are
   * sent unfenced. Minting is harmless to repeat, so a lost call is hedged
   * like a read (lost-call.ts).
   */
  async openWaveWriter(): Promise<string | null> {
    if (this._hostIncarnation() === undefined) return null;
    const answer = await this._call(this._resent<{ writer: string }>(
      { op: 'openWaveWriter', args: [], pid: this._pid() },
      { kind: 'open' },
      { hedgeAfterMs: LOST_CALL_HEDGE_AFTER_MS },
    ));
    return answer.writer;
  }

  /**
   * A write wave, sent once: its stream is consumed by the attempt that
   * carries it, so the writer that minted it re-sends a lost wave itself,
   * re-encoded under a newer fence (platform wave-writer.ts, lost-call.ts).
   * On a binding whose host names its incarnation the fence rides with it,
   * and that host instance refuses an attempt older than one it has seen
   * from the same writer; any other instance refuses it outright.
   */
  async writeBatchStream(
    stream: ReadableStream<Uint8Array>,
    fence?: WaveFence,
  ): Promise<WriteBatchStreamResult> {
    // The encoder emits one bounded v2 record per pull. This wrapper-isolate
    // estimate covers that record; the receiving VFS separately reports and
    // enforces its shared 8 MiB retained-payload credit.
    const STREAM_RESIDENT_BYTES = W7_MAX_RECORD_BYTES;
    setLastRpcFrame('writeBatchStream', -1);
    rpcPayloadStart(STREAM_RESIDENT_BYTES);
    try {
      const hostIncarnation = this._hostIncarnation();
      return await this._call(this._resent<WriteBatchStreamResult>({
        op: 'writeBatchStream',
        args: [],
        pid: this._pid(),
        mutationOwner: this._mutationOwner(),
        stream,
        waveFence: fence && hostIncarnation !== undefined ? { ...fence, hostIncarnation } : undefined,
      }, { kind: 'deliver', operationId: fence ? `${fence.writer}:${fence.wave}:${fence.attempt}` : undefined }, { maxAttempts: 1 }));
    } finally {
      rpcPayloadEnd(STREAM_RESIDENT_BYTES);
    }
  }

  /**
   * Bulk-write npm registry cache entries (resolved packument metadata)
   * in ONE RPC. Used by the resolver-facet to flush a wave of resolved
   * packages back to the supervisor without per-entry round-trips.
   *
   * `entries` is an array of RegistryCacheEntry from src/npm-cache.ts:
   *   { name, version, tarballUrl, integrity, depsJson, exportsJson,
   *     main, moduleField, binJson, fetchedAt }
   *
   * Returns { written, failed } — partial writes are tolerated; cache
   * is best-effort (resolver correctness depends on the returned
   * ResolvedPackage[], not on cache hits).
   */
  async putRegistryEntries(entries: any[]): Promise<{ written: number; failed: number }> {
    // Phase 2 A'.2: track the inbound array's resident byte cost.
    // Each registry entry is ~500 B (deps + integrity + tarballUrl);
    // a wave of 100 entries is ~50 KiB. Bounded; counted in
    // streamingBuffersBytes for visibility.
    const REGISTRY_ENTRY_BYTES = 512;
    const payloadBytes = (Array.isArray(entries) ? entries.length : 0) * REGISTRY_ENTRY_BYTES;
    rpcPayloadStart(payloadBytes);
    try {
      return await this._call(this._op('putRegistryEntries', [entries]));
    } finally {
      rpcPayloadEnd(payloadBytes);
    }
  }

  // ── R2-backed npm cache RPC [W4] ─────────────────────────────────────
  //
  // The R2 buckets are bindings on the SUPERVISOR worker (not the
  // facet). The facet only sees what we hang on its `env: { SUPERVISOR }`
  // injection (see src/facet-manager.ts:892 and similar). To expose R2
  // to the facet without pinning a binding stub through the LOADER, we
  // proxy reads/writes through these RPC methods.
  //
  // Counter increments live HERE (supervisor isolate, where diag-counters
  // is module-scoped). The facet itself never sees the counter module.
  //
  // Graceful-degrade: if NPM_TARBALL_CACHE / NPM_PACKUMENT_CACHE bindings
  // aren't configured (deploy without R2 buckets, or local dev), the
  // R2CacheClient falls through to null returns / no-op writes; the
  // facet sees null and uses its existing network-fetch path. No errors,

  /**
   * Build a fresh R2CacheClient bound to this request's env. Cheap to
   * instantiate; does no async work. Called from each R2 RPC method to
   * avoid keeping the client in instance state (the WorkerEntrypoint
   * lifecycle is per-invocation and we want a clean closure each time).
   */
  private _r2(): R2CacheClient {
    const tar = (this.env as any)?.NPM_TARBALL_CACHE ?? null;
    const pkm = (this.env as any)?.NPM_PACKUMENT_CACHE ?? null;
    return new R2CacheClient(tar, pkm);
  }

  /**
   * Look up a tarball in the R2 cross-tenant cache by its content
   * address (the resolved npm integrity string). Returns
   * { bytes, events } where:
   *   - bytes: Uint8Array on hit, null on miss/oversize/no-binding
   *   - events: L2/L3 hit/miss tuples captured during this lookup
   *
   * Facets propagate events into their result for installer.ts to fold
   * into the DO singleton (mirroring the recordR2RaceCounters pattern).
   * Without this enrichment the L2/L3 distinction is supervisor-side
   * knowledge only. The events list is structured-clone-safe (plain
   * objects + strings + numbers).
   *
   * Returned bytes have already been re-hashed against `integrity` by
   * R2CacheClient — the cross-tenant bucket is untrusted storage, so
   * verification happens at the storage boundary and nowhere else.
   */
  async getCachedTarball(
    integrity: string,
  ): Promise<{ bytes: Uint8Array | null; events: SupervisorCacheStatEvent[] }> {
    const r2 = this._r2();
    const bytes = await r2.getTarball(integrity);
    const events = _drainCacheEvents(r2);
    if (bytes && bytes.length > 0 && bytes.length <= MAX_R2_TARBALL_BYTES) {
      return { bytes, events };
    }
    return { bytes: null, events };
  }

  /**
   * Store a tarball in the R2 cross-tenant cache under its content
   * address. Best-effort: on R2 write failure, returns false but the
   * install pipeline continues unaffected. Bytes that do not hash to
   * `integrity` are rejected by R2CacheClient.
   */
  async putCachedTarball(
    integrity: string,
    bytes: Uint8Array | ArrayBuffer,
  ): Promise<boolean> {
    // L4 hits are captured FACET-SIDE in cache-obs-2 — the facet did
    // the registry fetch, so it can push the L4 event directly into
    // its own cacheStatEvents list before calling putCachedTarball.
    // This RPC remains a one-way write (returns bool); the L4 event
    // does NOT flow through this return path.
    const r2 = this._r2();
    return r2.putTarball(integrity, bytes);
  }

  /**
   * Resolve one package's corgi packument: cross-tenant cache read, and
   * on a miss the registry fetch plus the cache fill.
   *
   * Fetch and fill live inside R2CacheClient, not in the resolve facet,
   * and that is a security boundary rather than a layering preference.
   * The packument bucket is shared by every tenant and a packument
   * dictates the tarball URL and integrity digest for everyone who reads
   * it, so a caller-supplied `put` would be a cross-tenant
   * code-execution primitive for anyone holding a supervisor stub. No
   * such RPC exists: the only bytes that reach `pc/<name>.json` are the
   * ones registry.npmjs.org served for that exact name; another registry
   * (`options.registry`, the install's `NPM_REGISTRY`) has its own keys.
   */
  async getPackument(
    name: string,
    options?: { retries?: number; timeoutMs?: number; registry?: string },
  ): Promise<PackumentReadThrough & { events: SupervisorCacheStatEvent[] }> {
    const r2 = this._r2();
    const result = await r2.readThroughPackument(name, options);
    return { ...result, events: _drainCacheEvents(r2) };
  }

  // ── Process I/O ───────────────────────────────────────────────────────
  //
  // A process's stdio is bytes end to end: stdout/stderr up, cpStdinWrite
  // down, cpReadStdin/cpReadOutput/cpDrainOutput in a child's direction. A
  // text producer encodes at its own edge; a text consumer decodes at its.

  async stdout(data: Uint8Array): Promise<void> {
    return this._call(this._op('stdout', [data], { pid: this._reportingPid() }));
  }

  async stderr(data: Uint8Array): Promise<void> {
    return this._call(this._op('stderr', [data], { pid: this._reportingPid() }));
  }

  /**
   * Report process exit to the supervisor. Called from the facet's own
   * `finally` block after I/O has drained. The supervisor uses this to
   * stamp the log buffer and, for non-zero exits, emit a terminal dump.
   *
   * `tail` is an optional trailing stderr string — useful when the facet
   * has error state it couldn't stream in-band (rare; main path drains
   * via __pendingIO first). `dataReads` are the files it read and did not
   * have, `executedModules` the modules it tried to execute that its module
   * map lacked, and `runtimeCode` the code it produced and could not compile:
   * all for its command's next launch (launch-learning-store.ts).
   */
  async reportExit(code: number, tail?: string, dataReads?: string[], profileUnread?: string[], runtimeCode?: unknown[], executedModules?: string[]): Promise<void> {
    return this._call(this._op('reportExit', [code, tail || '', dataReads ?? [], profileUnread ?? null, runtimeCode ?? [], executedModules ?? []], { pid: this._reportingPid() }));
  }

  /**
   * Persist what a live process learned for its next launch without
   * terminating it: its generated code, the modules it tried to execute and
   * the files it read that its launch lacked (launch-learning-store.ts).
   */
  async reportRuntimeCode(entries: unknown[], executedModules: string[] = [], dataReads: string[] = []): Promise<void> {
    return this._call(this._op('reportRuntimeCode', [entries, executedModules, dataReads], { pid: this._reportingPid() }));
  }

  // ── Prefetch ──────────────────────────────────────────────────────────

  async prefetch(cwd: string, entryCode: string): Promise<Record<string, string>> {
    return this._call(this._op('prefetch', [cwd, entryCode]));
  }

  // ── Port registration ─────────────────────────────────────────────────

  async registerPort(port: number): Promise<void> {
    return this._call(this._op('registerPort', [port], { pid: this._reportingPid() }));
  }

  async allocatePort(): Promise<number> {
    return this._call(this._op('allocatePort', [], { pid: this._reportingPid() }));
  }

  async unregisterPort(port: number): Promise<void> {
    return this._call(this._op('unregisterPort', [port], { pid: this._reportingPid() }));
  }

  /**
   * Route an in-session loopback HTTP request (a facet's fetch to
   * 127.0.0.1/localhost:<port>) to the facet that owns <port> via the session
   * port registry — the same routing the shell curl/node loopback uses. Lets a
   * facet reach another facet's server in-session (e.g. `opencode attach` →
   * `opencode serve`). Returns the target's Response, streamed over RPC.
   *
   * NOT routed through `_call`: that disposes the RPC resource after mapping,
   * which would close a streaming Response body (SSE). We return the RPC promise
   * directly so the body streams to the caller for the response's lifetime —
   * exactly how PortRegistry.routeRequest returns the facet's Response as-is.
   */
  async routeLoopback(port: number, request: Request): Promise<Response> {
    return this._op('routeLoopback', [port, request]);
  }

  // ── Esbuild transform ─────────────────────────────────────────────────

  async transform(code: string, loader: string): Promise<{ code: string; map: string } | null> {
    return this._call(this._op('transform', [code, loader]));
  }

  // ── child_process [W8 Phase 1] ────────────────────────────────────────
  //
  // The parent facet's `child_process.spawn` shim (node-shims.ts) calls
  // these methods. They delegate to NimbusSession._rpcCp* methods which
  // route through the shared FacetProcessManager.
  //

  async cpSpawn(req: any): Promise<{ childPid: number }> {
    return this._call(this._op('cpSpawn', [{ ...req, parentPid: this._pid() }]));
  }

  async cpStdinWrite(childPid: number, data: Uint8Array): Promise<{ ok: boolean }> {
    return this._call(this._op('cpStdinWrite', [childPid, data]));
  }

  async cpStdinEnd(childPid: number): Promise<void> {
    return this._call(this._op('cpStdinEnd', [childPid]));
  }

  /**
   * The three long polls that deliver to a process — its stdin, and a
   * child's output and exit — carry the process's ACQUIRE arguments, and a
   * reply that delivers anything carries the answer for them (`acquired`,
   * session/rpc.ts `_acquireOnDelivery`), so the process applies it without
   * asking. The caller's pid names whose credential answers it.
   */
  async cpReadStdin(childPid: number, waitMs: number, acquire?: FsAcquireArgs): Promise<{
    data: Uint8Array;
    ended: boolean;
    resize?: { columns: number; rows: number };
    signal?: string;
    acquired?: VfsDeliveredAcquire;
  }> {
    return this._call(this._op('cpReadStdin', [childPid, waitMs, acquire ?? null], { pid: this._reportingPid() }));
  }

  async cpReadOutput(
    childPid: number,
    fd: 1 | 2,
    sinceSeq: number,
    waitMs: number,
    acquire?: FsAcquireArgs,
  ): Promise<{ chunks: { seq: number; data: Uint8Array }[]; closed: boolean; maxSeq: number; news?: number[]; acquired?: VfsDeliveredAcquire }> {
    return this._call(this._op('cpReadOutput', [childPid, fd, sinceSeq, waitMs, acquire ?? null], { pid: this._reportingPid() }));
  }

  async cpDrainOutput(childPid: number): Promise<{ stdout: Uint8Array; stderr: Uint8Array; stdoutClosed: boolean; stderrClosed: boolean }> {
    return this._call(this._op('cpDrainOutput', [childPid]));
  }

  async cpKill(childPid: number, signal: string): Promise<boolean> {
    return this._call(this._op('cpKill', [childPid, signal]));
  }

  /**
   * The child's end; with `knownStarted` false, also its start, as soon as
   * it comes (`started`), for a parent that emits 'spawn' on it.
   */
  async cpWait(
    childPid: number,
    waitMs: number,
    acquire?: FsAcquireArgs,
    knownStarted?: boolean,
  ): Promise<{ done: boolean; exitCode: number | null; signal: string | null; spawnError?: string; started?: boolean; news?: number[]; acquired?: VfsDeliveredAcquire }> {
    return this._call(this._op('cpWait', [childPid, waitMs, acquire ?? null, knownStarted !== false], { pid: this._reportingPid() }));
  }

  /**
   * This process says whether its only remaining work is waiting on its own
   * children, and the contiguous run of news numbers it has applied (the
   * session's Dynamic Worker ledger tells a wait no release can satisfy by
   * it: fabric budgets.ts setProcessBlocked). `seq` increases per report.
   */
  async cpBlocked(report: { blocked: boolean; frontier: number; seq: number }): Promise<void> {
    return this._call(this._op('cpBlocked', [report], { pid: this._pid() }));
  }
}
