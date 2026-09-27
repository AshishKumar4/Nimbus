import type { CommandOutputStream, CommandInputStream } from '../commands/types.js';
import { encode } from '../utils/encoding.js';
import { decideWrite, PIPE_CAPACITY } from '../../../runtime/bash/pipe-rules.js';

/** Both ends of every pipe: what `isFdPipe` answers for, whichever interpreter holds them. */
const pipeEnds = new WeakSet<CommandOutputStream | CommandInputStream>();

/** Whether a stream is an end of a shell pipe (S_ISFIFO). */
export function isPipeEnd(stream: CommandOutputStream | CommandInputStream | undefined): boolean {
  return stream !== undefined && pipeEnds.has(stream);
}

/**
 * A shell pipe that carries the producer's exact bytes. Text writes are
 * encoded once at the write side, `writeBytes` stores bytes verbatim, and
 * the text view (`read`/`readAll`/`readLine`) decodes progressively so a
 * multi-byte UTF-8 sequence split across chunks survives intact.
 */
export class PipeChannel {
  private buffer: Uint8Array[] = [];
  private closed = false;
  private waiting: Array<(value: Uint8Array | null) => void> = [];
  private decoder = new TextDecoder('utf-8');
  private queuedBytes = 0;
  /** A host that can park a writer (the wasm bash's JSPI host): pipe-rules.ts decides. */
  private readonly capacity = PIPE_CAPACITY;
  private drained: Array<() => void> = [];
  private readerClosed = false;
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
        const readers = this.closed || this.readerClosed ? 0 : 1;
        const decision = decideWrite({ queued: this.queuedBytes, readers, writers: 1 }, bytes.length - offset, 'jspi', this.capacity, Infinity);
        if (decision === 'sigpipe') throw Object.assign(new Error('EPIPE: pipe reader closed'), { code: 'EPIPE' });
        if (decision === 'write') break;
        await new Promise<void>((resolve) => this.drained.push(resolve));
      }
      const length = Math.min(bytes.length - offset, this.capacity - this.queuedBytes);
      this.deliver(bytes.slice(offset, offset + length), 'back');
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
    this.buffer = [];
    this.queuedBytes = 0;
    this.close();
  }

  readonly writer: CommandOutputStream = {
    write: async (text: string) => (await this.push(encode(text))),
    writeBytes: async (bytes: Uint8Array) => (await this.push(bytes)),
  };

  readonly reader: CommandInputStream = {
    read: async () => (await this.read()),
    readAll: async () => (await this.readAll()),
    readLine: async () => (await this.readLine()),
    readBytes: async (maxLength: number) => (await this.readBytes(maxLength)),
  };

  /** Next queued chunk, a waiter's delivery, or null once closed and empty. */
  private pull(): Promise<Uint8Array | null> {
    if (this.buffer.length > 0) {
      return Promise.resolve(this.buffer.shift() ?? null);
    }
    if (this.closed) {
      return Promise.resolve(null);
    }
    return new Promise<Uint8Array | null>((resolve) => {
      this.waiting.push(resolve);
    });
  }

  private async read(): Promise<string | null> {
    while (true) {
      const bytes = await this.pull();
      if (bytes === null) {
        const tail = this.decoder.decode();
        return tail.length > 0 ? tail : null;
      }
      this.consume(bytes.length);
      const text = this.decoder.decode(bytes, { stream: true });
      if (text.length > 0) return text;
    }
  }

  private async readAll(): Promise<string> {
    const parts: string[] = [];
    while (true) {
      const chunk = await this.read();
      if (chunk === null) break;
      parts.push(chunk);
    }
    return parts.join('');
  }

  private async readLine(): Promise<string | null> {
    let line = '';
    let sawAny = false;
    while (true) {
      const bytes = await this.pull();
      if (bytes === null) break;
      sawAny = true;
      // Split on the raw 0x0A byte so pushback returns ORIGINAL bytes; a
      // multibyte sequence straddling the chunk boundary then survives as
      // é instead of collapsing into a replacement character.
      const newline = bytes.indexOf(0x0a);
      if (newline >= 0) {
        const rest = bytes.subarray(newline + 1);
        if (rest.length > 0) this.buffer.unshift(rest);
        this.consume(newline + 1);
        line += this.decoder.decode(bytes.subarray(0, newline), { stream: true });
        const flushed = this.decoder.decode();
        return line + flushed;
      }
      this.consume(bytes.length);
      line += this.decoder.decode(bytes, { stream: true });
    }
    // A trailing incomplete sequence still surfaces as U+FFFD at EOF.
    const tail = this.decoder.decode();
    line += tail;
    return sawAny || tail.length > 0 ? line : null;
  }

  /**
   * Bounded byte read: returns whatever the producer has already delivered,
   * capped at maxLength. maxLength bounds the result, it is never a fill
   * target — waiting to complete it would stall every consumer downstream of
   * a live open producer. A larger chunk keeps only its first maxLength
   * bytes; the remainder stays queued in original order.
   */
  private async readBytes(maxLength: number): Promise<Uint8Array | null> {
    if (maxLength <= 0) return new Uint8Array(0);

    const chunk = await this.pull();
    if (chunk === null) return null;
    if (chunk.length <= maxLength) {
      this.consume(chunk.length);
      return chunk;
    }
    this.buffer.unshift(chunk.subarray(maxLength));
    this.consume(maxLength);
    return chunk.subarray(0, maxLength);
  }

  close(): void {
    this.closed = true;
    this.unlinkSignal?.();
    this.unlinkSignal = undefined;
    this.wakeWriters();
    while (this.waiting.length > 0) {
      this.waiting.shift()?.(null);
    }
  }

  private deliver(bytes: Uint8Array, position: 'front' | 'back'): void {
    if (bytes.length === 0) return;

    this.queuedBytes += bytes.length;
    const waiting = this.waiting.shift();
    if (waiting) {
      waiting(bytes);
      return;
    }
    if (position === 'front') this.buffer.unshift(bytes);
    else this.buffer.push(bytes);
  }

}
