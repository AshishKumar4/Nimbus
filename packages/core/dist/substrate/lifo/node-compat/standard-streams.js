import { Buffer } from 'node:buffer';
import realm from 'node:process';
import { SinkWriter } from '../../../_shared/byte-stream.js';
/** Every program's process.stdout and process.stderr this realm has made. */
const standardStreams = new WeakSet();
let pipeLeavesThemOpen = false;
/**
 * A pipe into a program's stdout or stderr leaves it open, as Node's pipe
 * leaves process.stdout and process.stderr; the engine's knows only its own
 * process's. Set on the engine's Readable when a program first reaches the
 * engine's streams, before it can pipe into one; a pipe into anything else
 * is the engine's as it was.
 */
export function leaveStandardStreamsOpen() {
    if (pipeLeavesThemOpen)
        return;
    pipeLeavesThemOpen = true;
    const { Readable } = realm.getBuiltinModule('node:stream');
    const pipe = Readable.prototype.pipe;
    Readable.prototype.pipe = function (destination, options) {
        return pipe.call(this, destination, standardStreams.has(destination) ? { ...options, end: false } : options);
    };
}
/**
 * A Writable's options over `output`: its bytes reach the output as each
 * write is made, decoded across writes for an output that takes text, so
 * they keep their place among the console's, which writes the output
 * directly; an output's failure is the stream's error, and the stream
 * finishes once every write handed to the output is done. Without an output
 * (a descriptor the program has not), every write fails EBADF.
 */
export function outputSink(output) {
    const writer = output === undefined ? undefined : new SinkWriter(output);
    // The writes handed to the output and not yet done: the stream finishes after them.
    const pending = new Set();
    return {
        // A UTF-8 string goes to the output as text; any other is made bytes in its encoding.
        decodeStrings: false,
        write(chunk, encoding, callback) {
            const stream = this;
            if (writer === undefined) {
                callback(Object.assign(new Error('EBADF: bad file descriptor, write'), { code: 'EBADF', errno: -9, syscall: 'write' }));
                return;
            }
            const done = typeof chunk === 'string' && (encoding === 'utf8' || encoding === 'utf-8')
                ? writer.writeText(chunk)
                : writer.write(typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk);
            pending.add(done);
            done.then(() => { pending.delete(done); }, (error) => { pending.delete(done); stream.destroy(error); });
            callback();
        },
        final(callback) {
            Promise.all(pending).then(() => writer?.end()).then(() => callback(), callback);
        },
    };
}
/**
 * `stream`, over `output`, as a program's process.stdout (fd 1) or
 * process.stderr (fd 2), which Node's legacy pipe knows by `_isStdio` and a
 * pipe into leaves open. A failed write is its error (a console write's only
 * when it has a listener, as Node's console ignores its own failures
 * otherwise).
 */
export function asStandardStream(stream, fd, output) {
    leaveStandardStreamsOpen();
    Object.assign(stream, { fd, _isStdio: true });
    output.onFailure?.((error, source) => {
        if (source === 'stream' || stream.listenerCount('error') > 0)
            stream.destroy(error);
    });
    standardStreams.add(stream);
    return stream;
}
/** A program's process.stdout (fd 1) or process.stderr (fd 2) that is not the terminal: a Writable over its output, as Node's is a stream. */
export function standardStream(output, fd) {
    leaveStandardStreamsOpen();
    const { Writable } = realm.getBuiltinModule('node:stream');
    return asStandardStream(new Writable(outputSink(output)), fd, output);
}
/**
 * `stream` reading fd 0 from `input` (none: fd 0 is at its end): a piece is
 * asked for when the stream wants one, as Node starts reading a descriptor.
 * Its wait holds the program until the stream is paused and, a tick later,
 * still not flowing, as Node stops reading a paused stdin then (so that the
 * process can end).
 */
export function joinStandardInput(stream, input) {
    let reading = false;
    let stopped = false;
    const want = () => input?.waiting(reading && !stopped);
    stream.on('pause', () => {
        realm.nextTick(() => {
            if (stream.readableFlowing === true)
                return;
            stopped = true;
            want();
        });
    });
    stream.on('resume', () => {
        stopped = false;
        want();
    });
    stream._read = () => {
        if (reading)
            return;
        if (input === undefined) {
            stream.push(null);
            return;
        }
        reading = true;
        want();
        const next = () => {
            input.read().then((piece) => {
                // An empty piece is no data and not the end: ask again.
                if (piece !== null && piece.length === 0) {
                    next();
                    return;
                }
                reading = false;
                want();
                // As a Buffer over the same bytes, as Node's reads give.
                stream.push(piece === null ? null : Buffer.from(piece.buffer, piece.byteOffset, piece.byteLength));
            }, (error) => {
                reading = false;
                want();
                stream.destroy(error);
            });
        };
        next();
    };
    return stream;
}
