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
 * A program's process.stdout (fd 1) or process.stderr (fd 2): a Writable
 * over its output, as Node's is a stream, which Node's legacy pipe knows by
 * `_isStdio`. Its bytes reach the output as each write is made, decoded
 * across writes for an output that takes text, so they keep their place
 * among the console's, which writes the output directly; an output's
 * failure is the stream's error, and the stream finishes once every write
 * handed to the output is done.
 */
export function standardStream(output, fd) {
    leaveStandardStreamsOpen();
    const { Writable } = realm.getBuiltinModule('node:stream');
    const writer = new SinkWriter(output);
    // The writes handed to the output and not yet done: the stream finishes after them.
    const pending = new Set();
    const stream = Object.assign(new Writable({
        // A UTF-8 string goes to the output as text; any other is made bytes in its encoding.
        decodeStrings: false,
        write(chunk, encoding, callback) {
            const done = typeof chunk === 'string' && (encoding === 'utf8' || encoding === 'utf-8')
                ? writer.writeText(chunk)
                : writer.write(typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk);
            pending.add(done);
            done.then(() => { pending.delete(done); }, (error) => { pending.delete(done); stream.destroy(error); });
            callback();
        },
        final(callback) {
            Promise.all(pending).then(() => writer.end()).then(() => callback(), callback);
        },
    }), { isTTY: false, fd, columns: 80, _isStdio: true });
    standardStreams.add(stream);
    return stream;
}
