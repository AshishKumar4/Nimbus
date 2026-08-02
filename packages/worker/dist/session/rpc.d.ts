/**
 * session/rpc.ts — Supervisor RPC + W8 child_process + legacy VFS impls.
 *
 * Why free-functions instead of class methods:
 * the DO RPC fabric calls these by name, so the supervisor's class
 * MUST keep the method names as delegators (otherwise the fabric
 * looks them up and finds nothing). Putting the bodies in free
 * functions and having the class methods one-line-delegate keeps
 * the class file small AND lets these be unit-tested without a DO
 * harness (the `RpcHost` parameter is a narrow contract).
 *
 * Bodies for every `_rpc*`, `vfs*`, `_emit*`, and `_reportExternalExit`
 * method live here. The class retains the method NAMES as one-line
 * delegators in src/session/nimbus-session.ts.
 * 1-line delegators (per plan §IX.4 R1: DO RPC fabric uses name dispatch
 * via the stub).
 *
 * Per DEFECT-D1: ctx is taken via `(self as any).ctx` cast where needed
 * (rpcInnerDoFetch uses self.ctx.id and self.ctx.facets; rpcPutRegistryEntries
 * uses self.ctx.storage.sql). The InitHost-style escape applies because
 * these ~3 sites would each need ctx threaded through; cast at boundary
 * is acceptable per plan §IX recommendation 1.
 */
import { type HostedResidentProcess } from '../loaders/process-fabric.js';
import { type RuntimeOpenFlags } from '../runtime/os-contracts.js';
import type { WriteBatchStreamResult } from '../vfs/sqlite-vfs.js';
import { z } from 'zod/v4';
type RpcHost = any;
export declare function _rpcReadFile(self: RpcHost, path: string, pid?: number): Promise<string | null>;
/**
 * Read a file as raw bytes (Uint8Array). Used by git network facet for
 * binary .git/objects/** and packfile reads, where TextDecoder/TextEncoder
 * round-tripping through readFile (string) would corrupt bytes.
 */
export declare function _rpcReadFileBytes(self: RpcHost, path: string, pid?: number): Promise<Uint8Array | null>;
/**
 * Phase-3 inner-DO fetch dispatcher. Called by NimbusDOStub.fetch()
 * from the inner Worker via the env.NIMBUS_SESSION loopback. We
 * resolve the inner DO class from the module-level registry (keyed
 * by <thisDoId>:<bindingName>), use ctx.facets.get with the inner's
 * id string as the facet id, and forward the serialized Request.
 *
 * All steps run in THIS RPC method's context, so no cross-request
 * I/O boundaries are crossed — the ctx.facets stub and its fetch()
 * are both created here.
 */
export declare function _rpcInnerDoFetch(self: RpcHost, req: {
    bindingName: string;
    id: string;
    method: string;
    url: string;
    headers: [string, string][];
    body: ArrayBuffer | null;
}): Promise<{
    status: number;
    statusText: string;
    headers: [string, string][];
    body: ArrayBuffer | null;
}>;
export declare function _rpcWriteFile(self: RpcHost, path: string, content: string | Uint8Array, pid?: number): Promise<void>;
export declare function _rpcStat(self: RpcHost, path: string, pid?: number): Promise<any>;
export declare function _rpcLstat(self: RpcHost, path: string, pid?: number): Promise<any>;
export declare function _rpcHasLegacySymlinkUnder(self: RpcHost, path: string, pid?: number): Promise<boolean>;
export declare function _rpcUtimes(self: RpcHost, path: string, atimeMs: number, mtimeMs: number, pid?: number): Promise<void>;
export declare function _rpcChmod(self: RpcHost, path: string, mode: number, pid?: number): Promise<void>;
export declare function _rpcAccess(self: RpcHost, path: string, mode: number, pid?: number): Promise<void>;
export declare function _rpcChown(self: RpcHost, path: string, uid: number, gid: number, pid?: number, options?: {
    followSymlinks?: boolean;
}): Promise<void>;
export declare function _rpcSetUmask(self: RpcHost, mask: number, pid?: number): Promise<number>;
export declare function _rpcReaddir(self: RpcHost, path: string, pid?: number): Promise<{
    name: string;
    type: string;
}[]>;
export declare function _rpcExists(self: RpcHost, path: string, pid?: number): Promise<boolean>;
export declare function _rpcMkdir(self: RpcHost, path: string, pid?: number): Promise<void>;
export declare function _rpcRmdir(self: RpcHost, path: string, pid?: number): Promise<void>;
export declare function _rpcRename(self: RpcHost, from: string, to: string, pid?: number): Promise<void>;
export declare function _rpcReadlink(self: RpcHost, path: string, pid?: number): Promise<string | null>;
export declare function _rpcSymlink(self: RpcHost, target: string, path: string, pid?: number): Promise<void>;
declare const FsReadBatchArgsSchema: z.ZodArray<z.ZodObject<{
    path: z.ZodString;
    offset: z.ZodNumber;
    length: z.ZodNumber;
}, z.core.$strip>>;
/** One requested range in a batch read. `length` bounds what it may return. */
export type FsReadBatchRequest = z.infer<typeof FsReadBatchArgsSchema>[number];
export interface FsReadBatchEntryError {
    readonly code?: string;
    readonly message: string;
}
/**
 * One range's outcome, positionally matched to its request. `bytes: null`
 * means the path does not exist — the same answer `fsReadRange` gives.
 */
export type FsReadBatchEntry = {
    bytes: Uint8Array | null;
    error?: undefined;
} | {
    bytes?: undefined;
    error: FsReadBatchEntryError;
};
export declare function _rpcFsRevision(self: RpcHost, path: string | undefined, pid?: number): Promise<number>;
export declare function _rpcFsReadRange(self: RpcHost, path: string, offset: number, length: number, pid?: number): Promise<Uint8Array | null>;
/**
 * Read many ranges in ONE round trip.
 *
 * Every entry is the same read `_rpcFsReadRange` performs, through the same
 * process credential and the same live bridge, in request order. A batch is
 * therefore exactly as authoritative as the individual reads it replaces —
 * it takes no snapshot and consults nothing the single-read path would not.
 * What it saves is round trips, which is the whole cost of a read.
 *
 * One failing path must not cost the caller the whole batch — with N separate
 * calls it would have learned each outcome — so a read that throws is
 * reported in its own slot and the rest of the batch proceeds. A missing path
 * yields `bytes: null`, exactly as the single read does.
 *
 * Bounds are checked before any read and rejected rather than trimmed: a
 * caller that silently got fewer entries than it asked for would read a
 * truncated file as a complete one.
 */
export declare function _rpcFsReadBatch(self: RpcHost, requests: unknown, pid?: number): Promise<FsReadBatchEntry[]>;
export declare function _rpcFsWriteRange(self: RpcHost, path: string, offset: number, bytes: Uint8Array | ArrayBuffer | number[], pid?: number): Promise<number>;
export declare function _rpcFsAppend(self: RpcHost, path: string, writerId: string, moduleId: string, operationId: string, bytes: Uint8Array | ArrayBuffer | number[], pid?: number): Promise<number>;
export declare function _rpcFsAppendAck(self: RpcHost, writerId: string, moduleId: string, operationId: string, pid?: number): Promise<void>;
export declare function _rpcFsTruncate(self: RpcHost, path: string, size: number, pid?: number): Promise<void>;
export declare function _rpcFsOpen(self: RpcHost, path: string, flags: RuntimeOpenFlags, pid?: number): Promise<any>;
export declare function _rpcFsRead(self: RpcHost, handleId: number, offset: number | null, length: number, pid?: number): Promise<Uint8Array>;
export declare function _rpcFsWrite(self: RpcHost, handleId: number, offset: number | null, bytes: Uint8Array | ArrayBuffer | number[], pid?: number): Promise<number>;
export declare function _rpcFsClose(self: RpcHost, handleId: number, pid?: number): Promise<void>;
/**
 * Called by CirrusHmrRPC.hmrSend. Runs in the DO's own context so
 * we can legally write to hibernatable WS sockets owned by this
 * DO. The HmrBridge holds the client→WS map; we delegate to it.
 */
export declare function _rpcHmrRelay(self: RpcHost, clientId: string | null, msg: string): Promise<void>;
export declare function _rpcUnlink(self: RpcHost, path: string, pid?: number): Promise<void>;
/**
 * Bulk-write files and directories via one transactionSync().
 * Called from facets that accumulate writes locally (git clone/fetch/pull,
 * potentially others) to avoid thousands of individual writeFile RPCs.
 *
 * payload: {
 *   inodes: BatchInodeEntry[],
 *   chunks: { path, chunkId, data: Uint8Array | ArrayBuffer }[],
 *   deletePaths?: string[]
 * }
 */
export declare function _rpcWriteBatch(self: RpcHost, payload: unknown, pid?: number): Promise<{
    inodes: number;
    chunks: number;
}>;
/**
 * W7 — Streaming bulk-write entry point. Receives a
 * ReadableStream<Uint8Array> in the W7 v3 wire format (see
 * src/_shared/w7-frame.ts) and hands the raw pull-controlled stream to
 * SqliteVFS.writeStream().
 *
 * Bypasses the 32 MiB structured-clone cap that constrained the
 * legacy writeBatch path — workerd flow-controls the byte stream
 * end-to-end.
 *
 * Unlike strict writeBatch, the stream contract is path-atomic with a
 * committed prefix: every reported path is complete, but earlier publish
 * groups remain durable when a later group fails. The typed result carries
 * the exact durable progress.
 */
export declare function _rpcWriteBatchStream(self: RpcHost, stream: ReadableStream<Uint8Array>, mutationOwner?: string, pid?: number): Promise<WriteBatchStreamResult>;
/**
 * Bulk-write npm registry cache entries in ONE RPC. Used by the
 * resolver-facet to flush a wave of resolved packages back to the
 * supervisor without per-entry round-trips.
 *
 * Payload is the array of RegistryCacheEntry shapes from src/npm-cache.ts.
 * Returns { written, failed } so the facet can surface partial-write
 * warnings to the install log.
 */
export declare function _rpcPutRegistryEntries(self: RpcHost, entries: any[]): Promise<{
    written: number;
    failed: number;
}>;
export declare const PRIOR_GENERATION_EXIT_REASON = "process lost: instance reset";
export declare function _rpcStdout(self: RpcHost, pid: number, data: string): Promise<void>;
export declare function _rpcStderr(self: RpcHost, pid: number, data: string): Promise<void>;
/**
 * Called by facets from their `finally` block after I/O has drained.
 * Marks the log store so `logs` / `ps` can show the exit code, and
 * fires `_emitExitDump` if the process exited non-zero with buffered
 * output.
 *
 * Idempotent — double-call is a no-op (ProcessLogStore.markExit guards).
 */
export declare function _rpcReportExit(self: RpcHost, pid: number, code: number, tail: string): Promise<void>;
/**
 * Emit a formatted exit-dump banner + last 30 lines of output to the
 * terminal. Called from both the facet-reported exit path and the
 * external-kill path (timeout / abort).
 *
 * Race notes:
 *   - Terminal.write is buffered with a 5ms flush; concurrent writes
 *     from facet stdout still in flight interleave cleanly at flush
 *     time.
 *   - If no terminal is attached, the dump is simply skipped — the
 *     log buffer still has everything, so `logs <pid>` recovers it.
 */
export declare function _emitExitDump(self: RpcHost, pid: number, code: number): void;
/**
 * Fix 3 + Fix 4 + Fix 5: finalizer for shellExecuteTracked.
 *
 * Runs after a tracked shell.execute finishes (any path). Chooses when
 * to emit the exit-dump banner and when to log the debug trace.
 *
 * Dump policy (Fix 4):
 *   - Non-zero exit AND any buffered output → always dump.
 *   - Zero exit AND buffered output has >0 bytes → dump anyway. Rationale:
 *     an npm run that returned "success" while the ring buffer still has
 *     a traceback is the exact "clean-but-silent failure" we're hunting.
 *     The replay is unique information the user didn't see live (e.g.
 *     because the terminal was reconnected after the fact).
 *   - Zero exit AND empty buffer → nothing to say. Skip.
 *
 * Trace policy (Fix 5):
 *   - NIMBUS_DEBUG=1: always print `[exited pid=N code=C duration=Xms]`.
 *   - Default: print only for non-zero OR long-running scripts (the
 *     cmd-start banner makes them expect an exit marker).
 *
 * Called with the already-marked pid (processes.exit + processes.markExit
 * ran in shellExecuteTracked's finally).
 */
export declare function _emitShellExecDone(self: RpcHost, pid: number, cmd: string, code: number, durationMs: number): void;
/**
 * External-exit path: invoked by FacetManager when a process is killed
 * outside the facet's own try/finally (timeout, explicit abort, or the
 * `kill` shell command). Appends a synthetic stderr line so the dump
 * has useful context, then runs the same dump machinery.
 */
export declare function _reportExternalExit(self: RpcHost, pid: number, code: number, reason: string): void;
/**
* W1: orphan-pid predicate exposed for the alarm dispatcher. A pid is
* "orphaned" if the process table has no record of it — either reap()
* already removed it, or it never fully registered. Long-running
* facets that hang and get GC'd fall into this category.
*/
export declare function _logJanitorOrphanCheck(self: RpcHost): (pid: number) => boolean;
export declare function _rpcPrefetch(self: RpcHost, cwd: string, entryCode: string): Promise<Record<string, string>>;
export declare function _rpcRegisterPort(self: RpcHost, pid: number, port: number): Promise<void>;
export declare function _rpcUnregisterPort(self: RpcHost, port: number): Promise<void>;
export declare function _rpcRouteLoopback(self: RpcHost, port: number, request: Request): Promise<Response>;
export declare function _rpcTransform(self: RpcHost, code: string, loader: string): Promise<{
    code: string;
    map: string;
} | null>;
export declare function _rpcCpSpawn(self: RpcHost, req: any): Promise<{
    childPid: number;
}>;
export declare function _rpcCpStdinWrite(self: RpcHost, childPid: number, data: string): Promise<{
    ok: boolean;
}>;
export declare function _rpcCpStdinEnd(self: RpcHost, childPid: number): Promise<void>;
export declare function _rpcCpReadStdin(self: RpcHost, childPid: number, waitMs: number): Promise<any>;
export declare function _rpcCpReadOutput(self: RpcHost, childPid: number, fd: 1 | 2, sinceSeq: number, waitMs: number): Promise<any>;
export declare function _rpcCpDrainOutput(self: RpcHost, childPid: number): Promise<any>;
export declare function _rpcCpKill(self: RpcHost, childPid: number, signal: string): Promise<boolean>;
export declare function _rpcCpWait(self: RpcHost, childPid: number, waitMs: number): Promise<any>;
/**
 * child-process isolation gap #1: dispatch a single cp.spawn request inline using the
 * existing pure-builtin / facet-direct logic, returning final stdout/
 * stderr/exitCode rather than streaming via hooks. Called by
 * spawn-facet.ts:runSpawnInIsolate from inside a fresh Worker Loader
 * isolate (the per-spawn fresh-isolate envelope).
 *
 * The fpm exposes a `dispatchInline(req, kind)` that adapts the
 * existing _dispatch path (originally hook-based) into a string-result
 * shape. That adapter is responsible for ensuring stdout/stderr are
 * accumulated inline rather than streamed.
 */
export declare function _rpcCpDispatchInline(self: RpcHost, req: any, kind: string): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
}>;
/** RPC: Read a file from the VFS. Returns ArrayBuffer or null. */
export declare function vfsReadFile(self: RpcHost, path: string): ArrayBuffer | null;
/** RPC: Read a file as string. Returns string or null. */
export declare function vfsReadFileString(self: RpcHost, path: string): string | null;
/** RPC: Stat a path. Returns file metadata or null. */
export declare function vfsStat(self: RpcHost, path: string): {
    type: string;
    size: number;
    atime: number;
    ctime: number;
    mtime: number;
    mode: number;
} | null;
/** RPC: Check if path exists. */
export declare function vfsExists(self: RpcHost, path: string): boolean;
/** RPC: List directory contents. Returns array of { name, type }. */
export declare function vfsReaddir(self: RpcHost, path: string): {
    name: string;
    type: string;
}[];
/** RPC: Write a file to the VFS. */
export declare function vfsWriteFile(self: RpcHost, path: string, data: ArrayBuffer): void;
/**
 * RPC: peer-DO execute leg of NimbusFanoutPool's peer-DO fanout topology.
 *
 * Called by a coordinator NimbusSession DO via
 * `env.NIMBUS_SESSION.idFromName(siblingName).get()._rpcFanoutExecute(...)`.
 * THIS DO instance acts as a peer worker: it runs ONE NimbusLoaderPool
 * over its assigned shard and returns the per-task results.
 *
 * Cap-sidestep mechanic
 * ─────────────────────
 * The supervisor's `submitMany` makes N RPC calls to N peer DOs.
 * Each RPC is a stub.fetch / RPC method invocation, NOT an
 * `env.LOADER.get()` from the supervisor's own method context — so
 * those N calls don't count against the V8 4-loaders-per-method cap.
 * Inside this RPC handler, we run a SINGLE LoaderPool with concurrency
 * matching the shard size — and since the shard arrived via the peer
 * router (capped at MAX_PEER_FANOUT = 32 peers, so each shard is
 * ⌈totalTasks / 32⌉ wide), the in-DO pool stays well under 4.
 *
 * Failure model
 * ─────────────
 * Throws bubble back to the coordinator's RPC promise (rejects on
 * the supervisor side). The coordinator's `submitMany` Promise.all
 * surfaces the first reject; the install path treats it as a hard
 * failure (matching today's single-facet `pool.submit` posture).
 *
 * Bytes-isolation
 * ───────────────
 * The fnSource string is forwarded verbatim into a fresh
 * NimbusLoaderPool, which serializes it into the loader's worker
 * code. No supervisor-side eval. Same trust posture as every other
 * NimbusLoaderPool dispatch.
 */
export declare function _rpcFanoutExecute(self: RpcHost, fnSource: string, args: unknown[], poolOpts?: {
    tag?: string;
    timeoutMs?: number;
    preamble?: string;
    wasmModules?: Record<string, ArrayBuffer>;
    extraBindings?: Record<string, unknown>;
    omitSupervisor?: boolean;
    /**
     * INSTALL-HONESTY: full doId of the COORDINATOR (the DO that
     * called NimbusFanoutPool.submitMany). The peer's NimbusLoaderPool
     * uses this to mint a SUPERVISOR binding that routes back to the
     * coordinator instead of the peer (default behavior pre-fix).
     * Without this, install-batch's writeBatchStream calls from inside
     * a loader isolate land in the PEER's VFS, invisible to the user.
     */
    coordinatorDoId?: string;
    /**
     * Invoking process pid, forwarded into the peer-side SUPERVISOR
     * binding so writeBatchStream is authorized under the caller's
     * credential (see NimbusLoaderPoolOptions.supervisorPid).
     */
    supervisorPid?: number;
}): Promise<{
    results: unknown[];
}>;
/**
 * One process this peer hosts for a coordinator sibling. Created
 * synchronously by `_rpcHostProcess` before any await, so the boot-payload
 * and routed-HTTP legs — which the coordinator may issue concurrently — always
 * find the record and simply await it.
 */
export interface HostedProcessRecord {
    /** Coordinator identity every leg mints its own stubs against. */
    supervisor: {
        doId: string;
        pid: number;
        writerId: string;
    };
    hosted: Promise<HostedResidentProcess>;
    booted: Promise<unknown>;
    /** Settles when the coordinator cancels or the process is torn down. */
    cancelled: Promise<void>;
    cancel(): void;
}
/**
 * RPC: placement probe. Returns this peer's module-scope isolate token so
 * the coordinator's scheduler can verify the peer landed in a distinct
 * workerd process (same token ⇒ shared isolate/process ⇒ try the next slot).
 */
export declare function _rpcHostProcessProbe(_self: RpcHost): {
    isolateToken: string;
};
/**
 * RPC: host a heavy-class resident process. Held open by the coordinator for
 * the process's whole lifetime — the exact contract the coordinator's local
 * attach path has with its loopback startProcess. Resolves on clean process
 * exit (the facet reports its exit to the coordinator itself via SUPERVISOR);
 * rejects on facet death, which the coordinator maps to SIGKILL semantics in
 * its ProcessTable and may answer with a respawn on a fresh peer.
 *
 * If the coordinator dies, workerd cancels this inbound call; the held-open
 * startProcess context below collapses and the facet dies with it — a
 * process-hosting peer never outlives its parent session.
 */
export declare function _rpcHostProcess(self: RpcHost, boot: unknown, opts: unknown): Promise<{
    ok: boolean;
}>;
/**
 * RPC: read back the boot payload of a process this peer hosts. The runner was
 * started by `_rpcHostProcess`; this never starts anything, so a coordinator
 * asking twice — or asking after a respawn — gets the same answer the local
 * placement would have returned inline.
 */
export declare function _rpcAwaitHostedBoot(self: RpcHost, workerKey: string): Promise<{
    payload: unknown;
}>;
/**
 * Inbound HTTP for a peer-hosted process, on the wire.
 *
 * A `Request`/`Response` cannot cross a sibling-DO hop by reference — workerd
 * rejects it with "Entrypoints to dynamically-loaded workers cannot be
 * transferred to other Workers", because the object belongs to the
 * dynamically-loaded facet on the other side. Their PARTS travel fine, and a
 * body is a plain ReadableStream, which RPC transfers with flow control. So
 * the leg carries the parts and rebuilds the object on each side: no
 * buffering, no size ceiling, and an SSE or chunked body still flows live.
 */
export interface HostedHttpRequest {
    method: string;
    url: string;
    headers: [string, string][];
    body: ReadableStream | null;
}
export interface HostedHttpResponse {
    status: number;
    statusText: string;
    headers: [string, string][];
    body: ReadableStream | null;
}
/**
 * RPC: inbound HTTP for a port owned by a process this peer hosts. The
 * coordinator's PortRegistry holds one route target per pid and cannot tell
 * this apart from a local facet: the same code-free NimbusLoadedEntrypoint
 * resolves the running facet, here on the PEER's loader.
 *
 * The route target is minted PER CALL, in the context that uses it. A stub
 * held from the host call belongs to that call's I/O context, and re-entering
 * it from here would read as transferring a dynamically-loaded worker's
 * entrypoint — which workerd does refuse. Minting fresh is what keeps this
 * leg legal; it is not an optimisation and must not be hoisted.
 */
export declare function _rpcRouteHostedHttp(self: RpcHost, workerKey: string, wire: HostedHttpRequest): Promise<HostedHttpResponse>;
/**
 * RPC: deterministic kill of a hosted process. Releases the resources pinning
 * the facet — the same teardown FacetManager.kill applies to a local facet —
 * which settles the coordinator's held-open `_rpcHostProcess` call.
 */
export declare function _rpcCancelHostProcess(self: RpcHost, workerKey: string): {
    cancelled: boolean;
};
import { type CacheTier, type CacheKind } from '../_shared/cache-stats.js';
export type CacheStatEvent = {
    kind: 'hit';
    tier: CacheTier;
    cacheKind: CacheKind;
    bytes: number;
} | {
    kind: 'miss';
    tier: CacheTier;
    cacheKind: CacheKind;
};
export declare function _rpcRecordCacheStats(_self: RpcHost, events: CacheStatEvent[]): Promise<void>;
export {};
//# sourceMappingURL=rpc.d.ts.map