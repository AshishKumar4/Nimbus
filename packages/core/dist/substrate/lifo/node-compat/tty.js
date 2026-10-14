import realm from 'node:process';
import { clearLine, clearScreenDown, cursorTo, moveCursor } from './readline.js';
/**
 * Node.js `tty` module shim for Lifo.
 *
 * In the browser there is no real TTY, so ReadStream/WriteStream behave like
 * plain streams with the TTY-specific properties stubbed to sensible defaults.
 */
/**
 * The tty module, its streams the engine's own stream classes, made when a
 * program requires it (the engine's stream module is loaded then). Neither
 * stream is joined to a descriptor yet: a ReadStream gives nothing, and what
 * a WriteStream is given goes nowhere, as lifo's own streams did.
 */
export function createTty() {
    const { Readable, Writable } = realm.getBuiltinModule('node:stream');
    class ReadStream extends Readable {
        constructor() {
            super({ read() { } });
        }
        isTTY = true;
        isRaw = false;
        setRawMode(_mode) {
            // no-op – raw mode is not applicable in the browser
            return this;
        }
    }
    class WriteStream extends Writable {
        constructor() {
            super({ write(_chunk, _encoding, callback) { callback(); } });
        }
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
    return { ReadStream, WriteStream, isatty };
}
function isatty(_fd) {
    return false;
}
