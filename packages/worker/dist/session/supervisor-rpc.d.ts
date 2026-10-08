/**
 * supervisor-rpc.ts — WorkerEntrypoint for facet → supervisor IPC.
 *
 * Exported from index.ts. Facets receive `env.SUPERVISOR` service binding
 * pointing to this class via ctx.exports loopback binding.
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
import type { WsRelayHeaders, WsRelayOpened } from './ws-relay.js';
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { WriteFileStatAnswer } from '@nimbus-sh/core/workspace/supervisor-op.js';
import type { PackumentReadThrough } from '../npm/r2-cache.js';
import type { VfsAcquireOptions, VfsAcquireResult, VfsListPage, VfsMutationReceipt, RuntimeFsBridge, RuntimeFsPath, RuntimeOpenFlags, RuntimeFileHandle, RecallKind } from '@nimbus-sh/core/runtime/os-contracts.js';
import { type SupervisorAnswer, type SupervisorAnsweredMethod } from '@nimbus-sh/core/runtime/vfs-supervisor.js';
import type { WriteBatchStreamResult } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import { type FsAcquireArgs, type FsAcquiredAnswer, type FsReadBatchEntry, type FsReadBatchRequest, type VfsDeliveredAcquire } from './rpc.js';
import type { WaveFence } from '@nimbus-sh/platform/wave-writer.js';
import type { CacheStatEvent } from '@nimbus-sh/core/_shared/cache-stats.js';
export declare class SupervisorRPC extends WorkerEntrypoint {
    /**
     * A fresh stub for the host, by the route the binding carries, per call.
     * The platform serves this entrypoint from whichever isolate it likes; the
     * props were minted in the host's.
     */
    private _host;
    private _route;
    private _op;
    /** Every path (including resent reads/mutations) uses the bound caller. */
    private _caller;
    /** Stamp filesystem credentials from the binding, not the supplied arguments. */
    private _fsOp;
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
    private _fsRead;
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
    private _fsMutation;
    /**
     * `envelope`, re-sent as it is on a fresh stub while the platform drops it
     * retryably, in the span that classifies a lost call: `nimbus.supervisor.`
     * `trace.kind`, naming which process and writer sent which operation under
     * which id, how many attempts it took, whether a hedge fired, which
     * attempt answered, and how each lost one failed (fabric do-calls `span`).
     * The session's side of a delivery or a read is its `nimbus.session.*`
     * span, under the RPC span of the attempt that reached it.
     */
    private _resent;
    private _mutationOwner;
    private _hostIncarnation;
    private _reportingPid;
    private _call;
    private _cacheRead;
    private _infrastructureCache;
    /**
     * The network this binding's process reaches out through: its workspace's
     * egress when its host supplied one (SupervisorBindingProps.egress), else
     * this isolate's own. Every request the binding makes for the process —
     * its fetch, its sockets, its packument reads — goes through it.
     */
    private _network;
    private _pid;
    /** The run of the process this binding was minted for, when it has one. */
    private _runId;
    /**
     * The filesystem call `method` (one of SUPERVISOR_ANSWERED_METHODS), with a
     * refusal answered as a value: a facet's client (core vfs-supervisor.ts
     * answeringSupervisor) rethrows it as the error a throw would have
     * delivered. A refusal thrown from here was recorded by the platform as an
     * exception, "canceled ... your Worker's code had hung", although its
     * caller was answered at once. Anything without a code still throws.
     */
    answer(method: SupervisorAnsweredMethod, args: unknown[]): Promise<SupervisorAnswer>;
    readFile(path: string): Promise<string | null>;
    /**
     * Read a file as raw bytes. Used by the git network facet for binary
     * object/pack files where the text readFile would corrupt content.
     */
    readFileBytes(path: RuntimeFsPath): Promise<Uint8Array | null>;
    writeFile(path: RuntimeFsPath, content: string | Uint8Array): Promise<number>;
    /** writeFile, answering the revision and the path's stat after it (supervisor-op.ts writeFileStat). */
    writeFileStat(path: RuntimeFsPath, content: string | Uint8Array): Promise<WriteFileStatAnswer>;
    stat(path: RuntimeFsPath, options?: {
        followSymlinks?: boolean;
    }): Promise<Awaited<ReturnType<RuntimeFsBridge['stat']>>>;
    lstat(path: string): Promise<any>;
    hasLegacySymlinkUnder(path: string): Promise<boolean>;
    utimes(path: RuntimeFsPath, atimeMs: number, mtimeMs: number): Promise<VfsMutationReceipt>;
    chmod(path: RuntimeFsPath, mode: number): Promise<VfsMutationReceipt>;
    access(path: RuntimeFsPath, mode: number): Promise<void>;
    chown(path: RuntimeFsPath, uid: number, gid: number, options?: {
        followSymlinks?: boolean;
    }): Promise<VfsMutationReceipt>;
    setUmask(mask: number): Promise<number>;
    readdir(path: RuntimeFsPath): Promise<{
        name: string;
        type: string;
    }[]>;
    exists(path: string): Promise<boolean>;
    mkdir(path: RuntimeFsPath, options?: Parameters<RuntimeFsBridge['mkdir']>[1]): Promise<void>;
    rmdir(path: RuntimeFsPath): Promise<void>;
    rename(from: RuntimeFsPath, to: RuntimeFsPath): Promise<void>;
    unlink(path: RuntimeFsPath): Promise<void>;
    readlink(path: RuntimeFsPath): Promise<string | null>;
    symlink(target: string, path: RuntimeFsPath): Promise<void>;
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
    fsAcquire(epoch: string | null, cursor: number, options?: VfsAcquireOptions): Promise<VfsAcquireResult>;
    /** fsAcquire and one read in a single call (session/rpc.ts _rpcFsAcquired). */
    fsAcquired(acquire: unknown, op: string, args: unknown[]): Promise<FsAcquiredAnswer>;
    fsRevision(path?: string): Promise<number>;
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
    fsStorageGrant(facet: string, bytes: number, databaseSize: number): Promise<{
        granted: number;
    }>;
    fsList(after?: string | null, limit?: number | null): Promise<VfsListPage>;
    /**
     * WebSocket relay. A facet does not open its own sockets: the supervisor
     * terminates them and hands frames back through `wsPoll`, so an inbound
     * frame is a supervisor reply and the facet's frame handler can take the
     * same ACQUIRE every other supervisor-delivered resumption takes. Without
     * it a third party wakes the facet at a time of its own choosing and the
     * facet's next synchronous read serves bytes the authority has replaced.
     */
    wsOpen(url: string, protocols: string[], headers?: WsRelayHeaders, refusalBody?: boolean): Promise<WsRelayOpened>;
    wsPoll(id: number, waitMs: number): Promise<unknown[]>;
    wsSend(id: number, text: string | null, bytes: Uint8Array | null): Promise<void>;
    wsClose(id: number, code?: number, reason?: string): Promise<void>;
    fsOpen(path: RuntimeFsPath, flags: RuntimeOpenFlags): Promise<RuntimeFileHandle>;
    fsRead(handleId: number, offset: number | null, length: number): Promise<Uint8Array>;
    fsWrite(handleId: number, offset: number | null, bytes: Uint8Array | ArrayBuffer | number[]): Promise<number>;
    /** A descriptor's stat and its directory listing move nothing: re-sent like any read. */
    fsFstat(...args: Parameters<RuntimeFsBridge['fstat']>): Promise<Awaited<ReturnType<RuntimeFsBridge['fstat']>>>;
    fsDup(...args: Parameters<RuntimeFsBridge['dup']>): Promise<Awaited<ReturnType<RuntimeFsBridge['dup']>>>;
    fsSeek(...args: Parameters<RuntimeFsBridge['seek']>): Promise<Awaited<ReturnType<RuntimeFsBridge['seek']>>>;
    fsSetStatus(...args: Parameters<RuntimeFsBridge['setStatus']>): Promise<Awaited<ReturnType<RuntimeFsBridge['setStatus']>>>;
    fsReaddirHandle(...args: Parameters<RuntimeFsBridge['readdirHandle']>): Promise<Awaited<ReturnType<RuntimeFsBridge['readdirHandle']>>>;
    fsFtruncate(...args: Parameters<RuntimeFsBridge['ftruncate']>): Promise<Awaited<ReturnType<RuntimeFsBridge['ftruncate']>>>;
    fsFchmod(...args: Parameters<RuntimeFsBridge['fchmod']>): Promise<Awaited<ReturnType<RuntimeFsBridge['fchmod']>>>;
    fsFchown(...args: Parameters<RuntimeFsBridge['fchown']>): Promise<Awaited<ReturnType<RuntimeFsBridge['fchown']>>>;
    fsFutimes(...args: Parameters<RuntimeFsBridge['futimes']>): Promise<Awaited<ReturnType<RuntimeFsBridge['futimes']>>>;
    fsSync(...args: Parameters<RuntimeFsBridge['fsync']>): Promise<Awaited<ReturnType<RuntimeFsBridge['fsync']>>>;
    fsRealpath(...args: Parameters<RuntimeFsBridge['realpath']>): Promise<Awaited<ReturnType<RuntimeFsBridge['realpath']>>>;
    fsLinkLeadsTo(...args: Parameters<RuntimeFsBridge['linkLeadsTo']>): Promise<Awaited<ReturnType<RuntimeFsBridge['linkLeadsTo']>>>;
    fsRemove(...args: Parameters<RuntimeFsBridge['remove']>): Promise<Awaited<ReturnType<RuntimeFsBridge['remove']>>>;
    fsCopyFile(...args: Parameters<RuntimeFsBridge['copyFile']>): Promise<Awaited<ReturnType<RuntimeFsBridge['copyFile']>>>;
    fsCopyTree(...args: Parameters<RuntimeFsBridge['copyTree']>): Promise<Awaited<ReturnType<RuntimeFsBridge['copyTree']>>>;
    fsAcquireExclusiveMutation(...args: Parameters<RuntimeFsBridge['acquireExclusiveMutation']>): Promise<Awaited<ReturnType<RuntimeFsBridge['acquireExclusiveMutation']>>>;
    fsReleaseExclusiveMutation(...args: Parameters<RuntimeFsBridge['releaseExclusiveMutation']>): Promise<Awaited<ReturnType<RuntimeFsBridge['releaseExclusiveMutation']>>>;
    /** A delegation's holder waits here for its next recall (a long poll, sent once: a lost one is asked again). */
    fsAwaitRecall(owner: string, waitMs?: number): Promise<RecallKind | null>;
    /** The holder has answered recall `kind`: delivered once. */
    fsRecalled(owner: string, kind: RecallKind): Promise<void>;
    fsClose(handleId: number): Promise<void>;
    /**
     * Stateless ranged ops. Unlike fsOpen/fsRead/fsWrite they carry no
     * server-side handle state, so they stay correct across supervisor
     * hibernation and never rewrite whole files for partial updates.
     */
    fsReadRange(path: string, offset: number, length: number): Promise<Uint8Array | null>;
    /**
     * The same read with the session's content cache bypassed, for a boot spec's
     * by-path members. They are read once, in slices, straight into a module map;
     * caching one evicts the user's hot working set and pins tens of MiB in the
     * session's heap for the rest of its life.
     */
    fsReadRangeUncached(path: string, offset: number, length: number): Promise<Uint8Array | null>;
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
    fsReadBatch(requests: FsReadBatchRequest[]): Promise<FsReadBatchEntry[]>;
    fsWriteRange(path: string, offset: number, bytes: Uint8Array | ArrayBuffer): Promise<VfsMutationReceipt>;
    fsTruncate(path: string, size: number): Promise<VfsMutationReceipt>;
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
    writeBatch(payload: any): Promise<{
        inodes: number;
        chunks: number;
    }>;
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
    openWaveWriter(first?: boolean): Promise<string | null>;
    /**
     * Retire write-wave epoch `writer` (SupervisorDeliveries.retireWaveWriter):
     * its writer gave a wave of it up, and nothing of it may land after what
     * it sends next. Harmless to repeat, so a lost call is re-sent.
     */
    retireWaveWriter(writer: string): Promise<void>;
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
    writeBatchStream(stream: ReadableStream<Uint8Array>, fence?: WaveFence, owner?: string): Promise<WriteBatchStreamResult>;
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
    putRegistryEntries(entries: any[]): Promise<{
        written: number;
        failed: number;
    }>;
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
    getCachedTarball(integrity: string): Promise<{
        bytes: Uint8Array | null;
        events: CacheStatEvent[];
    }>;
    /**
     * Store a tarball in the R2 cross-tenant cache under its content
     * address. Best-effort: on R2 write failure, returns false but the
     * install pipeline continues unaffected. Bytes that do not hash to
     * `integrity` are rejected by R2CacheClient.
     */
    putCachedTarball(integrity: string, bytes: Uint8Array | ArrayBuffer): Promise<boolean>;
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
    getPackument(name: string, options?: {
        retries?: number;
        timeoutMs?: number;
        registry?: string;
    }): Promise<PackumentReadThrough & {
        events: CacheStatEvent[];
    }>;
    stdout(data: Uint8Array, at?: number, run?: number): Promise<void>;
    stderr(data: Uint8Array, at?: number, run?: number): Promise<void>;
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
    reportExit(code: number, tail?: string, dataReads?: string[], profileUnread?: string[], runtimeCode?: unknown[], executedModules?: string[]): Promise<void>;
    /**
     * Persist what a live process learned for its next launch without
     * terminating it: its generated code, the modules it tried to execute and
     * the files it read that its launch lacked (launch-learning-store.ts).
     */
    reportRuntimeCode(entries: unknown[], executedModules?: string[], dataReads?: string[]): Promise<void>;
    prefetch(cwd: string, entryCode: string): Promise<Record<string, string>>;
    registerPort(port: number): Promise<void>;
    allocatePort(): Promise<number>;
    unregisterPort(port: number): Promise<void>;
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
    routeLoopback(port: number, request: Request): Promise<Response>;
    transform(code: string, loader: string): Promise<{
        code: string;
        map: string;
    } | null>;
    cpSpawn(req: any): Promise<{
        childPid: number;
    }>;
    cpStdinWrite(childPid: number, data: Uint8Array): Promise<{
        ok: boolean;
        full?: boolean;
    }>;
    cpStdinEnd(childPid: number): Promise<void>;
    /**
     * The three long polls that deliver to a process — its stdin, and a
     * child's output and exit — carry the process's ACQUIRE arguments, and a
     * reply that delivers anything carries the answer for them (`acquired`,
     * session/rpc.ts `_acquireOnDelivery`), so the process applies it without
     * asking. The caller's pid names whose credential answers it.
     */
    replayBoundary(): Promise<void>;
    /** fd-0 preparation, not a program's ordinary read of this pathname. */
    stdinFileRead(path: string, offset: number, length: number): Promise<{
        data: Uint8Array;
        size: number;
    }>;
    stdinPrepared(): Promise<void>;
    netTls(action: 'open' | 'upgrade', token: string, payload: Record<string, unknown>): Promise<unknown>;
    /**
     * The program's network, when this binding is its globalOutbound (a run
     * that can stop): a read is recorded with its bytes and answered again to a
     * run after a stop; anything else is something done outside the process.
     */
    fetch(request: Request): Promise<Response>;
    /**
     * A connection the program opens. One its TLS shim opened is named
     * `<token>.nimbus-net.invalid`: the session says where it goes, and this
     * side makes the TLS session with the server when the program asks for it
     * (netTls 'upgrade'), then carries the plaintext both ways. workerd's
     * outbound connect cannot carry TLS itself ("Incoming CONNECT with TLS not
     * supported", worker-entrypoint.c++), which is why TLS ends here. Any
     * other connection is proxied as it is.
     */
    connect(socket: Socket): Promise<void>;
    cpReadStdin(childPid: number, waitMs: number, acquire?: FsAcquireArgs): Promise<{
        data: Uint8Array;
        ended: boolean;
        resize?: {
            columns: number;
            rows: number;
        };
        signal?: string;
        acquired?: VfsDeliveredAcquire;
    }>;
    cpReadOutput(childPid: number, fd: 1 | 2, sinceSeq: number, waitMs: number, acquire?: FsAcquireArgs): Promise<{
        chunks: {
            seq: number;
            data: Uint8Array;
        }[];
        closed: boolean;
        maxSeq: number;
        news?: number[];
        acquired?: VfsDeliveredAcquire;
    }>;
    cpDrainOutput(childPid: number): Promise<{
        stdout: Uint8Array;
        stderr: Uint8Array;
        stdoutClosed: boolean;
        stderrClosed: boolean;
    }>;
    cpKill(childPid: number, signal: string): Promise<boolean>;
    /**
     * The child's end; with `knownStarted` false, also its start, as soon as
     * it comes (`started`), for a parent that emits 'spawn' on it.
     */
    cpWait(childPid: number, waitMs: number, acquire?: FsAcquireArgs, knownStarted?: boolean): Promise<{
        done: boolean;
        exitCode: number | null;
        signal: string | null;
        spawnError?: string;
        started?: boolean;
        news?: number[];
        acquired?: VfsDeliveredAcquire;
    }>;
    /**
     * This process says whether its only remaining work is waiting on its own
     * children, and the contiguous run of news numbers it has applied (the
     * session's Dynamic Worker ledger tells a wait no release can satisfy by
     * it: fabric budgets.ts setProcessBlocked). `seq` increases per report.
     */
    cpBlocked(report: {
        blocked: boolean;
        frontier: number;
        seq: number;
    }): Promise<void>;
}
//# sourceMappingURL=supervisor-rpc.d.ts.map