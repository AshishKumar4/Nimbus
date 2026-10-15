import type { Readable, Writable } from 'node:stream';
import { type FailableOutput, type StandardInput } from './standard-streams.js';
/** What a program's standard descriptors are, and the terminal's modes. */
export interface ProgramTerminal {
    /** Whether `fd` (0, 1 or 2) is the terminal. */
    isatty(fd: number): boolean;
    /** Whether `fd` (0, 1 or 2) is a pipe. */
    isPipe(fd: number): boolean;
    /** termios raw mode, on or off: the terminal's keys go to the program as they are typed. */
    setRawMode(on: boolean): void;
}
/** A program's standard descriptors, as its process and its tty module see them. */
export interface ProgramStdio {
    readonly stdout: FailableOutput;
    readonly stderr: FailableOutput;
    /** fd 0, a piece at a time; absent, fd 0 is at its end. */
    readonly input?: StandardInput;
    /** Absent, no descriptor is the terminal or a pipe. */
    readonly terminal?: ProgramTerminal;
    /** The window's size, COLUMNS x LINES, as the shell's own commands read it. */
    readonly env: Record<string, string>;
}
/** The tty module, as Node's is: its streams and isatty. */
export interface TtyModule {
    readonly ReadStream: new (fd: number) => Readable;
    readonly WriteStream: new (fd: number) => Writable;
    isatty(fd: number): boolean;
}
/** A program's tty module and its standard streams, each made once, when first reached. */
export interface ProgramTty {
    readonly module: TtyModule;
    stdin(): Readable;
    stdout(): Writable;
    stderr(): Writable;
}
/**
 * The tty module of the program `stdio` is, its streams joined to its
 * descriptors: a WriteStream writes to the descriptor it is made on, in order
 * with process.stdout, a ReadStream reads fd 0, and isatty answers for each.
 * One per program, so that its process's streams are its module's (in a
 * terminal, process.stdout is a tty.WriteStream). Its classes are the engine's
 * stream classes, made when the program first reaches them.
 */
export declare function ttyOf(stdio: ProgramStdio): ProgramTty;
//# sourceMappingURL=tty-streams.d.ts.map