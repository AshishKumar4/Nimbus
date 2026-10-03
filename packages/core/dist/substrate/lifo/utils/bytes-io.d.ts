/**
 * Byte input and output for the text commands. GNU's tools read and write
 * bytes: a byte that is not valid UTF-8 passes through unchanged. Decoding
 * with TextDecoder would turn it into U+FFFD, three different bytes.
 */
import type { ProcessView } from '../../../runtime/process-files.js';
import type { CommandInputStream } from '../commands/types.js';
export interface ByteInputContext {
    cwd: string;
    vfs: ProcessView;
    stdin?: string | CommandInputStream;
}
export interface ByteOutput {
    write(text: string): unknown;
    writeBytes?(bytes: Uint8Array): unknown;
}
export interface InputChunkOptions {
    /**
     * How much one read asks of a pipe: a reader that stops early leaves the
     * rest unread, as the GNU tool it mirrors would (head reads 8 KiB).
     */
    readSize?: number;
    /**
     * The reader takes a leading slice and stops on its own (head with a
     * count), or writes to a pipe whose reader can stop it (cat). Only then is
     * a character device streamed for as long as it is asked. Any other reader
     * wants the operand to its end, which the device itself answers: /dev/null
     * is empty, and an endless device (/dev/zero) refuses a whole read.
     */
    slice?: boolean;
}
/** An operand's bytes in bounded chunks; `-` or undefined is standard input. */
export declare function inputChunks(ctx: ByteInputContext, operand: string | undefined, { readSize, slice }?: InputChunkOptions): AsyncGenerator<Uint8Array>;
/** All of an operand's bytes. */
export declare function readAllInput(ctx: ByteInputContext, operand: string | undefined): Promise<Uint8Array>;
export declare function concatBytes(parts: readonly Uint8Array[]): Uint8Array;
/** Write bytes as they are, to a sink that takes bytes; a text-only sink gets their lossless decoding. */
export declare function writeBytes(out: ByteOutput, bytes: Uint8Array): Promise<void>;
/**
 * Bytes as a string without loss: valid UTF-8 decodes to its characters,
 * and every byte of an invalid sequence to U+DC80 + byte (a lone surrogate,
 * which valid UTF-8 never produces). `encodeLossless` inverts it exactly.
 */
export declare function decodeLossless(bytes: Uint8Array): string;
/** The length of the valid UTF-8 sequence at `i`, or 0. */
export declare function utf8SequenceLength(bytes: Uint8Array, i: number): number;
/** The inverse of `decodeLossless`. */
export declare function encodeLossless(text: string): Uint8Array;
/** A write to a pipe whose reader has gone: the writer ends there, silently, as SIGPIPE ends it. */
export declare function isBrokenPipe(error: unknown): boolean;
/** Records split on `delim`: each without its delimiter; `terminated` says whether the last had one. */
export declare function splitRecords(bytes: Uint8Array, delim: number): {
    records: Uint8Array[];
    terminated: boolean;
};
export declare function asciiBytes(text: string): Uint8Array;
//# sourceMappingURL=bytes-io.d.ts.map