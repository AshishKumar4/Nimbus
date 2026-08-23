import { encode } from '../utils/encoding.js';
import type { TerminalInputStream } from '../commands/types.js';

/**
 * A bridge between terminal keyboard input and command stdin. The Shell
 * feeds lines in via feed(); commands consume bytes or text. Bytes are the
 * storage format, so a byte read always makes progress even when maxLength
 * splits a multi-byte code point — `dd bs=1` over `é` yields c3, then a9.
 */
export class TerminalStdin implements TerminalInputStream {
  private buffer: Uint8Array[] = [];
  private closed = false;
  private resolvers: Array<(value: Uint8Array | null) => void> = [];
  private _rawMode = false;
  private decoder = new TextDecoder('utf-8');

  /** True when a command has called read() and is waiting for input. */
  get isWaiting(): boolean {
    return this.resolvers.length > 0;
  }

  /** When true, the shell should bypass line editing and feed raw keypresses. */
  get rawMode(): boolean {
    return this._rawMode;
  }

  set rawMode(value: boolean) {
    this._rawMode = value;
  }

  /** Shell calls this on Enter (with line + '\n'). */
  feed(text: string): void {
    if (this.closed || text === '') return;
    this.deliver(encode(text), 'back');
  }

  /** Shell calls this on Ctrl+D to signal EOF. */
  close(): void {
    this.closed = true;
    while (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift()!;
      resolve(null);
    }
  }

  /** Commands consume input. Returns null on EOF. */
  async read(): Promise<string | null> {
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

  async readLine(): Promise<string | null> {
    let line = '';
    while (true) {
      const chunk = await this.read();
      if (chunk === null) return line.length > 0 ? line : null;

      const newline = chunk.indexOf('\n');
      if (newline >= 0) {
        const rest = chunk.slice(newline + 1);
        if (rest.length > 0) this.deliverBackText(rest);
        return line + chunk.slice(0, newline);
      }

      line += chunk;
    }
  }

  /**
   * Bounded byte read; always makes progress while data remains, splitting
   * encoded code points across successive calls when maxLength demands it.
   */
  async readBytes(maxLength: number): Promise<Uint8Array | null> {
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

  /** Read all remaining input until EOF, joined together. */
  async readAll(): Promise<string> {
    const parts: string[] = [];
    while (true) {
      const chunk = await this.read();
      if (chunk === null) break;
      parts.push(chunk);
    }
    return parts.join('');
  }

  /**
   * Text snapshot of everything queued but not yet consumed. The shell's
   * wrap layer uses this for commands that want drained terminal input.
   */
  drainBuffered(): string {
    let text = '';
    while (this.buffer.length > 0) {
      text += this.decoder.decode(this.buffer.shift()!, { stream: true });
    }
    text += this.decoder.decode();
    return text;
  }

  private pull(): Promise<Uint8Array | null> {
    if (this.buffer.length > 0) {
      return Promise.resolve(this.buffer.shift() ?? null);
    }
    if (this.closed) {
      return Promise.resolve(null);
    }
    return new Promise<Uint8Array | null>((resolve) => {
      this.resolvers.push(resolve);
    });
  }

  private deliver(bytes: Uint8Array, position: 'front' | 'back'): void {
    if (bytes.length === 0) return;

    if (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift()!;
      resolve(bytes);
      return;
    }

    if (position === 'front') this.buffer.unshift(bytes);
    else this.buffer.push(bytes);
  }

  private deliverBackText(text: string): void {
    this.deliver(encode(text), 'front');
  }
}
