import { encode } from '../utils/encoding.js';
import { ByteQueue } from './byte-queue.js';
/**
 * A bridge between terminal keyboard input and command stdin: a ByteQueue
 * the Shell feeds lines into (feed) and ends on Ctrl+D (close), with the
 * raw-mode switch a full-screen command flips.
 */
export class TerminalStdin extends ByteQueue {
    _rawMode = false;
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
