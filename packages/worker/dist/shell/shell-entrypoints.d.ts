import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
import type { TerminalInputStream } from '../substrate/lifo/commands/types.js';
import { type ShellInvocationOptions } from './shell-invocation.js';
type Output = {
    write(s: string): void;
};
type ShellCommandContext = {
    args?: string[];
    stdout: Output;
    stderr: Output;
    cwd?: string;
    env?: Record<string, string>;
    stdin?: unknown;
    terminalStdin?: TerminalInputStream;
    isFdTerminal?: (fd: number) => boolean;
};
export type ShellEntrypointExecutor = {
    execute(cmd: string, options?: {
        cwd?: string;
        env?: Record<string, string>;
        onStdout?: (data: string) => void;
        onStderr?: (data: string) => void;
        stdin?: string;
        terminalStdin?: TerminalInputStream;
        runExitTrap?: boolean;
        isolateShellState?: boolean;
        shellOptions?: ShellInvocationOptions;
        scriptMode?: boolean;
        terminalFds?: {
            stdin?: boolean;
            stdout?: boolean;
            stderr?: boolean;
        };
    }): Promise<{
        exitCode: number;
        stdout?: string;
        stderr?: string;
    }>;
};
type RegistryLike = {
    register(name: string, handler: (ctx: ShellCommandContext) => Promise<number>): void;
};
export declare function registerShellEntrypointCommands(registry: RegistryLike, shell: ShellEntrypointExecutor, vfs: SqliteVFS): void;
export {};
//# sourceMappingURL=shell-entrypoints.d.ts.map