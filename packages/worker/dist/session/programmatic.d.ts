/**
 * session/programmatic.ts - public sandbox RPC helpers.
 *
 * These helpers are called by NimbusSession one-line delegators so the
 * Durable Object exposes a typed, programmatic sandbox surface without
 * duplicating the interactive terminal boot path.
 */
import { type MinShellRegistry } from '../runtime/package-manager.js';
import type { ProcessLogReadOptions } from '../runtime/process-logs.js';
import { SessionProcessSupervisor } from '../runtime/session-process-supervisor.js';
import { PortRegistry } from '../runtime/port-registry.js';
import type { RuntimeCatalogEnv } from '../runtime/runtime-catalog.js';
import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
interface ProgrammaticShell {
    env?: Record<string, string>;
    getEnv?(): Record<string, string>;
    getCwd?(): string;
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
}
interface ProgrammaticContext {
    getWebSockets?(tag?: string): WebSocket[];
    storage: {
        delete(key: string): Promise<void>;
        deleteAll(): Promise<void>;
    };
}
interface ProgrammaticFacetManager {
    kill(pid: number): boolean;
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
    env: RuntimeCatalogEnv;
    ctx: ProgrammaticContext;
    shell: ProgrammaticShell | null;
    sqliteFs: SqliteVFS | null;
    processes: SessionProcessSupervisor;
    portRegistry: PortRegistry;
    facetManager: ProgrammaticFacetManager | null;
    viteDevServer: ProgrammaticViteServer | null;
    cirrusReal: ProgrammaticCirrusServer | null;
    _cpRegistry: MinShellRegistry | null;
    _viteShimPid: number | null;
    _viteShimPort: number | null;
    _cirrusHmrWsClients?: {
        clear(): void;
    } | null;
    terminal?: {
        write(text: string): void;
        close(): void;
    } | null;
    kernel?: unknown;
    facetProcessManager?: unknown;
    esbuildService?: unknown;
    nimbusWrangler?: unknown;
    npmInstaller?: unknown;
    fetchProxyEntrypoint?: unknown;
    runtimeFsBridge?: unknown;
    sessionBasePath?: string;
    sessionBasePathHydrated?: boolean;
    wranglerAliasBannerShown?: boolean;
    _b4Phase?: string | null;
    _w9PersistWired?: boolean;
    _w9FlushTimer?: ReturnType<typeof setTimeout> | null;
    _w9SchemaInit?: boolean;
    _w9IsolateGen?: number;
    _w9IsolateGenPersisted?: boolean;
    _w9WireProcessLogPersist?(): void;
    ensureSqliteFs(): void;
    ensureFacetManager(): void;
    initSession(ws: WebSocket): void;
}
export interface ProgrammaticReadyOptions {
    preinstall?: string[];
}
export interface ProgrammaticExecOptions extends ProgrammaticReadyOptions {
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    stdin?: string;
}
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
export interface ProgrammaticStartResult extends ProgrammaticExecResult {
    pid: number | null;
    process: SerializedProcess | null;
    ports: SerializedPort[];
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
}
export declare function ensureProgrammaticReady(self: ProgrammaticHost, options?: ProgrammaticReadyOptions): Promise<{
    ok: true;
    preinstalled: string[];
}>;
export declare function rpcExec(self: ProgrammaticHost, command: string, options?: ProgrammaticExecOptions): Promise<ProgrammaticExecResult>;
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
    installed: import("../runtime/package-manager.js").RuntimeSummary[];
    available: {
        name: string;
        abi: import("../runtime/os-contracts.js").RuntimePackageAbi;
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
    chunks: import("../runtime/process-logs.js").SequencedLogChunk[];
    text: string;
    cursor: number;
    truncated: boolean;
    exit: import("../runtime/process-logs.js").ProcessExitInfo | null;
}>;
export declare function rpcListPorts(self: ProgrammaticHost): Promise<SerializedPort[]>;
export declare function rpcExposePort(self: ProgrammaticHost, port: number): Promise<{
    port: number;
    listening: boolean;
    pid: number | null;
    registeredAt: number | null;
}>;
export declare function rpcUnexposePort(self: ProgrammaticHost, port: number): Promise<{
    port: number;
    ok: boolean;
}>;
export declare function rpcDeleteFile(self: ProgrammaticHost, path: string, options?: {
    recursive?: boolean;
}): Promise<void>;
export declare function rpcDestroy(self: ProgrammaticHost, options?: ProgrammaticDestroyOptions): Promise<ProgrammaticDestroyResult>;
export {};
//# sourceMappingURL=programmatic.d.ts.map