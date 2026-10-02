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
import * as operations from '../session/programmatic.js';
export interface HostedSessionScope {
    /** The only named shell a command may run in; every command must name it (`sandbox(id, { shellId })`). */
    readonly shellId?: string;
    /** The identity every command and file operation runs as. */
    readonly cred?: VfsCred;
}
type RunCodeOptions = operations.ProgrammaticExecOptions & {
    language?: 'javascript' | 'typescript' | 'python' | 'ruby' | 'shell';
    install?: 'never' | 'ifMissing';
};
type Visibility = {
    visibility?: 'scoped' | 'public';
    name?: string;
};
export interface HostedSessionOwner extends operations.ProgrammaticHost {
    noteClientActivity(): void;
}
export declare class HostedSession extends RpcTarget {
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
    _rpcReady(options?: operations.ProgrammaticReadyOptions): Promise<{
        ok: true;
        preinstalled: string[];
    }>;
    _rpcExecStream(command: string, options?: operations.ProgrammaticExecOptions): Promise<ReadableStream<Uint8Array>>;
    _rpcStartProcess(command: string, options?: operations.ProgrammaticExecOptions): Promise<operations.ProgrammaticStartResult>;
    _rpcRunCode(code: string, options?: RunCodeOptions): Promise<import("@nimbus-sh/core/runtime/exec-stream.js").ExecOutput>;
    _rpcReadFile(path: string, _pid?: undefined, cred?: VfsCred): Promise<string | null>;
    _rpcReadFileBytes(path: string, _pid?: undefined, cred?: VfsCred): Promise<Uint8Array | null>;
    _rpcWriteFile(path: string, content: string | Uint8Array, _pid?: undefined, cred?: VfsCred): Promise<void>;
    _rpcStat(path: string, _pid?: undefined, cred?: VfsCred): Promise<any>;
    _rpcLstat(path: string, _pid?: undefined, cred?: VfsCred): Promise<any>;
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
    _rpcInstallRuntime(spec: string, options?: {
        force?: boolean;
    }): Promise<import("../runtime/package-manager.js").RuntimeInstallSummary>;
    _rpcEnsureRuntimes(specs: string[], options?: {
        force?: boolean;
    }): Promise<import("../runtime/package-manager.js").RuntimeInstallSummary[]>;
    _rpcListRuntimes(): Promise<{
        installed: import("@nimbus-sh/core/runtime/installed-runtimes.js").RuntimeSummary[];
        available: import("@nimbus-sh/core/runtime/runtime-package.js").RuntimeAvailability[];
    }>;
    _rpcListProcesses(): Promise<operations.SerializedProcess[]>;
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
    _rpcResizeProcess(pid: number, size: {
        columns: number;
        rows: number;
    }): Promise<{
        ok: boolean;
        pid: number;
    }>;
    _rpcSignalProcess(pid: number, signal: string): Promise<{
        ok: boolean;
        pid: number;
    }>;
    _rpcProcessLogs(pid: number, options?: {
        cursor?: number;
        lines?: number;
        bytes?: number;
    }): Promise<{
        pid: number;
        chunks: import("@nimbus-sh/core/runtime/process-logs.js").SequencedLogChunk[];
        text: string;
        cursor: number;
        truncated: boolean;
        exit: import("@nimbus-sh/core/runtime/process-logs.js").ProcessExitInfo | null;
    }>;
    _rpcListPorts(): Promise<operations.SerializedPort[]>;
    _rpcExposePort(port: number, options?: Visibility): Promise<{
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
    _rpcListApps(): Promise<operations.ListedApp[]>;
    _rpcExposeApp(target: operations.AppTarget, options?: Visibility): Promise<operations.ExposedAppResult>;
    _rpcRotateLink(target: operations.AppTarget): Promise<operations.ExposedAppResult>;
    _rpcRemoveApp(target: operations.AppTarget): Promise<{
        owner: string;
        removed: boolean;
        port: number | null;
    }>;
    _rpcEnsureDurableApp(input: {
        owner: string;
        preferredPort?: number;
        visibility?: 'scoped' | 'public';
        name?: string;
    }): Promise<{
        port: number;
        capability: string | null;
        visibility: "scoped" | "public";
    }>;
    _rpcRemoveDurableApp(owner: string): Promise<{
        owner: string;
        removed: boolean;
        port: number | null;
    }>;
    /** The embedder owns the workspace's life; a session it handed out cannot end it. */
    _rpcDestroy(): Promise<never>;
}
export {};
//# sourceMappingURL=session.d.ts.map