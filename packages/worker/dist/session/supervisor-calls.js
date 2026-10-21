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
import { EGRESS_TLS_REFUSAL, ISOLATE_NETWORK, workspaceNetwork } from '@nimbus-sh/core/_shared/workspace-network.js';
import { SUPERVISOR_DELIVER_OP, } from '@nimbus-sh/core/workspace/supervisor-delivery.js';
import { VFS_DELIVERY_RETRY_WINDOW_MS } from '@nimbus-sh/core/constants.js';
// W5: OOM discriminator — record last-known RPC frame on writeBatch entry
import { setLastRpcFrame } from '@nimbus-sh/platform/oom-discriminator.js';
import { recordFailure } from '../runtime/stop-replay-body.js';
// Phase 2 A'.2 — supervisor in-flight RPC payload byte tracking.
import { rpcPayloadStart, rpcPayloadEnd } from '@nimbus-sh/platform/diag-counters.js';
import { useRpcResource } from '@nimbus-sh/platform/rpc-dispose.js';
import { isSupervisorAnsweredMethod, supervisorAnswer, } from '@nimbus-sh/core/runtime/vfs-supervisor.js';
import { fsReadBatchRequestBytes } from './rpc.js';
import { W7_MAX_RECORD_BYTES } from '@nimbus-sh/platform/w7-frame.js';
import { LOST_CALL_HEDGE_AFTER_MS, WAVE_EPOCH_TTL_MS } from '@nimbus-sh/platform/lost-call.js';
/**
 * The npm cache client, loaded at its first use: it links the npm engine,
 * which no other call needs, and a host Worker's isolates all evaluate what
 * its re-exported SupervisorRPC links statically, at startup (ask 56).
 */
const npmCache = () => import('../npm/r2-cache.js');
/**
 * W5 Lever 5: estimate the byte-cost of a writeBatch payload so the
 * /api/_diag/memory.rpc.lastFrame.payloadBytes field is meaningful.
 * Counts chunk data bytes + per-inode header overhead. Fast (no copy).
 */
function _estimateWriteBatchBytes(payload) {
    if (!payload)
        return 0;
    let n = 0;
    const chunks = payload.chunks ?? [];
    for (const c of chunks) {
        n += (c?.data?.length ?? c?.data?.byteLength ?? 0);
    }
    const inodes = payload.inodes ?? [];
    for (const i of inodes)
        n += 80 + (i?.path?.length ?? 0);
    return n;
}
export const TRANSPORT = Symbol('supervisor transport');
// The binding's calls of itself: behind symbols too, for the same reason.
// Its process names only the methods below them (readFile, cpSpawn, …), each
// of which builds its own envelope.
export const OP = Symbol('supervisor op');
export const CALLER = Symbol('supervisor caller');
export const FS_OP = Symbol('supervisor fsOp');
export const FS_READ = Symbol('supervisor fsRead');
export const FS_MUTATION = Symbol('supervisor fsMutation');
export const RESENT = Symbol('supervisor resent');
export const MUTATION_OWNER = Symbol('supervisor mutationOwner');
export const HOST_INCARNATION = Symbol('supervisor hostIncarnation');
export const REPORTING_PID = Symbol('supervisor reportingPid');
export const CALL = Symbol('supervisor call');
export const CACHE_READ = Symbol('supervisor cacheRead');
export const INFRASTRUCTURE_CACHE = Symbol('supervisor infrastructureCache');
export const NETWORK = Symbol('supervisor network');
export const PID = Symbol('supervisor pid');
export const RUN_ID = Symbol('supervisor runId');
/**
 * Everything a process's SUPERVISOR answers, over either transport: a
 * binding (SupervisorRPC) or the capability its host hands a one-shot in
 * the call that runs it (ProcessSupervisor).
 */
export function supervisorCalls(base) {
    class SupervisorCalls extends base {
        [OP](op, args = [], extra = {}) {
            // Every call says which run of the process made it: a process that can
            // stop at a read of stdin is answered for its current run only.
            return this[TRANSPORT]().send(this[CALLER]({ op, args, ...extra }));
        }
        /** Every path (including resent reads/mutations) uses the bound caller. */
        [CALLER](envelope) {
            const props = this[TRANSPORT]().props;
            const pid = props?.pid;
            // The spawn/build helper has the explicitly bound pid 0. It is not a
            // process and cannot use filesystem credentials ([PID] still refuses it).
            if (typeof pid !== 'number' || !Number.isInteger(pid) || pid < 0)
                throw new Error('SupervisorRPC: missing or invalid caller pid in props');
            const run = this[RUN_ID]();
            if (props?.bindingKind === 'infrastructure') {
                if (run !== undefined)
                    throw new Error('infrastructure supervisor cannot carry a process run');
                if (['stdout', 'stderr', 'reportExit', 'reportRuntimeCode', 'cpSpawn', 'cpStdinWrite', 'cpStdinEnd', 'cpReadStdin', 'cpReadOutput', 'cpDrainOutput', 'cpCloseOutput', 'cpKill', 'cpWait', 'cpNextSignal', 'cpCatchSignals', 'cpTakeSignal', 'cpBlocked', 'replayBoundary', 'stdinFileRead', 'stdinPrepared', 'netTls', 'outbound'].includes(envelope.op)) {
                    throw new Error('infrastructure supervisor refuses guest-originated operations');
                }
            }
            else if (run === undefined)
                throw new Error('process supervisor binding requires a run');
            return { ...envelope, pid, run };
        }
        /** Stamp filesystem credentials from the binding, not the supplied arguments. */
        [FS_OP](op, args = []) {
            return this[OP](op, args, { pid: this[PID]() });
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
        [FS_READ](op, args = []) {
            return this[RESENT]({ op, args, pid: this[PID](), readId: crypto.randomUUID() }, { kind: 'read' }, { hedgeAfterMs: LOST_CALL_HEDGE_AFTER_MS });
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
        [FS_MUTATION](op, args) {
            const hostIncarnation = this[HOST_INCARNATION]();
            // A binding minted under an exclusive mutation lease presents it on every
            // mutation, as writeBatchStream does: the leased writer's own ranged
            // writes land under its root, and every other writer's are EBUSY.
            const mutationOwner = this[MUTATION_OWNER]();
            const lease = mutationOwner === undefined ? {} : { mutationOwner };
            if (hostIncarnation === undefined)
                return this[OP](op, args, { pid: this[PID](), ...lease });
            const id = crypto.randomUUID();
            return this[RESENT]({ op: SUPERVISOR_DELIVER_OP, args, pid: this[PID](), delivery: { op, id, hostIncarnation }, ...lease }, { kind: 'deliver', operationId: id }, { retryWindowMs: VFS_DELIVERY_RETRY_WINDOW_MS });
        }
        /** `envelope`, sent as `trace.kind`, and re-sent as `policy` says where the platform can drop it. */
        [RESENT](envelope, trace, policy) {
            return this[TRANSPORT]().send(this[CALLER](envelope), { trace, policy });
        }
        [MUTATION_OWNER]() {
            const props = this[TRANSPORT]().props;
            if (typeof props !== 'object' || props === null || !('mutationOwner' in props))
                return undefined;
            return typeof props.mutationOwner === 'string' ? props.mutationOwner : undefined;
        }
        [HOST_INCARNATION]() {
            const props = this[TRANSPORT]().props;
            if (typeof props !== 'object' || props === null || !('hostIncarnation' in props))
                return undefined;
            const incarnation = props.hostIncarnation;
            return typeof incarnation === 'string' && incarnation.length > 0 ? incarnation : undefined;
        }
        [REPORTING_PID]() {
            const pid = this[TRANSPORT]().props?.pid;
            return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : 0;
        }
        async [CALL](promise) {
            const value = await useRpcResource(promise, (reply) => reply);
            if (value !== null && (typeof value === 'object' || typeof value === 'function') && Object.hasOwn(value, Symbol.dispose)) {
                Reflect.deleteProperty(value, Symbol.dispose);
            }
            return value;
        }
        async [CACHE_READ](plan, produce) {
            let value;
            // The client's module loads inside the read: a run's ticket is answered however it fails.
            try {
                const cache = await npmCache();
                const client = new cache.R2CacheClient(this[TRANSPORT]().env?.NPM_TARBALL_CACHE ?? null, this[TRANSPORT]().env?.NPM_PACKUMENT_CACHE ?? null, plan.readOnly);
                value = await produce(client, cache);
            }
            catch (error) {
                if (plan.ticket)
                    await this[CALL](this[OP]('cacheResult', [plan.ticket, { failed: true, failure: recordFailure(error) }]));
                throw error;
            }
            if (plan.ticket)
                await this[CALL](this[OP]('cacheResult', [plan.ticket, { value }]));
            return value;
        }
        [INFRASTRUCTURE_CACHE](op, args) {
            const caller = this[CALLER]({ op, args });
            return this[TRANSPORT]().props?.bindingKind === 'infrastructure' && caller.run === undefined;
        }
        /**
         * The network this binding's process reaches out through: its workspace's
         * egress when its host supplied one (SupervisorBindingProps.egress), else
         * this isolate's own. Every request the binding makes for the process —
         * its fetch, its sockets, its packument reads — goes through it.
         */
        [NETWORK]() {
            const props = this[TRANSPORT]().props;
            return props?.egress === undefined ? ISOLATE_NETWORK : workspaceNetwork(props.egress, props.networkId);
        }
        [PID]() {
            const pid = this[TRANSPORT]().props?.pid;
            if (!Number.isInteger(pid) || typeof pid !== 'number' || pid <= 0) {
                throw new Error('SupervisorRPC: missing or invalid process pid in props');
            }
            return pid;
        }
        /** The run of the process this binding was minted for, when it has one. */
        [RUN_ID]() {
            const run = this[TRANSPORT]().props?.writerId;
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
        async answer(method, args) {
            if (!isSupervisorAnsweredMethod(method) || !Array.isArray(args)) {
                throw new TypeError(`SupervisorRPC.answer: ${JSON.stringify(method)} is not a filesystem call`);
            }
            return supervisorAnswer(() => Reflect.apply(this[method], this, args));
        }
        async readFile(path) {
            return this[CALL](this[FS_READ]('readFile', [path]));
        }
        /**
         * Read a file as raw bytes. Used by the git network facet for binary
         * object/pack files where the text readFile would corrupt content.
         */
        async readFileBytes(path, options) {
            return this[CALL](this[FS_READ]('readFileBytes', options === undefined ? [path] : [path, options]));
        }
        async writeFile(path, content, options) {
            // binary-fs wave: accept Uint8Array natively. Pre-fix this RPC was
            // string-only, which forced node-shims.ts:writeFileSync to UTF-8-
            // decode every Uint8Array write — mangling bytes ≥ 0x80 to U+FFFD
            // and corrupting binary content. RPC structured-clone handles
            // Uint8Array transparently; downstream _rpcWriteFile also accepts
            return this[CALL](this[FS_MUTATION]('writeFile', options === undefined ? [path, content] : [path, content, options]));
        }
        /** writeFile, answering the revision and the path's stat after it (supervisor-op.ts writeFileStat). */
        async writeFileStat(path, content) {
            return this[CALL](this[FS_MUTATION]('writeFileStat', [path, content]));
        }
        async stat(path, options) {
            return this[CALL](this[FS_READ]('stat', [path, options]));
        }
        async lstat(path) {
            return this[CALL](this[FS_READ]('lstat', [path]));
        }
        async utimes(...args) {
            return this[CALL](this[FS_MUTATION]('utimes', args));
        }
        async chmod(path, mode) {
            return this[CALL](this[FS_MUTATION]('chmod', [path, mode]));
        }
        async access(path, mode) {
            return this[CALL](this[FS_READ]('access', [path, mode]));
        }
        async chown(path, uid, gid, options) {
            return this[CALL](this[FS_MUTATION]('chown', [path, uid, gid, options]));
        }
        async setUmask(mask) {
            return this[CALL](this[FS_OP]('setUmask', [mask]));
        }
        async readdir(path, options) {
            return this[CALL](this[FS_READ]('readdir', options === undefined ? [path] : [path, options]));
        }
        async exists(path) {
            return this[CALL](this[FS_READ]('exists', [path]));
        }
        async mkdir(path, options) {
            return this[CALL](this[FS_MUTATION]('mkdir', [path, options]));
        }
        async rmdir(path) {
            return this[CALL](this[FS_MUTATION]('rmdir', [path]));
        }
        async rename(from, to) {
            return this[CALL](this[FS_MUTATION]('rename', [from, to]));
        }
        async unlink(path) {
            return this[CALL](this[FS_MUTATION]('unlink', [path]));
        }
        async readlink(path) {
            return this[CALL](this[FS_READ]('readlink', [path]));
        }
        async symlink(target, path) {
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
        async fsAcquire(epoch, cursor, options) {
            return this[CALL](this[FS_READ]('fsAcquire', options === undefined ? [epoch, cursor] : [epoch, cursor, options]));
        }
        /** fsAcquire and one read in a single call (session/rpc.ts _rpcFsAcquired). */
        async fsAcquired(acquire, op, args) {
            return this[CALL](this[FS_READ]('fsAcquired', [acquire, op, args]));
        }
        async fsRevision(path) {
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
        async fsStorageGrant(facet, bytes, databaseSize) {
            return this[CALL](this[FS_OP]('fsStorageGrant', [facet, bytes, databaseSize]));
        }
        async fsList(after, limit, options) {
            return this[CALL](this[FS_READ]('fsList', options === undefined ? [after ?? null, limit ?? null] : [after ?? null, limit ?? null, options]));
        }
        /** Everything beneath directory `root`, in one page and one revision; E2BIG past `maxEntries` (session/rpc.ts _rpcFsListTree). */
        async fsListTree(root, maxEntries) {
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
        async wsOpen(url, protocols, headers, refusalBody) {
            return this[CALL](this[FS_OP]('wsOpen', [url, protocols, headers ?? [], refusalBody === true]));
        }
        async wsPoll(id, waitMs) {
            return this[CALL](this[FS_OP]('wsPoll', [id, waitMs]));
        }
        async wsSend(id, text, bytes) {
            return this[CALL](this[FS_OP]('wsSend', [id, text, bytes]));
        }
        async wsClose(id, code, reason) {
            return this[CALL](this[FS_OP]('wsClose', [id, code, reason]));
        }
        async fsOpen(path, flags) {
            return this[CALL](this[FS_MUTATION]('fsOpen', [path, flags]));
        }
        async fsReopen(...args) {
            return this[CALL](this[FS_MUTATION]('fsReopen', args));
        }
        async fsReadDirectories(request) {
            return this[CALL](this[FS_MUTATION]('fsReadDirectories', [request]));
        }
        async fsRead(handleId, offset, length) {
            return this[CALL](this[FS_OP]('fsRead', [handleId, offset, length]));
        }
        async fsWrite(handleId, offset, bytes) {
            return this[CALL](this[FS_MUTATION]('fsWrite', [handleId, offset, bytes]));
        }
        /** A descriptor's stat and its directory listing move nothing: re-sent like any read. */
        async fsFstat(...args) {
            return this[CALL](this[FS_READ]('fsFstat', args));
        }
        async fsDup(...args) {
            return this[CALL](this[FS_MUTATION]('fsDup', args));
        }
        async fsSeek(...args) {
            return this[CALL](this[FS_MUTATION]('fsSeek', args));
        }
        async fsSetStatus(...args) {
            return this[CALL](this[FS_MUTATION]('fsSetStatus', args));
        }
        async fsReaddirHandle(...args) {
            return this[CALL](this[FS_READ]('fsReaddirHandle', args));
        }
        async fsFtruncate(...args) {
            return this[CALL](this[FS_MUTATION]('fsFtruncate', args));
        }
        async fsFchmod(...args) {
            return this[CALL](this[FS_MUTATION]('fsFchmod', args));
        }
        async fsFchown(...args) {
            return this[CALL](this[FS_MUTATION]('fsFchown', args));
        }
        async fsFutimes(...args) {
            return this[CALL](this[FS_MUTATION]('fsFutimes', args));
        }
        async fsSync(...args) {
            return this[CALL](this[FS_MUTATION]('fsSync', args));
        }
        async fsRealpath(...args) {
            return this[CALL](this[FS_READ]('fsRealpath', args));
        }
        async fsLinkLeadsTo(...args) {
            return this[CALL](this[FS_READ]('fsLinkLeadsTo', args));
        }
        async fsRemove(...args) {
            return this[CALL](this[FS_MUTATION]('fsRemove', args));
        }
        async fsCopyFile(...args) {
            return this[CALL](this[FS_MUTATION]('fsCopyFile', args));
        }
        async fsCopyTree(...args) {
            return this[CALL](this[FS_MUTATION]('fsCopyTree', args));
        }
        async fsAcquireExclusiveMutation(...args) {
            return this[CALL](this[FS_MUTATION]('fsAcquireExclusiveMutation', args));
        }
        async fsReleaseExclusiveMutation(...args) {
            return this[CALL](this[FS_MUTATION]('fsReleaseExclusiveMutation', args));
        }
        /** A delegation's holder waits here for its next recall (a long poll, sent once: a lost one is asked again). */
        async fsAwaitRecall(owner, waitMs) {
            return this[CALL](this[FS_OP]('fsAwaitRecall', waitMs === undefined ? [owner] : [owner, waitMs]));
        }
        /** The holder has answered recall `kind`: delivered once. */
        async fsRecalled(owner, kind) {
            return this[CALL](this[FS_MUTATION]('fsRecalled', [owner, kind]));
        }
        /** Settled once the process's held writes are published (RuntimeFsBridge.published). */
        async fsPublished(options) {
            return this[CALL](this[FS_OP]('fsPublished', options === undefined ? [] : [options]));
        }
        async fsClose(handleId) {
            return this[CALL](this[FS_MUTATION]('fsClose', [handleId]));
        }
        /**
         * Stateless ranged ops. Unlike fsOpen/fsRead/fsWrite they carry no
         * server-side handle state, so they stay correct across supervisor
         * hibernation and never rewrite whole files for partial updates.
         */
        async fsReadRange(path, offset, length, options) {
            return this[CALL](this[FS_READ]('fsReadRange', options === undefined ? [path, offset, length] : [path, offset, length, options]));
        }
        /**
         * The same read with the session's content cache bypassed, for a boot spec's
         * by-path members. They are read once, in slices, straight into a module map;
         * caching one evicts the user's hot working set and pins tens of MiB in the
         * session's heap for the rest of its life.
         */
        async fsReadRangeUncached(path, offset, length) {
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
        async fsReadBatch(requests) {
            // The requested total is the batch's payload ceiling: every entry
            // returns at most the range asked for. Counting it keeps the
            // supervisor's heap estimate honest for the duration of the await, the
            // same accounting writeBatch does for its inbound payload.
            const payloadBytes = requests.reduce((total, request) => total + fsReadBatchRequestBytes(request), 0);
            setLastRpcFrame('fsReadBatch', payloadBytes);
            rpcPayloadStart(payloadBytes);
            try {
                return await this[CALL](this[FS_READ]('fsReadBatch', [requests]));
            }
            finally {
                rpcPayloadEnd(payloadBytes);
            }
        }
        async fsWriteRange(path, offset, bytes, options) {
            return this[CALL](this[FS_MUTATION]('fsWriteRange', options === undefined ? [path, offset, bytes] : [path, offset, bytes, options]));
        }
        async fsTruncate(path, size, options) {
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
        async writeBatch(payload) {
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
            }
            finally {
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
        async openWaveWriter(first = false) {
            if (this[HOST_INCARNATION]() === undefined)
                return null;
            const props = this[TRANSPORT]().props;
            if (first && typeof props?.waveWriter === 'string' && typeof props.waveWriterMintedAt === 'number'
                && Date.now() - props.waveWriterMintedAt < WAVE_EPOCH_TTL_MS / 4) {
                return props.waveWriter;
            }
            const answer = await this[CALL](this[RESENT]({ op: 'openWaveWriter', args: [], pid: this[PID]() }, { kind: 'open' }, { hedgeAfterMs: LOST_CALL_HEDGE_AFTER_MS }));
            return answer.writer;
        }
        /**
         * Retire write-wave epoch `writer` (SupervisorDeliveries.retireWaveWriter):
         * its writer gave a wave of it up, and nothing of it may land after what
         * it sends next. Harmless to repeat, so a lost call is re-sent.
         */
        async retireWaveWriter(writer) {
            if (this[HOST_INCARNATION]() === undefined)
                return;
            await this[CALL](this[RESENT]({ op: 'retireWaveWriter', args: [writer], pid: this[PID]() }, { kind: 'open' }, { hedgeAfterMs: LOST_CALL_HEDGE_AFTER_MS }));
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
        async writeBatchStream(stream, fence, owner) {
            // The encoder emits one bounded v2 record per pull. This wrapper-isolate
            // estimate covers that record; the receiving VFS separately reports and
            // enforces its shared 8 MiB retained-payload credit.
            const STREAM_RESIDENT_BYTES = W7_MAX_RECORD_BYTES;
            setLastRpcFrame('writeBatchStream', -1);
            rpcPayloadStart(STREAM_RESIDENT_BYTES);
            try {
                const hostIncarnation = this[HOST_INCARNATION]();
                return await this[CALL](this[RESENT]({
                    op: 'writeBatchStream',
                    args: [],
                    pid: this[PID](),
                    mutationOwner: owner ?? this[MUTATION_OWNER](),
                    stream,
                    waveFence: fence && hostIncarnation !== undefined ? { ...fence, hostIncarnation } : undefined,
                }, { kind: 'deliver', operationId: fence ? `${fence.writer}:${fence.wave}:${fence.attempt}` : undefined }, { maxAttempts: 1 }));
            }
            finally {
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
        async getCachedTarball(integrity) {
            const plan = this[INFRASTRUCTURE_CACHE]('getCachedTarball', [integrity]) ? { readOnly: false }
                : await this[CALL](this[OP]('getCachedTarball', [integrity]));
            return this[CACHE_READ](plan, async (client, { MAX_R2_TARBALL_BYTES }) => {
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
        async putCachedTarball(integrity, bytes) {
            // L4 hits are captured FACET-SIDE in cache-obs-2 — the facet did
            // the registry fetch, so it can push the L4 event directly into
            // its own cacheStatEvents list before calling putCachedTarball.
            // This RPC remains a one-way write (returns bool); the L4 event
            // does NOT flow through this return path.
            if (!this[INFRASTRUCTURE_CACHE]('putCachedTarball', [integrity, bytes]))
                await this[CALL](this[OP]('putCachedTarball', [integrity, bytes]));
            const { R2CacheClient } = await npmCache();
            return new R2CacheClient(this[TRANSPORT]().env?.NPM_TARBALL_CACHE ?? null, null).putTarball(integrity, bytes);
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
        async getPackument(name, options) {
            const plan = this[INFRASTRUCTURE_CACHE]('getPackument', [name, options]) ? { readOnly: false }
                : await this[CALL](this[OP]('getPackument', [name, options]));
            return this[CACHE_READ](plan, async (client) => ({ ...await client.readThroughPackument(name, options, this[NETWORK]()), events: client._cacheEvents }));
        }
        // ── Process I/O ───────────────────────────────────────────────────────
        //
        // A process's stdio is bytes end to end: stdout/stderr up, cpStdinWrite
        // down, cpReadStdin/cpReadOutput/cpDrainOutput in a child's direction. A
        // text producer encodes at its own edge; a text consumer decodes at its.
        // `at` and `run`: where the chunk falls in what the run printed, and which
        // run of the process printed it (runtime/stop-replay.ts, ReplayOutputGate).
        async stdout(data, at, run) {
            return this[CALL](this[OP]('stdout', at === undefined || run === undefined ? [data] : [data, at, run], { pid: this[REPORTING_PID]() }));
        }
        async stderr(data, at, run) {
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
        async reportExit(code, tail, dataReads, profileUnread, runtimeCode, executedModules) {
            return this[CALL](this[OP]('reportExit', [code, tail || '', dataReads ?? [], profileUnread ?? null, runtimeCode ?? [], executedModules ?? []], { pid: this[REPORTING_PID]() }));
        }
        /**
         * Persist what a live process learned for its next launch without
         * terminating it: its generated code, the modules it tried to execute and
         * the files it read that its launch lacked (launch-learning-store.ts).
         */
        async reportRuntimeCode(entries, executedModules = [], dataReads = []) {
            return this[CALL](this[OP]('reportRuntimeCode', [entries, executedModules, dataReads], { pid: this[REPORTING_PID]() }));
        }
        // ── Prefetch ──────────────────────────────────────────────────────────
        async prefetch(cwd, entryCode) {
            return this[CALL](this[OP]('prefetch', [cwd, entryCode]));
        }
        // ── Port registration ─────────────────────────────────────────────────
        async registerPort(port) {
            return this[CALL](this[OP]('registerPort', [port], { pid: this[REPORTING_PID]() }));
        }
        async allocatePort() {
            return this[CALL](this[OP]('allocatePort', [], { pid: this[REPORTING_PID]() }));
        }
        async unregisterPort(port) {
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
        async routeLoopback(port, request) {
            return this[OP]('routeLoopback', [port, request]);
        }
        // ── Esbuild transform ─────────────────────────────────────────────────
        async transform(code, loader) {
            return this[CALL](this[OP]('transform', [code, loader]));
        }
        // ── child_process [W8 Phase 1] ────────────────────────────────────────
        //
        // The parent facet's `child_process.spawn` shim (node-shims.ts) calls
        // these methods. They delegate to NimbusSession._rpcCp* methods which
        // route through the shared ChildProcessManager.
        //
        async cpSpawn(req) {
            return this[CALL](this[OP]('cpSpawn', [{ ...req, parentPid: this[PID]() }]));
        }
        async cpStdinWrite(childPid, data) {
            return this[CALL](this[OP]('cpStdinWrite', [childPid, data]));
        }
        async cpStdinEnd(childPid) {
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
        async replayBoundary() {
            return this[CALL](this[OP]('replayBoundary', [], { pid: this[PID]() }));
        }
        /** fd-0 preparation, not a program's ordinary read of this pathname. */
        async stdinFileRead(path, offset, length) {
            return this[CALL](this[OP]('stdinFileRead', [path, offset, length]));
        }
        async stdinPrepared() { return this[CALL](this[OP]('stdinPrepared')); }
        async netTls(action, token, payload) {
            const egress = this[NETWORK]().egress;
            if (egress !== undefined) {
                this[CALLER]({ op: 'netTls' });
                if (action !== 'open' && action !== 'upgrade')
                    throw new Error('netTls: unknown action ' + action);
                const hostname = typeof payload.host === 'string' ? payload.host : '';
                const port = Number(payload.port);
                if (!hostname || !Number.isInteger(port) || port < 1 || port > 65535)
                    throw new TypeError('netTls: bad target');
                const servername = payload.servername;
                if (servername !== undefined && (typeof servername !== 'string' || servername === ''))
                    throw new TypeError('netTls: bad servername');
                if (typeof egress.connectTls !== 'function')
                    throw Object.assign(new Error(EGRESS_TLS_REFUSAL), { code: 'ERR_NIMBUS_EGRESS_TLS' });
                // The host is Node's servername when the program names none: only another name crosses.
                const target = servername === undefined || servername === hostname
                    ? { hostname, port } : { hostname, port, servername };
                try {
                    return await egress.connectTls(target);
                }
                catch (error) {
                    if (error instanceof TypeError && error.message === 'The RPC receiver does not implement the method "connectTls".') {
                        throw Object.assign(new Error(EGRESS_TLS_REFUSAL), { code: 'ERR_NIMBUS_EGRESS_TLS' });
                    }
                    throw error;
                }
            }
            return this[CALL](this[OP]('netTls', [action, token, payload], { pid: this[PID]() }));
        }
        async cpReadStdin(childPid, waitMs, acquire, maxBytes) {
            // The run reading: a run of the process that has stopped takes nothing
            // (worker runtime/stop-replay.ts StdinTaken).
            const writerId = this[TRANSPORT]().props?.writerId;
            return this[CALL](this[OP]('cpReadStdin', [childPid, waitMs, acquire ?? null, ...(maxBytes === undefined ? [] : [maxBytes])], {
                pid: this[REPORTING_PID](),
                ...(typeof writerId === 'string' && writerId.length > 0 ? { writerId } : {}),
            }));
        }
        async cpReadOutput(childPid, fd, sinceSeq, waitMs, acquire) {
            return this[CALL](this[OP]('cpReadOutput', [childPid, fd, sinceSeq, waitMs, acquire ?? null], { pid: this[REPORTING_PID]() }));
        }
        async cpDrainOutput(childPid) {
            return this[CALL](this[OP]('cpDrainOutput', [childPid]));
        }
        /** The parent closes its read end of the child's fd 1 or 2: the child's writes there fail, EPIPE. */
        async cpCloseOutput(childPid, fd) {
            return this[CALL](this[OP]('cpCloseOutput', [childPid, fd]));
        }
        async cpKill(childPid, signal) {
            return this[CALL](this[OP]('cpKill', [childPid, signal]));
        }
        /**
         * The child's end; with `knownStarted` false, also its start, as soon as
         * it comes (`started`), for a parent that emits 'spawn' on it.
         */
        async cpWait(childPid, waitMs, acquire, knownStarted) {
            return this[CALL](this[OP]('cpWait', [childPid, waitMs, acquire ?? null, knownStarted !== false], { pid: this[REPORTING_PID]() }));
        }
        /**
         * The next signal sent to this process, whose program takes its own
         * (SessionProcessSupervisor.takeSignals), waiting up to `waitMs` for one:
         * null if none came.
         */
        async cpNextSignal(waitMs) {
            return this[CALL](this[OP]('cpNextSignal', [waitMs], { pid: this[REPORTING_PID]() }));
        }
        /** The next signal sent to this Node process, its box taken back from a stop: cpNextSignal's, asked only past a replay's boundary. */
        async cpTakeSignal(waitMs) {
            return this[CALL](this[OP]('cpTakeSignal', [waitMs], { pid: this[REPORTING_PID]() }));
        }
        /** The signals this process's program catches now: each one sent to it is its own to take (cpNextSignal), any other its default. */
        async cpCatchSignals(catches) {
            return this[CALL](this[OP]('cpCatchSignals', [catches], { pid: this[REPORTING_PID]() }));
        }
        /**
         * This process says whether its only remaining work is waiting on its own
         * children, and the contiguous run of news numbers it has applied (the
         * session's Dynamic Worker ledger tells a wait no release can satisfy by
         * it: fabric budgets.ts setProcessBlocked). `seq` increases per report.
         */
        async cpBlocked(report) {
            return this[CALL](this[OP]('cpBlocked', [report], { pid: this[PID]() }));
        }
    }
    return SupervisorCalls;
}
