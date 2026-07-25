import type { VFS } from '../kernel/vfs/index.js';
import type { VfsCred } from '../../../runtime/os-contracts.js';
export interface CommandOutputStream {
    write(text: string): void;
    /**
     * Present on sinks that store bytes verbatim (files, `/dev/null`). Textual
     * sinks — the terminal, shell pipes — omit it and take decoded text, since
     * they have no way to carry a byte that is not text.
     */
    writeBytes?(bytes: Uint8Array): void;
    /**
     * Commit anything the sink is holding. File-backed descriptors buffer, the
     * way stdio does, so a line-at-a-time producer costs one store write per
     * block rather than one per line. The shell flushes every descriptor once
     * the command that owns it finishes.
     */
    flush?(): void;
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