import type { TerminalInputStream } from '../commands/types.js';
import { ByteQueue } from './byte-queue.js';
/**
 * A bridge between terminal keyboard input and command stdin: a ByteQueue
 * the Shell feeds lines into (feed) and ends on Ctrl+D (close), with the
 * raw-mode switch a full-screen command flips.
 */
export declare class TerminalStdin extends ByteQueue implements TerminalInputStream {
    private _rawMode;
    /** termios ISIG (TerminalInputStream.signalKeys). */
    signalKeys: boolean;
    /** When true, the shell should bypass line editing and feed raw keypresses. */
    get rawMode(): boolean;
    set rawMode(value: boolean);
    /** Shell calls this on Enter (with line + '\n'). */
    feed(text: string): void;
    /**
     * Text snapshot of everything queued but not yet consumed. The shell's
     * wrap layer uses this for commands that want drained terminal input.
     */
    drainBuffered(): string;
}
//# sourceMappingURL=terminal-stdin.d.ts.map