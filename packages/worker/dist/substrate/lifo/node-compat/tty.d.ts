import { Readable, Writable } from './stream.js';
/**
 * Node.js `tty` module shim for Lifo.
 *
 * In the browser there is no real TTY, so ReadStream/WriteStream behave like
 * plain streams with the TTY-specific properties stubbed to sensible defaults.
 */
export declare class ReadStream extends Readable {
    readonly isTTY = true;
    readonly isRaw = false;
    setRawMode(_mode: boolean): this;
}
export declare class WriteStream extends Writable {
    readonly isTTY = true;
    columns: number;
    rows: number;
    clearLine(_dir: number, _cb?: () => void): boolean;
    clearScreenDown(_cb?: () => void): boolean;
    cursorTo(_x: number, _y?: number | (() => void), _cb?: () => void): boolean;
    moveCursor(_dx: number, _dy: number, _cb?: () => void): boolean;
    getColorDepth(): number;
    hasColors(count?: number): boolean;
    getWindowSize(): [number, number];
}
export declare function isatty(_fd: number): boolean;
declare const _default: {
    ReadStream: typeof ReadStream;
    WriteStream: typeof WriteStream;
    isatty: typeof isatty;
};
export default _default;
//# sourceMappingURL=tty.d.ts.map