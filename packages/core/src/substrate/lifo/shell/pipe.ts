import type { CommandOutputStream, CommandInputStream } from '../commands/types.js';
import { encode } from '../utils/encoding.js';

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
  private readonly capacity = 64 * 1024;
  private drained: Array<() => void> = [];
  private readerClosed = false;
  private unlinkSignal: (() => void) | undefined;

  constructor(signal?: AbortSignal) {
    if (signal?.aborted) this.cancel();
    else if (signal) {
      const abort = () => this.cancel();
      signal.addEventListener('abort', abort, { once: true });
      this.unlinkSignal = () => signal.removeEventListener('abort', abort);
    }
  }

  private async push(bytes: Uint8Array): Promise<void> {
    for (let offset = 0; offset < bytes.length;) {
      while (this.queuedBytes >= this.capacity && !this.closed) {
        await new Promise<void>((resolve) => this.drained.push(resolve));
      }
      if (this.closed || this.readerClosed) {
        throw Object.assign(new Error('EPIPE: pipe reader closed'), { code: 'EPIPE' });
      }
      const length = Math.min(bytes.length - offset, this.capacity - this.queuedBytes);
      this.deliver(bytes.slice(offset, offset + length), 'back');
      offset += length;
    }
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
    write: (text: string) => this.push(encode(text)),
    writeBytes: (bytes: Uint8Array) => this.push(bytes),
  };

  readonly reader: CommandInputStream = {
    read: () => this.read(),
    readAll: () => this.readAll(),
    readLine: () => this.readLine(),
    readBytes: (maxLength: number) => this.readBytes(maxLength),
  };

  /** Next queued chunk, a waiter's delivery, or null once closed and empty. */
  private pull(): Promise<Uint8Array | null> {
    if (this.buffer.length > 0) {
      const bytes = this.buffer.shift()!;
      this.queuedBytes -= bytes.length;
      this.wakeWriters();
      return Promise.resolve(bytes);
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
        if (rest.length > 0) this.deliver(rest, 'front');
        line += this.decoder.decode(bytes.subarray(0, newline), { stream: true });
        const flushed = this.decoder.decode();
        return line + flushed;
      }
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
    if (chunk.length <= maxLength) return chunk;
    this.deliver(chunk.subarray(maxLength), 'front');
    return chunk.subarray(0, maxLength);
  }

  close(): void {
    this.closed = true;
    this.unlinkSignal?.();
    this.unlinkSignal = undefined;
    this.wakeWriters();
    while (this.waiting.length > 0) {
      const resolve = this.waiting.shift()!;
      resolve(null);
    }
  }

  private deliver(bytes: Uint8Array, position: 'front' | 'back'): void {
    if (bytes.length === 0) return;

    if (this.waiting.length > 0) {
      const resolve = this.waiting.shift()!;
      resolve(bytes);
      return;
    }

    this.queuedBytes += bytes.length;
    if (position === 'front') this.buffer.unshift(bytes);
    else this.buffer.push(bytes);
  }

}
