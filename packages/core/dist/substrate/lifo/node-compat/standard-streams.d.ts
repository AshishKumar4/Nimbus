import type { Writable } from 'node:stream';
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
 * A program's process.stdout (fd 1) or process.stderr (fd 2): a Writable
 * over its output, as Node's is a stream, which Node's legacy pipe knows by
 * `_isStdio`. Its bytes reach the output as each write is made, decoded
 * across writes for an output that takes text, so they keep their place
 * among the console's, which writes the output directly; a failed write
 * is the stream's error (a console write's only when the stream has a
 * listener, as Node's console ignores its own failures otherwise), and the
 * stream finishes once every write handed to the output is done.
 */
export declare function standardStream(output: FailableOutput, fd: 1 | 2): Writable;
//# sourceMappingURL=standard-streams.d.ts.map