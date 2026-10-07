import type { CommandOutputStream, CommandInputStream } from '../commands/types.js';
/** Whether a stream is an end of a shell pipe (S_ISFIFO). */
export declare function isPipeEnd(stream: CommandOutputStream | CommandInputStream | undefined): boolean;
/**
 * A shell pipe that carries the producer's exact bytes: a ByteQueue with a
 * writer end. Text writes are encoded once at the write side, `writeBytes`
 * stores bytes verbatim; a writer waits while the pipe holds its capacity
 * (pipe-rules.ts decides) and gets EPIPE once the reader is gone.
 */
export declare class PipeChannel {
    private readonly queue;
    private queuedBytes;
    /** A host that can park a writer (the wasm bash's JSPI host): pipe-rules.ts decides. */
    private readonly capacity;
    private drained;
    private readerClosed;
    private writerClosed;
    private unlinkSignal;
    constructor(signal?: AbortSignal);
    private push;
    private consume;
    private wakeWriters;
    cancel(): void;
    readonly writer: CommandOutputStream;
    readonly reader: CommandInputStream;
    close(): void;
}
//# sourceMappingURL=pipe.d.ts.map