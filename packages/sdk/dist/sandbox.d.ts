/**
 * @nimbus-sh/sdk/sandbox - programmatic Nimbus sandbox handle.
 */
export type RuntimeSpec = string;
export type RuntimeName = 'node' | 'bun' | 'npm' | 'git' | 'python' | 'ruby' | 'clang' | 'shell' | (string & {});
export interface NimbusRuntimePolicy {
    preinstall?: RuntimeSpec[];
    onDemand?: boolean;
    allow?: RuntimeName[];
}
export interface NimbusSandboxProfile {
    root?: string;
    runtimes?: NimbusRuntimePolicy;
    tools?: {
        namespace?: string;
        kind?: string;
    };
    preview?: {
        baseUrl?: string;
        pathStyle?: boolean;
    };
}
export interface NimbusConfig {
    endpoint?: string;
    /**
     * The deployment's `NIMBUS_PREVIEW_HOST_SUFFIX`, enabling the
     * `<port>--<sid>.<suffix>` preview origin. `Nimbus.fromEnv` reads it off
     * the bindings, so in-Worker callers never restate it; remote clients
     * (`Nimbus.connect`) have no bindings and must supply it to get host-form
     * preview URLs.
     */
    previewHostSuffix?: string;
    sandboxes?: Record<string, NimbusSandboxProfile>;
}
export interface NimbusFromEnvOptions {
    binding?: string;
    endpoint?: string;
}
export type NimbusHeaders = HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
export interface NimbusConnectOptions {
    /** Base URL of a Nimbus deployment, for example `https://nimbus.example.com`. */
    endpoint: string;
    /** Nimbus JWT. Sent as `Authorization: Bearer <token>` when provided. */
    token?: string;
    /** Additional headers, or a callback for rotating credentials. */
    headers?: NimbusHeaders;
    /** Custom fetch implementation. Defaults to global `fetch`. */
    fetch?: typeof fetch;
    /** Remote API base path. Defaults to `/api/nimbus/v1`. */
    basePath?: string;
    /** Sandbox profiles used by this client. The deployment should use the same config. */
    config?: NimbusConfig;
}
export interface NimbusSandboxOptions {
    profile?: string;
    tenant?: string;
    subject?: string;
    root?: string;
}
export interface NimbusExecOptions {
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    stdin?: string;
}
export interface NimbusExecResult {
    command: string;
    exitCode: number;
    success: boolean;
    stdout: string;
    stderr: string;
    duration: number;
    timestamp: number;
}
export interface NimbusTerminalSize {
    columns: number;
    rows: number;
}
export interface NimbusDestroyOptions {
    reason?: string;
}
export interface NimbusDestroyResult {
    ok: true;
    killed: number;
    destroyedAt: number;
    reason: string | null;
}
/**
 * A started background process. It is still running when `startProcess`
 * returns, so there is no exit code or captured output here — poll
 * `processes.logs(pid)` (which carries the exit record once it lands),
 * `processes.list()`, or `processes.attach(pid)`.
 */
export interface NimbusStartResult {
    command: string;
    pid: number;
    process: NimbusProcess;
    ports: NimbusPort[];
    startedAt: number;
}
export interface NimbusProcess {
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
}
export interface NimbusProcessLogChunk {
    seq: number;
    ts: number;
    stream: 'stdout' | 'stderr';
    data: string;
    binary?: boolean;
}
export interface NimbusProcessExitInfo {
    code: number;
    at: number;
    reason?: string;
}
export interface NimbusProcessLogsOptions {
    cursor?: number;
    lines?: number;
    bytes?: number;
}
export interface NimbusProcessLogsResult {
    pid: number;
    chunks: NimbusProcessLogChunk[];
    text: string;
    cursor: number;
    truncated: boolean;
    exit: NimbusProcessExitInfo | null;
}
export interface NimbusProcessAttachOptions {
    pollIntervalMs?: number;
    lines?: number;
    bytes?: number;
    signal?: AbortSignal;
}
export interface NimbusPort {
    port: number;
    pid: number;
    registeredAt: number;
}
export interface NimbusFileStat {
    type: 'file' | 'directory' | string;
    size: number;
    ctime?: number;
    mtime: number;
    mode: number;
}
export interface NimbusRuntimeSummary {
    name: string;
    version: string;
    root: string;
    abi: string;
    bins: string[];
    sizeBytes: number;
    license: string;
}
export interface NimbusAvailableRuntime {
    name: string;
    abi: string;
    defaultVersion: string;
    versions: Array<{
        version: string;
        sizeBytes: number;
        license: string;
    }>;
}
interface NimbusSessionStub {
    _rpcReady(options?: {
        preinstall?: string[];
    }): Promise<{
        ok: true;
        preinstalled: string[];
    }>;
    _rpcExec(command: string, options?: Record<string, unknown>): Promise<NimbusExecResult>;
    _rpcStartProcess(command: string, options?: Record<string, unknown>): Promise<NimbusStartResult>;
    _rpcRunCode(code: string, options?: Record<string, unknown>): Promise<NimbusExecResult>;
    _rpcReadFile(path: string): Promise<string | null>;
    _rpcReadFileBytes(path: string): Promise<Uint8Array | null>;
    _rpcWriteFile(path: string, content: string | Uint8Array): Promise<void>;
    _rpcStat(path: string): Promise<NimbusFileStat | null>;
    _rpcLstat(path: string): Promise<NimbusFileStat | null>;
    _rpcReaddir(path: string): Promise<{
        name: string;
        type: string;
    }[]>;
    _rpcRename(from: string, to: string): Promise<void>;
    _rpcChmod(path: string, mode: number): Promise<void>;
    _rpcFsReadRange(path: string, offset: number, length: number): Promise<Uint8Array | null>;
    _rpcExists(path: string): Promise<boolean>;
    _rpcMkdir(path: string): Promise<void>;
    _rpcDeleteFile(path: string, options?: {
        recursive?: boolean;
    }): Promise<void>;
    _rpcInstallRuntime(spec: string, options?: {
        force?: boolean;
    }): Promise<unknown>;
    _rpcEnsureRuntimes(specs: string[], options?: {
        force?: boolean;
    }): Promise<unknown>;
    _rpcListRuntimes(): Promise<{
        installed: NimbusRuntimeSummary[];
        available: NimbusAvailableRuntime[];
    }>;
    _rpcListProcesses(): Promise<NimbusProcess[]>;
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
    _rpcResizeProcess(pid: number, size: NimbusTerminalSize): Promise<{
        ok: boolean;
        pid: number;
    }>;
    _rpcSignalProcess(pid: number, signal: string): Promise<{
        ok: boolean;
        pid: number;
    }>;
    _rpcProcessLogs(pid: number, options?: NimbusProcessLogsOptions): Promise<NimbusProcessLogsResult>;
    _rpcListPorts(): Promise<NimbusPort[]>;
    _rpcExposePort(port: number): Promise<{
        port: number;
        listening: boolean;
        pid: number | null;
        registeredAt: number | null;
    }>;
    _rpcUnexposePort(port: number): Promise<{
        port: number;
        ok: boolean;
    }>;
    _rpcDestroy(options?: NimbusDestroyOptions): Promise<NimbusDestroyResult>;
}
interface NimbusSessionNamespace {
    idFromName(name: string): DurableObjectId;
    get(id: DurableObjectId): NimbusSessionStub;
}
type NimbusTarget = {
    kind: 'binding';
    namespace: NimbusSessionNamespace;
} | {
    kind: 'remote';
    endpoint: string;
    basePath: string;
    token?: string;
    headers?: NimbusHeaders;
    fetch: typeof fetch;
};
export declare class NimbusRemoteError extends Error {
    readonly status: number;
    readonly code: string | undefined;
    readonly body: unknown;
    constructor(message: string, options: {
        status: number;
        code?: string;
        body?: unknown;
    });
}
export declare class Nimbus {
    private readonly config;
    static fromEnv(env: Record<string, unknown>, config?: NimbusConfig, options?: NimbusFromEnvOptions): Nimbus;
    static connect(options: NimbusConnectOptions): Nimbus;
    private readonly target;
    constructor(target: NimbusSessionNamespace | NimbusTarget, config?: NimbusConfig);
    sandbox(id: string, options?: NimbusSandboxOptions): NimbusSandbox;
}
export declare class NimbusSandbox {
    private readonly target;
    private readonly options;
    private readonly config;
    readonly id: string;
    readonly profileName: string;
    private readonly profile;
    private readyPromise;
    constructor(target: NimbusTarget, id: string, options: NimbusSandboxOptions, config: NimbusConfig);
    private get tenantSegment();
    private get doName();
    private get root();
    private stub;
    private remoteStub;
    private remoteRpc;
    ready(): Promise<void>;
    exec(command: string, options?: NimbusExecOptions): Promise<NimbusExecResult>;
    /**
     * Start a command in the background. Returns as soon as the process has a
     * pid — it does not wait for the command to finish.
     */
    startProcess(command: string, options?: NimbusExecOptions): Promise<NimbusStartResult>;
    runCode(code: string, options?: NimbusExecOptions & {
        language?: 'javascript' | 'typescript' | 'python' | 'ruby' | 'shell';
        install?: 'never' | 'ifMissing';
    }): Promise<NimbusExecResult>;
    destroy(options?: NimbusDestroyOptions): Promise<NimbusDestroyResult>;
    files: {
        read: (path: string) => Promise<string | null>;
        readBytes: (path: string) => Promise<Uint8Array | null>;
        write: (path: string, content: string | Uint8Array) => Promise<void>;
        stat: (path: string) => Promise<NimbusFileStat | null>;
        /** stat without following a symlink leaf. */
        lstat: (path: string) => Promise<NimbusFileStat | null>;
        rename: (from: string, to: string) => Promise<void>;
        chmod: (path: string, mode: number) => Promise<void>;
        /** Read `length` bytes at `offset` without materializing the whole file. */
        readRange: (path: string, offset: number, length: number) => Promise<Uint8Array | null>;
        list: (path?: string) => Promise<{
            name: string;
            type: string;
        }[]>;
        mkdir: (path: string) => Promise<void>;
        exists: (path: string) => Promise<boolean>;
        delete: (path: string, options?: {
            recursive?: boolean;
        }) => Promise<void>;
    };
    runtimes: {
        available: () => Promise<NimbusAvailableRuntime[]>;
        installed: () => Promise<NimbusRuntimeSummary[]>;
        list: () => Promise<{
            installed: NimbusRuntimeSummary[];
            available: NimbusAvailableRuntime[];
        }>;
        install: (spec: RuntimeSpec, options?: {
            force?: boolean;
        }) => Promise<unknown>;
        ensure: (specs: RuntimeSpec | RuntimeSpec[], options?: {
            force?: boolean;
        }) => Promise<unknown>;
    };
    processes: {
        list: () => Promise<NimbusProcess[]>;
        kill: (pid: number) => Promise<{
            ok: boolean;
            pid: number;
        }>;
        write: (pid: number, data: string) => Promise<{
            ok: boolean;
            pid: number;
        }>;
        endInput: (pid: number) => Promise<{
            ok: boolean;
            pid: number;
        }>;
        resize: (pid: number, size: NimbusTerminalSize) => Promise<{
            ok: boolean;
            pid: number;
        }>;
        signal: (pid: number, signal: string) => Promise<{
            ok: boolean;
            pid: number;
        }>;
        logs: (pid: number, options?: NimbusProcessLogsOptions) => Promise<NimbusProcessLogsResult>;
        attach: (pid: number, options?: NimbusProcessAttachOptions) => NimbusProcessAttachment;
    };
    ports: {
        list: () => Promise<NimbusPort[]>;
        expose: (port: number) => Promise<{
            url: string | undefined;
            port: number;
            listening: boolean;
            pid: number | null;
            registeredAt: number | null;
        }>;
        unexpose: (port: number) => Promise<{
            port: number;
            ok: boolean;
        }>;
        url: (port: number) => string | undefined;
    };
    tools(options?: {
        namespace?: string;
        kind?: string;
        name?: string;
    }): {
        name: string;
        kind: string;
        capabilities: string[];
        isAvailable: () => Promise<boolean>;
        connect: () => Promise<void>;
        disconnect: () => Promise<undefined>;
        tools: {
            exec: {
                execute: (command: string, opts?: NimbusExecOptions) => Promise<NimbusExecResult>;
            };
            runCode: {
                execute: (code: string, opts?: Parameters<NimbusSandbox["runCode"]>[1]) => Promise<NimbusExecResult>;
            };
            readFile: {
                execute: (input: unknown) => Promise<string | null>;
            };
            writeFile: {
                execute: (input: unknown) => Promise<void>;
            };
            listFiles: {
                execute: (input?: unknown) => Promise<{
                    name: string;
                    type: string;
                }[]>;
            };
            readdir: {
                execute: (input?: unknown) => Promise<{
                    name: string;
                    type: string;
                }[]>;
            };
            deleteFile: {
                execute: (input: unknown) => Promise<void>;
            };
            exists: {
                execute: (input: unknown) => Promise<boolean>;
            };
            startProcess: {
                execute: (command: string, opts?: NimbusExecOptions) => Promise<NimbusStartResult>;
            };
            killProcess: {
                execute: (input: number | {
                    pid: number;
                }) => Promise<{
                    ok: boolean;
                    pid: number;
                }>;
            };
            writeProcessInput: {
                execute: (input: {
                    pid: number;
                    data: string;
                }) => Promise<{
                    ok: boolean;
                    pid: number;
                }>;
            };
            endProcessInput: {
                execute: (input: number | {
                    pid: number;
                }) => Promise<{
                    ok: boolean;
                    pid: number;
                }>;
            };
            resizeProcess: {
                execute: (input: {
                    pid: number;
                    columns: number;
                    rows: number;
                }) => Promise<{
                    ok: boolean;
                    pid: number;
                }>;
            };
            signalProcess: {
                execute: (input: {
                    pid: number;
                    signal: string;
                }) => Promise<{
                    ok: boolean;
                    pid: number;
                }>;
            };
            logs: {
                execute: (input: number | {
                    pid: number;
                    lines?: number;
                    bytes?: number;
                }) => Promise<NimbusProcessLogsResult>;
            };
            exposePort: {
                execute: (input: number | {
                    port: number;
                }) => Promise<{
                    url: string | undefined;
                    port: number;
                    listening: boolean;
                    pid: number | null;
                    registeredAt: number | null;
                }>;
            };
            unexposePort: {
                execute: (input: number | {
                    port: number;
                }) => Promise<{
                    port: number;
                    ok: boolean;
                }>;
            };
            listPorts: {
                execute: () => Promise<NimbusPort[]>;
            };
            installRuntime: {
                execute: (spec: RuntimeSpec) => Promise<unknown>;
            };
            listRuntimes: {
                execute: () => Promise<{
                    installed: NimbusRuntimeSummary[];
                    available: NimbusAvailableRuntime[];
                }>;
            };
        };
    };
    capabilities(): string[];
    private execOptions;
    private assertRuntimeAllowed;
    /**
     * Browser-facing URL for an exposed port, or undefined when the deployment
     * is not addressable (no `endpoint`, no configured preview base).
     *
     * The URL carries NO credential. On a deployment with auth enforced it is
     * the destination, not the ticket: the session mints a single-use attach
     * token for it at `GET /s/<id>/api/preview-url?port=<n>`, which is what the
     * session shell opens and what an embedder should hand to a browser.
     */
    private portUrl;
    private rpc;
}
export declare class NimbusProcessAttachment implements AsyncIterable<NimbusProcessLogChunk> {
    private readonly sandbox;
    readonly pid: number;
    private readonly options;
    private cursor;
    constructor(sandbox: NimbusSandbox, pid: number, options?: NimbusProcessAttachOptions);
    write(data: string): Promise<{
        ok: boolean;
        pid: number;
    }>;
    endInput(): Promise<{
        ok: boolean;
        pid: number;
    }>;
    resize(size: NimbusTerminalSize): Promise<{
        ok: boolean;
        pid: number;
    }>;
    signal(signal: string): Promise<{
        ok: boolean;
        pid: number;
    }>;
    kill(): Promise<{
        ok: boolean;
        pid: number;
    }>;
    logs(options?: NimbusProcessLogsOptions): Promise<NimbusProcessLogsResult>;
    stream(options?: NimbusProcessAttachOptions): AsyncIterable<NimbusProcessLogChunk>;
    [Symbol.asyncIterator](): AsyncIterator<NimbusProcessLogChunk>;
}
export {};
//# sourceMappingURL=sandbox.d.ts.map