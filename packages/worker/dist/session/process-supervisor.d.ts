import { RpcTarget } from 'cloudflare:workers';
import type { SupervisorBindingProps } from '@nimbus-sh/fabric/supervisor-props.js';
import type { SupervisorOpEnvelope } from '@nimbus-sh/core/workspace/supervisor-op.js';
import { TRANSPORT, type SupervisorTransport } from './supervisor-calls.js';
declare const ProcessSupervisor_base: (abstract new (...args: any[]) => {
    _op<T>(op: import("@nimbus-sh/core/workspace/supervisor-ops.js").SupervisorOpName, args?: readonly unknown[], extra?: Omit<SupervisorOpEnvelope, "op" | "args">): Promise<T>;
    _caller(envelope: SupervisorOpEnvelope): SupervisorOpEnvelope;
    _fsOp<T>(op: import("@nimbus-sh/core/workspace/supervisor-ops.js").SupervisorOpName, args?: readonly unknown[]): Promise<T>;
    _fsRead<T>(op: import("@nimbus-sh/core/workspace/supervisor-ops.js").SupervisorJoinedReadOpName, args?: readonly unknown[]): Promise<T>;
    _fsMutation<T>(op: import("@nimbus-sh/core/workspace/supervisor-ops.js").SupervisorDeliveredOpName, args: NonNullable<SupervisorOpEnvelope["args"]>): Promise<T>;
    _resent<T>(envelope: SupervisorOpEnvelope, trace: import("./supervisor-calls.js").Resend["trace"], policy?: import("@nimbus-sh/fabric/do-calls.js").DoCallRetryPolicy): Promise<T>;
    _mutationOwner(): string | undefined;
    _hostIncarnation(): string | undefined;
    _reportingPid(): number;
    _call<T>(promise: Promise<T>): Promise<T>;
    _cacheRead<T>(plan: {
        ticket?: string;
        readOnly: boolean;
    }, produce: (client: import("../npm/r2-cache.js").R2CacheClient) => Promise<T>): Promise<T>;
    _infrastructureCache(op: import("@nimbus-sh/core/workspace/supervisor-ops.js").SupervisorOpName, args: readonly unknown[]): boolean;
    _network(): import("@nimbus-sh/core/_shared/workspace-network.js").WorkspaceNetwork;
    _pid(): number;
    _runId(): string | undefined;
    answer(method: import("@nimbus-sh/core/runtime/vfs-supervisor.js").SupervisorAnsweredMethod, args: unknown[]): Promise<import("@nimbus-sh/core/runtime/vfs-supervisor.js").SupervisorAnswer>;
    readFile(path: string): Promise<string | null>;
    readFileBytes(path: import("@nimbus-sh/core/runtime/os-contracts.js").RuntimeFsPath): Promise<Uint8Array | null>;
    writeFile(path: import("@nimbus-sh/core/runtime/os-contracts.js").RuntimeFsPath, content: string | Uint8Array): Promise<number>;
    writeFileStat(path: import("@nimbus-sh/core/runtime/os-contracts.js").RuntimeFsPath, content: string | Uint8Array): Promise<import("@nimbus-sh/core/workspace/supervisor-op.js").WriteFileStatAnswer>;
    stat(path: import("@nimbus-sh/core/runtime/os-contracts.js").RuntimeFsPath, options?: {
        followSymlinks?: boolean;
    } | undefined): Promise<Awaited<ReturnType<import("@nimbus-sh/core/runtime/os-contracts.js").RuntimeFsBridge["stat"]>>>;
    lstat(path: string): Promise<any>;
    hasLegacySymlinkUnder(path: string): Promise<boolean>;
    utimes(path: import("@nimbus-sh/core/runtime/os-contracts.js").RuntimeFsPath, atimeMs: number, mtimeMs: number): Promise<import("@nimbus-sh/core/runtime/os-contracts.js").VfsMutationReceipt>;
    chmod(path: import("@nimbus-sh/core/runtime/os-contracts.js").RuntimeFsPath, mode: number): Promise<import("@nimbus-sh/core/runtime/os-contracts.js").VfsMutationReceipt>;
    access(path: import("@nimbus-sh/core/runtime/os-contracts.js").RuntimeFsPath, mode: number): Promise<void>;
    chown(path: import("@nimbus-sh/core/runtime/os-contracts.js").RuntimeFsPath, uid: number, gid: number, options?: {
        followSymlinks?: boolean;
    } | undefined): Promise<import("@nimbus-sh/core/runtime/os-contracts.js").VfsMutationReceipt>;
    setUmask(mask: number): Promise<number>;
    readdir(path: import("@nimbus-sh/core/runtime/os-contracts.js").RuntimeFsPath): Promise<{
        name: string;
        type: string;
    }[]>;
    exists(path: string): Promise<boolean>;
    mkdir(path: import("@nimbus-sh/core/runtime/os-contracts.js").RuntimeFsPath, options?: Parameters<import("@nimbus-sh/core/runtime/os-contracts.js").RuntimeFsBridge["mkdir"]>[1]): Promise<void>;
    rmdir(path: import("@nimbus-sh/core/runtime/os-contracts.js").RuntimeFsPath): Promise<void>;
    rename(from: import("@nimbus-sh/core/runtime/os-contracts.js").RuntimeFsPath, to: import("@nimbus-sh/core/runtime/os-contracts.js").RuntimeFsPath): Promise<void>;
    unlink(path: import("@nimbus-sh/core/runtime/os-contracts.js").RuntimeFsPath): Promise<void>;
    readlink(path: import("@nimbus-sh/core/runtime/os-contracts.js").RuntimeFsPath): Promise<string | null>;
    symlink(target: string, path: import("@nimbus-sh/core/runtime/os-contracts.js").RuntimeFsPath): Promise<void>;
    fsAcquire(epoch: string | null, cursor: number, options?: import("@nimbus-sh/core/runtime/os-contracts.js").VfsAcquireOptions): Promise<import("@nimbus-sh/core/runtime/os-contracts.js").VfsAcquireResult>;
    fsAcquired(acquire: unknown, op: string, args: unknown[]): Promise<import("./rpc.js").FsAcquiredAnswer>;
    fsRevision(path?: string): Promise<number>;
    fsStorageGrant(facet: string, bytes: number, databaseSize: number): Promise<{
        granted: number;
    }>;
    fsList(after?: string | null, limit?: number | null): Promise<import("@nimbus-sh/core/runtime/os-contracts.js").VfsListPage>;
    fsListTree(root: string, maxEntries: number): Promise<import("@nimbus-sh/core/runtime/os-contracts.js").VfsListTree>;
    wsOpen(url: string, protocols: string[], headers?: import("./ws-relay.js").WsRelayHeaders, refusalBody?: boolean): Promise<import("./ws-relay.js").WsRelayOpened>;
    wsPoll(id: number, waitMs: number): Promise<unknown[]>;
    wsSend(id: number, text: string | null, bytes: Uint8Array | null): Promise<void>;
    wsClose(id: number, code?: number, reason?: string): Promise<void>;
    fsOpen(path: import("@nimbus-sh/core/runtime/os-contracts.js").RuntimeFsPath, flags: import("@nimbus-sh/core/runtime/os-contracts.js").RuntimeOpenFlags): Promise<import("@nimbus-sh/core/runtime/os-contracts.js").RuntimeFileHandle>;
    fsRead(handleId: number, offset: number | null, length: number): Promise<Uint8Array>;
    fsWrite(handleId: number, offset: number | null, bytes: Uint8Array | ArrayBuffer | number[]): Promise<number>;
    fsFstat(handleId: number): Promise<Awaited<ReturnType<import("@nimbus-sh/core/runtime/os-contracts.js").RuntimeFsBridge["fstat"]>>>;
    fsDup(handleId: number): Promise<Awaited<ReturnType<import("@nimbus-sh/core/runtime/os-contracts.js").RuntimeFsBridge["dup"]>>>;
    fsSeek(handleId: number, offset: number, whence: "set" | "current" | "end"): Promise<Awaited<ReturnType<import("@nimbus-sh/core/runtime/os-contracts.js").RuntimeFsBridge["seek"]>>>;
    fsSetStatus(handleId: number, status: {
        append?: boolean;
    }): Promise<Awaited<ReturnType<import("@nimbus-sh/core/runtime/os-contracts.js").RuntimeFsBridge["setStatus"]>>>;
    fsReaddirHandle(handleId: number): Promise<Awaited<ReturnType<import("@nimbus-sh/core/runtime/os-contracts.js").RuntimeFsBridge["readdirHandle"]>>>;
    fsFtruncate(handleId: number, size: number): Promise<Awaited<ReturnType<import("@nimbus-sh/core/runtime/os-contracts.js").RuntimeFsBridge["ftruncate"]>>>;
    fsFchmod(handleId: number, mode: number): Promise<Awaited<ReturnType<import("@nimbus-sh/core/runtime/os-contracts.js").RuntimeFsBridge["fchmod"]>>>;
    fsFchown(handleId: number, uid: number, gid: number): Promise<Awaited<ReturnType<import("@nimbus-sh/core/runtime/os-contracts.js").RuntimeFsBridge["fchown"]>>>;
    fsFutimes(handleId: number, atimeMs: number, mtimeMs: number): Promise<Awaited<ReturnType<import("@nimbus-sh/core/runtime/os-contracts.js").RuntimeFsBridge["futimes"]>>>;
    fsSync(handleId?: number | undefined): Promise<Awaited<ReturnType<import("@nimbus-sh/core/runtime/os-contracts.js").RuntimeFsBridge["fsync"]>>>;
    fsRealpath(path: import("@nimbus-sh/core/runtime/os-contracts.js").RuntimeFsPath): Promise<Awaited<ReturnType<import("@nimbus-sh/core/runtime/os-contracts.js").RuntimeFsBridge["realpath"]>>>;
    fsLinkLeadsTo(path: string, link: string): Promise<Awaited<ReturnType<import("@nimbus-sh/core/runtime/os-contracts.js").RuntimeFsBridge["linkLeadsTo"]>>>;
    fsRemove(path: import("@nimbus-sh/core/runtime/os-contracts.js").RuntimeFsPath, options?: {
        recursive?: boolean;
        force?: boolean;
    } | undefined): Promise<Awaited<ReturnType<import("@nimbus-sh/core/runtime/os-contracts.js").RuntimeFsBridge["remove"]>>>;
    fsCopyFile(from: import("@nimbus-sh/core/runtime/os-contracts.js").RuntimeFsPath, to: import("@nimbus-sh/core/runtime/os-contracts.js").RuntimeFsPath): Promise<Awaited<ReturnType<import("@nimbus-sh/core/runtime/os-contracts.js").RuntimeFsBridge["copyFile"]>>>;
    fsCopyTree(from: import("@nimbus-sh/core/runtime/os-contracts.js").RuntimeFsPath, to: import("@nimbus-sh/core/runtime/os-contracts.js").RuntimeFsPath, options?: {
        preserve?: boolean;
    } | undefined): Promise<Awaited<ReturnType<import("@nimbus-sh/core/runtime/os-contracts.js").RuntimeFsBridge["copyTree"]>>>;
    fsAcquireExclusiveMutation(path: import("@nimbus-sh/core/runtime/os-contracts.js").RuntimeFsPath, options?: import("@nimbus-sh/core/runtime/os-contracts.js").ExclusiveMutationRequest | undefined): Promise<Awaited<ReturnType<import("@nimbus-sh/core/runtime/os-contracts.js").RuntimeFsBridge["acquireExclusiveMutation"]>>>;
    fsReleaseExclusiveMutation(owner: string): Promise<Awaited<ReturnType<import("@nimbus-sh/core/runtime/os-contracts.js").RuntimeFsBridge["releaseExclusiveMutation"]>>>;
    fsAwaitRecall(owner: string, waitMs?: number): Promise<import("@nimbus-sh/core/runtime/os-contracts.js").RecallKind | null>;
    fsRecalled(owner: string, kind: import("@nimbus-sh/core/runtime/os-contracts.js").RecallKind): Promise<void>;
    fsClose(handleId: number): Promise<void>;
    fsReadRange(path: string, offset: number, length: number): Promise<Uint8Array | null>;
    fsReadRangeUncached(path: string, offset: number, length: number): Promise<Uint8Array | null>;
    fsReadBatch(requests: import("./rpc.js").FsReadBatchRequest[]): Promise<import("./rpc.js").FsReadBatchEntry[]>;
    fsWriteRange(path: string, offset: number, bytes: Uint8Array | ArrayBuffer): Promise<import("@nimbus-sh/core/runtime/os-contracts.js").VfsMutationReceipt>;
    fsTruncate(path: string, size: number): Promise<import("@nimbus-sh/core/runtime/os-contracts.js").VfsMutationReceipt>;
    writeBatch(payload: any): Promise<{
        inodes: number;
        chunks: number;
    }>;
    openWaveWriter(first?: boolean): Promise<string | null>;
    retireWaveWriter(writer: string): Promise<void>;
    writeBatchStream(stream: ReadableStream<Uint8Array>, fence?: import("@nimbus-sh/platform/wave-writer.js").WaveFence, owner?: string): Promise<import("@nimbus-sh/core/vfs/sqlite-vfs.js").WriteBatchStreamResult>;
    putRegistryEntries(entries: any[]): Promise<{
        written: number;
        failed: number;
    }>;
    getCachedTarball(integrity: string): Promise<{
        bytes: Uint8Array | null;
        events: import("@nimbus-sh/core/_shared/cache-stats.js").CacheStatEvent[];
    }>;
    putCachedTarball(integrity: string, bytes: Uint8Array | ArrayBuffer): Promise<boolean>;
    getPackument(name: string, options?: {
        retries?: number;
        timeoutMs?: number;
        registry?: string;
    } | undefined): Promise<import("../npm/r2-cache.js").PackumentReadThrough & {
        events: import("@nimbus-sh/core/_shared/cache-stats.js").CacheStatEvent[];
    }>;
    stdout(data: Uint8Array, at?: number, run?: number): Promise<void>;
    stderr(data: Uint8Array, at?: number, run?: number): Promise<void>;
    reportExit(code: number, tail?: string, dataReads?: string[], profileUnread?: string[], runtimeCode?: unknown[], executedModules?: string[]): Promise<void>;
    reportRuntimeCode(entries: unknown[], executedModules?: string[], dataReads?: string[]): Promise<void>;
    prefetch(cwd: string, entryCode: string): Promise<Record<string, string>>;
    registerPort(port: number): Promise<void>;
    allocatePort(): Promise<number>;
    unregisterPort(port: number): Promise<void>;
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
    replayBoundary(): Promise<void>;
    stdinFileRead(path: string, offset: number, length: number): Promise<{
        data: Uint8Array;
        size: number;
    }>;
    stdinPrepared(): Promise<void>;
    netTls(action: "open" | "upgrade", token: string, payload: Record<string, unknown>): Promise<unknown>;
    cpReadStdin(childPid: number, waitMs: number, acquire?: import("./rpc.js").FsAcquireArgs, maxBytes?: number): Promise<{
        data: Uint8Array;
        ended: boolean;
        resize?: {
            columns: number;
            rows: number;
        } | undefined;
        signal?: string;
        acquired?: import("./rpc.js").VfsDeliveredAcquire;
    }>;
    cpReadOutput(childPid: number, fd: 1 | 2, sinceSeq: number, waitMs: number, acquire?: import("./rpc.js").FsAcquireArgs): Promise<{
        chunks: {
            seq: number;
            data: Uint8Array;
        }[];
        closed: boolean;
        maxSeq: number;
        news?: number[];
        acquired?: import("./rpc.js").VfsDeliveredAcquire;
    }>;
    cpDrainOutput(childPid: number): Promise<{
        stdout: Uint8Array;
        stderr: Uint8Array;
        stdoutClosed: boolean;
        stderrClosed: boolean;
    }>;
    cpKill(childPid: number, signal: string): Promise<boolean>;
    cpWait(childPid: number, waitMs: number, acquire?: import("./rpc.js").FsAcquireArgs, knownStarted?: boolean): Promise<{
        done: boolean;
        exitCode: number | null;
        signal: string | null;
        spawnError?: string;
        started?: boolean;
        news?: number[];
        acquired?: import("./rpc.js").VfsDeliveredAcquire;
    }>;
    cpBlocked(report: {
        blocked: boolean;
        frontier: number;
        seq: number;
    }): Promise<void>;
    [TRANSPORT](): SupervisorTransport;
}) & typeof RpcTarget;
/**
 * A one-shot's SUPERVISOR as a capability its host hands it in the call that
 * runs it, answered by `answer`, the host Durable Object's own
 * supervisorOp. workerd delivers a call on it over that call's RPC session,
 * inside the host's IoContext: no new request to the host, so it neither
 * becomes the host's front request, whose subrequest depth every later call
 * of the host inherits, nor costs the binding's hop and the stub's.
 */
export declare class ProcessSupervisor extends ProcessSupervisor_base {
    #private;
    constructor(props: SupervisorBindingProps, env: unknown, answer: (envelope: SupervisorOpEnvelope) => Promise<unknown>);
    [TRANSPORT](): SupervisorTransport;
}
export {};
//# sourceMappingURL=process-supervisor.d.ts.map