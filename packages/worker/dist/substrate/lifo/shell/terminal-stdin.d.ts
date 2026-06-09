import type { TerminalInputStream } from '../commands/types.js';
/**
 * A bridge between terminal keyboard input and command stdin.
 * The Shell feeds lines in via feed(), commands consume via read()/readAll().
 */
export declare class TerminalStdin implements TerminalInputStream {
    private buffer;
    private closed;
    private resolvers;
    private _rawMode;
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
    readBytes(maxLength: number): Promise<string | null>;
    /** Read all remaining input until EOF, joined together. */
    readAll(): Promise<string>;
    private deliver;
}
//# sourceMappingURL=terminal-stdin.d.ts.map