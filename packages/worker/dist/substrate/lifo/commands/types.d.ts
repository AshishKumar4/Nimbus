import type { VFS } from '../kernel/vfs/index.js';
import type { VfsCred } from '../../../runtime/os-contracts.js';
export interface CommandOutputStream {
    write(text: string): void;
}
export interface CommandInputStream {
    read(): Promise<string | null>;
    readAll(): Promise<string>;
    readLine?(): Promise<string | null>;
    readBytes?(maxLength: number): Promise<string | null>;
}
export interface TerminalInputStream extends CommandInputStream {
    rawMode: boolean;
}
export interface CommandContext {
    pid: number;
    cred: VfsCred;
    args: string[];
    env: Record<string, string>;
    cwd: string;
    vfs: VFS;
    stdout: CommandOutputStream;
    stderr: CommandOutputStream;
    signal: AbortSignal;
    stdin?: CommandInputStream;
    terminalStdin?: TerminalInputStream;
    setRawMode?: (enabled: boolean) => void;
    getRawMode?: () => boolean;
    isFdTerminal?: (fd: number) => boolean;
    setUmask(mask: number): void;
    runAs(cred: VfsCred, argv: string[]): Promise<number>;
    execInterpreterDepth?: number;
}
export type CommandRunAsHost = (parent: CommandContext, cred: VfsCred, argv: string[]) => Promise<number>;
export type Command = (ctx: CommandContext) => Promise<number>;
//# sourceMappingURL=types.d.ts.map