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
 * (_rpcInnerDoCall uses self.ctx.id and self.ctx.facets). The InitHost-style escape applies because
 * these ~3 sites would each need ctx threaded through; cast at boundary
 * is acceptable per plan §IX recommendation 1.
 */
import { type SessionFileStat, type SessionFollowOptions, type SessionMkdirOptions } from '@nimbus-sh/core/runtime/session-protocol.js';
import type { D1QueryResponse, D1QuerySql, KvCall, R2Call } from '@nimbus-sh/fabric/inner-storage-env.js';
import type { RuntimeVfsStat } from '@nimbus-sh/core/runtime/os-contracts.js';
import { type FanoutShardOptions } from '@nimbus-sh/fabric/fanout.js';
import { type SupervisorOpEnvelope } from '@nimbus-sh/core/workspace/supervisor-op.js';
import { PeerHost, type HostedHttpRequest, type HostedHttpResponse, type HostedReply } from '@nimbus-sh/fabric/peer-host.js';
import { type VfsAcquireOptions, type VfsAcquireResult, type VfsCred, type VfsListOptions, type VfsListPage, type VfsMutationReceipt, type VfsListTree } from '@nimbus-sh/core/runtime/os-contracts.js';
import { type LoaderStoreRequest } from '../wrangler/loader-code-store.js';
import type { WriteBatchStreamResult } from '@nimbus-sh/core/runtime/wave-contracts.js';
import { z } from 'zod/v4';
import type { NimbusSession } from './nimbus-session.js';
import type { WsRelayHeaders, WsRelayOpened } from './ws-relay.js';
import type { HmrEvent } from '../facets/real-vite-hmr.js';
type RpcHost = any;
export declare function _rpcGetCachedTarball(_self: RpcHost, _integrity: string, _pid?: number, _run?: string): Promise<{
    readOnly: boolean;
}>;
export declare function _rpcGetPackument(_self: RpcHost, _name: string, _options?: unknown, _pid?: number, _run?: string): Promise<{
    readOnly: boolean;
}>;
export declare function _rpcPutCachedTarball(_self: RpcHost, _integrity: string, _bytes: Uint8Array | ArrayBuffer): Promise<void>;
export declare function _rpcCacheResult(self: RpcHost, ticket: string, result: {
    value?: unknown;
    failure?: unknown;
    failed?: boolean;
}, pid?: number, run?: string): Promise<void>;
export declare function _rpcStdinPrepared(self: RpcHost, pid?: number, run?: string): Promise<void>;
type ProcessRpcHost = Pick<NimbusSession, 'processes'>;
type ReportRpcHost = ProcessRpcHost & Pick<NimbusSession, 'facetManager'>;
type ExitRpcHost = ReportRpcHost & Pick<NimbusSession, 'terminal' | 'shell' | 'webSocketRelay' | 'supervisorDeliveries' | 'servedReads' | '_emitExitDump' | 'nimbusDebug' | 'childProcessManager'>;
export declare function checkedReadPayloadBytes(bytes: number): number;
export declare function withReadAllocation<T>(bytes: number, read: () => Promise<T>, pid?: number, session?: string): Promise<T>;
/**
 * `files.readFile` — the read with the supervisor's allocation lease.
 * The body lives in `buildSessionSupervisorOps`'s `readFile` override so
 * direct `_rpc*` calls and the supervisor envelope share it.
 */
export declare function _rpcReadFile(self: RpcHost, path: string, pid?: number, cred?: VfsCred): Promise<string | null>;
/**
 * Read a file as raw bytes (Uint8Array). Used by git network facet for
 * binary .git/objects/** and packfile reads, where TextDecoder/TextEncoder
 * round-tripping through readFile (string) would corrupt bytes.
 */
export declare function _rpcReadFileBytes(self: RpcHost, path: string, pid?: number, cred?: VfsCred): Promise<Uint8Array | null>;
/**
 * A member of the inner Worker's Durable Object, as a stub's caller reaches
 * it on Cloudflare (NimbusDurableObjectNamespace.callOn and getOn): the names
 * of `path`, from the object down, walked on the object's facet, then called
 * with `args`, or read when `args` is null. It answers what the object
 * answers, or rejects with what it throws (the error's type and message
 * travel back).
 */
export declare function _rpcInnerDoCall(self: RpcHost, req: {
    bindingName: string;
    id: string;
    path: string[];
    args: unknown[] | null;
}): Promise<unknown>;
/** The session's filesystem, as a `wrangler dev` Worker's KV and R2 bindings reach it. */
type StorageHost = Pick<NimbusSession, 'sqliteFs' | 'ensureSqliteFs'>;
/**
 * The store a storage binding's props name (fabric bindings.ts
 * NimbusKVNamespace, NimbusD1Binding, NimbusR2Bucket): the project, and its
 * KV namespace's or R2 bucket's binding name, or its D1 database.
 */
declare const StorageTargetSchema: z.ZodObject<{
    root: z.ZodString;
    store: z.ZodString;
    writer: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
type StorageTarget = z.infer<typeof StorageTargetSchema>;
/** A call of a `wrangler dev` Worker's KV binding, on the namespace its props name. */
export declare function _rpcKvCall(self: StorageHost, target: StorageTarget, call: KvCall, cred?: VfsCred): Promise<void | import("../bindings/kv.js").KvListResult | Map<string, import("@nimbus-sh/fabric/inner-storage-env.js").KvJson> | {
    value: import("../bindings/kv.js").KvValue;
    metadata: import("@nimbus-sh/fabric/inner-storage-env.js").KvJson;
    cacheStatus: null;
} | import("../bindings/kv.js").KvValue>;
/** A call of a `wrangler dev` Worker's R2 binding, on the bucket its props name. */
export declare function _rpcR2Call(self: StorageHost, target: StorageTarget, call: R2Call, cred?: VfsCred): Promise<void | import("@nimbus-sh/fabric/inner-storage-env.js").R2WireGetResult | import("@nimbus-sh/fabric/inner-storage-env.js").R2WireObject | import("@nimbus-sh/fabric/inner-storage-env.js").R2WireObjects | null>;
/**
 * A `wrangler dev` Worker's D1 queries, in the database its props name: the
 * project's facet, got in this request.
 */
export declare function _rpcD1Query(self: {
    readonly ctx: DurableObjectState;
}, target: StorageTarget, queries: D1QuerySql[]): Promise<D1QueryResponse>;
export declare function _rpcWriteFile(self: RpcHost, path: string, content: string | Uint8Array, pid?: number, cred?: VfsCred): Promise<number>;
/**
 * Write one host-governed file at a session root and let ordinary Unix
 * permissions keep it that way: the root becomes a sticky 1777 directory owned
 * by the kernel, and the file itself is kernel-owned and read-only.
 *
 * The guest keeps normal use of the root — it creates, edits and removes its
 * own files there, which is what the sticky bit is for — and cannot replace,
 * rename or remove this one. That is the whole mechanism; there is no special
 * case anywhere in the filesystem for it.
 *
 * Deliberately absent from the remote HTTP RPC dispatcher, so only an
 * embedder holding the DO stub may write it.
 *
 * It follows no link: the guest may own every directory on the way, and a
 * link there would have the kernel make another directory sticky and
 * world-writable. Each directory from `/` to the root must be a directory
 * itself, or the call is refused; a link at the file's own name is replaced
 * by the file. One synchronous turn, so nothing changes between a look and
 * the write.
 *
 * It guards against accidents, not against the session's code: the session's
 * user has passwordless root (`sudo`, `su`), and a program that runs `sudo`
 * can replace or remove this file. Do not rely on it to keep a value from code
 * running in the session (docs/sandbox-sdk.md, "Users and Permissions").
 */
export declare function _rpcWriteProtectedRootFile(self: RpcHost, rootPath: string, path: string, content: string | Uint8Array): Promise<void>;
/** What a session's file calls reach: its supervisor's file ops, as the caller (a pid, or a credential). */
export interface FilesHost {
    supervisorOp(envelope: SupervisorOpEnvelope): Promise<unknown>;
}
export declare function _rpcStat(self: FilesHost, path: string, pid?: number, cred?: VfsCred): Promise<SessionFileStat | null>;
export declare function _rpcLstat(self: FilesHost, path: string, pid?: number, cred?: VfsCred): Promise<SessionFileStat | null>;
export declare function _rpcUnlink(self: FilesHost, path: string, pid?: number, cred?: VfsCred): Promise<void>;
export declare function _rpcRmdir(self: FilesHost, path: string, pid?: number, cred?: VfsCred): Promise<void>;
/** Opened O_APPEND (made when absent), written to its end, closed: every byte at the file's end however it grows meanwhile. */
export declare function _rpcAppendFile(self: FilesHost, path: string, content: string | Uint8Array, pid?: number, cred?: VfsCred): Promise<void>;
export declare function _rpcSymlink(self: FilesHost, target: string, path: string, pid?: number, cred?: VfsCred): Promise<void>;
export declare function _rpcRealpath(self: FilesHost, path: string, pid?: number, cred?: VfsCred): Promise<string>;
export declare function _rpcTruncate(self: FilesHost, path: string, size: number, pid?: number, cred?: VfsCred): Promise<void>;
export declare function _rpcUtimes(self: FilesHost, path: string, atime: number, mtime: number, pid?: number, cred?: VfsCred, options?: SessionFollowOptions): Promise<void>;
export declare function _rpcChown(self: FilesHost, path: string, uid: number | null, gid: number | null, pid?: number, cred?: VfsCred, options?: SessionFollowOptions): Promise<void>;
export declare function _rpcReadlink(self: RpcHost, path: string, pid?: number, cred?: VfsCred): Promise<string | null>;
export declare function _rpcChmod(self: RpcHost, path: string, mode: number, pid?: number, cred?: VfsCred): Promise<void>;
export declare function _rpcSetUmask(self: RpcHost, mask: number, pid?: number): Promise<number>;
export declare function _rpcReaddir(self: RpcHost, path: string, pid?: number, cred?: VfsCred): Promise<{
    name: string;
    type: string;
}[]>;
export declare function _rpcExists(self: RpcHost, path: string, pid?: number, cred?: VfsCred): Promise<boolean>;
export declare function _rpcMkdir(self: FilesHost, path: string, pid?: number, cred?: VfsCred, options?: SessionMkdirOptions): Promise<void>;
export declare function _rpcRename(self: RpcHost, from: string, to: string, pid?: number, cred?: VfsCred): Promise<void>;
declare const FsReadBatchArgsSchema: z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
    path: z.ZodString;
    lstat: z.ZodLiteral<true>;
}, z.core.$strict>, z.ZodObject<{
    path: z.ZodString;
    offset: z.ZodNumber;
    length: z.ZodNumber;
    expectedEpoch: z.ZodOptional<z.ZodString>;
    expectedRevision: z.ZodOptional<z.ZodNumber>;
    expectedFile: z.ZodOptional<z.ZodObject<{
        dev: z.ZodNumber;
        ino: z.ZodNumber;
        size: z.ZodNumber;
        mtime: z.ZodNumber;
        ctime: z.ZodNumber;
        revision: z.ZodNumber;
    }, z.core.$strip>>;
}, z.core.$strip>]>>;
/**
 * One request in a batch read: a range, whose `length` bounds what it may
 * return, or a path's lstat, which returns no file bytes.
 */
export type FsReadBatchRequest = z.infer<typeof FsReadBatchArgsSchema>[number];
/** The file bytes a batch request may return: its range's length; an lstat, none. */
export declare function fsReadBatchRequestBytes(request: FsReadBatchRequest): number;
/**
 * One request's outcome, positionally matched to it. A range answers
 * `bytes`, `null` when the path does not exist — the same answer
 * `fsReadRange` gives. An lstat answers `stat`, `null` when the path does not
 * exist — the same answer the `lstat` op gives. A request that failed answers
 * the error itself: with `enhanced_error_serialization` on both ends, workerd
 * clones an Error with its own properties, so its `code` arrives with it.
 */
export type FsReadBatchEntry = 
/** \`path\`: the file the read reached, its symlinks resolved as the read resolved them. */
{
    bytes: Uint8Array | null;
    path?: string;
    stat?: undefined;
    error?: undefined;
} | {
    stat: RuntimeVfsStat | null;
    bytes?: undefined;
    error?: undefined;
} | {
    bytes?: undefined;
    stat?: undefined;
    error: Error;
};
declare const FsAcquireArgsSchema: z.ZodObject<{
    epoch: z.ZodNullable<z.ZodString>;
    cursor: z.ZodNumber;
    begin: z.ZodOptional<z.ZodNumber>;
    own: z.ZodOptional<z.ZodNumber>;
    options: z.ZodOptional<z.ZodObject<{
        namespace: z.ZodOptional<z.ZodBoolean>;
        lease: z.ZodOptional<z.ZodBoolean>;
        push: z.ZodOptional<z.ZodObject<{
            roots: z.ZodArray<z.ZodString>;
            exclude: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
}, z.core.$strip>;
export declare function _rpcWsOpen(self: RpcHost, url: string, protocols: string[], headers?: WsRelayHeaders | null, refusalBody?: boolean | null, pid?: number): Promise<WsRelayOpened>;
export declare function _rpcWsPoll(self: RpcHost, id: number, waitMs: number, pid?: number): Promise<unknown[]>;
export declare function _rpcWsSend(self: RpcHost, id: number, text: string | null, bytes: Uint8Array | null, pid?: number): Promise<void>;
export declare function _rpcWsClose(self: RpcHost, id: number, code?: number, reason?: string, pid?: number): Promise<void>;
/**
 * The facet cache-coherence barrier: what changed since `cursor`.
 *
 * Returned as payload, never on an Error — custom Error properties do not
 * survive structured clone across the RPC boundary, so a cursor carried that
 * way would silently arrive as undefined.
 */
export declare function _rpcFsAcquire(self: RpcHost, epoch: string | null, cursor: number, options?: VfsAcquireOptions | null, pid?: number): Promise<VfsAcquireResult>;
/** The reads a process may ask together with its ACQUIRE (_rpcFsAcquired). */
export declare const FS_ACQUIRED_READ_OPS: readonly ['stat', 'lstat', 'fsReadBatch'];
/**
 * A process's ACQUIRE and the read it was about to make, in one call.
 *
 * An async read applies a barrier and then reads, and each was its own round
 * trip to this host: measured on a throwaway (2026-10-01), 7-8 ms each, with
 * the host's own work under a millisecond. The answer to the barrier is the
 * one fsAcquire gives (_acquireOnDelivery, as a delivery carries it), computed
 * before the read, so the read sees everything the barrier reports, and the
 * process applies the barrier before it uses the value.
 */
export declare function _rpcFsAcquired(self: RpcHost, acquire: unknown, op: unknown, args: unknown, pid?: number): Promise<FsAcquiredAnswer>;
/** _rpcFsAcquired's answer: the barrier's, and the read's value or its refusal. */
export type FsAcquiredAnswer = {
    acquired: VfsDeliveredAcquire | undefined;
    value: unknown;
    failure?: undefined;
} | {
    acquired: VfsDeliveredAcquire | undefined;
    value?: undefined;
    failure: {
        code: string | undefined;
        message: string;
    };
};
/**
 * N18: a process's facet store asks for room to grow, reporting what its
 * database measures. The ledger's row for the facet first takes the
 * measurement where it is over the record (overshoot), then admits `bytes`
 * more under the facet's name; refused, nothing is granted and the store
 * keeps what it has (reading the rest through the session).
 */
export declare function _rpcFsStorageGrant(self: RpcHost, facet: string, bytes: number, databaseSize: number, pid?: number): Promise<{
    granted: number;
    available?: number;
}>;
/** What a process passes to fsAcquire: the cursor its resident set is at. */
export type FsAcquireArgs = z.infer<typeof FsAcquireArgsSchema>;
/** An ACQUIRE a delivery carries: fsAcquire's arguments and its answer to them. */
export interface VfsDeliveredAcquire {
    args: FsAcquireArgs;
    answer: VfsAcquireResult;
}
/**
 * The ACQUIRE a delivery carries, so the process it is delivered to applies
 * it instead of asking.
 *
 * A stdin packet, a child's output or exit, a request routed to a port: the
 * supervisor hands each of these to a process, and the process may not run
 * the code they wake until it has applied everything written before them
 * (protocol §3, §5.6). Asking costs a round trip per delivery, which an
 * attached terminal pays on every keystroke. But the supervisor is already
 * answering: `args` are what the process would pass to fsAcquire, and
 * `answer` is exactly what fsAcquire answers for them, computed here, after
 * the thing delivered was queued. Every write that preceded it is in the
 * answer, and the delivery carries it, so it cannot be lost or reordered
 * apart from it.
 *
 * One format with fsAcquire's own: the same arguments, checked by the same
 * schema, answered by the same function. Undefined when there is no answer
 * to carry — the process sent no arguments it can be answered for, or this
 * one could not be computed — and the process then asks, as it always has,
 * where a failure is counted and handled. It is never a reason to fail the
 * delivery: that would lose a dequeued keystroke or a routed request.
 */
export declare function _acquireOnDelivery(self: RpcHost, args: unknown, pid?: number): Promise<VfsDeliveredAcquire | undefined>;
/**
 * The ACQUIRE a request routed to `pid`'s port carries. The supervisor, not
 * the process, starts a request, so it holds no cursor of the process's to
 * answer from, and answers from its own: "nothing since now". The process can
 * use that only when it is already there, which is protocol §9.2's
 * one-integer piggyback — true for any request no write preceded since the
 * process last caught up — and otherwise asks.
 */
export declare function _acquireForRoutedRequest(self: RpcHost, pid: number): Promise<VfsDeliveredAcquire | undefined>;
/**
 * Enumerate the session filesystem for a process, one bounded page at a time.
 *
 * Goes through `self.supervisorBridge(pid)` like every other fs RPC, so the listing
 * is filtered by the calling process's own credential rather than the kernel's
 * — a process must not learn of a path it could not stat.
 */
export declare function _rpcFsList(self: RpcHost, after: string | null, limit: number | null, options?: VfsListOptions, pid?: number): Promise<VfsListPage>;
/** Everything beneath directory `root` a process may see, in one answer (subtreeListing). */
export declare function _rpcFsListTree(self: RpcHost, root: string, maxEntries: number, pid?: number): Promise<VfsListTree>;
export declare function _rpcFsReadRange(self: RpcHost, path: string, offset: number, length: number, pid?: number, cred?: VfsCred): Promise<Uint8Array | null>;
/** A bounded range used only to prepare fd 0, never an ordinary file read. */
export declare function _rpcStdinFileRead(self: RpcHost, path: string, offset: number, length: number, pid?: number): Promise<{
    data: Uint8Array;
    size: number;
}>;
/**
 * Read many ranges, and lstat many paths, in ONE round trip.
 *
 * Every entry is the same read `_rpcFsReadRange` performs, or the same stat
 * the `lstat` op performs, through the same process credential and the same
 * live bridge, in request order. A batch is
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
export declare function _rpcFsWriteRange(self: RpcHost, path: string, offset: number, bytes: Uint8Array | ArrayBuffer | number[], pid?: number): Promise<VfsMutationReceipt>;
/**
 * Called by CirrusHmrRPC.hmrSend. Runs in the DO's own context so
 * we can legally write to hibernatable WS sockets owned by this
 * DO. The HmrBridge holds the client→WS map; we delegate to it.
 */
export declare function _rpcHmrRelay(self: RpcHost, clientId: string | null, msg: string): Promise<void>;
/** Poll the HMR queue in the same DO that owns its browser connections. */
export declare function _rpcHmrNextEvent(self: Pick<NimbusSession, 'cirrusReal'>, timeoutMs?: number): Promise<HmrEvent[]>;
export declare function _rpcReplayBoundary(self: RpcHost, pid?: number, run?: string): Promise<void>;
export declare function _rpcNetTls(self: RpcHost, action: unknown, token: unknown, payload: unknown, pid?: number, run?: string): Promise<unknown>;
export declare function _rpcOutbound(self: RpcHost, action: unknown, payload: unknown, pid?: number, run?: string): Promise<unknown>;
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
 * the namespace's ingestion (WaveIngest), through the writeBatchStream op.
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
export declare const PRIOR_GENERATION_EXIT_REASON = "process lost: instance reset";
export declare function _rpcStdout(self: RpcHost, pid: number, data: Uint8Array, at?: number, run?: number): Promise<void>;
export declare function _rpcStderr(self: RpcHost, pid: number, data: Uint8Array, at?: number, run?: number): Promise<void>;
/** A live server can catch a codegen miss and continue serving: persist its
 * ledger before it is killed or evicted, without changing its process state. */
export declare function _rpcReportRuntimeCode(self: ReportRpcHost, pid: number, entries: unknown[], executedModules?: string[], dataReads?: string[]): Promise<void>;
/**
 * Called by facets from their `finally` block after I/O has drained.
 * Marks the log store so `logs` / `ps` can show the exit code, and
 * fires `_emitExitDump` if the process exited non-zero with buffered
 * output.
 *
 * Idempotent — double-call is a no-op (ProcessLogStore.markExit guards).
 */
export declare function _rpcReportExit(self: ExitRpcHost, pid: number, code: number, tail: string, dataReads?: string[], profileUnread?: string[] | null, runtimeCode?: unknown[], executedModules?: string[]): Promise<void>;
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
export declare function _emitShellExecDone(self: RpcHost, pid: number, _cmd: string, code: number, durationMs: number): void;
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
export declare function _rpcPrefetch(self: RpcHost, cwd: string, entryCode: string): Promise<Record<string, string>>;
export declare function _rpcRegisterPort(self: RpcHost, pid: number, port: number): Promise<void>;
export declare function _rpcAllocatePort(self: Pick<NimbusSession, 'portRegistry'>, pid: number): Promise<number>;
export declare function _rpcUnregisterPort(self: Pick<NimbusSession, 'portRegistry'>, pid: number, port: number): Promise<void>;
export declare function _rpcRouteLoopback(self: RpcHost, port: number, request: Request): Promise<Response>;
export declare function _rpcTransform(self: RpcHost, code: string, loader: string): Promise<{
    code: string;
    map: string;
} | null>;
/**
 * A child of `parentPid`, the process whose envelope asked for it (the
 * supervisor route passes the pid its binding stamped): the parent a request
 * names is overridden, so no process spawns a child as another's. A host's
 * own call, which no process makes, names the parent in the request.
 */
export declare function _rpcCpSpawn(self: RpcHost, req: any, parentPid?: number): Promise<{
    childPid: number;
}>;
/**
 * A child's stdin is bytes: esbuild's service protocol is binary packets,
 * and so is any pipe carrying an image or an archive. The facet queue, this
 * contract and a long-running child's input store all carry them as bytes;
 * the store used to take text, decoded here, which turned a byte that is not
 * UTF-8 into U+FFFD.
 */
export declare function _rpcCpStdinWrite(self: RpcHost, childPid: number, data: Uint8Array, pid?: number): Promise<{
    ok: boolean;
    signal?: string;
}>;
export declare function _rpcCpStdinEnd(self: RpcHost, childPid: number, pid?: number): Promise<void>;
/**
 * A process's read of its stdin. It reads its own, the pid its binding
 * stamped, whatever channel it names: a stdin it inherited as fd 0 is its
 * own channel's alias (SessionProcessSupervisor.inheritInput), and no other
 * process's is reachable by naming it. A call with no caller is the
 * session's own, and reads the channel it names.
 */
export declare function _rpcCpReadStdin(self: RpcHost, childPid: number, waitMs: number, acquire?: unknown, pid?: number, writerId?: string, maxBytes?: number): Promise<{
    signal: string;
    ended: boolean;
} | {
    data: Uint8Array;
    ended: boolean;
    resize?: {
        columns: number;
        rows: number;
    };
    signal?: string;
}>;
/**
 * The next signal sent to `pid` (the caller's own process, whose program
 * takes its own: SessionProcessSupervisor.takeSignals), waiting up to
 * `waitMs`: null if none came.
 */
/**
 * The Worker Loader shim's code store (wrangler/loader-code-store.ts): the
 * host's alone. A process's envelope carries its pid, an infrastructure
 * binding's pid 0, and both are refused; only the shim, which holds the host
 * namespace, makes a call without one.
 */
export declare function _rpcLoaderCodeStore(self: RpcHost, request: LoaderStoreRequest, stream: ReadableStream<Uint8Array> | undefined, pid?: number): Promise<unknown>;
export declare function _rpcCpNextSignal(self: RpcHost, pid: number | undefined, waitMs: number): Promise<string | null>;
/**
 * The next signal sent to `pid`'s Node program, which takes its own: its
 * box taken back from a stop (SessionProcessSupervisor.takeSignalsBack), then
 * cpNextSignal's wait. Its own op: a Node run asks only past a replay's
 * boundary, so none of its waits is a replayed observation.
 */
export declare function _rpcCpTakeSignal(self: ProcessRpcHost, pid: number | undefined, waitMs: unknown): Promise<string | null>;
/** The signals process `pid`'s program catches now (SessionProcessSupervisor.catchSignals); names not a signal's are not. */
export declare function _rpcCpCatchSignals(self: ProcessRpcHost, pid: number | undefined, catches: unknown): Promise<void>;
export declare function _rpcCpReadOutput(self: RpcHost, childPid: number, fd: 1 | 2, sinceSeq: number, waitMs: number, acquire?: unknown, pid?: number): Promise<any>;
export declare function _rpcCpDrainOutput(self: RpcHost, childPid: number, pid?: number): Promise<any>;
export declare function _rpcCpCloseOutput(self: RpcHost, childPid: number, fd: 1 | 2, pid?: number): Promise<void>;
/** A child's kill: its parent's, and as Linux's kill(2) allows (SessionProcessSupervisor.maySignal). */
export declare function _rpcCpKill(self: RpcHost, childPid: number, signal: string, pid?: number): Promise<boolean>;
/**
 * Process `pid` says whether its only remaining work is waiting on its
 * children, and how far it has applied its news (fabric setProcessBlocked).
 * Who its children are is the session's to know, not its.
 */
export declare function _rpcCpBlocked(self: RpcHost, pid: number, report: unknown): Promise<void>;
export declare function _rpcCpWait(self: RpcHost, childPid: number, waitMs: number, acquire?: unknown, pid?: number, knownStarted?: boolean): Promise<any>;
/** RPC: the peer end of Fanout's sharded submitMany (fabric executeFanoutShard). */
export declare function _rpcFanoutExecute(self: RpcHost, fnSource: string, args: unknown[], shardOpts?: FanoutShardOptions): Promise<{
    results: unknown[];
}>;
/**
 * The PeerHost an object serves its siblings with, using Nimbus's boot specs.
 */
export declare function peerHostFor(ctx: DurableObjectState, env: unknown): PeerHost;
interface PeerHostRpcHost {
    readonly peerHost: PeerHost;
}
export declare function _rpcProcessHostProbe(self: PeerHostRpcHost): {
    isolateToken: string;
};
export declare function _rpcHostProcess(self: PeerHostRpcHost, boot: unknown, opts: unknown): Promise<HostedReply<{
    ok: boolean;
    incarnation: string;
}>>;
export declare function _rpcAwaitHostedBoot(self: PeerHostRpcHost, workerKey: string): Promise<HostedReply<{
    payload: unknown;
} | {
    refused: unknown;
}>>;
export declare function _rpcRouteHostedHttp(self: PeerHostRpcHost, workerKey: string, wire: HostedHttpRequest): Promise<HostedReply<HostedHttpResponse>>;
export declare function _rpcAbandonHostedHttp(self: PeerHostRpcHost, workerKey: string, capability: string, id: number): Promise<void>;
export declare function _rpcCancelHostProcess(self: PeerHostRpcHost, workerKey: string): Promise<{
    cancelled: boolean;
}>;
interface OneShotRpcHost {
    readonly ctx: DurableObjectState;
    readonly env: object;
}
export declare function _rpcOneShotSubmit(self: OneShotRpcHost, spec: unknown, callId: unknown, fn: unknown, args: unknown, options: unknown, images: unknown): Promise<{
    ok: false;
    message: string;
    code?: string | undefined;
    unsettled: boolean;
} | {
    ok: "preamble missing";
} | {
    ok: true;
    value: unknown;
    call: {
        cold: boolean;
        loadMs: number;
        callMs: number;
    } | null;
}>;
export declare function _rpcOneShotWarm(self: OneShotRpcHost, spec: unknown, fn: unknown, images: unknown): Promise<{
    warmed: true;
}>;
export declare function _rpcOneShotCancel(self: OneShotRpcHost, callId: unknown): {
    cancelled: boolean;
};
export {};
//# sourceMappingURL=rpc.d.ts.map