import type { StartedSessionProgram } from './program-start.js';
/** Content type of an HTTP body carrying an encoded program stream. */
export declare const PROGRAM_STREAM_CONTENT_TYPE = "application/vnd.nimbus.program-stream";
/** The started program `start` makes (given the stream's own cancel), as one byte stream of frames. */
export declare function encodeProgramStream(start: (cancel: AbortSignal) => Promise<StartedSessionProgram>): ReadableStream<Uint8Array>;
/**
 * The inverse of encodeProgramStream: resolved with the started program
 * (its kill sent through `signal`), or rejected with the start's error, Node's
 * spawn error with its own properties.
 */
export declare function decodeProgramStream(wire: ReadableStream<Uint8Array>, signal: (pid: number, signal: string) => void, cancel?: AbortSignal): Promise<StartedSessionProgram>;
//# sourceMappingURL=program-stream.d.ts.map