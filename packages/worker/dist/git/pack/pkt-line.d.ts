export declare function pktLine(text: string): Uint8Array;
/** pkt-lines off a byte stream, pulled one at a time; null is a flush. */
export declare class PktReader {
    private readonly reader;
    private readonly stallMs;
    private buffer;
    private done;
    constructor(reader: ReadableStreamDefaultReader<Uint8Array>, stallMs?: number);
    /** The next chunk, or a stall error when none comes in time (the read is cancelled). */
    private read;
    private fill;
    /** The next packet's payload, null for a flush, undefined at the stream's end. */
    next(): Promise<Uint8Array | null | undefined>;
    cancel(): Promise<void>;
}
export declare function text(payload: Uint8Array): string;
//# sourceMappingURL=pkt-line.d.ts.map