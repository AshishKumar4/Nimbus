import realm from 'node:process';
import { nodeError, nodeSystemError } from '../../../_shared/node-error.js';
import { asStandardStream, joinStandardInput, leaveStandardStreamsOpen, outputSink, standardStream } from './standard-streams.js';
const programs = new WeakMap();
/**
 * The tty module of the program `stdio` is, its streams joined to its
 * descriptors: a WriteStream writes to the descriptor it is made on, in order
 * with process.stdout, a ReadStream reads fd 0, and isatty answers for each.
 * One per program, so that its process's streams are its module's (in a
 * terminal, process.stdout is a tty.WriteStream). Its classes are the engine's
 * stream classes, made when the program first reaches them.
 */
export function ttyOf(stdio) {
    let tty = programs.get(stdio);
    if (tty === undefined)
        programs.set(stdio, tty = createTty(stdio));
    return tty;
}
function createTty(stdio) {
    let module;
    let stdin;
    let stdout;
    let stderr;
    const isatty = (fd) => Number.isInteger(fd) && fd >= 0 && fd <= 2 && stdio.terminal?.isatty(fd) === true;
    const ttyModule = () => module ??= ttyClasses(stdio, isatty);
    const standardOutput = (fd) => {
        const output = fd === 1 ? stdio.stdout : stdio.stderr;
        if (!isatty(fd))
            return standardStream(output, fd);
        return asStandardStream(new (ttyModule().WriteStream)(fd), fd, output);
    };
    return {
        get module() { return ttyModule(); },
        // Before it can pipe: `process.stdin.pipe(process.stdout)` takes pipe before it makes stdout.
        stdin: () => stdin ??= (leaveStandardStreamsOpen(), isatty(0))
            ? Object.assign(new (ttyModule().ReadStream)(0), { fd: 0 })
            : Object.assign(joinStandardInput(new (realm.getBuiltinModule('node:stream').Readable)(), stdio.input), { fd: 0 }),
        stdout: () => stdout ??= standardOutput(1),
        stderr: () => stderr ??= standardOutput(2),
    };
}
/** A descriptor as Node's tty streams take it: a whole number, else ERR_INVALID_FD. */
function checkFd(fd) {
    if (typeof fd !== 'number' || (fd >> 0) !== fd || fd < 0)
        throw nodeError(RangeError, 'ERR_INVALID_FD', `"fd" must be a positive integer: ${String(fd)}`);
    return fd;
}
/**
 * What uv_tty_init answers for a descriptor it cannot stream: one the
 * program has not, or a file (libuv streams only a terminal, a pipe or a
 * socket).
 */
function ttyInitFailed() {
    return nodeSystemError('ERR_TTY_INIT_FAILED', 'TTY initialization failed', { errno: -22, code: 'EINVAL', message: 'invalid argument', syscall: 'uv_tty_init' });
}
function ttyClasses(stdio, isatty) {
    const { Readable, Writable } = realm.getBuiltinModule('node:stream');
    const readline = realm.getBuiltinModule('node:readline');
    /** A standard descriptor libuv can stream: the terminal or a pipe. */
    const streamable = (fd) => fd <= 2 && (isatty(fd) || stdio.terminal?.isPipe(fd) === true);
    const windowSize = () => [Number(stdio.env.COLUMNS) || 80, Number(stdio.env.LINES) || 24];
    class ReadStream extends Readable {
        isTTY = true;
        isRaw = false;
        constructor(fd) {
            if (checkFd(fd) !== 0 || !streamable(fd))
                throw ttyInitFailed();
            super();
            joinStandardInput(this, stdio.input);
        }
        setRawMode(mode) {
            const raw = Boolean(mode);
            stdio.terminal?.setRawMode(raw);
            this.isRaw = raw;
            return this;
        }
    }
    class WriteStream extends Writable {
        isTTY = true;
        // The window's, on the terminal; none on a pipe, as Node has none there.
        columns;
        rows;
        constructor(fd) {
            if (!streamable(checkFd(fd)))
                throw ttyInitFailed();
            super(outputSink(fd === 1 ? stdio.stdout : fd === 2 ? stdio.stderr : undefined));
            if (isatty(fd))
                [this.columns, this.rows] = windowSize();
        }
        // As Node's tty.WriteStream: each cursor method is readline's, on this stream.
        clearLine(dir, cb) {
            return readline.clearLine(this, dir, cb);
        }
        clearScreenDown(cb) {
            return readline.clearScreenDown(this, cb);
        }
        cursorTo(x, y, cb) {
            return typeof y === 'function' ? readline.cursorTo(this, x, undefined, y) : readline.cursorTo(this, x, y, cb);
        }
        moveCursor(dx, dy, cb) {
            return readline.moveCursor(this, dx, dy, cb);
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
            return windowSize();
        }
    }
    return { ReadStream, WriteStream, isatty };
}
