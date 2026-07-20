import type { CredentialedVfs } from '../vfs/sqlite-vfs.js';
import type { CommandRunAsHost, TerminalInputStream } from '../substrate/lifo/commands/types.js';
import type { VfsCred } from '../runtime/os-contracts.js';
import type { VFS } from '../substrate/lifo/kernel/vfs/index.js';
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
    pid: number;
    cred: VfsCred;
    setUmask(mask: number): void;
    runAs(cred: VfsCred, argv: string[]): Promise<number>;
    vfs: VFS;
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
        commandContext?: Record<string, unknown>;
        runAs?: CommandRunAsHost;
    }): Promise<{
        exitCode: number;
        stdout?: string;
        stderr?: string;
    }>;
};
type RegistryLike = {
    register(name: string, handler: (ctx: ShellCommandContext) => Promise<number>): void;
};
export declare function registerShellEntrypointCommands(registry: RegistryLike, shell: ShellEntrypointExecutor, vfs: CredentialedVfs): void;
export {};
//# sourceMappingURL=shell-entrypoints.d.ts.map