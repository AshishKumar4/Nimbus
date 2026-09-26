import type { Command } from '../commands/types.js';
import type { CommandRegistry } from '../commands/registry.js';
import type { Kernel } from '../kernel/index.js';
import type { Shell } from '../shell/Shell.js';
import type { VfsFileType as FileType } from '../../../vfs/vfs.js';
import type { SqliteVFS } from '../../../vfs/sqlite-vfs.js';
export interface RunOptions {
    /** Working directory for this command */
    cwd?: string;
    /** Extra environment variables for this command */
    env?: Record<string, string>;
    /** Abort signal to cancel the command */
    signal?: AbortSignal;
    /** Timeout in milliseconds */
    timeout?: number;
    /** Streaming stdout callback; bytes, see Shell's ExecuteOptions */
    onStdout?: (data: Uint8Array) => void;
    /** Streaming stderr callback; bytes */
    onStderr?: (data: Uint8Array) => void;
    /** Provide stdin content */
    stdin?: string;
}
export interface CommandResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}
export interface SandboxCommands {
    run(cmd: string, options?: RunOptions): Promise<CommandResult>;
    register(name: string, handler: Command): void;
    /**
     * The command table itself, for layering a command set over the defaults.
     * Public because composing a workspace means replacing builtins wholesale —
     * the durable-filesystem coreutils override ~25 of them — and every caller
     * that needed it was already reaching through the private field.
     */
    readonly registry: CommandRegistry;
}
/** What a user handle's storeStats reports: the store, and the ledger's totals. */
export type UserStoreStats = Omit<ReturnType<SqliteVFS['storeStats']>, 'ledger'> & {
    ledger: {
        used: number;
        limit: number;
        available: number;
    };
};
export interface SandboxFs {
    readFile(path: string): Promise<string>;
    readFile(path: string, encoding: null): Promise<Uint8Array>;
    writeFile(path: string, content: string | Uint8Array): Promise<void>;
    readdir(path: string): Promise<Array<{
        name: string;
        type: FileType;
    }>>;
    stat(path: string): Promise<{
        type: FileType;
        size: number;
        mtime: number;
    }>;
    mkdir(path: string, options?: {
        recursive?: boolean;
    }): Promise<void>;
    rm(path: string, options?: {
        recursive?: boolean;
    }): Promise<void>;
    exists(path: string): Promise<boolean>;
    rename(oldPath: string, newPath: string): Promise<void>;
    cp(src: string, dest: string): Promise<void>;
    writeFiles(files: Array<{
        path: string;
        content: string | Uint8Array;
    }>): Promise<void>;
    /**
     * The content store's diagnostic, with the storage ledger's totals only
     * (used, limit, available). Which facets and namespace images hold what is
     * the kernel's, with snapshots, diff, restore and the paged export/import:
     * `ws.vfs.storeStats()`.
     */
    storeStats(): Promise<UserStoreStats>;
}
export interface SandboxInternals {
    kernel: Kernel;
    shell: Shell;
}
//# sourceMappingURL=types.d.ts.map