/**
 * @nimbus-sh/sdk/sandbox - programmatic Nimbus sandbox handle.
 */
import type { VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import { type ExecChunk, type ExecExit, type ExecStream, type ExecOutput } from '@nimbus-sh/core/runtime/exec-stream.js';
import { type SessionRpc as NimbusSessionSurface, type SessionExecOptions, type SessionRunCodeOptions, type SessionRestartPolicy as NimbusRestartPolicy, type SessionAppVisibility as NimbusAppVisibility, type SessionAppTarget as NimbusAppTarget, type SessionApp, type SessionExposedApp, type SessionTerminalSize as NimbusTerminalSize, type SessionDestroyOptions as NimbusDestroyOptions, type SessionDestroyResult as NimbusDestroyResult, type SessionStartResult as NimbusStartResult, type SessionProcess as NimbusProcess, type SessionProcessLogChunk as NimbusProcessLogChunk, type SessionProcessExit as NimbusProcessExitInfo, type SessionProcessLogsOptions as NimbusProcessLogsOptions, type SessionProcessLogs as NimbusProcessLogsResult, type SessionPort as NimbusPort, type SessionFileStat as NimbusFileStat, type SessionDirectoryEntry, type SessionRuntimeSummary as NimbusRuntimeSummary, type SessionAvailableRuntime as NimbusAvailableRuntime } from '@nimbus-sh/core/runtime/session-protocol.js';
export type { NimbusSessionSurface, NimbusRestartPolicy, NimbusAppVisibility, NimbusAppTarget, NimbusTerminalSize, NimbusDestroyOptions, NimbusDestroyResult, NimbusStartResult, NimbusProcess, NimbusProcessLogChunk, NimbusProcessExitInfo, NimbusProcessLogsOptions, NimbusProcessLogsResult, NimbusPort, NimbusFileStat, NimbusRuntimeSummary, NimbusAvailableRuntime, };
import { type NimbusConfig, type NimbusCodeLanguage, type RuntimeSpec } from '@nimbus-sh/config/sandbox';
export type { NimbusConfig, NimbusSandboxProfile, NimbusRuntimePolicy, RuntimeSpec, NimbusRuntimeName as RuntimeName } from '@nimbus-sh/config/sandbox';
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
    /** The named shell every command runs in unless the call names another; see {@link NimbusExecOptions.shellId}. */
    shellId?: string;
}
export type NimbusExecOptions = Omit<SessionExecOptions, 'preinstall' | 'shellRoot'>;
/** The sandbox file plane; see `NimbusSandbox.files`. */
export interface NimbusSandboxFiles {
    /** The same API bound to `cred` — the view `SqliteVFS.as(cred)` gives in-process. */
    as(cred: VfsCred): NimbusSandboxFiles;
    read(path: string): Promise<string | null>;
    readBytes(path: string): Promise<Uint8Array | null>;
    write(path: string, content: string | Uint8Array): Promise<void>;
    stat(path: string): Promise<NimbusFileStat | null>;
    /** stat without following a symlink leaf. */
    lstat(path: string): Promise<NimbusFileStat | null>;
    rename(from: string, to: string): Promise<void>;
    chmod(path: string, mode: number): Promise<void>;
    /** Read `length` bytes at `offset` without materializing the whole file. */
    readRange(path: string, offset: number, length: number): Promise<Uint8Array | null>;
    list(path?: string): Promise<SessionDirectoryEntry[]>;
    mkdir(path: string): Promise<void>;
    exists(path: string): Promise<boolean>;
    delete(path: string, options?: {
        recursive?: boolean;
    }): Promise<void>;
}
/** The SDK builds a browser URL, or leaves it undefined when the deployment is not addressable. */
export type NimbusExposedApp = Omit<SessionExposedApp, 'url'> & {
    url: string | undefined;
};
export type NimbusApp = Omit<SessionApp, 'url'> & {
    url: string | undefined;
};
/** A slice of a command's stdout or stderr, as the bytes it wrote. */
export type NimbusExecChunk = ExecChunk;
/** How a command ended: what `exec` returns, without the output. */
export type NimbusExecExit = ExecExit;
/**
 * A running command's output. Read `output` to the end (or cancel it, which
 * kills the command); `exit` settles after the last chunk. A reader that
 * stops reading stops the command at its next write.
 */
export type NimbusExecStream = ExecStream;
export type NimbusExecResult = ExecOutput;
export interface NimbusProcessAttachOptions {
    pollIntervalMs?: number;
    lines?: number;
    bytes?: number;
    signal?: AbortSignal;
}
interface NimbusSessionNamespace {
    idFromName(name: string): DurableObjectId;
    get(id: DurableObjectId): NimbusSessionSurface;
}
type NimbusTarget = {
    kind: 'binding';
    namespace: NimbusSessionNamespace;
} | {
    kind: 'session';
    open: () => NimbusSessionSurface;
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
    /**
     * A client over a session surface the caller already holds, such as the
     * one a hosted runtime's `session()` returns, possibly as an RPC stub from
     * another isolate. `open` is asked once per call, so a caller whose stub
     * does not outlive one RPC session can hand out a fresh one each time. It
     * is a function, never the surface itself: an RPC stub is callable too,
     * so the two could not be told apart. The sandbox id names nothing here;
     * the surface is the session.
     */
    static fromSession(open: () => NimbusSessionSurface, config?: NimbusConfig): Nimbus;
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
    /** The `execStream` op answers with the encoded stream as its body, or a JSON error. */
    private remoteExecStream;
    private remoteFetch;
    ready(): Promise<void>;
    /** Run a command to completion and return its output as strings. Built on {@link execStream}. */
    exec(command: string, options?: NimbusExecOptions): Promise<NimbusExecResult>;
    /**
     * Run a command and read its stdout and stderr as they are written, as
     * bytes, without the sandbox or this client holding the whole output.
     * Resolves once the command has started. `timeoutMs` still applies.
     */
    execStream(command: string, options?: NimbusExecOptions): Promise<NimbusExecStream>;
    /**
     * Start a command in the background. Returns as soon as the process has a
     * pid — it does not wait for the command to finish.
     */
    startProcess(command: string, options?: NimbusExecOptions): Promise<NimbusStartResult>;
    runCode(code: string, options?: Omit<SessionRunCodeOptions, 'preinstall' | 'shellRoot' | 'language'> & {
        language?: NimbusCodeLanguage;
    }): Promise<NimbusExecResult>;
    destroy(options?: NimbusDestroyOptions): Promise<NimbusDestroyResult>;
    /**
     * The session file plane. Every method acts as the session's default
     * identity for a pid-less caller — the session user for reads, writes,
     * stat, list, mkdir, rename and chmod; the kernel for `delete` — which is
     * the embedder's trusted surface, reached only by a caller holding the DO
     * binding or a remote token. `files.as(cred)` returns the same API bound
     * to `cred` instead, the view `SqliteVFS.as(cred)` gives in-process: a
     * file the identity cannot read answers EACCES, one it owns answers.
     * Over the remote endpoint a `cred` is refused by the dispatcher, as it is
     * on `exec` — a token authenticates a session, not a user inside it.
     */
    files: NimbusSandboxFiles;
    private filesAs;
    runtimes: {
        available: () => Promise<NimbusAvailableRuntime[]>;
        installed: () => Promise<NimbusRuntimeSummary[]>;
        list: () => Promise<{
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
        install: (spec: RuntimeSpec, options?: {
            force?: boolean;
        }) => Promise<{
            spec: string;
            exitCode: number;
            stdout: string;
            stderr: string;
        }>;
        ensure: (specs: RuntimeSpec | RuntimeSpec[], options?: {
            force?: boolean;
        }) => Promise<{
            spec: string;
            exitCode: number;
            stdout: string;
            stderr: string;
        }[]>;
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
        /**
         * Expose a port. When the port's occupant carries an identity (a node
         * resident, a durable worker app) this is the same lazy reservation
         * `apps.expose` makes and the result names the owner; a bare port —
         * a dev server, a python resident — is written port-only as before.
         */
        expose: (port: number, options?: {
            visibility?: "scoped" | "public";
            name?: string;
        }) => Promise<{
            url: string | undefined;
            port: number;
            listening: boolean;
            pid: number | null;
            registeredAt: number | null;
            capability: string | null;
            visibility?: "scoped" | "public" | undefined;
            owner?: string | null | undefined;
            name?: string | null | undefined;
            execId?: string | undefined;
        }>;
        unexpose: (port: number) => Promise<{
            port: number;
            ok: boolean;
        }>;
        /**
         * Reserve (or re-answer) a durable application's port: the capability it
         * answers is minted here and survives every reset, so the URL it builds
         * is the URL the application keeps.
         */
        ensureDurableApp: (input: {
            owner: string;
            preferredPort?: number;
            visibility?: "scoped" | "public";
        }) => Promise<{
            port: number;
            capability: string | null;
            visibility: "scoped" | "public";
        }>;
        /**
         * End a durable application's contract: its launch is killed, the journal
         * row purged, the reserved port released, the durable slot freed. Answers
         * the owner, whether anything was removed, and the durable port that was
         * released — null when no reservation existed.
         */
        removeDurableApp: (owner: string) => Promise<{
            owner: string;
            removed: boolean;
            port: number | null;
        }>;
        url: (port: number, options?: {
            visibility?: "scoped" | "public";
            capability?: string;
            name?: string;
        }) => string | undefined;
    };
    /**
     * The application surface: every server is durable under its identity
     * from the moment it is spawned; exposing it reserves its port for that
     * identity, names it, and (when public) mints the capability its shared
     * URL is built on. `ports.expose` is the port-addressed alias of
     * `apps.expose`; the identity-addressed verbs live here.
     */
    apps: {
        list: () => Promise<NimbusApp[]>;
        expose: (target: NimbusAppTarget, options?: {
            visibility?: "scoped" | "public";
            name?: string;
        }) => Promise<NimbusExposedApp>;
        rotateLink: (target: NimbusAppTarget) => Promise<NimbusExposedApp>;
        remove: (target: NimbusAppTarget) => Promise<{
            owner: string;
            removed: boolean;
            port: number | null;
        }>;
    };
    private exposedApp;
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
                execute: (command: string, opts?: NimbusExecOptions) => Promise<{
                    command: string;
                    exitCode: number;
                    success: boolean;
                    duration: number;
                    timestamp: number;
                    stdout: string;
                    stderr: string;
                }>;
            };
            runCode: {
                execute: (code: string, opts?: Parameters<NimbusSandbox["runCode"]>[1]) => Promise<{
                    command: string;
                    exitCode: number;
                    success: boolean;
                    duration: number;
                    timestamp: number;
                    stdout: string;
                    stderr: string;
                }>;
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
                execute: (command: string, opts?: NimbusExecOptions) => Promise<{
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
                }) => Promise<{
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
                    capability: string | null;
                    visibility?: "scoped" | "public" | undefined;
                    owner?: string | null | undefined;
                    name?: string | null | undefined;
                    execId?: string | undefined;
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
                execute: () => Promise<{
                    port: number;
                    pid: number;
                    registeredAt: number;
                    capability: string;
                    execId?: string | undefined;
                }[]>;
            };
            exposeApp: {
                execute: (input: NimbusAppTarget | {
                    target: NimbusAppTarget;
                    visibility?: "scoped" | "public";
                    name?: string;
                }) => Promise<NimbusExposedApp>;
            };
            listApps: {
                execute: () => Promise<NimbusApp[]>;
            };
            installRuntime: {
                execute: (spec: RuntimeSpec) => Promise<{
                    spec: string;
                    exitCode: number;
                    stdout: string;
                    stderr: string;
                }>;
            };
            listRuntimes: {
                execute: () => Promise<{
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
//# sourceMappingURL=sandbox.d.ts.map