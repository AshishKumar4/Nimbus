import { clearLine, clearScreenDown, cursorTo, moveCursor } from './readline.js';
import { Readable, Writable } from './stream.js';
/**
 * Node.js `tty` module shim for Lifo.
 *
 * In the browser there is no real TTY, so ReadStream/WriteStream behave like
 * plain streams with the TTY-specific properties stubbed to sensible defaults.
 */
export class ReadStream extends Readable {
    isTTY = true;
    isRaw = false;
    setRawMode(_mode) {
        // no-op – raw mode is not applicable in the browser
        return this;
    }
}
export class WriteStream extends Writable {
    isTTY = true;
    columns = 80;
    rows = 24;
    // As Node's tty.WriteStream: each cursor method is readline's, on this stream.
    clearLine(dir, cb) {
        return clearLine(this, dir, cb);
    }
    clearScreenDown(cb) {
        return clearScreenDown(this, cb);
    }
    cursorTo(x, y, cb) {
        return cursorTo(this, x, y, cb);
    }
    moveCursor(dx, dy, cb) {
        return moveCursor(this, dx, dy, cb);
    }
    getColorDepth() {
        return 8; // 256 colours – reasonable default for a virtual terminal
    }
    hasColors(count) {
        if (count === undefined)
            return true;
        return count <= 256;
    }
    getWindowSize() {
        return [this.columns, this.rows];
    }
}
export function isatty(_fd) {
    return false;
}
export default { ReadStream, WriteStream, isatty };
