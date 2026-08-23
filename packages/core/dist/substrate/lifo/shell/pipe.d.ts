import type { CommandOutputStream, CommandInputStream } from '../commands/types.js';
/**
 * A shell pipe that carries the producer's exact bytes. Text writes are
 * encoded once at the write side, `writeBytes` stores bytes verbatim, and
 * the text view (`read`/`readAll`/`readLine`) decodes progressively so a
 * multi-byte UTF-8 sequence split across chunks survives intact.
 */
export declare class PipeChannel {
    private buffer;
    private closed;
    private waiting;
    private decoder;
    readonly writer: CommandOutputStream;
    readonly reader: CommandInputStream;
    /** Next queued chunk, a waiter's delivery, or null once closed and empty. */
    private pull;
    private read;
    private readAll;
    private readLine;
    private readBytes;
    close(): void;
    private deliver;
}
//# sourceMappingURL=pipe.d.ts.map