import type { VFS } from '../kernel/vfs/index.js';
import type { VfsCred } from '../../../runtime/os-contracts.js';
export interface CommandOutputStream {
    write(text: string): void;
    /**
     * Present on sinks that store bytes verbatim — files, `/dev/null`, and
     * byte-capable shell pipes. Sinks without it take decoded text instead.
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
    /**
     * Bounded raw-byte read. Byte-capable sources (shell pipes, dumps) return
     * the original bytes; text-only sources encode what they hold. Null means
     * EOF with nothing returned.
     */
    readBytes?(maxLength: number): Promise<Uint8Array | null>;
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