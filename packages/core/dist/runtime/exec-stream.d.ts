/**
 * runtime/exec-stream.ts — a command's output while it runs.
 *
 * `output` yields stdout and stderr chunks, as bytes, in the order the command
 * wrote them; `exit` settles once the last chunk is queued. The stream is
 * pull-based: a writer awaits room below {@link EXEC_STREAM_HIGH_WATER_BYTES}
 * before its next write, so a slow reader slows the command instead of
 * growing a buffer. Cancelling `output` kills the command and rejects `exit`
 * with the cancel reason.
 *
 * Across a Durable Object RPC or an HTTP body the same stream travels as one
 * byte stream of frames (`encodeExecStream` / `decodeExecStream`), so both
 * boundaries keep the platform's own stream backpressure.
 */
import { z } from 'zod/v4';
export type ExecStreamName = 'stdout' | 'stderr';
export interface ExecChunk {
    stream: ExecStreamName;
    data: Uint8Array;
}
export declare const ExecExitSchema: z.ZodObject<{
    command: z.ZodString;
    exitCode: z.ZodNumber;
    success: z.ZodBoolean;
    duration: z.ZodNumber;
    timestamp: z.ZodNumber;
}, z.core.$strip>;
export type ExecExit = z.infer<typeof ExecExitSchema>;
export interface ExecStream {
    output: ReadableStream<ExecChunk>;
    exit: Promise<ExecExit>;
}
export declare const ExecOutputSchema: z.ZodObject<{
    command: z.ZodString;
    exitCode: z.ZodNumber;
    success: z.ZodBoolean;
    duration: z.ZodNumber;
    timestamp: z.ZodNumber;
    stdout: z.ZodString;
    stderr: z.ZodString;
}, z.core.$strip>;
export type ExecOutput = z.infer<typeof ExecOutputSchema>;
/** Output a writer may run ahead of its reader before its writes wait. */
export declare const EXEC_STREAM_HIGH_WATER_BYTES: number;
/** Content type of an HTTP body carrying an encoded exec stream. */
export declare const EXEC_STREAM_CONTENT_TYPE = "application/vnd.nimbus.exec-stream";
export interface ExecStreamWriter {
    readonly stream: ExecStream;
    /** Queue a chunk; resolves when the reader has room for more. Dropped once the stream settled. */
    write(stream: ExecStreamName, data: Uint8Array): Promise<void>;
    end(exit: ExecExit): void;
    fail(error: unknown): void;
}
export declare function createExecStream(onCancel: (reason: unknown) => void): ExecStreamWriter;
/** Read the whole stream into strings: the buffered exec result. */
export declare function collectExecStream(stream: ExecStream): Promise<ExecOutput>;
/** One frame of a byte stream of frames: `[kind u8][length u32 BE][payload]` (program-stream.ts frames this way too). */
export declare function frame(kind: number, payload: Uint8Array): Uint8Array;
/** One byte stream carrying `stream`'s chunks, then its exit or failure. */
export declare function encodeExecStream(stream: ExecStream): ReadableStream<Uint8Array>;
/** One frame of a frame stream: its kind and its payload. */
export interface StreamFrame {
    kind: number;
    payload: Uint8Array;
}
/**
 * The frames of `wire`, one at a time, as its bytes arrive split or joined in
 * any way: each chunk is queued as it came and a frame copied out of the queue
 * once whole. `next` answers null at the wire's end (any partial frame left is
 * dropped: the decoder says what was missing).
 */
export declare function createFrameReader(wire: ReadableStream<Uint8Array>): {
    next(): Promise<StreamFrame | null>;
    cancel(reason?: unknown): Promise<void>;
};
/** The inverse of `encodeExecStream`; frames may arrive split or joined in any way. */
export declare function decodeExecStream(wire: ReadableStream<Uint8Array>): ExecStream;
//# sourceMappingURL=exec-stream.d.ts.map