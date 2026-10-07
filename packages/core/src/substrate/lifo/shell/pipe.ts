import type { CommandOutputStream, CommandInputStream } from '../commands/types.js';
import { encode } from '../utils/encoding.js';
import { decideWrite, PIPE_CAPACITY } from '../../../runtime/bash/pipe-rules.js';
import { ByteQueue } from './byte-queue.js';

/** Both ends of every pipe: what `isFdPipe` answers for, whichever interpreter holds them. */
const pipeEnds = new WeakSet<CommandOutputStream | CommandInputStream>();

/** Whether a stream is an end of a shell pipe (S_ISFIFO). */
export function isPipeEnd(stream: CommandOutputStream | CommandInputStream | undefined): boolean {
  return stream !== undefined && pipeEnds.has(stream);
}

/**
 * A shell pipe that carries the producer's exact bytes: a ByteQueue with a
 * writer end. Text writes are encoded once at the write side, `writeBytes`
 * stores bytes verbatim; a writer waits while the pipe holds its capacity
 * (pipe-rules.ts decides) and gets EPIPE once the reader is gone.
 */
export class PipeChannel {
  private readonly queue = new PipeQueue((length) => this.consume(length));
  private queuedBytes = 0;
  /** A host that can park a writer (the wasm bash's JSPI host): pipe-rules.ts decides. */
  private readonly capacity = PIPE_CAPACITY;
  private drained: Array<() => void> = [];
  private readerClosed = false;
  private writerClosed = false;
  private unlinkSignal: (() => void) | undefined;

  constructor(signal?: AbortSignal) {
    pipeEnds.add(this.writer).add(this.reader);
    if (signal?.aborted) this.cancel();
    else if (signal) {
      const abort = () => this.cancel();
      signal.addEventListener('abort', abort, { once: true });
      this.unlinkSignal = () => signal.removeEventListener('abort', abort);
    }
  }

  private async push(bytes: Uint8Array): Promise<void> {
    for (let offset = 0; offset < bytes.length;) {
      for (;;) {
        const readers = this.writerClosed || this.readerClosed ? 0 : 1;
        const decision = decideWrite({ queued: this.queuedBytes, readers, writers: 1 }, bytes.length - offset, 'jspi', this.capacity, Infinity);
        if (decision === 'sigpipe') throw Object.assign(new Error('EPIPE: pipe reader closed'), { code: 'EPIPE' });
        if (decision === 'write') break;
        await new Promise<void>((resolve) => this.drained.push(resolve));
      }
      const length = Math.min(bytes.length - offset, this.capacity - this.queuedBytes);
      this.queuedBytes += length;
      this.queue.push(bytes.slice(offset, offset + length));
      offset += length;
    }
  }

  private consume(length: number): void {
    if (!this.readerClosed) this.queuedBytes -= length;
    this.wakeWriters();
  }

  private wakeWriters(): void {
    for (const wake of this.drained.splice(0)) wake();
  }

  cancel(): void {
    this.readerClosed = true;
    this.queue.drop();
    this.queuedBytes = 0;
    this.close();
  }

  readonly writer: CommandOutputStream = {
    write: async (text: string) => (await this.push(encode(text))),
    writeBytes: async (bytes: Uint8Array) => (await this.push(bytes)),
  };

  readonly reader: CommandInputStream = {
    read: async () => (await this.queue.read()),
    readAll: async () => (await this.queue.readAll()),
    readLine: async () => (await this.queue.readLine()),
    readBytes: async (maxLength: number) => (await this.queue.readBytes(maxLength)),
  };

  close(): void {
    this.writerClosed = true;
    this.unlinkSignal?.();
    this.unlinkSignal = undefined;
    this.wakeWriters();
    this.queue.close();
  }
}

/** The pipe's queue, its delivery and discard opened to the pipe. */
class PipeQueue extends ByteQueue {
  push(bytes: Uint8Array): void {
    this.deliver(bytes);
  }

  drop(): void {
    this.discard();
  }
}
