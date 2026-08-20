/**
 * session/programmatic.ts - public sandbox RPC helpers.
 *
 * These helpers are called by NimbusSession one-line delegators so the
 * Durable Object exposes a typed, programmatic sandbox surface without
 * duplicating the interactive terminal boot path.
 */
import { type MinShellRegistry } from '@nimbus-sh/core/runtime/installed-runtimes.js';
import type { ProcessLogReadOptions } from '@nimbus-sh/core/runtime/process-logs.js';
import { type TerminalLike } from '../runtime/process-logs-api.js';
import { SessionProcessSupervisor } from '@nimbus-sh/core/runtime/session-process-supervisor.js';
import { PortRegistry } from '@nimbus-sh/core/runtime/port-registry.js';
import type { RuntimeCatalogEnv } from '../runtime/runtime-catalog.js';
import type { SqliteVFS } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import { type VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
export interface ProgrammaticShell {
    env?: Record<string, string>;
    getEnv(): Record<string, string>;
    getCwd(): string;
    execute(command: string, options?: ProgrammaticShellExecuteOptions): Promise<{
        exitCode: number;
    }>;
}
interface ProgrammaticShellExecuteOptions {
    cwd?: string;
    env?: Record<string, string>;
    onStdout?: (data: string) => void;
    onStderr?: (data: string) => void;
    signal?: AbortSignal;
    stdin?: string;
    isolateShellState?: boolean;
    commandContext?: Record<string, unknown>;
}
interface ProgrammaticContext {
    getWebSockets?(tag?: string): WebSocket[];
    /** Holds a background process's work open for the life of the process. */
    waitUntil?(promise: Promise<unknown>): void;
    storage: {
        get(key: string): Promise<unknown>;
        delete(key: string): Promise<void>;
        deleteAll(): Promise<void>;
        deleteAlarm(): Promise<void>;
        put(key: string, value: unknown): Promise<void>;
    };
}
interface ProgrammaticFacetManager {
    kill(pid: number): boolean;
    hasResidentProcess(pid: number): boolean;
}
interface ProgrammaticViteServer {
    isRunning: boolean;
    stop(): void;
}
interface ProgrammaticCirrusServer {
    isRunning: boolean;
    stop(ctx: ProgrammaticContext): void;
}
export interface ProgrammaticHost {
    _w1SessionDestroyed: boolean;
    env: RuntimeCatalogEnv;
    ctx: ProgrammaticContext;
    shell: ProgrammaticShell | null;
    shellProcessPid: number | null;
    sqliteFs: SqliteVFS | null;
    processes: SessionProcessSupervisor;
    portRegistry: PortRegistry;
    facetManager: ProgrammaticFacetManager | null;
    viteDevServer: ProgrammaticViteServer | null;
    cirrusReal: ProgrammaticCirrusServer | null;
    _cpRegistry: MinShellRegistry | null;
    /** One serialization queue per named durable shell. See `withShellState`. */
    _programmaticShellQueues?: Map<string, Promise<void>>;
    _viteShimPid: number | null;
    _viteShimPort: number | null;
    _cirrusHmrWsClients?: {
        clear(): void;
    } | null;
    terminal?: (TerminalLike & {
        write(text: string): void;
        close(): void;
    }) | null;
    kernel?: unknown;
    facetProcessManager?: unknown;
    esbuildService?: unknown;
    nimbusWrangler?: unknown;
    npmInstaller?: unknown;
    fetchProxyEntrypoint?: unknown;
    runtimeFsBridges?: Map<number, unknown> | null;
    sessionBasePath?: string;
    sessionBasePathHydrated?: boolean;
    wranglerAliasBannerShown?: boolean;
    _b4Phase?: string | null;
    _w9PersistWired?: boolean;
    _w9FlushTimer?: ReturnType<typeof setTimeout> | null;
    _w9SchemaInit?: boolean;
    _w9WireProcessLogPersist?(): void;
    ensureSqliteFs(): void;
    ensureFacetManager(): void;
    initSession(ws: WebSocket): Promise<void>;
}
export interface ProgrammaticReadyOptions {
    preinstall?: string[];
}
export interface ProgrammaticExecOptions extends ProgrammaticReadyOptions {
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    stdin?: string;
    /**
     * Identity the command runs as. Omitted, the spawn inherits the session
     * user, which is what every programmatic exec has always run as.
     */
    cred?: VfsCred;
    /**
     * Run in a NAMED shell whose cwd and environment persist between calls, the
     * way an interactive terminal does. Omitted, the call runs on the session's
     * one shell and nothing is remembered — the behaviour every programmatic
     * exec has always had.
     */
    shellId?: string;
    /** @internal Initial cwd for a shellId with no durable state yet. */
    shellRoot?: string;
}
/**
 * A second Shell over the session's own kernel, filesystem and command
 * registry — the same objects the interactive shell uses, so a named shell is
 * not a second filesystem or a second process table. Only cwd and environment
 * are its own, which is exactly what makes `cd` stick between calls.
 */
export declare function createProgrammaticShell(self: ProgrammaticHost, pid: number, state: {
    cwd: string;
    env: Record<string, string>;
}): ProgrammaticShell;
export interface ProgrammaticDestroyOptions {
    reason?: string;
}
export interface ProgrammaticDestroyResult {
    ok: true;
    killed: number;
    destroyedAt: number;
    reason: string | null;
}
export interface ProgrammaticExecResult {
    command: string;
    exitCode: number;
    success: boolean;
    stdout: string;
    stderr: string;
    duration: number;
    timestamp: number;
}
/**
 * A started background process. There is no exit code or output here — the
 * process is still running when this returns. Read both back through
 * `processLogs(pid)`, which carries the exit record once it lands.
 */
export interface ProgrammaticStartResult {
    command: string;
    pid: number;
    process: SerializedProcess;
    ports: SerializedPort[];
    startedAt: number;
}
export interface SerializedProcess {
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
export interface SerializedPort {
    port: number;
    pid: number;
    registeredAt: number;
    capability: string;
}
export declare function ensureProgrammaticReady(self: ProgrammaticHost, options?: ProgrammaticReadyOptions): Promise<{
    ok: true;
    preinstalled: string[];
}>;
export declare function rpcExec(self: ProgrammaticHost, command: string, options?: ProgrammaticExecOptions): Promise<ProgrammaticExecResult>;
/**
 * Start a command in the background and return its handle immediately.
 *
 * The command runs for as long as it needs to: the session holds its work
 * open through `ctx.waitUntil`, the same contract a long-running facet uses.
 * Status, incremental output, and termination are read back through the
 * process surface (`listProcesses`, `processLogs`, `killProcess`).
 */
export declare function rpcStartProcess(self: ProgrammaticHost, command: string, options?: ProgrammaticExecOptions): Promise<ProgrammaticStartResult>;
export declare function rpcRunCode(self: ProgrammaticHost, code: string, options?: ProgrammaticExecOptions & {
    language?: 'javascript' | 'typescript' | 'python' | 'ruby' | 'shell';
    install?: 'never' | 'ifMissing';
}): Promise<ProgrammaticExecResult>;
export declare function rpcInstallRuntime(self: ProgrammaticHost, spec: string, options?: {
    force?: boolean;
}): Promise<import("../runtime/package-manager.js").RuntimeInstallSummary>;
export declare function rpcEnsureRuntimes(self: ProgrammaticHost, specs: string[], options?: {
    force?: boolean;
}): Promise<import("../runtime/package-manager.js").RuntimeInstallSummary[]>;
export declare function rpcListRuntimes(self: ProgrammaticHost): Promise<{
    installed: import("@nimbus-sh/core/runtime/installed-runtimes.js").RuntimeSummary[];
    available: {
        name: string;
        abi: import("@nimbus-sh/core/runtime/os-contracts.js").RuntimePackageAbi;
        defaultVersion: string;
        versions: Array<{
            version: string;
            sizeBytes: number;
            license: string;
        }>;
    }[];
}>;
export declare function rpcListProcesses(self: ProgrammaticHost): Promise<SerializedProcess[]>;
export declare function rpcKillProcess(self: ProgrammaticHost, pid: number): Promise<{
    ok: boolean;
    pid: number;
}>;
export declare function rpcWriteProcessInput(self: ProgrammaticHost, pid: number, data: string): Promise<{
    ok: boolean;
    pid: number;
}>;
export declare function rpcEndProcessInput(self: ProgrammaticHost, pid: number): Promise<{
    ok: boolean;
    pid: number;
}>;
export declare function rpcResizeProcess(self: ProgrammaticHost, pid: number, size: {
    columns: number;
    rows: number;
}): Promise<{
    ok: boolean;
    pid: number;
}>;
export declare function rpcSignalProcess(self: ProgrammaticHost, pid: number, signal: string): Promise<{
    ok: boolean;
    pid: number;
}>;
export declare function rpcProcessLogs(self: ProgrammaticHost, pid: number, options?: ProcessLogReadOptions): Promise<{
    pid: number;
    chunks: import("@nimbus-sh/core/runtime/process-logs.js").SequencedLogChunk[];
    text: string;
    cursor: number;
    truncated: boolean;
    exit: import("@nimbus-sh/core/runtime/process-logs.js").ProcessExitInfo | null;
}>;
export declare function rpcListPorts(self: ProgrammaticHost): Promise<SerializedPort[]>;
export declare function rpcExposePort(self: ProgrammaticHost, port: number): Promise<{
    port: number;
    listening: boolean;
    pid: number | null;
    registeredAt: number | null;
    capability: string | null;
}>;
export declare function rpcUnexposePort(self: ProgrammaticHost, port: number): Promise<{
    port: number;
    ok: boolean;
}>;
/**
 * Route an embedder request that carries a port capability. The embedder has
 * authenticated the capability at its edge and stripped its own credentials,
 * so the guest's `Authorization` is preserved through this path and no other.
 */
export declare function rpcRouteCapabilityPort(self: ProgrammaticHost, port: number, capability: string, request: Request, pathname: string): Promise<Response>;
export declare function rpcDeleteFile(self: ProgrammaticHost, path: string, options?: {
    recursive?: boolean;
}): Promise<void>;
export declare function rpcDestroy(self: ProgrammaticHost, options?: ProgrammaticDestroyOptions): Promise<ProgrammaticDestroyResult>;
export {};
//# sourceMappingURL=programmatic.d.ts.map