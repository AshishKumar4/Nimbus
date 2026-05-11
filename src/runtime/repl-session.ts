/**
 * repl-session.ts — substrate for interactive REPL sessions.
 *
 * Per /workspace/.seal-internal/2026-05-11-repl-plan/plan.md §§2-4:
 *   Layer 1: long-lived runtime via repeated execute() into a cached
 *            child-facet isolate (state persists on globalThis).
 *   Layer 2: stdin routing via WebSocketTerminal.attachRepl().
 *   Layer 3: prompt detection per-runtime — Pyodide uses sentinel-
 *            controlled sys.ps1; Bun/Node/Ruby use per-runtime regex.
 *
 * This file owns the runtime-agnostic plumbing. Per-runtime adapters
 * live in src/runtime/<name>-repl.ts and implement the ReplAdapter
 * interface declared below.
 */

import type { WebSocketTerminal } from '../facets/ws-terminal.js';

/**
 * Per-runtime adapter contract. The shell-side ReplSession orchestrates
 * input handling; the adapter wraps the actual runtime invocation.
 */
export interface ReplAdapter {
  /** Called once when the session starts. Returns the banner to print
   *  before the first prompt. */
  banner(): string;
  /** Send a complete line of user input. Returns:
   *    - kind === 'output': normal eval result; resume reading at prompt.
   *    - kind === 'incomplete': need more input (multi-line block).
   *    - kind === 'exit': REPL should close with the given exit code.
   *    - kind === 'error': error message to display; resume at prompt.
   */
  push(line: string): Promise<ReplPushResult>;
  /** Called once on session close (exit() / Ctrl-D / shell teardown).
   *  Should free any cached pool / isolate. Idempotent. */
  close(): Promise<void>;
  /** Primary prompt (typically '>>> '). */
  ps1: string;
  /** Continuation prompt (typically '... '). */
  ps2: string;
}

export type ReplPushResult =
  | { kind: 'output'; stdout: string; stderr: string }
  | { kind: 'incomplete' }
  | { kind: 'exit'; exitCode: number; stdout?: string; stderr?: string }
  | { kind: 'error'; stderr: string };

/**
 * Manages an interactive REPL session: stdin buffering with minimal
 * readline UX (line-mode), output routing to the WS terminal, prompt
 * rendering, and adapter dispatch.
 *
 * The shell creates a ReplSession when a runtime's `startRepl` hook
 * fires; the session installs a `replCallback` on the WebSocketTerminal
 * (via attachRepl()) and runs until the adapter signals 'exit' or the
 * user presses Ctrl-D on an empty line.
 *
 * No setTimeout in the read loop — the session is driven entirely by
 * keystroke arrival on the WS, with awaits gating the adapter's push().
 */
export class ReplSession {
  private adapter: ReplAdapter;
  private terminal: WebSocketTerminal;
  private detachReplCb: (() => void) | null = null;

  /** Current line buffer (chars typed since the last enter). */
  private lineBuf: string = '';
  /** Cursor position within lineBuf (0 = beginning). */
  private cursorPos: number = 0;
  /** Accumulated lines for a multi-line block (e.g. inside def/class). */
  private blockBuf: string[] = [];
  /** True while the adapter is processing a push (block subsequent submits). */
  private busy: boolean = false;
  /** Per-session history ring (most recent first). Capped at 100. */
  private history: string[] = [];
  private historyIdx: number = -1;
  /** Resolves when close() has been called and the session ended. */
  private closedResolve: (() => void) | null = null;
  private closedPromise: Promise<void>;
  /** Exit code captured from adapter's last 'exit' return. */
  private exitCode: number = 0;

  constructor(adapter: ReplAdapter, terminal: WebSocketTerminal) {
    this.adapter = adapter;
    this.terminal = terminal;
    this.closedPromise = new Promise<void>((resolve) => {
      this.closedResolve = resolve;
    });
  }

  /** Run the session: prints banner, installs the input hook, returns
   *  a promise that resolves with the exit code when the session ends. */
  async run(): Promise<number> {
    // 1. Print banner from adapter.
    const banner = this.adapter.banner();
    if (banner) this.terminal.write(banner);
    if (banner && !banner.endsWith('\n')) this.terminal.write('\r\n');

    // 2. Print primary prompt.
    this.terminal.write(this.adapter.ps1);

    // 3. Install the input handler.
    this.detachReplCb = this.terminal.attachRepl((data: string) => {
      // Fire-and-forget; the input handler IS async-ish via this.busy gate.
      void this.handleInput(data);
    });

    // 4. Wait until close() is called.
    await this.closedPromise;
    return this.exitCode;
  }

  /** Process an input chunk. May contain multiple characters (paste
   *  or rapid typing) — we iterate char-by-char to handle each
   *  control byte individually. */
  private async handleInput(data: string): Promise<void> {
    for (let i = 0; i < data.length; i++) {
      const ch = data[i];
      // CTRL-D (0x04): on empty line, close cleanly.
      if (ch === '\x04') {
        if (this.lineBuf.length === 0 && this.blockBuf.length === 0 && !this.busy) {
          this.terminal.write('\r\n');
          await this.endSession(0);
          return;
        }
        // Non-empty line: ignore (matches CPython REPL behavior).
        continue;
      }
      // CTRL-C (0x03): cancel current line / block.
      if (ch === '\x03') {
        if (this.busy) {
          // Mid-execution: we can't actually interrupt the wasm runtime
          // in v1 (no SIGINT plumbing). Buffer the cancel for after.
          // For now: just display ^C and let the runtime finish.
          this.terminal.write('^C\r\n');
          continue;
        }
        // Idle: discard current buffer, reset, fresh prompt.
        this.lineBuf = '';
        this.cursorPos = 0;
        this.blockBuf = [];
        this.terminal.write('\r\nKeyboardInterrupt\r\n' + this.adapter.ps1);
        continue;
      }
      // Enter (\r or \n): submit the line.
      if (ch === '\r' || ch === '\n') {
        await this.submitLine();
        continue;
      }
      // Backspace (0x7f) or DEL (\b 0x08): delete char before cursor.
      if (ch === '\x7f' || ch === '\b') {
        if (this.cursorPos > 0) {
          this.lineBuf =
            this.lineBuf.slice(0, this.cursorPos - 1) +
            this.lineBuf.slice(this.cursorPos);
          this.cursorPos--;
          // Repaint: move cursor back, write rest, clear trailing, restore.
          this.terminal.write('\b' + this.lineBuf.slice(this.cursorPos) + ' \b');
          // Cursor sits one past the rewritten chars; pull it back to position.
          const tail = this.lineBuf.slice(this.cursorPos).length;
          for (let k = 0; k < tail; k++) this.terminal.write('\b');
        }
        continue;
      }
      // ANSI escape sequence (arrow keys, etc.). Buffer the full sequence
      // by reading ahead. v1: only handle up/down arrows for history;
      // left/right are deferred (minimal readline = no in-line editing).
      if (ch === '\x1b' && i + 2 < data.length && data[i + 1] === '[') {
        const code = data[i + 2];
        if (code === 'A') { this.historyUp(); i += 2; continue; }
        if (code === 'B') { this.historyDown(); i += 2; continue; }
        // C/D (left/right) and others: ignore.
        i += 2;
        continue;
      }
      // Printable char: append + echo.
      if (ch >= ' ' && ch !== '\x7f') {
        if (this.cursorPos === this.lineBuf.length) {
          this.lineBuf += ch;
          this.cursorPos++;
          this.terminal.write(ch);
        } else {
          // Mid-line insert (rare without left-arrow editing in v1).
          this.lineBuf =
            this.lineBuf.slice(0, this.cursorPos) + ch + this.lineBuf.slice(this.cursorPos);
          this.cursorPos++;
          this.terminal.write(ch);
        }
      }
    }
  }

  /** Submit the current line buffer to the adapter. */
  private async submitLine(): Promise<void> {
    this.terminal.write('\r\n');
    const line = this.lineBuf;
    this.lineBuf = '';
    this.cursorPos = 0;
    // Record in history (skip blank and duplicate-of-most-recent).
    if (line.length > 0 && this.history[0] !== line) {
      this.history.unshift(line);
      if (this.history.length > 100) this.history.length = 100;
    }
    this.historyIdx = -1;

    // Accumulate block lines.
    this.blockBuf.push(line);
    const fullSource = this.blockBuf.join('\n');

    this.busy = true;
    let result: ReplPushResult;
    try {
      result = await this.adapter.push(fullSource);
    } catch (e: any) {
      result = {
        kind: 'error',
        stderr: `[repl] adapter threw: ${e?.message || e}\n`,
      };
    }
    this.busy = false;

    if (result.kind === 'output') {
      if (result.stdout) this.terminal.write(this.normalizeNewlines(result.stdout));
      if (result.stderr) this.terminal.write(this.normalizeNewlines(result.stderr));
      this.blockBuf = [];
      this.terminal.write(this.adapter.ps1);
      return;
    }
    if (result.kind === 'incomplete') {
      this.terminal.write(this.adapter.ps2);
      return;
    }
    if (result.kind === 'error') {
      if (result.stderr) this.terminal.write(this.normalizeNewlines(result.stderr));
      this.blockBuf = [];
      this.terminal.write(this.adapter.ps1);
      return;
    }
    if (result.kind === 'exit') {
      if (result.stdout) this.terminal.write(this.normalizeNewlines(result.stdout));
      if (result.stderr) this.terminal.write(this.normalizeNewlines(result.stderr));
      await this.endSession(result.exitCode);
      return;
    }
  }

  /** Map up-arrow → previous history entry. */
  private historyUp(): void {
    if (this.history.length === 0) return;
    if (this.historyIdx < this.history.length - 1) this.historyIdx++;
    this.replaceCurrentLine(this.history[this.historyIdx]);
  }

  /** Map down-arrow → next (newer) history entry. */
  private historyDown(): void {
    if (this.historyIdx <= 0) {
      this.historyIdx = -1;
      this.replaceCurrentLine('');
      return;
    }
    this.historyIdx--;
    this.replaceCurrentLine(this.history[this.historyIdx]);
  }

  /** Erase the current displayed line and replace with `text`. */
  private replaceCurrentLine(text: string): void {
    // Erase current chars: backspace + space + backspace per char.
    const oldLen = this.lineBuf.length;
    for (let i = 0; i < this.cursorPos; i++) this.terminal.write('\b');
    for (let i = 0; i < oldLen; i++) this.terminal.write(' ');
    for (let i = 0; i < oldLen; i++) this.terminal.write('\b');
    this.lineBuf = text;
    this.cursorPos = text.length;
    this.terminal.write(text);
  }

  /** Normalize LF → CRLF for terminal display. The WS terminal does not
   *  do this automatically; raw \n leaves the cursor at column-0 of a
   *  new row WITHOUT carriage return (xterm convention). */
  private normalizeNewlines(s: string): string {
    return s.replace(/\r?\n/g, '\r\n');
  }

  /** Close the session: detach input hook, free adapter, resolve. */
  private async endSession(code: number): Promise<void> {
    this.exitCode = code;
    if (this.detachReplCb) {
      try { this.detachReplCb(); } catch { /* fail-soft */ }
      this.detachReplCb = null;
    }
    try { await this.adapter.close(); } catch { /* fail-soft */ }
    if (this.closedResolve) {
      this.closedResolve();
      this.closedResolve = null;
    }
  }
}
