import type { TerminalInputStream } from '../commands/types.js';

/**
 * A bridge between terminal keyboard input and command stdin.
 * The Shell feeds lines in via feed(), commands consume via read()/readAll().
 */
export class TerminalStdin implements TerminalInputStream {
  private buffer: string[] = [];
  private closed = false;
  private resolvers: Array<(value: string | null) => void> = [];
  private _rawMode = false;

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
    if (this.closed) return;

    this.deliver(text, 'back');
  }

  /** Shell calls this on Ctrl+D to signal EOF. */
  close(): void {
    if (this.closed) return;
    this.closed = true;

    while (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift()!;
      resolve(null);
    }
  }

  /** Commands consume input. Returns null on EOF. */
  async read(): Promise<string | null> {
    if (this.buffer.length > 0) {
      return this.buffer.shift()!;
    }
    if (this.closed) {
      return null;
    }
    return new Promise<string | null>((resolve) => {
      this.resolvers.push(resolve);
    });
  }

  async readLine(): Promise<string | null> {
    let line = '';
    while (true) {
      const chunk = await this.read();
      if (chunk === null) return line.length > 0 ? line : null;

      const newline = chunk.indexOf('\n');
      if (newline >= 0) {
        const rest = chunk.slice(newline + 1);
        if (rest.length > 0) this.deliver(rest, 'front');
        return line + chunk.slice(0, newline);
      }

      line += chunk;
    }
  }

  async readBytes(maxLength: number): Promise<string | null> {
    if (maxLength <= 0) return '';

    const chunk = await this.read();
    if (chunk === null) return null;
    if (chunk.length <= maxLength) return chunk;

    this.deliver(chunk.slice(maxLength), 'front');
    return chunk.slice(0, maxLength);
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

  private deliver(text: string, position: 'front' | 'back'): void {
    if (text.length === 0) return;

    if (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift()!;
      resolve(text);
      return;
    }

    if (position === 'front') this.buffer.unshift(text);
    else this.buffer.push(text);
  }
}
