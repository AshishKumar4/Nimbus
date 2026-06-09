import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
type Output = {
    write(data: string): void;
};
type RegistryLike = {
    resolve(name: string): Promise<unknown> | unknown;
};
type ProcessTableLike = {
    spawn(command: string, argv: string[], cwd: string): {
        pid: number;
    };
    setLongRunning?(pid: number): void;
    setAttachedTty?(pid: number): void;
    exit(pid: number, code: number): void;
};
type ProcessInputLike = {
    open(pid: number): void;
};
type ProcessLogsLike = {
    append(pid: number, stream: 'stdout' | 'stderr', data: string): void;
    markExit(pid: number, code: number): void;
    getExit(pid: number): unknown;
};
type RuntimeCommandHint = {
    installSpec: string;
} | null;
export declare function installNpmBinFallbackResolver(registry: RegistryLike, deps: {
    vfs: SqliteVFS;
    getCwd(): string;
    processTable: ProcessTableLike;
    processInput?: ProcessInputLike | null;
    processLogs: ProcessLogsLike;
    terminal?: Output | null;
    notifyTerminalEvent(event: {
        type: 'spawn' | 'exit';
        pid: number;
        command: string;
        longRunning?: boolean;
        code?: number;
    }): void;
    runtimeCommandHint(name: string): Promise<RuntimeCommandHint>;
    emitShellExecDone(pid: number, command: string, exitCode: number, durationMs: number): void;
}): void;
export {};
//# sourceMappingURL=npm-bin-entrypoints.d.ts.map