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
    clearLine(_dir, _cb) {
        const mode = _dir < 0 ? 1 : _dir > 0 ? 0 : 2;
        this.write(`\x1b[${mode}K`);
        _cb?.();
        return true;
    }
    clearScreenDown(_cb) {
        this.write('\x1b[0J');
        _cb?.();
        return true;
    }
    cursorTo(_x, _y, _cb) {
        if (typeof _y === 'function') {
            _cb = _y;
            _y = undefined;
        }
        const col = Math.max(0, Math.floor(Number(_x) || 0)) + 1;
        if (_y === undefined) {
            this.write(`\x1b[${col}G`);
        }
        else {
            const row = Math.max(0, Math.floor(Number(_y) || 0)) + 1;
            this.write(`\x1b[${row};${col}H`);
        }
        _cb?.();
        return true;
    }
    moveCursor(_dx, _dy, _cb) {
        const x = Math.trunc(Number(_dx) || 0);
        const y = Math.trunc(Number(_dy) || 0);
        if (x < 0)
            this.write(`\x1b[${-x}D`);
        else if (x > 0)
            this.write(`\x1b[${x}C`);
        if (y < 0)
            this.write(`\x1b[${-y}A`);
        else if (y > 0)
            this.write(`\x1b[${y}B`);
        _cb?.();
        return true;
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
