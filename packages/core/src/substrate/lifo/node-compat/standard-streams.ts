import { Buffer } from 'node:buffer';
import realm from 'node:process';
import type { PipeOptions, Readable, Writable, WritableOptions } from 'node:stream';
import { SinkWriter } from '../../../_shared/byte-stream.js';
import type { CommandOutputStream } from '../commands/types.js';

/** Every program's process.stdout and process.stderr this realm has made. */
const standardStreams = new WeakSet<Writable>();
let pipeLeavesThemOpen = false;

/**
 * A pipe into a program's stdout or stderr leaves it open, as Node's pipe
 * leaves process.stdout and process.stderr; the engine's knows only its own
 * process's. Set on the engine's Readable when a program first reaches the
 * engine's streams, before it can pipe into one; a pipe into anything else
 * is the engine's as it was.
 */
export function leaveStandardStreamsOpen(): void {
  if (pipeLeavesThemOpen) return;
  pipeLeavesThemOpen = true;
  const { Readable } = realm.getBuiltinModule('node:stream');
  const pipe = Readable.prototype.pipe;
  Readable.prototype.pipe = function (this: Readable, destination: Writable, options?: PipeOptions): Writable {
    return pipe.call(this, destination, standardStreams.has(destination) ? { ...options, end: false } : options);
  };
}

/** What made a write to a program's stdout or stderr: its stream, or its console (which, in Node, writes through the stream). */
export type OutputSource = 'stream' | 'console';

/**
 * An output that can fail after it took a write (a program in a realm, whose
 * host makes the write later): `onFailure` hears of each failed write, and
 * what made it, until its disposer lets go.
 */
export interface FailableOutput extends CommandOutputStream {
  onFailure?(listener: (error: Error, source: OutputSource) => void): () => void;
  /** Another writer of the same descriptor, which hears only its own writes' failures (a tty.WriteStream a program makes). */
  another?(): FailableOutput;
  /** Once every write handed to it so far is made or failed, a failure heard first. */
  settled?(): Promise<void>;
}

/**
 * A Writable's options over `output`: its bytes reach the output as each
 * write is made, decoded across writes for an output that takes text, so
 * they keep their place among the console's, which writes the output
 * directly; an output's failure is the stream's error, and the stream
 * finishes once every write handed to the output is done (settled, by one
 * that makes them later: a failure then is its error). Without an output
 * (a descriptor the program has not), every write fails EBADF.
 */
export function outputSink(output: FailableOutput | undefined): WritableOptions {
  const writer = output === undefined ? undefined : new SinkWriter(output);
  // The writes handed to the output and not yet done: the stream finishes after them.
  const pending = new Set<Promise<void>>();
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
      done.then(() => { pending.delete(done); }, (error: Error) => { pending.delete(done); stream.destroy(error); });
      callback();
    },
    final(callback) {
      Promise.all(pending).then(() => writer?.end()).then(() => output?.settled?.()).then(() => callback(), callback);
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
export function asStandardStream<T extends Writable>(stream: T, fd: 1 | 2, output: FailableOutput): T {
  leaveStandardStreamsOpen();
  Object.assign(stream, { fd, _isStdio: true });
  output.onFailure?.((error, source) => {
    if (source === 'stream' || stream.listenerCount('error') > 0) stream.destroy(error);
  });
  standardStreams.add(stream);
  return stream;
}

/** A program's process.stdout (fd 1) or process.stderr (fd 2) that is not the terminal: a Writable over its output, as Node's is a stream. */
export function standardStream(output: FailableOutput, fd: 1 | 2): Writable {
  leaveStandardStreamsOpen();
  const { Writable } = realm.getBuiltinModule('node:stream');
  return asStandardStream(new Writable(outputSink(output)), fd, output);
}

/** What a read of fd 0 gives: a piece, null at its end, or nothing, withdrawn before anything arrived. */
export type StandardPiece = Uint8Array | null | 'withdrawn';

/** A read of fd 0 in flight. */
export interface StandardRead {
  readonly piece: Promise<StandardPiece>;
  /** Withdraw it: what has not arrived stays on fd 0 for the next read, and the read settles 'withdrawn'. */
  cancel(): void;
}

/** fd 0, a piece at a time, as a program's process.stdin and tty.ReadStream(0) read it. */
export interface StandardInput {
  /** fd 0's next piece, never an empty one; a failed read rejects with the descriptor's error. */
  read(): StandardRead;
  /** One more reader waits on fd 0 (true), or one fewer (false): while any does, the program is held, as reading a pipe or the terminal holds a Node process. */
  hold(on: boolean): void;
}

/**
 * `stream` reading fd 0 from `input` (none: fd 0 is at its end), as Node's
 * stdin reads its descriptor: a piece is asked for when the stream wants
 * one, and its wait holds the program. Paused and, a tick later, still not
 * flowing, or destroyed, it stops reading (the read is withdrawn and holds
 * no more), as Node's stdin does so that its process can end; reading again
 * starts a new read.
 */
export function joinStandardInput<T extends Readable>(stream: T, input: StandardInput | undefined): T {
  let pending: StandardRead | null = null;
  const settle = (read: StandardRead): void => {
    if (pending !== read) return;
    pending = null;
    input?.hold(false);
  };
  const stop = (): void => {
    const read = pending;
    if (read === null) return;
    settle(read);
    read.cancel();
    // As Node's onpause: the next _read starts a new read.
    stream._readableState.reading = false;
  };
  stream.on('pause', () => {
    realm.nextTick(() => {
      if (stream.readableFlowing !== true) stop();
    });
  });
  stream.on('close', stop);
  stream._read = () => {
    if (pending !== null) return;
    if (input === undefined) { stream.push(null); return; }
    const read = input.read();
    pending = read;
    input.hold(true);
    read.piece.then((piece) => {
      settle(read);
      // A piece that arrived after its read stopped was taken from fd 0: it is the stream's, as Node's buffered data is.
      if (piece === 'withdrawn' || stream.destroyed) return;
      // As a Buffer over the same bytes, as Node's reads give.
      stream.push(piece === null ? null : Buffer.from(piece.buffer, piece.byteOffset, piece.byteLength));
    }, (error: Error) => {
      settle(read);
      stream.destroy(error);
    });
  };
  return stream;
}
