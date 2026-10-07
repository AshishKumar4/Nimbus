import type { ITerminal } from '../terminal/ITerminal.js';

/**
 * A terminal with no screen, for a shell nobody watches (programmatic and
 * agent sessions, tests): what the shell writes to it is dropped, by
 * contract (a command's output reaches its caller through Shell.execute's
 * capture, not the terminal), and sendData types into the shell.
 */
export class HeadlessTerminal implements ITerminal {
  private dataCallback: ((data: string) => void | Promise<void>) | null = null;

  write(_data: string): void {
    // Headless mode: discard visual output
  }

  writeln(_data: string): void {
    // Headless mode: discard visual output
  }

  onData(cb: (data: string) => void | Promise<void>): void {
    this.dataCallback = cb;
  }

  get cols(): number {
    return 80;
  }

  get rows(): number {
    return 24;
  }

  focus(): void {}

  clear(): void {}

  /** Send data as if typed on keyboard (used internally for stdin) */
  sendData(data: string): void | Promise<void> {
    return this.dataCallback?.(data);
  }
}
