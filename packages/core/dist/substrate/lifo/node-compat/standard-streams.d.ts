import type { Readable, Writable, WritableOptions } from 'node:stream';
import type { CommandOutputStream } from '../commands/types.js';
/**
 * A pipe into a program's stdout or stderr leaves it open, as Node's pipe
 * leaves process.stdout and process.stderr; the engine's knows only its own
 * process's. Set on the engine's Readable when a program first reaches the
 * engine's streams, before it can pipe into one; a pipe into anything else
 * is the engine's as it was.
 */
export declare function leaveStandardStreamsOpen(): void;
/** What made a write to a program's stdout or stderr: its stream, or its console (which, in Node, writes through the stream). */
export type OutputSource = 'stream' | 'console';
/**
 * An output that can fail after it took a write (a program in a realm, whose
 * host makes the write later): `onFailure` hears of each failed write, and
 * what made it.
 */
export interface FailableOutput extends CommandOutputStream {
    onFailure?(listener: (error: Error, source: OutputSource) => void): void;
}
/**
 * A Writable's options over `output`: its bytes reach the output as each
 * write is made, decoded across writes for an output that takes text, so
 * they keep their place among the console's, which writes the output
 * directly; an output's failure is the stream's error, and the stream
 * finishes once every write handed to the output is done. Without an output
 * (a descriptor the program has not), every write fails EBADF.
 */
export declare function outputSink(output: CommandOutputStream | undefined): WritableOptions;
/**
 * `stream`, over `output`, as a program's process.stdout (fd 1) or
 * process.stderr (fd 2), which Node's legacy pipe knows by `_isStdio` and a
 * pipe into leaves open. A failed write is its error (a console write's only
 * when it has a listener, as Node's console ignores its own failures
 * otherwise).
 */
export declare function asStandardStream<T extends Writable>(stream: T, fd: 1 | 2, output: FailableOutput): T;
/** A program's process.stdout (fd 1) or process.stderr (fd 2) that is not the terminal: a Writable over its output, as Node's is a stream. */
export declare function standardStream(output: FailableOutput, fd: 1 | 2): Writable;
/** What a read of fd 0 gives: a piece, null at its end, or nothing, withdrawn before anything arrived. */
export type StandardPiece = Uint8Array | null | 'withdrawn';
/** A read of fd 0 in flight. */
export interface StandardRead {
    readonly piece: Promise<StandardPiece>;
    /** Withdraw it: what has not arrived stays on fd 0 for the next read, and the read settles 'withdrawn'. */
    cancel(): void;
}
/** fd 0, a piece at a time, as a program's process.stdin and tty.ReadStream(0) read it. */
export interface StandardInput {
    /** fd 0's next piece, never an empty one; a failed read rejects with the descriptor's error. */
    read(): StandardRead;
    /** One more reader waits on fd 0 (true), or one fewer (false): while any does, the program is held, as reading a pipe or the terminal holds a Node process. */
    hold(on: boolean): void;
}
/**
 * `stream` reading fd 0 from `input` (none: fd 0 is at its end), as Node's
 * stdin reads its descriptor: a piece is asked for when the stream wants
 * one, and its wait holds the program. Paused and, a tick later, still not
 * flowing, or destroyed, it stops reading (the read is withdrawn and holds
 * no more), as Node's stdin does so that its process can end; reading again
 * starts a new read.
 */
export declare function joinStandardInput<T extends Readable>(stream: T, input: StandardInput | undefined): T;
//# sourceMappingURL=standard-streams.d.ts.map