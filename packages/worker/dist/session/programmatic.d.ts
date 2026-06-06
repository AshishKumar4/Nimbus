/**
 * session/programmatic.ts - public sandbox RPC helpers.
 *
 * These helpers are called by NimbusSession one-line delegators so the
 * Durable Object exposes a typed, programmatic sandbox surface without
 * duplicating the interactive terminal boot path.
 */
type Host = any;
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
}
export interface SerializedPort {
    port: number;
    pid: number;
    registeredAt: number;
}
export declare function ensureProgrammaticReady(self: Host, options?: ProgrammaticReadyOptions): Promise<{
    ok: true;
    preinstalled: string[];
}>;
export declare function rpcExec(self: Host, command: string, options?: ProgrammaticExecOptions): Promise<ProgrammaticExecResult>;
export declare function rpcStartProcess(self: Host, command: string, options?: ProgrammaticExecOptions): Promise<ProgrammaticStartResult>;
export declare function rpcRunCode(self: Host, code: string, options?: ProgrammaticExecOptions & {
    language?: 'javascript' | 'typescript' | 'python' | 'ruby' | 'shell';
    install?: 'never' | 'ifMissing';
}): Promise<ProgrammaticExecResult>;
export declare function rpcInstallRuntime(self: Host, spec: string, options?: {
    force?: boolean;
}): Promise<import("../runtime/package-manager.js").RuntimeInstallSummary>;
export declare function rpcEnsureRuntimes(self: Host, specs: string[], options?: {
    force?: boolean;
}): Promise<import("../runtime/package-manager.js").RuntimeInstallSummary[]>;
export declare function rpcListRuntimes(self: Host): Promise<{
    installed: import("../runtime/package-manager.js").RuntimeSummary[];
    available: {
        name: string;
        defaultVersion: string;
        versions: Array<{
            version: string;
            sizeBytes: number;
            license: string;
        }>;
    }[];
}>;
export declare function rpcListProcesses(self: Host): Promise<SerializedProcess[]>;
export declare function rpcKillProcess(self: Host, pid: number): Promise<{
    ok: boolean;
    pid: number;
}>;
export declare function rpcProcessLogs(self: Host, pid: number, options?: {
    lines?: number;
    bytes?: number;
}): Promise<{
    pid: number;
    chunks: any;
    text: any;
    exit: any;
}>;
export declare function rpcListPorts(self: Host): Promise<SerializedPort[]>;
export declare function rpcExposePort(self: Host, port: number): Promise<{
    port: number;
    listening: boolean;
    pid: any;
    registeredAt: any;
}>;
export declare function rpcUnexposePort(self: Host, port: number): Promise<{
    port: number;
    ok: any;
}>;
export declare function rpcDeleteFile(self: Host, path: string, options?: {
    recursive?: boolean;
}): Promise<void>;
export declare function rpcDestroy(self: Host, options?: ProgrammaticDestroyOptions): Promise<ProgrammaticDestroyResult>;
export {};
//# sourceMappingURL=programmatic.d.ts.map