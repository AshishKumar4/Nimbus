import type { CommandOutputStream, CommandInputStream } from '../commands/types.js';

export class PipeChannel {
  private buffer: string[] = [];
  private closed = false;
  private waiting: Array<(value: string | null) => void> = [];

  readonly writer: CommandOutputStream = {
    write: (text: string) => {
      if (this.closed) return;
      this.deliver(text, 'back');
    },
  };

  readonly reader: CommandInputStream = {
    read: () => this.read(),
    readAll: () => this.readAll(),
    readLine: () => this.readLine(),
    readBytes: (maxLength: number) => this.readBytes(maxLength),
  };

  private read(): Promise<string | null> {
    if (this.buffer.length > 0) {
      return Promise.resolve(this.buffer.shift() ?? null);
    }
    if (this.closed) {
      return Promise.resolve(null);
    }
    return new Promise<string | null>((resolve) => {
      this.waiting.push(resolve);
    });
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

  private async readBytes(maxLength: number): Promise<string | null> {
    if (maxLength <= 0) return '';

    const chunk = await this.read();
    if (chunk === null) return null;
    if (chunk.length <= maxLength) return chunk;

    this.deliver(chunk.slice(maxLength), 'front');
    return chunk.slice(0, maxLength);
  }

  close(): void {
    this.closed = true;
    while (this.waiting.length > 0) {
      const resolve = this.waiting.shift()!;
      resolve(null);
    }
  }

  private deliver(text: string, position: 'front' | 'back'): void {
    if (text.length === 0) return;

    if (this.waiting.length > 0) {
      const resolve = this.waiting.shift()!;
      resolve(text);
      return;
    }

    if (position === 'front') this.buffer.unshift(text);
    else this.buffer.push(text);
  }
}
