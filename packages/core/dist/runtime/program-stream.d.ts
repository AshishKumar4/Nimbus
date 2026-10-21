import type { ExitStatus, StartedSessionProgram } from './program-start.js';
/** Content type of an HTTP body carrying an encoded program stream. */
export declare const PROGRAM_STREAM_CONTENT_TYPE = "application/vnd.nimbus.program-stream";
/** The started program `start` makes (given the stream's own cancel), as one byte stream of frames. */
export declare function encodeProgramStream(start: (cancel: AbortSignal) => Promise<StartedSessionProgram>): ReadableStream<Uint8Array>;
/** What a decoded program reaches its session by, beside its stream: its signals, and its exit. */
export interface ProgramControl {
    signal(pid: number, signal: string): void;
    /** Its exit once it comes, or null when the wait ended first (waitProgram). */
    wait(pid: number): Promise<ExitStatus | null>;
}
/**
 * The inverse of encodeProgramStream: resolved with the started program
 * (its kill and its exit through `control`), or rejected with the start's
 * error, Node's spawn error with its own properties.
 */
export declare function decodeProgramStream(wire: ReadableStream<Uint8Array>, control: ProgramControl, cancel?: AbortSignal): Promise<StartedSessionProgram>;
//# sourceMappingURL=program-stream.d.ts.map