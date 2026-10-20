/**
 * supervisor-calls.ts — everything a process's SUPERVISOR answers, over
 * either transport: the service binding `env.SUPERVISOR` (supervisor-rpc.ts,
 * SupervisorRPC) or the capability its host hands a one-shot in the call
 * that runs it (process-supervisor.ts, ProcessSupervisor).
 *
 * Props: { doId: string, pid: number, writerId: string, route: HostRoute, hostIncarnation?: string }
 *   doId — the supervisor DO's durable object ID (for routing)
 *   pid  — the process ID (for stdout/stderr routing)
 *   writerId — the run of the process the binding was minted for (its stdin
 *           reads and replay journal are that run's)
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
 *   fsReadRange/fsWriteRange/fsTruncate
 *     → shared RuntimeFsBridge operations
 *   fsReadBatch(requests) → per-request results  (many reads and lstats, one round trip)
 *   fsList(after, limit) → one page of what EXISTS, with per-path revisions
 *   writeBatch(payload) → { inodes, chunks }  (bulk atomic write)
 *   stdout(data) → void  (pushed to WebSocket + ring buffer)
 *   stderr(data) → void
 *   reportExit(code, tail?) → void  (called from facet's finally block)
 *   prefetch(cwd, entryCode) → Record<string, string>
 *
 * Delivery: a call on the capability is answered in the host itself; it fails
 * only with the host or the process. Every call through the binding reaches
 * the session over a Durable Object stub the platform can drop ("Network connection lost.", `retryable`). Reads are
 * re-sent on a fresh stub, and hedged: one unanswered after
 * LOST_CALL_HEDGE_AFTER_MS is sent again while it stays in flight.
 * Filesystem mutations, on a binding that names its
 * host's incarnation, are re-sent under one delivery id that host applies at
 * most once (`_fsMutation`); on any other binding they are sent once.
 * Appends are re-sent under the append ledger's identity. Everything else is
 * sent once and a drop surfaces.
 */

import { EGRESS_TLS_REFUSAL, ISOLATE_NETWORK, workspaceNetwork, type EgressTlsTarget, type WorkspaceEgress, type WorkspaceNetwork } from '@nimbus-sh/core/_shared/workspace-network.js';
import type { WsRelayHeaders, WsRelayOpened } from './ws-relay.js';
import type { DoCallRetryPolicy } from '@nimbus-sh/fabric/do-calls.js';
import type { SupervisorOpEnvelope, SupervisorOpName, WriteFileStatAnswer } from '@nimbus-sh/core/workspace/supervisor-op.js';
import {
  SUPERVISOR_DELIVER_OP,
  type SupervisorDeliveredOpName,
  type SupervisorJoinedReadOpName,
} from '@nimbus-sh/core/workspace/supervisor-delivery.js';
import { VFS_DELIVERY_RETRY_WINDOW_MS } from '@nimbus-sh/core/constants.js';
// W5: OOM discriminator — record last-known RPC frame on writeBatch entry
import { setLastRpcFrame } from '@nimbus-sh/platform/oom-discriminator.js';
import { recordFailure } from '../runtime/stop-replay-body.js';
// Phase 2 A'.2 — supervisor in-flight RPC payload byte tracking.
import { rpcPayloadStart, rpcPayloadEnd } from '@nimbus-sh/platform/diag-counters.js';
// W4: R2 cross-tenant npm cache (tarballs + packuments)
import type { PackumentReadOptions, PackumentReadThrough } from '../npm/r2-cache.js';
import { R2CacheClient, MAX_R2_TARBALL_BYTES } from '../npm/r2-cache.js';
import { useRpcResource } from '@nimbus-sh/platform/rpc-dispose.js';
import type { VfsAcquireOptions, VfsAcquireResult, VfsListOptions, VfsListPage, VfsListTree, VfsMutationReceipt, RuntimeFsBridge, RuntimeFsPath, RuntimeOpenFlags, RuntimeFileHandle, RuntimeReadFileOptions, RuntimeReadOptions, RecallKind } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { ReadDirectoryBatchRequest, ReadDirectoryBatchResult } from '@nimbus-sh/core/runtime/read-directory-batch.js';
import {
  isSupervisorAnsweredMethod,
  supervisorAnswer,
  type SupervisorAnswer,
  type SupervisorAnsweredMethod,
} from '@nimbus-sh/core/runtime/vfs-supervisor.js';
import type { WriteBatchStreamResult } from '@nimbus-sh/core/runtime/wave-contracts.js';
import { fsReadBatchRequestBytes, type FsAcquireArgs, type FsAcquiredAnswer, type FsReadBatchEntry, type FsReadBatchRequest, type VfsDeliveredAcquire } from './rpc.js';
import { W7_MAX_RECORD_BYTES } from '@nimbus-sh/platform/w7-frame.js';
import { LOST_CALL_HEDGE_AFTER_MS, WAVE_EPOCH_TTL_MS } from '@nimbus-sh/platform/lost-call.js';
import type { WaveFence } from '@nimbus-sh/platform/wave-writer.js';
// Cache hits and misses here would bump this isolate's counters, not the
// DO's: each RPC returns its events with its result (CacheStatEvent), and
// the caller folds them where /api/_diag/cache reads them.
import type { CacheStatEvent } from '@nimbus-sh/core/_shared/cache-stats.js';

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

// A process's filesystem read (SupervisorRPC → session) still unanswered
// after LOST_CALL_HEDGE_AFTER_MS is sent again on a fresh stub, the first left
// running and the first answer taken (fabric do-calls `hedgeAfterMs`): the
// platform's lost call, measured and timed in @nimbus-sh/platform lost-call.ts.

/**
 * How a supervisor reaches its host: what it was minted with, and how any
 * envelope gets there. Behind a symbol, so it is off the RPC surface: every
 * method of an RPC target named by a string is callable by whoever holds it.
 */
export interface SupervisorTransport {
  /** The props it was minted with (supervisorBindingProps, or an infrastructure binding's). */
  readonly props: unknown;
  /** The host Worker's env: its npm caches. */
  readonly env: unknown;
  /** `envelope`, answered by the host; `resend` says how, where the platform can drop it. */
  send(envelope: SupervisorOpEnvelope, resend?: Resend): Promise<unknown>;
}

/** A call the platform can drop, re-sent: what it is, for its span, and how often. */
export interface Resend {
  trace: { kind: 'deliver' | 'read' | 'append' | 'open'; operationId?: string };
  policy?: DoCallRetryPolicy;
}

export const TRANSPORT: unique symbol = Symbol('supervisor transport');

// The binding's calls of itself: behind symbols too, for the same reason.
// Its process names only the methods below them (readFile, cpSpawn, …), each
// of which builds its own envelope.
export const OP: unique symbol = Symbol('supervisor op');
export const CALLER: unique symbol = Symbol('supervisor caller');
export const FS_OP: unique symbol = Symbol('supervisor fsOp');
export const FS_READ: unique symbol = Symbol('supervisor fsRead');
export const FS_MUTATION: unique symbol = Symbol('supervisor fsMutation');
export const RESENT: unique symbol = Symbol('supervisor resent');
export const MUTATION_OWNER: unique symbol = Symbol('supervisor mutationOwner');
export const HOST_INCARNATION: unique symbol = Symbol('supervisor hostIncarnation');
export const REPORTING_PID: unique symbol = Symbol('supervisor reportingPid');
export const CALL: unique symbol = Symbol('supervisor call');
export const CACHE_READ: unique symbol = Symbol('supervisor cacheRead');
export const INFRASTRUCTURE_CACHE: unique symbol = Symbol('supervisor infrastructureCache');
export const NETWORK: unique symbol = Symbol('supervisor network');
export const PID: unique symbol = Symbol('supervisor pid');
export const RUN_ID: unique symbol = Symbol('supervisor runId');

type Class = abstract new (...args: any[]) => object;

/**
 * Everything a process's SUPERVISOR answers, over either transport: a
 * binding (SupervisorRPC) or the capability its host hands a one-shot in
 * the call that runs it (ProcessSupervisor).
 */
export function supervisorCalls<Base extends Class>(base: Base) {
  abstract class SupervisorCalls extends base {
    abstract [TRANSPORT](): SupervisorTransport;

    [OP]<T>(
      op: SupervisorOpName,
      args: readonly unknown[] = [],
      extra: Omit<SupervisorOpEnvelope, 'op' | 'args'> = {},
    ): Promise<T> {
      // Every call says which run of the process made it: a process that can
      // stop at a read of stdin is answered for its current run only.
      return this[TRANSPORT]().send(this[CALLER]({ op, args, ...extra })) as Promise<T>;
    }

    /** Every path (including resent reads/mutations) uses the bound caller. */
    [CALLER](envelope: SupervisorOpEnvelope): SupervisorOpEnvelope {
      const props = this[TRANSPORT]().props as { pid?: unknown; bindingKind?: unknown } | undefined;
      const pid = props?.pid;
      // The spawn/build helper has the explicitly bound pid 0. It is not a
      // process and cannot use filesystem credentials ([PID] still refuses it).
      if (typeof pid !== 'number' || !Number.isInteger(pid) || pid < 0) throw new Error('SupervisorRPC: missing or invalid caller pid in props');
      const run = this[RUN_ID]();
      if (props?.bindingKind === 'infrastructure') {
        if (run !== undefined) throw new Error('infrastructure supervisor cannot carry a process run');
        if (['stdout', 'stderr', 'reportExit', 'reportRuntimeCode', 'cpSpawn', 'cpStdinWrite', 'cpStdinEnd', 'cpReadStdin', 'cpReadOutput', 'cpDrainOutput', 'cpCloseOutput', 'cpKill', 'cpWait', 'cpNextSignal', 'cpBlocked', 'replayBoundary', 'stdinFileRead', 'stdinPrepared', 'netTls', 'outbound'].includes(envelope.op)) {
          throw new Error('infrastructure supervisor refuses guest-originated operations');
        }
      } else if (run === undefined) throw new Error('process supervisor binding requires a run');
      return { ...envelope, pid, run };
    }

    /** Stamp filesystem credentials from the binding, not the supplied arguments. */
    [FS_OP]<T>(op: SupervisorOpName, args: readonly unknown[] = []): Promise<T> {
      return this[OP]<T>(op, args, { pid: this[PID]() });
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
    [FS_READ]<T>(op: SupervisorJoinedReadOpName, args: readonly unknown[] = []): Promise<T> {
      return this[RESENT]<T>(
        { op, args, pid: this[PID](), readId: crypto.randomUUID() },
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
    [FS_MUTATION]<T>(op: SupervisorDeliveredOpName, args: NonNullable<SupervisorOpEnvelope['args']>): Promise<T> {
      const hostIncarnation = this[HOST_INCARNATION]();
      // A binding minted under an exclusive mutation lease presents it on every
      // mutation, as writeBatchStream does: the leased writer's own ranged
      // writes land under its root, and every other writer's are EBUSY.
      const mutationOwner = this[MUTATION_OWNER]();
      const lease = mutationOwner === undefined ? {} : { mutationOwner };
      if (hostIncarnation === undefined) return this[OP]<T>(op, args, { pid: this[PID](), ...lease });
      const id = crypto.randomUUID();
      return this[RESENT]<T>(
        { op: SUPERVISOR_DELIVER_OP, args, pid: this[PID](), delivery: { op, id, hostIncarnation }, ...lease },
        { kind: 'deliver', operationId: id },
        { retryWindowMs: VFS_DELIVERY_RETRY_WINDOW_MS },
      );
    }

    /** `envelope`, sent as `trace.kind`, and re-sent as `policy` says where the platform can drop it. */
    [RESENT]<T>(
      envelope: SupervisorOpEnvelope,
      trace: Resend['trace'],
      policy?: DoCallRetryPolicy,
    ): Promise<T> {
      return this[TRANSPORT]().send(this[CALLER](envelope), { trace, policy }) as Promise<T>;
    }

    [MUTATION_OWNER](): string | undefined {
      const props = this[TRANSPORT]().props;
      if (typeof props !== 'object' || props === null || !('mutationOwner' in props)) return undefined;
      return typeof props.mutationOwner === 'string' ? props.mutationOwner : undefined;
    }

    [HOST_INCARNATION](): string | undefined {
      const props = this[TRANSPORT]().props;
      if (typeof props !== 'object' || props === null || !('hostIncarnation' in props)) return undefined;
      const incarnation = props.hostIncarnation;
      return typeof incarnation === 'string' && incarnation.length > 0 ? incarnation : undefined;
    }

    [REPORTING_PID](): number {
      const pid = (this[TRANSPORT]().props as { pid?: unknown } | undefined)?.pid;
      return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : 0;
    }

    async [CALL]<T>(promise: Promise<T>): Promise<T> {
      const value = await useRpcResource(promise, (reply) => reply);
      if (value !== null && (typeof value === 'object' || typeof value === 'function') && Object.hasOwn(value, Symbol.dispose)) {
        Reflect.deleteProperty(value, Symbol.dispose);
      }
      return value;
    }
    async [CACHE_READ]<T>(plan: { ticket?: string; readOnly: boolean }, produce: (client: R2CacheClient) => Promise<T>): Promise<T> {
      const client = new R2CacheClient((this[TRANSPORT]().env as any)?.NPM_TARBALL_CACHE ?? null, (this[TRANSPORT]().env as any)?.NPM_PACKUMENT_CACHE ?? null, plan.readOnly);
      let value: T;
      try { value = await produce(client); }
      catch (error) {
        if (plan.ticket) await this[CALL](this[OP]('cacheResult', [plan.ticket, { failed: true, failure: recordFailure(error) }]));
        throw error;
      }
      if (plan.ticket) await this[CALL](this[OP]('cacheResult', [plan.ticket, { value }]));
      return value;
    }
    [INFRASTRUCTURE_CACHE](op: SupervisorOpName, args: readonly unknown[]): boolean {
      const caller = this[CALLER]({ op, args });
      return (this[TRANSPORT]().props as { bindingKind?: unknown })?.bindingKind === 'infrastructure' && caller.run === undefined;
    }

    /**
     * The network this binding's process reaches out through: its workspace's
     * egress when its host supplied one (SupervisorBindingProps.egress), else
     * this isolate's own. Every request the binding makes for the process —
     * its fetch, its sockets, its packument reads — goes through it.
     */
    [NETWORK](): WorkspaceNetwork {
      const props = this[TRANSPORT]().props as { egress?: WorkspaceEgress; networkId?: string } | undefined;
      return props?.egress === undefined ? ISOLATE_NETWORK : workspaceNetwork(props.egress, props.networkId);
    }

    [PID](): number {
      const pid = (this[TRANSPORT]().props as any)?.pid;
      if (!Number.isInteger(pid) || typeof pid !== 'number' || pid <= 0) {
        throw new Error('SupervisorRPC: missing or invalid process pid in props');
      }
      return pid;
    }

    /** The run of the process this binding was minted for, when it has one. */
    [RUN_ID](): string | undefined {
      const run = (this[TRANSPORT]().props as { writerId?: unknown } | undefined)?.writerId;
      return typeof run === 'string' && run.length > 0 ? run : undefined;
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
      return this[CALL](this[FS_READ]('readFile', [path]));
    }

    /**
     * Read a file as raw bytes. Used by the git network facet for binary
     * object/pack files where the text readFile would corrupt content.
     */
    async readFileBytes(path: RuntimeFsPath, options?: RuntimeReadFileOptions): Promise<Uint8Array | null> {
      return this[CALL](this[FS_READ]('readFileBytes', options === undefined ? [path] : [path, options]));
    }

    async writeFile(path: RuntimeFsPath, content: string | Uint8Array, options?: Parameters<RuntimeFsBridge['writeFile']>[2]): Promise<number> {
      // binary-fs wave: accept Uint8Array natively. Pre-fix this RPC was
      // string-only, which forced node-shims.ts:writeFileSync to UTF-8-
      // decode every Uint8Array write — mangling bytes ≥ 0x80 to U+FFFD
      // and corrupting binary content. RPC structured-clone handles
      // Uint8Array transparently; downstream _rpcWriteFile also accepts
      return this[CALL](this[FS_MUTATION]('writeFile', options === undefined ? [path, content] : [path, content, options]));
    }

    /** writeFile, answering the revision and the path's stat after it (supervisor-op.ts writeFileStat). */
    async writeFileStat(path: RuntimeFsPath, content: string | Uint8Array): Promise<WriteFileStatAnswer> {
      return this[CALL](this[FS_MUTATION]('writeFileStat', [path, content]));
    }

    async stat(path: RuntimeFsPath, options?: { followSymlinks?: boolean }): Promise<Awaited<ReturnType<RuntimeFsBridge['stat']>>> {
      return this[CALL](this[FS_READ]('stat', [path, options]));
    }

    async lstat(path: string): Promise<any> {
      return this[CALL](this[FS_READ]('lstat', [path]));
    }

    async utimes(...args: Parameters<RuntimeFsBridge['utimes']>): Promise<VfsMutationReceipt> {
      return this[CALL](this[FS_MUTATION]('utimes', args));
    }

    async chmod(path: RuntimeFsPath, mode: number): Promise<VfsMutationReceipt> {
      return this[CALL](this[FS_MUTATION]('chmod', [path, mode]));
    }

    async access(path: RuntimeFsPath, mode: number): Promise<void> {
      return this[CALL](this[FS_READ]('access', [path, mode]));
    }

    async chown(
      path: RuntimeFsPath,
      uid: number | null,
      gid: number | null,
      options?: { followSymlinks?: boolean },
    ): Promise<VfsMutationReceipt> {
      return this[CALL](this[FS_MUTATION]('chown', [path, uid, gid, options]));
    }

    async setUmask(mask: number): Promise<number> {
      return this[CALL](this[FS_OP]('setUmask', [mask]));
    }

    async readdir(path: RuntimeFsPath, options?: { followSymlinks?: boolean }): Promise<{ name: string; type: string }[]> {
      return this[CALL](this[FS_READ]('readdir', options === undefined ? [path] : [path, options]));
    }

    async exists(path: string): Promise<boolean> {
      return this[CALL](this[FS_READ]('exists', [path]));
    }

    async mkdir(path: RuntimeFsPath, options?: Parameters<RuntimeFsBridge['mkdir']>[1]): Promise<void> {
      return this[CALL](this[FS_MUTATION]('mkdir', [path, options]));
    }

    async rmdir(path: RuntimeFsPath): Promise<void> {
      return this[CALL](this[FS_MUTATION]('rmdir', [path]));
    }

    async rename(from: RuntimeFsPath, to: RuntimeFsPath): Promise<void> {
      return this[CALL](this[FS_MUTATION]('rename', [from, to]));
    }

    async unlink(path: RuntimeFsPath): Promise<void> {
      return this[CALL](this[FS_MUTATION]('unlink', [path]));
    }

    async readlink(path: RuntimeFsPath): Promise<string | null> {
      return this[CALL](this[FS_READ]('readlink', [path]));
    }

    async symlink(target: string, path: RuntimeFsPath): Promise<void> {
      return this[CALL](this[FS_MUTATION]('symlink', [target, path]));
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
      return this[CALL](this[FS_READ]('fsAcquire', options === undefined ? [epoch, cursor] : [epoch, cursor, options]));
    }

    /** fsAcquire and one read in a single call (session/rpc.ts _rpcFsAcquired). */
    async fsAcquired(acquire: unknown, op: string, args: unknown[]): Promise<FsAcquiredAnswer> {
      return this[CALL](this[FS_READ]('fsAcquired', [acquire, op, args]));
    }

    async fsRevision(path?: string): Promise<number> {
      return this[CALL](this[FS_READ]('fsRevision', [path]));
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
    async fsStorageGrant(facet: string, bytes: number, databaseSize: number): Promise<{ granted: number; available?: number }> {
      return this[CALL](this[FS_OP]('fsStorageGrant', [facet, bytes, databaseSize]));
    }

    async fsList(after?: string | null, limit?: number | null, options?: VfsListOptions): Promise<VfsListPage> {
      return this[CALL](this[FS_READ]('fsList', options === undefined ? [after ?? null, limit ?? null] : [after ?? null, limit ?? null, options]));
    }

    /** Everything beneath directory `root`, in one page and one revision; E2BIG past `maxEntries` (session/rpc.ts _rpcFsListTree). */
    async fsListTree(root: string, maxEntries: number): Promise<VfsListTree> {
      return this[CALL](this[FS_READ]('fsListTree', [root, maxEntries]));
    }

    /**
     * WebSocket relay. A facet does not open its own sockets: the supervisor
     * terminates them and hands frames back through `wsPoll`, so an inbound
     * frame is a supervisor reply and the facet's frame handler can take the
     * same ACQUIRE every other supervisor-delivered resumption takes. Without
     * it a third party wakes the facet at a time of its own choosing and the
     * facet's next synchronous read serves bytes the authority has replaced.
     */
    async wsOpen(url: string, protocols: string[], headers?: WsRelayHeaders, refusalBody?: boolean): Promise<WsRelayOpened> {
      return this[CALL](this[FS_OP]('wsOpen', [url, protocols, headers ?? [], refusalBody === true]));
    }

    async wsPoll(id: number, waitMs: number): Promise<unknown[]> {
      return this[CALL](this[FS_OP]('wsPoll', [id, waitMs]));
    }

    async wsSend(id: number, text: string | null, bytes: Uint8Array | null): Promise<void> {
      return this[CALL](this[FS_OP]('wsSend', [id, text, bytes]));
    }

    async wsClose(id: number, code?: number, reason?: string): Promise<void> {
      return this[CALL](this[FS_OP]('wsClose', [id, code, reason]));
    }

    async fsOpen(path: RuntimeFsPath, flags: RuntimeOpenFlags): Promise<RuntimeFileHandle> {
      return this[CALL](this[FS_MUTATION]('fsOpen', [path, flags]));
    }

    async fsReopen(...args: Parameters<RuntimeFsBridge['reopen']>): Promise<Awaited<ReturnType<RuntimeFsBridge['reopen']>>> {
      return this[CALL](this[FS_MUTATION]('fsReopen', args));
    }

    async fsReadDirectories(request: ReadDirectoryBatchRequest): Promise<ReadDirectoryBatchResult> {
      return this[CALL](this[FS_MUTATION]('fsReadDirectories', [request]));
    }

    async fsRead(handleId: number, offset: number | null, length: number): Promise<Uint8Array> {
      return this[CALL](this[FS_OP]('fsRead', [handleId, offset, length]));
    }

    async fsWrite(handleId: number, offset: number | null, bytes: Uint8Array | ArrayBuffer | number[]): Promise<number> {
      return this[CALL](this[FS_MUTATION]('fsWrite', [handleId, offset, bytes]));
    }

    /** A descriptor's stat and its directory listing move nothing: re-sent like any read. */
    async fsFstat(...args: Parameters<RuntimeFsBridge['fstat']>): Promise<Awaited<ReturnType<RuntimeFsBridge['fstat']>>> {
      return this[CALL](this[FS_READ]('fsFstat', args));
    }
    async fsDup(...args: Parameters<RuntimeFsBridge['dup']>): Promise<Awaited<ReturnType<RuntimeFsBridge['dup']>>> {
      return this[CALL](this[FS_MUTATION]('fsDup', args));
    }
    async fsSeek(...args: Parameters<RuntimeFsBridge['seek']>): Promise<Awaited<ReturnType<RuntimeFsBridge['seek']>>> {
      return this[CALL](this[FS_MUTATION]('fsSeek', args));
    }
    async fsSetStatus(...args: Parameters<RuntimeFsBridge['setStatus']>): Promise<Awaited<ReturnType<RuntimeFsBridge['setStatus']>>> {
      return this[CALL](this[FS_MUTATION]('fsSetStatus', args));
    }
    async fsReaddirHandle(...args: Parameters<RuntimeFsBridge['readdirHandle']>): Promise<Awaited<ReturnType<RuntimeFsBridge['readdirHandle']>>> {
      return this[CALL](this[FS_READ]('fsReaddirHandle', args));
    }
    async fsFtruncate(...args: Parameters<RuntimeFsBridge['ftruncate']>): Promise<Awaited<ReturnType<RuntimeFsBridge['ftruncate']>>> {
      return this[CALL](this[FS_MUTATION]('fsFtruncate', args));
    }
    async fsFchmod(...args: Parameters<RuntimeFsBridge['fchmod']>): Promise<Awaited<ReturnType<RuntimeFsBridge['fchmod']>>> {
      return this[CALL](this[FS_MUTATION]('fsFchmod', args));
    }
    async fsFchown(...args: Parameters<RuntimeFsBridge['fchown']>): Promise<Awaited<ReturnType<RuntimeFsBridge['fchown']>>> {
      return this[CALL](this[FS_MUTATION]('fsFchown', args));
    }
    async fsFutimes(...args: Parameters<RuntimeFsBridge['futimes']>): Promise<Awaited<ReturnType<RuntimeFsBridge['futimes']>>> {
      return this[CALL](this[FS_MUTATION]('fsFutimes', args));
    }
    async fsSync(...args: Parameters<RuntimeFsBridge['fsync']>): Promise<Awaited<ReturnType<RuntimeFsBridge['fsync']>>> {
      return this[CALL](this[FS_MUTATION]('fsSync', args));
    }
    async fsRealpath(...args: Parameters<RuntimeFsBridge['realpath']>): Promise<Awaited<ReturnType<RuntimeFsBridge['realpath']>>> {
      return this[CALL](this[FS_READ]('fsRealpath', args));
    }
    async fsLinkLeadsTo(...args: Parameters<RuntimeFsBridge['linkLeadsTo']>): Promise<Awaited<ReturnType<RuntimeFsBridge['linkLeadsTo']>>> {
      return this[CALL](this[FS_READ]('fsLinkLeadsTo', args));
    }
    async fsRemove(...args: Parameters<RuntimeFsBridge['remove']>): Promise<Awaited<ReturnType<RuntimeFsBridge['remove']>>> {
      return this[CALL](this[FS_MUTATION]('fsRemove', args));
    }
    async fsCopyFile(...args: Parameters<RuntimeFsBridge['copyFile']>): Promise<Awaited<ReturnType<RuntimeFsBridge['copyFile']>>> {
      return this[CALL](this[FS_MUTATION]('fsCopyFile', args));
    }
    async fsCopyTree(...args: Parameters<RuntimeFsBridge['copyTree']>): Promise<Awaited<ReturnType<RuntimeFsBridge['copyTree']>>> {
      return this[CALL](this[FS_MUTATION]('fsCopyTree', args));
    }
    async fsAcquireExclusiveMutation(...args: Parameters<RuntimeFsBridge['acquireExclusiveMutation']>): Promise<Awaited<ReturnType<RuntimeFsBridge['acquireExclusiveMutation']>>> {
      return this[CALL](this[FS_MUTATION]('fsAcquireExclusiveMutation', args));
    }
    async fsReleaseExclusiveMutation(...args: Parameters<RuntimeFsBridge['releaseExclusiveMutation']>): Promise<Awaited<ReturnType<RuntimeFsBridge['releaseExclusiveMutation']>>> {
      return this[CALL](this[FS_MUTATION]('fsReleaseExclusiveMutation', args));
    }
    /** A delegation's holder waits here for its next recall (a long poll, sent once: a lost one is asked again). */
    async fsAwaitRecall(owner: string, waitMs?: number): Promise<RecallKind | null> {
      return this[CALL](this[FS_OP]('fsAwaitRecall', waitMs === undefined ? [owner] : [owner, waitMs]));
    }
    /** The holder has answered recall `kind`: delivered once. */
    async fsRecalled(owner: string, kind: RecallKind): Promise<void> {
      return this[CALL](this[FS_MUTATION]('fsRecalled', [owner, kind]));
    }
    /** Settled once the process's held writes are published (RuntimeFsBridge.published). */
    async fsPublished(options?: { escape?: boolean }): Promise<void> {
      return this[CALL](this[FS_OP]('fsPublished', options === undefined ? [] : [options]));
    }

    async fsClose(handleId: number): Promise<void> {
      return this[CALL](this[FS_MUTATION]('fsClose', [handleId]));
    }

    /**
     * Stateless ranged ops. Unlike fsOpen/fsRead/fsWrite they carry no
     * server-side handle state, so they stay correct across supervisor
     * hibernation and never rewrite whole files for partial updates.
     */
    async fsReadRange(path: string, offset: number, length: number, options?: RuntimeReadOptions): Promise<Uint8Array | null> {
      return this[CALL](this[FS_READ]('fsReadRange', options === undefined ? [path, offset, length] : [path, offset, length, options]));
    }

    /**
     * The same read with the session's content cache bypassed, for a boot spec's
     * by-path members. They are read once, in slices, straight into a module map;
     * caching one evicts the user's hot working set and pins tens of MiB in the
     * session's heap for the rest of its life.
     */
    async fsReadRangeUncached(path: string, offset: number, length: number): Promise<Uint8Array | null> {
      return this[CALL](this[FS_READ]('fsReadRangeUncached', [path, offset, length]));
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
        return await this[CALL](this[FS_READ]('fsReadBatch', [requests]));
      } finally {
        rpcPayloadEnd(payloadBytes);
      }
    }

    async fsWriteRange(path: string, offset: number, bytes: Uint8Array | ArrayBuffer, options?: Parameters<RuntimeFsBridge['writeRange']>[3]): Promise<VfsMutationReceipt> {
      return this[CALL](this[FS_MUTATION]('fsWriteRange', options === undefined ? [path, offset, bytes] : [path, offset, bytes, options]));
    }

    async fsTruncate(path: string, size: number, options?: Parameters<RuntimeFsBridge['truncate']>[2]): Promise<VfsMutationReceipt> {
      return this[CALL](this[FS_MUTATION]('fsTruncate', options === undefined ? [path, size] : [path, size, options]));
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
        return await this[CALL](this[FS_MUTATION]('writeBatch', [payload]));
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
    /**
     * `first`: the process's first epoch, asked once per run by its writer
     * (process-fs-client): the one minted with this binding answers it, with
     * no round trip, while it is young (a quarter of its life). Any later one
     * is minted anew: a writer that numbers afresh never reuses an epoch.
     */
    async openWaveWriter(first = false): Promise<string | null> {
      if (this[HOST_INCARNATION]() === undefined) return null;
      const props = this[TRANSPORT]().props as { waveWriter?: unknown; waveWriterMintedAt?: unknown } | undefined;
      if (first && typeof props?.waveWriter === 'string' && typeof props.waveWriterMintedAt === 'number'
        && Date.now() - props.waveWriterMintedAt < WAVE_EPOCH_TTL_MS / 4) {
        return props.waveWriter;
      }
      const answer = await this[CALL](this[RESENT]<{ writer: string }>(
        { op: 'openWaveWriter', args: [], pid: this[PID]() },
        { kind: 'open' },
        { hedgeAfterMs: LOST_CALL_HEDGE_AFTER_MS },
      ));
      return answer.writer;
    }

    /**
     * Retire write-wave epoch `writer` (SupervisorDeliveries.retireWaveWriter):
     * its writer gave a wave of it up, and nothing of it may land after what
     * it sends next. Harmless to repeat, so a lost call is re-sent.
     */
    async retireWaveWriter(writer: string): Promise<void> {
      if (this[HOST_INCARNATION]() === undefined) return;
      await this[CALL](this[RESENT]<void>(
        { op: 'retireWaveWriter', args: [writer], pid: this[PID]() },
        { kind: 'open' },
        { hedgeAfterMs: LOST_CALL_HEDGE_AFTER_MS },
      ));
    }

    /**
     * A write wave, sent once: its stream is consumed by the attempt that
     * carries it, so the writer that minted it re-sends a lost wave itself,
     * re-encoded under a newer fence (platform wave-writer.ts, lost-call.ts).
     * On a binding whose host names its incarnation the fence rides with it,
     * and that host instance refuses an attempt older than one it has seen
     * from the same writer; any other instance refuses it outright.
     */
    /**
     * `owner`: the lease the wave is written under, when it is not the one this
     * binding was made with: a delegation the process took at run time.
     */
    async writeBatchStream(
      stream: ReadableStream<Uint8Array>,
      fence?: WaveFence,
      owner?: string,
    ): Promise<WriteBatchStreamResult> {
      // The encoder emits one bounded v2 record per pull. This wrapper-isolate
      // estimate covers that record; the receiving VFS separately reports and
      // enforces its shared 8 MiB retained-payload credit.
      const STREAM_RESIDENT_BYTES = W7_MAX_RECORD_BYTES;
      setLastRpcFrame('writeBatchStream', -1);
      rpcPayloadStart(STREAM_RESIDENT_BYTES);
      try {
        const hostIncarnation = this[HOST_INCARNATION]();
        return await this[CALL](this[RESENT]<WriteBatchStreamResult>({
          op: 'writeBatchStream',
          args: [],
          pid: this[PID](),
          mutationOwner: owner ?? this[MUTATION_OWNER](),
          stream,
          waveFence: fence && hostIncarnation !== undefined ? { ...fence, hostIncarnation } : undefined,
        }, { kind: 'deliver', operationId: fence ? `${fence.writer}:${fence.wave}:${fence.attempt}` : undefined }, { maxAttempts: 1 }));
      } finally {
        rpcPayloadEnd(STREAM_RESIDENT_BYTES);
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
    // Reads and writes cross the session journal like every other operation.
    // Cache-stat events still return to the calling facet for installer folding.
    //
    // Graceful-degrade: if NPM_TARBALL_CACHE / NPM_PACKUMENT_CACHE bindings
    // aren't configured (deploy without R2 buckets, or local dev), the
    // R2CacheClient falls through to null returns / no-op writes; the
    // facet sees null and uses its existing network-fetch path. No errors,

    /**
     * Look up a tarball in the R2 cross-tenant cache by its content
     * address (the resolved npm integrity string). Returns
     * { bytes, events } where:
     *   - bytes: Uint8Array on hit, null on miss/oversize/no-binding
     *   - events: L1/L2/L3 hit/miss tuples captured during this lookup
     *
     * Facets propagate events into their result for installer.ts to fold
     * into the DO singleton (mirroring the recordR2RaceCounters pattern).
     * Without this enrichment the tier distinction is supervisor-side
     * knowledge only. The events list is structured-clone-safe (plain
     * objects + strings + numbers).
     *
     * Returned bytes have already been re-hashed against `integrity` by
     * R2CacheClient — the cross-tenant bucket is untrusted storage, so
     * verification happens at the storage boundary and nowhere else.
     */
    async getCachedTarball(
      integrity: string,
    ): Promise<{ bytes: Uint8Array | null; events: CacheStatEvent[] }> {
      const plan = this[INFRASTRUCTURE_CACHE]('getCachedTarball', [integrity]) ? { readOnly: false }
        : await this[CALL](this[OP]<{ ticket?: string; readOnly: boolean }>('getCachedTarball', [integrity]));
      return this[CACHE_READ](plan, async (client) => {
        const bytes = await client.getTarball(integrity);
        return { bytes: bytes?.length && bytes.length <= MAX_R2_TARBALL_BYTES ? bytes : null, events: client._cacheEvents };
      });
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
      if (!this[INFRASTRUCTURE_CACHE]('putCachedTarball', [integrity, bytes])) await this[CALL](this[OP]('putCachedTarball', [integrity, bytes]));
      return new R2CacheClient((this[TRANSPORT]().env as any)?.NPM_TARBALL_CACHE ?? null, null).putTarball(integrity, bytes);
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
      options?: PackumentReadOptions,
    ): Promise<PackumentReadThrough & { events: CacheStatEvent[] }> {
      const plan = this[INFRASTRUCTURE_CACHE]('getPackument', [name, options]) ? { readOnly: false }
        : await this[CALL](this[OP]<{ ticket?: string; readOnly: boolean }>('getPackument', [name, options]));
      return this[CACHE_READ](plan, async (client) => ({ ...await client.readThroughPackument(name, options, this[NETWORK]()), events: client._cacheEvents }));
    }

    // ── Process I/O ───────────────────────────────────────────────────────
    //
    // A process's stdio is bytes end to end: stdout/stderr up, cpStdinWrite
    // down, cpReadStdin/cpReadOutput/cpDrainOutput in a child's direction. A
    // text producer encodes at its own edge; a text consumer decodes at its.

    // `at` and `run`: where the chunk falls in what the run printed, and which
    // run of the process printed it (runtime/stop-replay.ts, ReplayOutputGate).
    async stdout(data: Uint8Array, at?: number, run?: number): Promise<void> {
      return this[CALL](this[OP]('stdout', at === undefined || run === undefined ? [data] : [data, at, run], { pid: this[REPORTING_PID]() }));
    }

    async stderr(data: Uint8Array, at?: number, run?: number): Promise<void> {
      return this[CALL](this[OP]('stderr', at === undefined || run === undefined ? [data] : [data, at, run], { pid: this[REPORTING_PID]() }));
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
      return this[CALL](this[OP]('reportExit', [code, tail || '', dataReads ?? [], profileUnread ?? null, runtimeCode ?? [], executedModules ?? []], { pid: this[REPORTING_PID]() }));
    }

    /**
     * Persist what a live process learned for its next launch without
     * terminating it: its generated code, the modules it tried to execute and
     * the files it read that its launch lacked (launch-learning-store.ts).
     */
    async reportRuntimeCode(entries: unknown[], executedModules: string[] = [], dataReads: string[] = []): Promise<void> {
      return this[CALL](this[OP]('reportRuntimeCode', [entries, executedModules, dataReads], { pid: this[REPORTING_PID]() }));
    }

    // ── Prefetch ──────────────────────────────────────────────────────────

    async prefetch(cwd: string, entryCode: string): Promise<Record<string, string>> {
      return this[CALL](this[OP]('prefetch', [cwd, entryCode]));
    }

    // ── Port registration ─────────────────────────────────────────────────

    async registerPort(port: number): Promise<void> {
      return this[CALL](this[OP]('registerPort', [port], { pid: this[REPORTING_PID]() }));
    }

    async allocatePort(): Promise<number> {
      return this[CALL](this[OP]('allocatePort', [], { pid: this[REPORTING_PID]() }));
    }

    async unregisterPort(port: number): Promise<void> {
      return this[CALL](this[OP]('unregisterPort', [port], { pid: this[REPORTING_PID]() }));
    }

    /**
     * Route an in-session loopback HTTP request (a facet's fetch to
     * 127.0.0.1/localhost:<port>) to the facet that owns <port> via the session
     * port registry — the same routing the shell curl/node loopback uses. Lets a
     * facet reach another facet's server in-session (e.g. `opencode attach` →
     * `opencode serve`). Returns the target's Response, streamed over RPC.
     *
     * NOT routed through `[CALL]`: that disposes the RPC resource after mapping,
     * which would close a streaming Response body (SSE). We return the RPC promise
     * directly so the body streams to the caller for the response's lifetime —
     * exactly how PortRegistry.routeRequest returns the facet's Response as-is.
     */
    async routeLoopback(port: number, request: Request): Promise<Response> {
      return this[OP]('routeLoopback', [port, request]);
    }

    // ── Esbuild transform ─────────────────────────────────────────────────

    async transform(code: string, loader: string): Promise<{ code: string; map: string } | null> {
      return this[CALL](this[OP]('transform', [code, loader]));
    }

    // ── child_process [W8 Phase 1] ────────────────────────────────────────
    //
    // The parent facet's `child_process.spawn` shim (node-shims.ts) calls
    // these methods. They delegate to NimbusSession._rpcCp* methods which
    // route through the shared ChildProcessManager.
    //

    async cpSpawn(req: any): Promise<{ childPid: number }> {
      return this[CALL](this[OP]('cpSpawn', [{ ...req, parentPid: this[PID]() }]));
    }

    async cpStdinWrite(childPid: number, data: Uint8Array): Promise<{ ok: boolean; signal?: string }> {
      return this[CALL](this[OP]('cpStdinWrite', [childPid, data]));
    }

    async cpStdinEnd(childPid: number): Promise<void> {
      return this[CALL](this[OP]('cpStdinEnd', [childPid]));
    }

    /**
     * The three long polls that deliver to a process — its stdin, and a
     * child's output and exit — carry the process's ACQUIRE arguments, and a
     * reply that delivers anything carries the answer for them (`acquired`,
     * session/rpc.ts `_acquireOnDelivery`), so the process applies it without
     * asking. The caller's pid names whose credential answers it.
     */
    // ── A process that can stop at a read of stdin ─────────────────────────
    // (worker runtime/stop-replay.ts). Its run after a stop reached the read the
    // run before stopped at; a TLS connection it opens through the session.

    async replayBoundary(): Promise<void> {
      return this[CALL](this[OP]('replayBoundary', [], { pid: this[PID]() }));
    }

    /** fd-0 preparation, not a program's ordinary read of this pathname. */
    async stdinFileRead(path: string, offset: number, length: number): Promise<{ data: Uint8Array; size: number }> {
      return this[CALL](this[OP]('stdinFileRead', [path, offset, length]));
    }
    async stdinPrepared(): Promise<void> { return this[CALL](this[OP]('stdinPrepared')); }

    async netTls(action: 'open' | 'upgrade', token: string, payload: Record<string, unknown>): Promise<unknown> {
      const egress = this[NETWORK]().egress;
      if (egress !== undefined) {
        this[CALLER]({ op: 'netTls' });
        if (action !== 'open' && action !== 'upgrade') throw new Error('netTls: unknown action ' + action);
        const hostname = typeof payload.host === 'string' ? payload.host : '';
        const port = Number(payload.port);
        if (!hostname || !Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('netTls: bad target');
        const servername = payload.servername;
        if (servername !== undefined && (typeof servername !== 'string' || servername === '')) throw new TypeError('netTls: bad servername');
        if (typeof egress.connectTls !== 'function') throw Object.assign(new Error(EGRESS_TLS_REFUSAL), { code: 'ERR_NIMBUS_EGRESS_TLS' });
        // The host is Node's servername when the program names none: only another name crosses.
        const target: EgressTlsTarget = servername === undefined || servername === hostname
          ? { hostname, port } : { hostname, port, servername };
        try { return await egress.connectTls(target); }
        catch (error) {
          if (error instanceof TypeError && error.message === 'The RPC receiver does not implement the method "connectTls".') {
            throw Object.assign(new Error(EGRESS_TLS_REFUSAL), { code: 'ERR_NIMBUS_EGRESS_TLS' });
          }
          throw error;
        }
      }
      return this[CALL](this[OP]('netTls', [action, token, payload], { pid: this[PID]() }));
    }

    async cpReadStdin(childPid: number, waitMs: number, acquire?: FsAcquireArgs, maxBytes?: number): Promise<{
      data: Uint8Array;
      ended: boolean;
      resize?: { columns: number; rows: number };
      signal?: string;
      acquired?: VfsDeliveredAcquire;
    }> {
      // The run reading: a run of the process that has stopped takes nothing
      // (worker runtime/stop-replay.ts StdinTaken).
      const writerId = (this[TRANSPORT]().props as { writerId?: unknown } | undefined)?.writerId;
      return this[CALL](this[OP]('cpReadStdin', [childPid, waitMs, acquire ?? null, ...(maxBytes === undefined ? [] : [maxBytes])], {
        pid: this[REPORTING_PID](),
        ...(typeof writerId === 'string' && writerId.length > 0 ? { writerId } : {}),
      }));
    }

    async cpReadOutput(
      childPid: number,
      fd: 1 | 2,
      sinceSeq: number,
      waitMs: number,
      acquire?: FsAcquireArgs,
    ): Promise<{ chunks: { seq: number; data: Uint8Array }[]; closed: boolean; maxSeq: number; news?: number[]; acquired?: VfsDeliveredAcquire }> {
      return this[CALL](this[OP]('cpReadOutput', [childPid, fd, sinceSeq, waitMs, acquire ?? null], { pid: this[REPORTING_PID]() }));
    }

    async cpDrainOutput(childPid: number): Promise<{ stdout: Uint8Array; stderr: Uint8Array; stdoutClosed: boolean; stderrClosed: boolean }> {
      return this[CALL](this[OP]('cpDrainOutput', [childPid]));
    }

    /** The parent closes its read end of the child's fd 1 or 2: the child's writes there fail, EPIPE. */
    async cpCloseOutput(childPid: number, fd: 1 | 2): Promise<void> {
      return this[CALL](this[OP]('cpCloseOutput', [childPid, fd]));
    }

    async cpKill(childPid: number, signal: string): Promise<boolean> {
      return this[CALL](this[OP]('cpKill', [childPid, signal]));
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
      return this[CALL](this[OP]('cpWait', [childPid, waitMs, acquire ?? null, knownStarted !== false], { pid: this[REPORTING_PID]() }));
    }

    /**
     * The next signal sent to this process, whose program takes its own
     * (SessionProcessSupervisor.takeSignals), waiting up to `waitMs` for one:
     * null if none came.
     */
    async cpNextSignal(waitMs: number): Promise<string | null> {
      return this[CALL](this[OP]('cpNextSignal', [waitMs], { pid: this[REPORTING_PID]() }));
    }

    /**
     * This process says whether its only remaining work is waiting on its own
     * children, and the contiguous run of news numbers it has applied (the
     * session's Dynamic Worker ledger tells a wait no release can satisfy by
     * it: fabric budgets.ts setProcessBlocked). `seq` increases per report.
     */
    async cpBlocked(report: { blocked: boolean; frontier: number; seq: number }): Promise<void> {
      return this[CALL](this[OP]('cpBlocked', [report], { pid: this[PID]() }));
    }
  }
  return SupervisorCalls;
}
