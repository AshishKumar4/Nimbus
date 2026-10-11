import type { ChildExit, CommandInputStream, CommandRunAsHost, RunAsOptions, TerminalInputStream } from '../substrate/lifo/commands/types.js';
import type { VfsCred } from '../runtime/os-contracts.js';
import type { ProcessView as VFS } from '../runtime/process-files.js';
import { type ShellInvocationOptions } from './shell-invocation.js';
type Output = {
    write(text: string): void | Promise<void>;
    writeBytes?(bytes: Uint8Array): void | Promise<void>;
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
    runAs(cred: VfsCred, argv: string[], options?: RunAsOptions): Promise<ChildExit>;
    vfs: VFS;
};
export type ShellEntrypointExecutor = {
    execute(cmd: string, options?: {
        cwd?: string;
        env?: Record<string, string>;
        onStdout?: (data: Uint8Array) => void | Promise<void>;
        onStderr?: (data: Uint8Array) => void | Promise<void>;
        stdin?: string | CommandInputStream;
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
    }>;
};
type RegistryLike = {
    has(name: string): boolean;
    register(name: string, handler: (ctx: ShellCommandContext) => Promise<number>): void;
};
export declare function registerShellEntrypointCommands(registry: RegistryLike, shell: ShellEntrypointExecutor): void;
export {};
//# sourceMappingURL=shell-entrypoints.d.ts.map