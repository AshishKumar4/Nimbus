/** Shared smart-HTTP packet framing for upload-pack and receive-pack. */
import { STALL_MS, UploadPackError } from './transport.js';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function pktLine(text: string): Uint8Array {
  const body = encoder.encode(text);
  const out = new Uint8Array(body.byteLength + 4);
  out.set(encoder.encode((body.byteLength + 4).toString(16).padStart(4, '0')));
  out.set(body, 4);
  return out;
}

/** pkt-lines off a byte stream, pulled one at a time; null is a flush. */
export class PktReader {
  private buffer: Uint8Array = new Uint8Array(0);
  private done = false;

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>, private readonly stallMs = STALL_MS) {}

  /** The next chunk, or a stall error when none comes in time (the read is cancelled). */
  private read(): Promise<ReadableStreamReadResult<Uint8Array>> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stalled = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new UploadPackError('the server sent nothing for ' + Math.round(this.stallMs / 1000) + ' s'));
        void this.reader.cancel().catch(() => undefined);
      }, this.stallMs);
    });
    const read = this.reader.read().catch((error: unknown) => {
      // A response cut off mid-stream is the transport's failure, as a stall is.
      throw error instanceof UploadPackError ? error
        : new UploadPackError('the response broke off: ' + (error instanceof Error ? error.message : String(error)));
    });
    return Promise.race([read, stalled]).finally(() => {
      if (timer !== null) clearTimeout(timer);
    });
  }

  private async fill(needed: number): Promise<boolean> {
    while (this.buffer.byteLength < needed) {
      if (this.done) return false;
      const { done, value } = await this.read();
      if (done) {
        this.done = true;
        return this.buffer.byteLength >= needed;
      }
      if (this.buffer.byteLength === 0) {
        this.buffer = value;
      } else {
        const merged = new Uint8Array(this.buffer.byteLength + value.byteLength);
        merged.set(this.buffer);
        merged.set(value, this.buffer.byteLength);
        this.buffer = merged;
      }
    }
    return true;
  }

  /** The next packet's payload, null for a flush, undefined at the stream's end. */
  async next(): Promise<Uint8Array | null | undefined> {
    if (!await this.fill(4)) {
      if (this.buffer.byteLength === 0) return undefined;
      throw new UploadPackError('stream ended inside a packet length');
    }
    const length = parseInt(decoder.decode(this.buffer.subarray(0, 4)), 16);
    if (!Number.isInteger(length) || (length > 0 && length < 4)) throw new UploadPackError('bad packet length');
    if (length === 0 || length === 1 || length === 2) {
      this.buffer = this.buffer.subarray(4);
      return null;
    }
    if (!await this.fill(length)) throw new UploadPackError('stream ended inside a packet');
    const payload = this.buffer.subarray(4, length);
    this.buffer = this.buffer.subarray(length);
    return payload;
  }

  cancel(): Promise<void> {
    return this.reader.cancel();
  }
}

export function text(payload: Uint8Array): string {
  const line = decoder.decode(payload);
  return line.endsWith('\n') ? line.slice(0, -1) : line;
}
