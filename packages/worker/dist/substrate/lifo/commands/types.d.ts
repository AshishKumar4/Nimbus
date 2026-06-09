import type { VFS } from '../kernel/vfs/index.js';
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
}
export type Command = (ctx: CommandContext) => Promise<number>;
//# sourceMappingURL=types.d.ts.map