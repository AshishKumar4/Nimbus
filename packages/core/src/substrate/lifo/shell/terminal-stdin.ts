import { encode } from '../utils/encoding.js';
import type { TerminalInputStream } from '../commands/types.js';
import { ByteQueue } from './byte-queue.js';

/**
 * A bridge between terminal keyboard input and command stdin: a ByteQueue
 * the Shell feeds lines into (feed) and ends on Ctrl+D (close), with the
 * raw-mode switch a full-screen command flips.
 */
export class TerminalStdin extends ByteQueue implements TerminalInputStream {
  private _rawMode = false;

  /** When true, the shell should bypass line editing and feed raw keypresses. */
  get rawMode(): boolean {
    return this._rawMode;
  }

  set rawMode(value: boolean) {
    this._rawMode = value;
  }

  /** Shell calls this on Enter (with line + '\n'). */
  feed(text: string): void {
    if (this.ended || text === '') return;
    this.deliver(encode(text));
  }

  /**
   * Text snapshot of everything queued but not yet consumed. The shell's
   * wrap layer uses this for commands that want drained terminal input.
   */
  drainBuffered(): string {
    return this.drainText();
  }
}
