import { clearLine, clearScreenDown, cursorTo, moveCursor } from './readline.js';
import { Readable, Writable } from './stream.js';

/**
 * Node.js `tty` module shim for Lifo.
 *
 * In the browser there is no real TTY, so ReadStream/WriteStream behave like
 * plain streams with the TTY-specific properties stubbed to sensible defaults.
 */

export class ReadStream extends Readable {
  readonly isTTY = true;
  readonly isRaw = false;

  setRawMode(_mode: boolean): this {
    // no-op – raw mode is not applicable in the browser
    return this;
  }
}

export class WriteStream extends Writable {
  readonly isTTY = true;
  columns = 80;
  rows = 24;

  // As Node's tty.WriteStream: each cursor method is readline's, on this stream.
  clearLine(dir: number, cb?: () => void): boolean {
    return clearLine(this, dir, cb);
  }

  clearScreenDown(cb?: () => void): boolean {
    return clearScreenDown(this, cb);
  }

  cursorTo(x: number, y?: number | (() => void), cb?: () => void): boolean {
    return cursorTo(this, x, y, cb);
  }

  moveCursor(dx: number, dy: number, cb?: () => void): boolean {
    return moveCursor(this, dx, dy, cb);
  }

  getColorDepth(): number {
    return 8; // 256 colours – reasonable default for a virtual terminal
  }

  hasColors(count?: number): boolean {
    if (count === undefined) return true;
    return count <= 256;
  }

  getWindowSize(): [number, number] {
    return [this.columns, this.rows];
  }
}

export function isatty(_fd: number): boolean {
  return false;
}

export default { ReadStream, WriteStream, isatty };
