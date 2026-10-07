/**
 * Byte chunks in order, with readers that wait for the next: what a shell
 * pipe (pipe.ts) and the terminal's stdin (terminal-stdin.ts) both are
 * underneath. Bytes are the storage, so a byte read always makes progress
 * (`dd bs=1` over `é` yields c3, then a9) and the text reads decode
 * progressively, a multi-byte sequence split across chunks intact.
 */
export declare class ByteQueue {
    private readonly consumed;
    private buffer;
    private waiting;
    private readonly decoder;
    protected ended: boolean;
    /** `consumed` hears how many bytes each read takes (a pipe's capacity accounting). */
    constructor(consumed?: (length: number) => void);
    /** True when a reader is waiting for input. */
    get isWaiting(): boolean;
    /** Queue `bytes`, handing them to a waiting reader first. */
    protected deliver(bytes: Uint8Array): void;
    /** No more input: every waiting reader, and every later one, sees the end. */
    close(): void;
    /** Drop what is queued and unread. */
    protected discard(): void;
    /** Next queued chunk, a delivery waited for, or null once ended and empty. */
    private pull;
    /** The next text the input holds, or null at its end. */
    read(): Promise<string | null>;
    /** Everything to the end, as text. */
    readAll(): Promise<string>;
    /**
     * The next line without its newline, or null at the end. The split is on
     * the raw 0x0A byte and what follows it is queued back as it came, so a
     * multi-byte sequence straddling the split survives.
     */
    readLine(): Promise<string | null>;
    /**
     * Bounded byte read: whatever has already arrived, capped at maxLength.
     * maxLength bounds the result and is never a fill target: waiting to
     * complete it would stall every reader downstream of a live producer. A
     * larger chunk gives its first maxLength bytes; the rest stays queued.
     */
    readBytes(maxLength: number): Promise<Uint8Array | null>;
    /** What is queued and unread, as text, without waiting: the queue is left empty. */
    drainText(): string;
}
//# sourceMappingURL=byte-queue.d.ts.map