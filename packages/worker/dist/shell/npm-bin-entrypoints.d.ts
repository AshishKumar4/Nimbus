import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
import type { SessionProcessSupervisor } from '../runtime/session-process-supervisor.js';
type Output = {
    write(data: string): void;
};
type RegistryLike = {
    resolve(name: string): Promise<unknown> | unknown;
};
type RuntimeCommandHint = {
    installSpec: string;
} | null;
export declare function installNpmBinFallbackResolver(registry: RegistryLike, deps: {
    vfs: SqliteVFS;
    getCwd(): string;
    processes: SessionProcessSupervisor;
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