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

  readonly writer: CommandOutputStream = {
    write: (text: string) => {
      if (this.closed) return;
      this.deliver(encode(text), 'back');
    },
    writeBytes: (bytes: Uint8Array) => {
      if (this.closed) return;
      this.deliver(bytes, 'back');
    },
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

  private async readBytes(maxLength: number): Promise<Uint8Array | null> {
    if (maxLength <= 0) return new Uint8Array(0);

    const parts: Uint8Array[] = [];
    let got = 0;
    while (got < maxLength) {
      const chunk = await this.pull();
      if (chunk === null) break;
      const take = chunk.length <= maxLength - got ? chunk : chunk.subarray(0, maxLength - got);
      parts.push(take);
      got += take.length;
      if (take.length < chunk.length) this.buffer.unshift(chunk.subarray(take.length));
    }
    if (parts.length === 0) return null;
    if (parts.length === 1) return parts[0];
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }

  close(): void {
    this.closed = true;
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

    if (position === 'front') this.buffer.unshift(bytes);
    else this.buffer.push(bytes);
  }

}
