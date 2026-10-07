import { encode } from '../utils/encoding.js';
import { decideWrite, PIPE_CAPACITY } from '../../../runtime/bash/pipe-rules.js';
import { ByteQueue } from './byte-queue.js';
/** Both ends of every pipe: what `isFdPipe` answers for, whichever interpreter holds them. */
const pipeEnds = new WeakSet();
/** Whether a stream is an end of a shell pipe (S_ISFIFO). */
export function isPipeEnd(stream) {
    return stream !== undefined && pipeEnds.has(stream);
}
/**
 * A shell pipe that carries the producer's exact bytes: a ByteQueue with a
 * writer end. Text writes are encoded once at the write side, `writeBytes`
 * stores bytes verbatim; a writer waits while the pipe holds its capacity
 * (pipe-rules.ts decides) and gets EPIPE once the reader is gone.
 */
export class PipeChannel {
    queue = new PipeQueue((length) => this.consume(length));
    queuedBytes = 0;
    /** A host that can park a writer (the wasm bash's JSPI host): pipe-rules.ts decides. */
    capacity = PIPE_CAPACITY;
    drained = [];
    readerClosed = false;
    writerClosed = false;
    unlinkSignal;
    constructor(signal) {
        pipeEnds.add(this.writer).add(this.reader);
        if (signal?.aborted)
            this.cancel();
        else if (signal) {
            const abort = () => this.cancel();
            signal.addEventListener('abort', abort, { once: true });
            this.unlinkSignal = () => signal.removeEventListener('abort', abort);
        }
    }
    async push(bytes) {
        for (let offset = 0; offset < bytes.length;) {
            for (;;) {
                const readers = this.writerClosed || this.readerClosed ? 0 : 1;
                const decision = decideWrite({ queued: this.queuedBytes, readers, writers: 1 }, bytes.length - offset, 'jspi', this.capacity, Infinity);
                if (decision === 'sigpipe')
                    throw Object.assign(new Error('EPIPE: pipe reader closed'), { code: 'EPIPE' });
                if (decision === 'write')
                    break;
                await new Promise((resolve) => this.drained.push(resolve));
            }
            const length = Math.min(bytes.length - offset, this.capacity - this.queuedBytes);
            this.queuedBytes += length;
            this.queue.push(bytes.slice(offset, offset + length));
            offset += length;
        }
    }
    consume(length) {
        if (!this.readerClosed)
            this.queuedBytes -= length;
        this.wakeWriters();
    }
    wakeWriters() {
        for (const wake of this.drained.splice(0))
            wake();
    }
    cancel() {
        this.readerClosed = true;
        this.queue.drop();
        this.queuedBytes = 0;
        this.close();
    }
    writer = {
        write: async (text) => (await this.push(encode(text))),
        writeBytes: async (bytes) => (await this.push(bytes)),
    };
    reader = {
        read: async () => (await this.queue.read()),
        readAll: async () => (await this.queue.readAll()),
        readLine: async () => (await this.queue.readLine()),
        readBytes: async (maxLength) => (await this.queue.readBytes(maxLength)),
    };
    close() {
        this.writerClosed = true;
        this.unlinkSignal?.();
        this.unlinkSignal = undefined;
        this.wakeWriters();
        this.queue.close();
    }
}
/** The pipe's queue, its delivery and discard opened to the pipe. */
class PipeQueue extends ByteQueue {
    push(bytes) {
        this.deliver(bytes);
    }
    drop() {
        this.discard();
    }
}
