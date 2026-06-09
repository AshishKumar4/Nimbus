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

  clearLine(_dir: number, _cb?: () => void): boolean {
    const mode = _dir < 0 ? 1 : _dir > 0 ? 0 : 2;
    this.write(`\x1b[${mode}K`);
    _cb?.();
    return true;
  }

  clearScreenDown(_cb?: () => void): boolean {
    this.write('\x1b[0J');
    _cb?.();
    return true;
  }

  cursorTo(_x: number, _y?: number | (() => void), _cb?: () => void): boolean {
    if (typeof _y === 'function') {
      _cb = _y;
      _y = undefined;
    }
    const col = Math.max(0, Math.floor(Number(_x) || 0)) + 1;
    if (_y === undefined) {
      this.write(`\x1b[${col}G`);
    } else {
      const row = Math.max(0, Math.floor(Number(_y) || 0)) + 1;
      this.write(`\x1b[${row};${col}H`);
    }
    _cb?.();
    return true;
  }

  moveCursor(_dx: number, _dy: number, _cb?: () => void): boolean {
    const x = Math.trunc(Number(_dx) || 0);
    const y = Math.trunc(Number(_dy) || 0);
    if (x < 0) this.write(`\x1b[${-x}D`);
    else if (x > 0) this.write(`\x1b[${x}C`);
    if (y < 0) this.write(`\x1b[${-y}A`);
    else if (y > 0) this.write(`\x1b[${y}B`);
    _cb?.();
    return true;
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
