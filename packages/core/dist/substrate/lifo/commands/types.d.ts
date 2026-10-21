import type { ProcessView } from '../../../runtime/process-files.js';
import type { VfsCred } from '../../../runtime/os-contracts.js';
export interface CommandOutputStream {
    write(text: string): void | Promise<void>;
    /**
     * Present on sinks that store bytes verbatim — files, `/dev/null`, and
     * byte-capable shell pipes. Sinks without it take decoded text instead.
     */
    writeBytes?(bytes: Uint8Array): void | Promise<void>;
    /**
     * Write anything the sink is holding. The shell flushes every descriptor
     * once the command that owns it finishes, and a failure is that command's.
     */
    flush?(): void | Promise<void>;
}
export interface CommandInputStream {
    read(): Promise<string | null>;
    readAll(): Promise<string>;
    readLine?(): Promise<string | null>;
    /**
     * Bounded raw-byte read. Byte-capable sources (shell pipes, dumps) return
     * the original bytes; text-only sources encode what they hold. Null means
     * EOF with nothing returned. A read `signal` ends before anything arrives
     * takes nothing: it rejects with the signal's reason, and what arrives
     * next is the next read's.
     */
    readBytes?(maxLength: number, signal?: AbortSignal): Promise<Uint8Array | null>;
    /**
     * The regular file a `< file` redirect opened, and how far into it this
     * stream has read: a command may read the file itself from there (at a
     * position, as a descriptor to a regular file allows) instead of reading
     * this stream.
     */
    readonly file?: {
        readonly path: string;
        readonly offset: number;
    };
}
export interface TerminalInputStream extends CommandInputStream {
    rawMode: boolean;
    /**
     * termios ISIG: when true, Ctrl+C and Ctrl+\ signal the foreground
     * command; when false, they are its input (0x03, 0x1c), as a
     * program that reads them as keys asks for (a REPL's readline).
     */
    signalKeys: boolean;
}
/**
 * What a child process `runAs` starts inherits besides its credential: its
 * descriptors, environment and directory come from `parent`, which is the
 * calling command's own context unless given. A script interpreter passes the
 * context its script's command runs in (that line's redirections and pipes);
 * find -execdir passes its own with the matched file's directory.
 */
export interface RunAsOptions {
    readonly parent?: CommandContext;
}
/**
 * How a child process `runAs` started ended, as wait(2) reports it: `status`
 * is what `$?` shows for it (128 plus the signal's number when a signal
 * ended it), `signal` the name of that signal (`PIPE`), or null when the
 * child exited.
 */
export interface ChildExit {
    readonly status: number;
    readonly signal: string | null;
}
export interface CommandContext {
    pid: number;
    cred: VfsCred;
    args: string[];
    env: Record<string, string>;
    cwd: string;
    vfs: ProcessView;
    /**
     * The command's view of the filesystem as `vfs` is, but not revoked by its
     * signal: for work it must finish once started, whatever stops the
     * command (an install's publication, and its undo). Absent where the
     * command runs with no process identity of its own.
     */
    vfsUntilExit?: () => ProcessView;
    stdout: CommandOutputStream;
    stderr: CommandOutputStream;
    signal: AbortSignal;
    stdin?: CommandInputStream;
    terminalStdin?: TerminalInputStream;
    setRawMode?: (enabled: boolean) => void;
    getRawMode?: () => boolean;
    isFdTerminal?: (fd: number) => boolean;
    /** Whether `fd` is a shell pipe (S_ISFIFO): its reader ends a writer by closing it. */
    isFdPipe?: (fd: number) => boolean;
    /**
     * The command says its program takes the shell's signals (its signal's
     * abort is sent to the program, which decides what it does): its status
     * is then the program's, not the signal's.
     */
    takesSignals?: () => void;
    /**
     * The PATH the shell searches with, its variable's value exported or not:
     * a shell builtin's lookups (type, command -v) use it, where a program's
     * environment holds PATH only if it is exported. Absent, `env`'s.
     */
    searchPath?: string;
    /** Whether the shell running this command runs `name` itself, as a builtin (type and command -v ask). */
    isShellBuiltin?: (name: string) => boolean;
    /**
     * Where a program `name` started from this command's cwd would be found
     * when the cwd's mount runs programs on its own machine (Kinu ask 66):
     * its path there, or null when the machine has none. Undefined: a start
     * from here runs here, and is found here.
     */
    locateProgram?: (name: string) => Promise<string | null | undefined>;
    setUmask(mask: number): void;
    /** Run `argv` as a child process under `cred`, with this command's stdio and environment, and wait for it. */
    runAs(cred: VfsCred, argv: string[], options?: RunAsOptions): Promise<ChildExit>;
    execInterpreterDepth?: number;
}
export type CommandRunAsHost = (parent: CommandContext, cred: VfsCred, argv: string[]) => Promise<ChildExit>;
export type Command = (ctx: CommandContext) => Promise<number>;
//# sourceMappingURL=types.d.ts.map