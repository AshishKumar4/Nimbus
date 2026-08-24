import type { TerminalInputStream } from '../commands/types.js';
/**
 * A bridge between terminal keyboard input and command stdin. The Shell
 * feeds lines in via feed(); commands consume bytes or text. Bytes are the
 * storage format, so a byte read always makes progress even when maxLength
 * splits a multi-byte code point — `dd bs=1` over `é` yields c3, then a9.
 */
export declare class TerminalStdin implements TerminalInputStream {
    private buffer;
    private closed;
    private resolvers;
    private _rawMode;
    private decoder;
    /** True when a command has called read() and is waiting for input. */
    get isWaiting(): boolean;
    /** When true, the shell should bypass line editing and feed raw keypresses. */
    get rawMode(): boolean;
    set rawMode(value: boolean);
    /** Shell calls this on Enter (with line + '\n'). */
    feed(text: string): void;
    /** Shell calls this on Ctrl+D to signal EOF. */
    close(): void;
    /** Commands consume input. Returns null on EOF. */
    read(): Promise<string | null>;
    readLine(): Promise<string | null>;
    /**
     * Bounded byte read: returns whatever the user has already typed, capped
     * at maxLength. maxLength bounds the result, it is never a fill target —
     * a command reading bytes must not stall until maxLength arrive. A larger
     * queued chunk keeps only its first maxLength bytes; the remainder stays
     * queued, so `dd bs=1` over `é` still yields c3, then a9.
     */
    readBytes(maxLength: number): Promise<Uint8Array | null>;
    /** Read all remaining input until EOF, joined together. */
    readAll(): Promise<string>;
    /**
     * Text snapshot of everything queued but not yet consumed. The shell's
     * wrap layer uses this for commands that want drained terminal input.
     */
    drainBuffered(): string;
    private pull;
    private deliver;
    private deliverBackText;
}
//# sourceMappingURL=terminal-stdin.d.ts.map