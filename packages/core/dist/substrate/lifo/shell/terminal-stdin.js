import { encode } from '../utils/encoding.js';
import { ByteQueue } from './byte-queue.js';
/**
 * A bridge between terminal keyboard input and command stdin: a ByteQueue
 * the Shell feeds lines into (feed) and ends on Ctrl+D (close), with the
 * raw-mode switch a full-screen command flips.
 */
export class TerminalStdin extends ByteQueue {
    beforeRead;
    constructor(beforeRead = () => { }) {
        super();
        this.beforeRead = beforeRead;
    }
    pull(signal) {
        // A read already withdrawn takes no type-ahead: it is the next reader's.
        if (!this.buffered && !this.ended && !signal?.aborted)
            this.beforeRead();
        return super.pull(signal);
    }
    /** Whether a read would be answered at once: something is queued, or the input ended. */
    get ready() {
        return this.buffered || this.ended;
    }
    _rawMode = false;
    /** termios ISIG (TerminalInputStream.signalKeys). */
    signalKeys = true;
    /** When true, the shell should bypass line editing and feed raw keypresses. */
    get rawMode() {
        return this._rawMode;
    }
    set rawMode(value) {
        this._rawMode = value;
    }
    /** Shell calls this on Enter (with line + '\n'). */
    feed(text) {
        if (this.ended || text === '')
            return;
        this.deliver(encode(text));
    }
    /**
     * Text snapshot of everything queued but not yet consumed. The shell's
     * wrap layer uses this for commands that want drained terminal input.
     */
    drainBuffered() {
        return this.drainText();
    }
}
