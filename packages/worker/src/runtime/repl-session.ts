/**
 * repl-session.ts — substrate for interactive REPL sessions.
 *
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
import type { Shell } from '@nimbus-sh/core/substrate/lifo/shell/Shell.js';
import { errorText } from '@nimbus-sh/core/_shared/error-text.js';
import { normalizeTerminalNewlines } from '@nimbus-sh/core/_shared/terminal.js';

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
  /** Abort and settle the active push, resetting its interpreter before resolving. */
  interrupt?(): void | Promise<void>;
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
type InterruptOutcome = { kind: 'interrupted' } | { kind: 'failed'; message: string };

export class ReplSession {
  private adapter: ReplAdapter;
  private detachRepl: (() => void) | null = null;
  private terminal: WebSocketTerminal;
  private shellRef: Pick<Shell, 'takeQueuedInput'> | null = null;

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
  private closedResolve: (() => void) | null = null;
  private closedPromise: Promise<void>;
  private pendingInterrupt: Promise<InterruptOutcome> | null = null;
  private activePush: Promise<ReplPushResult> | null = null;
  private ending: Promise<void> | null = null;

  /** Exit code captured from adapter's last 'exit' return. */
  private exitCode: number = 0;
  /**
   * REPL-A1b (master plan §1 + user-evidence 2026-05-11): handleInput
   * is invoked fire-and-forget per WS frame. Multiple WS frames arrive
   * in quick succession during real REPL use (and during probes that
   * send multiple lines without waiting for prompt). Without
   * serialization, two concurrent handleInput coroutines both hit `\r`
   * and call submitLine(); blockBuf accumulates wrong source; PyodideConsole
   * gets `print("hi")\\nexit()` as a single 'single'-mode compile →
   * "multiple statements found while compiling a single statement"
   * SyntaxError.
   *
   * Fix: chain handleInput invocations through inputQueue. Each WS
   * frame appends to queue; a single drain task processes the queue
   * sequentially. submitLine's await is properly ordered relative to
   * the next frame's chars.
   */
  private inputQueue: string = '';
  private draining: boolean = false;

  constructor(adapter: ReplAdapter, terminal: WebSocketTerminal, shell?: Pick<Shell, 'takeQueuedInput'>) {
    this.adapter = adapter;
    this.terminal = terminal;
    // REPL-R7-1: optional shell reference for pasteQueue drain.
    this.shellRef = shell ?? null;
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
    // REPL-A1b: per-frame data appended to inputQueue; single drain
    // task ensures serial processing across multiple WS frames.
    this.detachRepl = this.terminal.attachRepl((data: string) => {
      // Ctrl-C is the one input byte that must not queue behind a busy
      // push: it is the user's abort, and it only works if it runs now.
      if (this.busy && data.includes('\x03')) {
        this.inputQueue = '';
        data = data.slice(data.lastIndexOf('\x03') + 1);
        this.interruptBusy();
        if (data.length === 0) return;
      }
      if (this.ending) return;
      this.inputQueue += data;
      if (!this.draining) {
        this.draining = true;
        void this.drainInput();
      }
    }, () => this.endSession(this.exitCode));

    const queued = this.shellRef?.takeQueuedInput() ?? [];
    if (queued.length > 0) {
      this.inputQueue += queued.join('\r') + '\r';
      if (!this.draining) { this.draining = true; void this.drainInput(); }
    }

    // 4. Wait until close() is called.
    await this.closedPromise;
    return this.exitCode;
  }
  private async drainInput(): Promise<void> {
    try {
      while (this.inputQueue.length > 0 && !this.ending) {
        const chunk = this.inputQueue;
        this.inputQueue = '';
        await this.handleInput(chunk);
      }
    } catch (error) {
      if (!this.ending) {
        this.terminal.write('[repl] ' + errorText(error) + '\r\n');
        try { await this.endSession(1); } catch { /* run() reports the cleanup failure as exit 1. */ }
      }
    } finally {
      this.draining = false;
    }
  }

  /** Process an input chunk. May contain multiple characters (paste
   *  or rapid typing) — we iterate char-by-char to handle each
   *  control byte individually. */
  private async handleInput(data: string): Promise<void> {
    for (let i = 0; i < data.length; i++) {
      if (this.ending) return;
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
          this.interruptBusy();
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
  private interruptBusy(): void {
    if (this.ending || this.pendingInterrupt) return;
    this.terminal.write('^C\r\n');
    this.terminal.flushNow();
    if (!this.adapter.interrupt) return;
    try {
      this.pendingInterrupt = Promise.resolve(this.adapter.interrupt()).then(
        (): InterruptOutcome => ({ kind: 'interrupted' }),
        (error): InterruptOutcome => ({ kind: 'failed', message: errorText(error) }),
      );
    } catch (error) {
      this.pendingInterrupt = Promise.resolve({ kind: 'failed', message: errorText(error) });
    }
  }



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
      this.activePush = this.adapter.push(fullSource);
      result = await this.activePush;
    } catch (error) {
      result = { kind: 'error', stderr: '[repl] adapter threw: ' + errorText(error) + '\n' };
    } finally {
      this.activePush = null;
    }
    const pending = this.pendingInterrupt;
    if (pending) {
      const outcome = await pending;
      if (this.pendingInterrupt === pending) this.pendingInterrupt = null;
      if (outcome.kind === 'interrupted') {
        result = { kind: 'error', stderr: 'KeyboardInterrupt\n[repl] execution interrupted; interpreter state reset.\n' };
      } else {
        this.terminal.write('[repl] interrupt failed: ' + outcome.message + '\r\n');
        this.terminal.flushNow();
      }
    }
    this.busy = false;
    if (this.ending) return;

    // REPL-A1 (master plan §1): emit stdout, stderr, and the next-prompt
    // as three discrete WS frames in deterministic order. Without
    // flushNow() between them, the 5 ms coalescer in WebSocketTerminal
    // joins them into one `{type:'output'}` payload — probes asserting
    // frame ordering see false-failing, and xterm renders correctly only
    // because string-order is preserved. flushNow() guarantees both
    // are true: bytes-in-order AND frame-boundary-after-each-stream.
    if (result.kind === 'output') {
      if (result.stdout) {
        this.terminal.write(normalizeTerminalNewlines(result.stdout));
        this.terminal.flushNow();
      }
      if (result.stderr) {
        this.terminal.write(normalizeTerminalNewlines(result.stderr));
        this.terminal.flushNow();
      }
      this.blockBuf = [];
      this.terminal.write(this.adapter.ps1);
      this.terminal.flushNow();
      return;
    }
    if (result.kind === 'incomplete') {
      this.terminal.write(this.adapter.ps2);
      this.terminal.flushNow();
      return;
    }
    if (result.kind === 'error') {
      if (result.stderr) {
        this.terminal.write(normalizeTerminalNewlines(result.stderr));
        this.terminal.flushNow();
      }
      this.blockBuf = [];
      this.terminal.write(this.adapter.ps1);
      this.terminal.flushNow();
      return;
    }
    if (result.kind === 'exit') {
      if (result.stdout) {
        this.terminal.write(normalizeTerminalNewlines(result.stdout));
        this.terminal.flushNow();
      }
      if (result.stderr) {
        this.terminal.write(normalizeTerminalNewlines(result.stderr));
        this.terminal.flushNow();
      }
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
  private endSession(code: number): Promise<void> {
    if (this.ending) return this.ending;
    this.exitCode = code;
    this.inputQueue = '';
    this.ending = Promise.resolve().then(async () => {
      let failure: Error | null = null;
      try {
        await this.adapter.close();
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        this.exitCode = 1;
        this.terminal.write('[repl] cleanup failed: ' + failure.message + '\r\n');
        this.terminal.flushNow();
      }
      if (this.activePush) await this.activePush.catch(() => {});
      if (this.pendingInterrupt) await this.pendingInterrupt;
      this.detachRepl?.();
      this.detachRepl = null;
      this.closedResolve?.();
      this.closedResolve = null;
      if (failure) throw failure;
    });
    return this.ending;
  }
}
