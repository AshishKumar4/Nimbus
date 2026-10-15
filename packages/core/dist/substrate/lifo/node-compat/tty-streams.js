import realm from 'node:process';
import { nodeError, nodeSystemError } from '../../../_shared/node-error.js';
import { asStandardStream, joinStandardInput, leaveStandardStreamsOpen, outputSink, standardStream } from './standard-streams.js';
/** Made by the program's own process.stdout or process.stderr, whose writer is its descriptor's first: not a WriteStream the program makes. */
const STANDARD = Symbol('standard stream');
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
    let classes;
    let stdin;
    let stdout;
    let stderr;
    const isatty = (fd) => Number.isInteger(fd) && fd >= 0 && fd <= 2 && stdio.terminal?.isatty(fd) === true;
    // The WriteStreams the program made, until they close.
    const writers = new Set();
    const ttyClassesOf = () => classes ??= ttyClasses(stdio, isatty, writers);
    const ttyModule = () => ttyClassesOf().module;
    const standardOutput = (fd) => {
        const output = fd === 1 ? stdio.stdout : stdio.stderr;
        if (!isatty(fd))
            return standardStream(output, fd);
        return asStandardStream(ttyClassesOf().standardWriter(fd), fd, output);
    };
    return {
        get module() { return ttyModule(); },
        // Before it can pipe: `process.stdin.pipe(process.stdout)` takes pipe before it makes stdout.
        stdin: () => stdin ??= (leaveStandardStreamsOpen(), isatty(0))
            ? Object.assign(new (ttyModule().ReadStream)(0), { fd: 0 })
            : Object.assign(joinStandardInput(new (realm.getBuiltinModule('node:stream').Readable)(), stdio.input), { fd: 0 }),
        stdout: () => stdout ??= standardOutput(1),
        stderr: () => stderr ??= standardOutput(2),
        writersHear: () => [...writers].some((writer) => writer.listenerCount('error') > 0),
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
function ttyClasses(stdio, isatty, writers) {
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
            // As Node's: nothing is read ahead of the program, so a paused terminal stops being read.
            super({ highWaterMark: 0 });
            joinStandardInput(this, stdio.input);
        }
        setRawMode(mode) {
            const raw = Boolean(mode);
            // As uv_tty_set_mode: a mode the stream is already in is not set again.
            if (raw === this.isRaw)
                return this;
            // On a descriptor that is not a terminal, its termios cannot be read.
            if (!isatty(0)) {
                this.emit('error', Object.assign(new Error('setRawMode ENOTTY'), { errno: -25, code: 'ENOTTY', syscall: 'setRawMode' }));
                return this;
            }
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
        constructor(fd, standard) {
            if (!streamable(checkFd(fd)))
                throw ttyInitFailed();
            const base = fd === 1 ? stdio.stdout : fd === 2 ? stdio.stderr : undefined;
            // One the program makes writes as a writer of its own, and hears its own writes' failures, as Node's
            // does each write's: process.stdout's are asStandardStream's to hear.
            const output = standard === STANDARD ? base : base?.another?.() ?? base;
            super(outputSink(output));
            if (standard !== STANDARD) {
                output?.onFailure?.((error, source) => {
                    if (source === 'stream')
                        this.destroy(error);
                });
                writers.add(this);
                this.once('close', () => writers.delete(this));
            }
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
    return { module: { ReadStream, WriteStream, isatty }, standardWriter: (fd) => new WriteStream(fd, STANDARD) };
}
