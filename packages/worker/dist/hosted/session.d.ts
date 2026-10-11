/**
 * The SDK's session surface, served by a hosted runtime.
 *
 * `Nimbus.fromSession` drives a `NimbusSandbox` over any object with the
 * `_rpc*` methods a `NimbusSession` Durable Object answers. A hosted runtime
 * has no such object of its own: its embedder's Durable Object owns it. So the
 * runtime hands out this `RpcTarget`, and the embedder passes it wherever a
 * sandbox client runs — another isolate included, since an `RpcTarget`
 * crosses RPC as a stub whose calls run here.
 *
 * A session may be scoped. A scope confines two things: the one named shell
 * its commands run in, and the identity every command and file operation
 * runs as. The stub is the capability, so a caller that names another shell
 * or identity is refused rather than obeyed; a scope that names no shell
 * runs no command, since the only shell left to it is the embedder's own.
 * The workspace's destruction stays with the embedder. Processes, ports,
 * logs and applications are not confined: they are workspace-wide, as they
 * are to the shell's own `ps`, `kill`, `logs` and `nimbus expose`/`app`.
 */
import { RpcTarget } from 'cloudflare:workers';
import { type VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { SessionRpc, SessionReadyOptions, SessionExecOptions, SessionRunCodeOptions, SessionExposeOptions, SessionDurableAppOptions, SessionRuntimeInstallOptions, SessionTerminalSize, SessionProcessLogsOptions, SessionAppTarget } from '@nimbus-sh/core/runtime/session-protocol.js';
import * as operations from '../session/programmatic.js';
export interface HostedSessionScope {
    /** The only named shell a command may run in; every command must name it (`sandbox(id, { shellId })`). */
    readonly shellId?: string;
    /** The identity every command and file operation runs as. */
    readonly cred?: VfsCred;
}
export interface HostedSessionOwner extends operations.ProgrammaticHost {
    noteClientActivity(): void;
}
export declare class HostedSession extends RpcTarget implements SessionRpc {
    private readonly owner;
    private readonly scope;
    constructor(owner: HostedSessionOwner, scope: HostedSessionScope);
    /** Every call is a client's, as every `composeHostedRuntime` call is: it notes activity for the resident keep-alive. */
    private client;
    /**
     * The identity a call acts as. A scoped session always names one: its own,
     * or the session user every command runs as by default, so no verb's own
     * default (the kernel, for `files.delete`) applies to it.
     */
    private cred;
    private exec;
    _rpcReady(options?: SessionReadyOptions): Promise<{
        ok: true;
        preinstalled: string[];
    }>;
    _rpcExecStream(command: string, options?: SessionExecOptions): Promise<ReadableStream<Uint8Array>>;
    _rpcStartProcess(command: string, options?: SessionExecOptions): Promise<{
        command: string;
        pid: number;
        process: {
            pid: number;
            command: string;
            argv: string[];
            cwd: string;
            state: string;
            exitCode: number | null;
            startTime: number;
            endTime: number | null;
            longRunning: boolean;
            attachedTty: boolean;
            execId?: string | undefined;
        };
        ports: {
            port: number;
            pid: number;
            registeredAt: number;
            capability: string;
            execId?: string | undefined;
        }[];
        startedAt: number;
    }>;
    _rpcDetachExec(detachId: string): Promise<{
        detached: boolean;
    }>;
    _rpcRunCode(code: string, options?: SessionRunCodeOptions): Promise<{
        command: string;
        exitCode: number;
        success: boolean;
        duration: number;
        timestamp: number;
        stdout: string;
        stderr: string;
    }>;
    _rpcReadFile(path: string, _pid?: undefined, cred?: VfsCred): Promise<string | null>;
    _rpcReadFileBytes(path: string, _pid?: undefined, cred?: VfsCred): Promise<Uint8Array | null>;
    _rpcWriteFile(path: string, content: string | Uint8Array, _pid?: undefined, cred?: VfsCred): Promise<number>;
    _rpcStat(path: string, _pid?: undefined, cred?: VfsCred): Promise<{
        type: string;
        size: number;
        mtime: number;
        mode: number;
        ctime?: number | undefined;
        ino?: number | undefined;
        revision?: number | undefined;
    } | null>;
    _rpcLstat(path: string, _pid?: undefined, cred?: VfsCred): Promise<{
        type: string;
        size: number;
        mtime: number;
        mode: number;
        ctime?: number | undefined;
        ino?: number | undefined;
        revision?: number | undefined;
    } | null>;
    _rpcReadlink(path: string, _pid?: undefined, cred?: VfsCred): Promise<string | null>;
    _rpcReaddir(path: string, _pid?: undefined, cred?: VfsCred): Promise<{
        name: string;
        type: string;
    }[]>;
    _rpcRename(from: string, to: string, _pid?: undefined, cred?: VfsCred): Promise<void>;
    _rpcChmod(path: string, mode: number, _pid?: undefined, cred?: VfsCred): Promise<void>;
    _rpcFsReadRange(path: string, offset: number, length: number, _pid?: undefined, cred?: VfsCred): Promise<Uint8Array<ArrayBufferLike> | null>;
    _rpcExists(path: string, _pid?: undefined, cred?: VfsCred): Promise<boolean>;
    _rpcMkdir(path: string, _pid?: undefined, cred?: VfsCred): Promise<void>;
    _rpcDeleteFile(path: string, options?: {
        recursive?: boolean;
    }, cred?: VfsCred): Promise<void>;
    _rpcInstallRuntime(spec: string, options?: SessionRuntimeInstallOptions): Promise<{
        spec: string;
        exitCode: number;
        stdout: string;
        stderr: string;
    }>;
    _rpcEnsureRuntimes(specs: string[], options?: SessionRuntimeInstallOptions): Promise<{
        spec: string;
        exitCode: number;
        stdout: string;
        stderr: string;
    }[]>;
    _rpcListRuntimes(): Promise<{
        installed: {
            name: string;
            version: string;
            root: string;
            abi: string;
            bins: string[];
            sizeBytes: number;
            license: string;
        }[];
        available: {
            name: string;
            abi: string;
            defaultVersion: string;
            versions: {
                version: string;
                sizeBytes: number;
                license: string;
            }[];
        }[];
    }>;
    _rpcListProcesses(): Promise<{
        pid: number;
        command: string;
        argv: string[];
        cwd: string;
        state: string;
        exitCode: number | null;
        startTime: number;
        endTime: number | null;
        longRunning: boolean;
        attachedTty: boolean;
        execId?: string | undefined;
    }[]>;
    _rpcKillProcess(pid: number): Promise<{
        ok: boolean;
        pid: number;
    }>;
    _rpcWriteProcessInput(pid: number, data: string): Promise<{
        ok: boolean;
        pid: number;
    }>;
    _rpcEndProcessInput(pid: number): Promise<{
        ok: boolean;
        pid: number;
    }>;
    _rpcResizeProcess(pid: number, size: SessionTerminalSize): Promise<{
        ok: boolean;
        pid: number;
    }>;
    _rpcSignalProcess(pid: number, signal: string): Promise<{
        ok: boolean;
        pid: number;
    }>;
    _rpcProcessLogs(pid: number, options?: SessionProcessLogsOptions): Promise<{
        pid: number;
        chunks: {
            seq: number;
            ts: number;
            stream: "stdout" | "stderr";
            data: string;
            binary?: boolean | undefined;
        }[];
        text: string;
        cursor: number;
        truncated: boolean;
        exit: {
            code: number;
            at: number;
            reason?: string | undefined;
        } | null;
    }>;
    _rpcListPorts(): Promise<{
        port: number;
        pid: number;
        registeredAt: number;
        capability: string;
        execId?: string | undefined;
    }[]>;
    _rpcExposePort(port: number, options?: SessionExposeOptions): Promise<{
        execId?: string;
        port: number;
        listening: boolean;
        pid: number | null;
        registeredAt: number | null;
        capability: string | null;
        visibility: "scoped" | "public";
        owner: string | null;
        name: string | null;
    }>;
    _rpcUnexposePort(port: number): Promise<{
        port: number;
        ok: boolean;
    }>;
    _rpcListApps(): Promise<{
        owner: string;
        name: string | null;
        port: number | null;
        pid: number | null;
        status: "running" | "starting" | "stopped" | "failed";
        visibility: "scoped" | "public";
        capability: string | null;
        restart: "never" | "on-failure";
        diagnostic: string | null;
        url: string | null;
        execId?: string | undefined;
    }[]>;
    _rpcExposeApp(target: SessionAppTarget, options?: SessionExposeOptions): Promise<{
        owner: string;
        name: string | null;
        port: number;
        pid: number | null;
        capability: string | null;
        visibility: "scoped" | "public";
        url: string | null;
        execId?: string | undefined;
    }>;
    _rpcRotateLink(target: SessionAppTarget): Promise<{
        owner: string;
        name: string | null;
        port: number;
        pid: number | null;
        capability: string | null;
        visibility: "scoped" | "public";
        url: string | null;
        execId?: string | undefined;
    }>;
    _rpcRemoveApp(target: SessionAppTarget): Promise<{
        removed: boolean;
        owner: string;
        port: number | null;
    }>;
    _rpcEnsureDurableApp(input: SessionDurableAppOptions): Promise<{
        port: number;
        capability: string | null;
        visibility: import("../session/port-capability.js").PortVisibility;
    }>;
    _rpcRemoveDurableApp(owner: string): Promise<{
        owner: string;
        removed: boolean;
        port: number | null;
    }>;
    /** The embedder owns the workspace's life; a session it handed out cannot end it. */
    _rpcDestroy(): Promise<never>;
}
//# sourceMappingURL=session.d.ts.map