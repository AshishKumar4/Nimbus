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
export interface NimbusStartResult extends NimbusExecResult {
    pid: number | null;
    process: NimbusProcess | null;
    ports: NimbusPort[];
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
    bins: string[];
    sizeBytes: number;
    license: string;
}
export interface NimbusAvailableRuntime {
    name: string;
    defaultVersion: string;
    versions: Array<{
        version: string;
        sizeBytes: number;
        license: string;
    }>;
}
type NimbusSessionNamespace = DurableObjectNamespace<any>;
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
    startProcess(command: string, options?: NimbusExecOptions): Promise<NimbusStartResult>;
    runCode(code: string, options?: NimbusExecOptions & {
        language?: 'javascript' | 'typescript' | 'python' | 'ruby' | 'shell';
        install?: 'never' | 'ifMissing';
    }): Promise<NimbusExecResult>;
    files: {
        read: (path: string) => Promise<string | null>;
        readBytes: (path: string) => Promise<Uint8Array | null>;
        write: (path: string, content: string | Uint8Array) => Promise<void>;
        stat: (path: string) => Promise<NimbusFileStat | null>;
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
        logs: (pid: number, options?: {
            lines?: number;
            bytes?: number;
        }) => Promise<unknown>;
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
                execute: (input: any) => Promise<void>;
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
                execute: (input: any) => Promise<void>;
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
            logs: {
                execute: (input: number | {
                    pid: number;
                    lines?: number;
                    bytes?: number;
                }) => Promise<unknown>;
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
    private portUrl;
}
export {};
//# sourceMappingURL=sandbox.d.ts.map