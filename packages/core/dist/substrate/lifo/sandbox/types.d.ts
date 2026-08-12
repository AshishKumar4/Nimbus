import type { Command } from '../commands/types.js';
import type { CommandRegistry } from '../commands/registry.js';
import type { Kernel } from '../kernel/index.js';
import type { Shell } from '../shell/Shell.js';
import type { ITerminal } from '../terminal/ITerminal.js';
import type { NativeFsModule } from '../kernel/vfs/providers/NativeFsProvider.js';
import type { FileType, MountProvider } from '../kernel/vfs/types.js';
export interface SandboxOptions {
    /** Enable kernel persistence through the configured backend (default: false). */
    persist?: boolean;
    /** Extra environment variables (merged with defaults) */
    env?: Record<string, string>;
    /** Initial working directory (default: /home/user) */
    cwd?: string;
    /** Pre-populate files: path → content */
    files?: Record<string, string | Uint8Array>;
    /** Attach a pre-created ITerminal for visual mode */
    terminal?: ITerminal;
    /**
     * Mount native filesystem directories into the virtual filesystem at boot time.
     * Only works in Node.js environments (or when a custom fsModule is provided).
     */
    mounts?: Array<{
        /** Path inside the virtual filesystem where the mount will appear */
        virtualPath: string;
        /** Host filesystem path to mount */
        hostPath: string;
        /** If true, the mount is read-only (default: false) */
        readOnly?: boolean;
        /** Custom fs module implementing NativeFsModule. If omitted, node:fs is used. */
        fsModule?: NativeFsModule;
    }>;
    /**
     * Directories whose storage comes from a provider rather than from the
     * in-memory tree — a durable filesystem, for instance.
     *
     * Applied before anything reads the filesystem, because boot reads it:
     * `create` sources `/etc/profile`, and a provider that arrived afterwards
     * would have been invisible to it. Native `mounts` overlay an already-booted
     * sandbox and keep their existing position.
     */
    providerMounts?: Array<{
        /** Path inside the virtual filesystem where the mount will appear. */
        virtualPath: string;
        /** Supplies every operation under `virtualPath`. */
        provider: MountProvider;
    }>;
}
export interface RunOptions {
    /** Working directory for this command */
    cwd?: string;
    /** Extra environment variables for this command */
    env?: Record<string, string>;
    /** Abort signal to cancel the command */
    signal?: AbortSignal;
    /** Timeout in milliseconds */
    timeout?: number;
    /** Streaming stdout callback */
    onStdout?: (data: string) => void;
    /** Streaming stderr callback */
    onStderr?: (data: string) => void;
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
    /** Export entire VFS as a tar.gz snapshot */
    exportSnapshot(): Promise<Uint8Array>;
    /** Restore VFS from a tar.gz snapshot */
    importSnapshot(data: Uint8Array): Promise<void>;
}
export interface SandboxInternals {
    kernel: Kernel;
    shell: Shell;
}
//# sourceMappingURL=types.d.ts.map