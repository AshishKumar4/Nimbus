import { lex } from '../substrate/lifo/shell/lexer.js';
import { TokenKind } from '../substrate/lifo/shell/types.js';

interface ShellLike {
  executeLine(line: string): Promise<void>;
  printPrompt(): void;
  handleInput(data: string): void;
  drainPasteQueue(): void;
  redrawLine(): void;
  running: boolean;
  history: string[];
  lineBuffer: string;
  cursorPos: number;
  screenCursorRow: number;
  historyIndex: number;
  pasteQueue: string[];
}

interface TerminalLike {
  write(data: string): void;
}

export interface HeredocInfo {
  command: string;
  delimiters: Array<{
    delimiter: string;
    stripTabs: boolean;
  }>;
}

export function parseHeredoc(input: string): HeredocInfo | null {
  const tokens = lex(input);
  const delimiters: HeredocInfo['delimiters'] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === TokenKind.Heredoc || token.kind === TokenKind.HeredocStripTabs) {
      const delimiter = tokens[i + 1];
      if (!delimiter || delimiter.kind !== TokenKind.Word || !delimiter.value) {
        return null;
      }
      delimiters.push({
        delimiter: delimiter.value,
        stripTabs: token.kind === TokenKind.HeredocStripTabs,
      });
    }
  }

  return delimiters.length > 0 ? { command: input, delimiters } : null;
}

export class HeredocHandler {
  private shell: ShellLike;
  private terminal: TerminalLike;
  private originalExecuteLine: ((line: string) => Promise<void>) | null = null;
  private originalPrintPrompt: (() => void) | null = null;
  private originalHandleInput: ((data: string) => void) | null = null;

  // ── Accumulation state ──
  private active = false;
  private heredocInfo: HeredocInfo | null = null;
  private currentHeredocIndex = 0;
  private bodies: string[][] = [];
  private historyLengthAtStart = 0;

  /** Safety limit to prevent unbounded memory growth */
  private static readonly MAX_HEREDOC_LINES = 50000;

  constructor(shell: ShellLike, terminal: TerminalLike) {
    this.shell = shell;
    this.terminal = terminal;
  }

  /**
   * Install the heredoc handler on a Shell instance.
   * Call once after the Shell is created.
   */
  static install(shell: ShellLike, terminal: TerminalLike): HeredocHandler {
    const handler = new HeredocHandler(shell, terminal);
    handler._patch();
    return handler;
  }

  /** Cancel heredoc accumulation and return to normal shell prompt. */
  private _cancel(): void {
    this.active = false;
    this.heredocInfo = null;
    this.currentHeredocIndex = 0;
    this.bodies = [];
    // Restore history to before the heredoc started (removes content lines)
    if (this.shell.history) {
      this.shell.history.length = this.historyLengthAtStart;
    }
  }

  private _patch(): void {
    // Save originals (bound to shell)
    this.originalExecuteLine = this.shell.executeLine.bind(this.shell);
    this.originalPrintPrompt = this.shell.printPrompt.bind(this.shell);
    this.originalHandleInput = this.shell.handleInput.bind(this.shell);

    this.shell.handleInput = (data: string): void => {
      if (this.active && data === '\x03') {
        this._cancel();
        this.terminal.write('^C\r\n');
        this._printPrompt();
        return;
      }

      if (this.active && !this.shell.running && data.length > 1 && /[\r\n]/.test(data)) {
        const parts = data.split(/\r\n|\r|\n/);
        if (parts[0]) {
          this.shell.lineBuffer = this.shell.lineBuffer.slice(0, this.shell.cursorPos)
            + parts[0] + this.shell.lineBuffer.slice(this.shell.cursorPos);
          this.shell.cursorPos += parts[0].length;
        }
        if (parts.length > 1) {
          this.shell.redrawLine();
          this.terminal.write('\r\n');
          const currentLine = this.shell.lineBuffer;
          this.shell.lineBuffer = '';
          this.shell.cursorPos = 0;
          this.shell.screenCursorRow = 0;
          this.shell.historyIndex = -1;
          for (let i = 1; i < parts.length; i++) {
            if (i === parts.length - 1 && parts[i] === '') continue;
            this.shell.pasteQueue.push(parts[i]);
          }
          if (currentLine.trim()) {
            this.shell.history.push(currentLine.trim());
          }
          const isDelim = this._processLine(currentLine);
          if (isDelim && this.heredocInfo !== null) {
            this._finishHeredoc();
          } else if (!isDelim) {
            this.terminal.write('> ');
            this._drainPasteQueue();
          }
        }
        return;
      }

      if (this.active && !this.shell.running && data === '\r') {
        this.terminal.write('\r\n');
        const currentLine = this.shell.lineBuffer;
        this.shell.lineBuffer = '';
        this.shell.cursorPos = 0;
        this.shell.screenCursorRow = 0;
        this.shell.historyIndex = -1;
        if (currentLine.trim()) {
          this.shell.history.push(currentLine.trim());
        }
        const isDelim = this._processLine(currentLine);
        if (isDelim && this.heredocInfo !== null) {
          this._finishHeredoc();
        } else if (!isDelim) {
          this.terminal.write('> ');
        }
        return;
      }

      this._handleOriginalInput(data);
    };

    this.shell.executeLine = async (line: string): Promise<void> => {
      if (this.active) {
        const current = this._currentDelimiter();
        const rawLine = (current?.stripTabs && this.shell.lineBuffer)
          ? this.shell.lineBuffer
          : line;
        await this._accumulateLine(rawLine);
        return;
      }

      const info = parseHeredoc(line);
      if (info) {
        await this._startAccumulation(info);
        return;
      }

      return this._executeOriginalLine(line);
    };

    this.shell.printPrompt = (): void => {
      if (this.active) {
        this._accumulateLine('');
        return;
      }
      this._printPrompt();
    };
  }

  private _printPrompt(): void {
    const printPrompt = this.originalPrintPrompt;
    if (printPrompt) printPrompt();
  }

  private _handleOriginalInput(data: string): void {
    const handleInput = this.originalHandleInput;
    if (handleInput) handleInput(data);
  }

  private async _executeOriginalLine(line: string): Promise<void> {
    const executeLine = this.originalExecuteLine;
    if (!executeLine) {
      throw new Error('heredoc handler is not installed');
    }
    await executeLine(line);
  }

  private async _startAccumulation(info: HeredocInfo): Promise<void> {
    this.active = true;
    this.heredocInfo = info;
    this.currentHeredocIndex = 0;
    this.bodies = info.delimiters.map(() => []);
    this.historyLengthAtStart = this.shell.history?.length ?? 0;
    this.terminal.write('> ');
    await this._drainPasteQueue();
  }

  /**
   * Process a single heredoc content line (non-recursive).
   * Returns true if this was the delimiter (heredoc is complete).
   */
  private _processLine(line: string): boolean {
    const delimiter = this._currentDelimiter();
    if (!delimiter) return true;

    const cleaned = line.replace(/[\r\n]+$/, '');

    const checkLine = delimiter.stripTabs ? stripLeadingTabs(cleaned) : cleaned;
    if (checkLine === delimiter.delimiter) {
      this.currentHeredocIndex++;
      return this.currentHeredocIndex >= this.bodies.length;
    }

    const lines = this.bodies[this.currentHeredocIndex];
    if (!lines || lines.length >= HeredocHandler.MAX_HEREDOC_LINES) {
      this.terminal.write(`\x1b[31mheredoc: exceeded ${HeredocHandler.MAX_HEREDOC_LINES} line limit\x1b[0m\r\n`);
      this._cancel();
      this._printPrompt();
      return true; // stop accumulation
    }

    const processedLine = delimiter.stripTabs ? stripLeadingTabs(cleaned) : cleaned;
    lines.push(processedLine);
    return false;
  }

  /**
   * Called when executeLine fires during accumulation (user typed a line + Enter).
   * Also called during paste processing.
   */
  private async _accumulateLine(line: string): Promise<void> {
    if (this._processLine(line)) {
      if (this.heredocInfo === null) return; // limit exceeded, already cancelled
      await this._finishHeredoc();
      return;
    }
    this.terminal.write('> ');
  }

  /**
   * Drain the Shell's pasteQueue during heredoc accumulation.
   * When a multi-line heredoc is pasted, all lines land in the paste queue.
   * Uses an iterative loop (not recursive) to avoid stack overflow.
   */
  private async _drainPasteQueue(): Promise<void> {
    const queue: string[] | undefined = this.shell.pasteQueue;
    if (!queue || queue.length === 0) return;

    while (this.active && queue.length > 0) {
      const nextLine = queue.shift();
      if (nextLine === undefined) break;
      this.terminal.write(nextLine + '\r\n');

      if (this._processLine(nextLine)) {
        if (this.heredocInfo === null) return; // limit exceeded
        await this._finishHeredoc();
        return;
      }
      this.terminal.write('> ');
    }
  }

  private async _finishHeredoc(): Promise<void> {
    const info = this.heredocInfo;
    if (!info) return;
    const script = [
      info.command,
      ...info.delimiters.flatMap((delimiter, index) => {
        const lines = this.bodies[index] ?? [];
        return lines.length > 0 ? [lines.join('\n'), delimiter.delimiter] : [delimiter.delimiter];
      }),
      '',
    ].join('\n');

    this.active = false;
    this.heredocInfo = null;
    this.currentHeredocIndex = 0;
    this.bodies = [];

    if (this.shell.history) {
      this.shell.history.length = this.historyLengthAtStart;
    }

    try {
      await this._executeOriginalLine(script);
    } catch (error) {
      this.terminal.write(`\x1b[31mheredoc error: ${errorMessage(error)}\x1b[0m\r\n`);
      this._printPrompt();
      this.shell.drainPasteQueue();
    }
  }

  private _currentDelimiter(): HeredocInfo['delimiters'][number] | null {
    return this.heredocInfo?.delimiters[this.currentHeredocIndex] ?? null;
  }
}

function stripLeadingTabs(input: string): string {
  let i = 0;
  while (input[i] === '\t') i++;
  return input.slice(i);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── Line-editor extension (readline parity) ─────────────────────────────

/**
 * LineEditorExtender — adds bash-readline-parity keybindings to the
 * Nimbus shell line editor.
 *
 * The vanilla Shell handles only a minimal set: ←/→/↑/↓, Home, End,
 * Ctrl+A, Ctrl+E, Ctrl+C, Ctrl+D (EOF), Ctrl+U (whole-line wipe), Tab,
 * Enter, Backspace, Delete. Every other readline binding (Ctrl+W,
 * Ctrl+K, Ctrl+Y, Alt+B, Alt+F, Alt+D, Ctrl+←, Alt+. , Ctrl+R, etc.)
 * gets dropped on the floor.
 *
 * This handler wraps `shell.handleInput` to recognise the missing
 * sequences and apply their readline-spec semantics directly to
 * `shell.lineBuffer` / `shell.cursorPos` / `shell.history`, then
 * triggers `shell.redrawLine()` to re-render.
 *
 * Install AFTER HeredocHandler so the heredoc wrapper sees input
 * first (its mode is exclusive); when heredoc isn't active our
 * handler runs.
 *
 * Word boundary conventions (matches bash 5.x readline):
 *   - Ctrl+W (unix-word-rubout): whitespace boundary — bash override
 *   - Alt+Backspace (backward-kill-word): readline word `[A-Za-z0-9_]+`
 *   - Alt+B / Alt+F (backward/forward-word): readline word
 *   - Ctrl+← / Ctrl+→ (alias for word nav): readline word
 *   - Alt+D (kill-word): readline word
 *
 * Kill-ring: simple single-slot (the most-recent cut). Ctrl+Y yanks it.
 *
 * Ctrl+R sub-mode: enters reverse-i-search; capturing chars narrows
 * the match against history; Enter runs the matched line; Esc/Ctrl+G
 * aborts; another Ctrl+R steps to the next-older match.
 */
export class LineEditorExtender {
  private shell: ShellLike;
  private terminal: TerminalLike;
  private originalHandleInput: ((data: string) => void) | null = null;

  /** Single-slot kill-ring. Set by Ctrl+W / Ctrl+K / Ctrl+U / Alt+Backspace / Alt+D. */
  private killRing: string = '';

  /** Yank-last-arg state — index into `history` (from the end), most
   *  recent = 0. Reset when the user types anything other than Alt+. */
  private yankLastArgIndex: number = -1;
  /** Length of the inserted last-arg blob from the previous Alt+. press
   *  so a follow-up Alt+. can remove it and insert the older one. */
  private yankLastArgInsertedLen: number = 0;

  /** Reverse-i-search sub-mode state. */
  private rsearchActive = false;
  private rsearchQuery = '';
  /** History index (from end) of the currently-displayed match;
   *  -1 = no match, otherwise points at `history[history.length-1-idx]`. */
  private rsearchMatchIndex = -1;

  /** Match readline's word definition: ASCII alphanumerics + underscore. */
  private static isWordChar(ch: string): boolean {
    if (!ch) return false;
    const c = ch.charCodeAt(0);
    return (
      (c >= 0x30 && c <= 0x39) || // 0-9
      (c >= 0x41 && c <= 0x5a) || // A-Z
      (c >= 0x61 && c <= 0x7a) || // a-z
      c === 0x5f                  // _
    );
  }

  constructor(shell: ShellLike, terminal: TerminalLike) {
    this.shell = shell;
    this.terminal = terminal;
  }

  static install(shell: ShellLike, terminal: TerminalLike): LineEditorExtender {
    const handler = new LineEditorExtender(shell, terminal);
    handler._patch();
    return handler;
  }

  private _patch(): void {
    this.originalHandleInput = this.shell.handleInput.bind(this.shell);

    this.shell.handleInput = (data: string): void => {
      // Skip when a process is running — the line editor only governs
      // shell-prompt input. Process-stdin input has its own model
      // (terminalStdin / stdinLineBuffer) handled by the shell.
      if (this.shell.running) {
        this.originalHandleInput!(data);
        return;
      }

      // Reverse-i-search sub-mode owns ALL input until exited.
      if (this.rsearchActive) {
        this._rsearchHandle(data);
        return;
      }

      // Yank-last-arg state is reset on any non-Alt+. input.
      if (data !== '\x1b.') {
        this.yankLastArgIndex = -1;
        this.yankLastArgInsertedLen = 0;
      }

      // Try each binding. First-match wins; on no match fall through.
      if (this._handleBinding(data)) return;

      this.originalHandleInput!(data);
    };
  }

  /**
   * Returns true if the input was a recognised readline binding and we
   * handled it; false to fall through to the original handler.
   */
  private _handleBinding(data: string): boolean {
    const s = this.shell;

    switch (data) {
      // ── char-by-char navigation (readline Ctrl aliases) ──
      case '\x02': // Ctrl+B → left
        if (s.cursorPos > 0) { s.cursorPos--; s.redrawLine(); }
        return true;
      case '\x06': // Ctrl+F → right
        if (s.cursorPos < s.lineBuffer.length) { s.cursorPos++; s.redrawLine(); }
        return true;

      // ── Home/End (Linux variants the upstream Shell misses) ──
      case '\x1b[1~': // Home (vt220 / Linux)
      case '\x1b[7~': // Home (rxvt)
        s.cursorPos = 0;
        s.redrawLine();
        return true;
      case '\x1b[4~': // End (vt220 / Linux)
      case '\x1b[8~': // End (rxvt)
        s.cursorPos = s.lineBuffer.length;
        s.redrawLine();
        return true;

      // ── word-by-word navigation ──
      case '\x1b[1;5D': // Ctrl+←  (xterm modifier-5)
      case '\x1b[1;3D': // Alt+←   (xterm modifier-3, Mac Option+←)
      case '\x1bb':     // Alt+B / Esc-b
      case '\x1bB':
        s.cursorPos = this._prevWordStart(s.lineBuffer, s.cursorPos);
        s.redrawLine();
        return true;
      case '\x1b[1;5C': // Ctrl+→
      case '\x1b[1;3C': // Alt+→
      case '\x1bf':     // Alt+F / Esc-f
      case '\x1bF':
        s.cursorPos = this._nextWordEnd(s.lineBuffer, s.cursorPos);
        s.redrawLine();
        return true;

      // ── history aliases ──
      case '\x10': // Ctrl+P → ↑
        // Delegate to the existing handler for ↑ which already manages
        // historyIndex/savedLine bookkeeping.
        return this.originalHandleInput!('\x1b[A'), true;
      case '\x0e': // Ctrl+N → ↓
        return this.originalHandleInput!('\x1b[B'), true;

      // ── kill-to-end (Ctrl+K) ──
      case '\x0b':
        if (s.cursorPos < s.lineBuffer.length) {
          this.killRing = s.lineBuffer.slice(s.cursorPos);
          s.lineBuffer = s.lineBuffer.slice(0, s.cursorPos);
          s.redrawLine();
        }
        return true;

      // ── kill-to-start (Ctrl+U) — override the upstream whole-line wipe ──
      case '\x15':
        if (s.cursorPos > 0) {
          this.killRing = s.lineBuffer.slice(0, s.cursorPos);
          s.lineBuffer = s.lineBuffer.slice(s.cursorPos);
          s.cursorPos = 0;
          s.redrawLine();
        }
        // cursorPos === 0 + non-empty line: bash's Ctrl+U here also kills
        // the whole line (cursor was already at start, "to start" = 0).
        // Falling through to the upstream whole-line wipe is wrong for
        // mid-line case but correct for the start case. Since we
        // returned true above only when something was cut, the
        // start-of-empty case falls through to upstream which is fine
        // (whole line is already empty). For non-empty-at-start, we
        // also return true to avoid double-redraw.
        return true;

      // ── kill-word-back (Ctrl+W) — bash uses WHITESPACE boundary ──
      case '\x17': {
        if (s.cursorPos === 0) return true;
        const buf = s.lineBuffer as string;
        let i = s.cursorPos;
        // Skip trailing whitespace BEFORE the cursor.
        while (i > 0 && /\s/.test(buf[i - 1])) i--;
        // Then skip non-whitespace (the "word").
        while (i > 0 && !/\s/.test(buf[i - 1])) i--;
        this.killRing = buf.slice(i, s.cursorPos);
        s.lineBuffer = buf.slice(0, i) + buf.slice(s.cursorPos);
        s.cursorPos = i;
        s.redrawLine();
        return true;
      }

      // ── kill-word-back (Alt+Backspace) — readline word boundary ──
      case '\x1b\x7f':
      case '\x1b\x08': {
        if (s.cursorPos === 0) return true;
        const buf = s.lineBuffer as string;
        const newPos = this._prevWordStart(buf, s.cursorPos);
        this.killRing = buf.slice(newPos, s.cursorPos);
        s.lineBuffer = buf.slice(0, newPos) + buf.slice(s.cursorPos);
        s.cursorPos = newPos;
        s.redrawLine();
        return true;
      }

      // ── kill-word-forward (Alt+D) — readline word boundary ──
      case '\x1bd':
      case '\x1bD': {
        const buf = s.lineBuffer as string;
        if (s.cursorPos >= buf.length) return true;
        const newPos = this._nextWordEnd(buf, s.cursorPos);
        this.killRing = buf.slice(s.cursorPos, newPos);
        s.lineBuffer = buf.slice(0, s.cursorPos) + buf.slice(newPos);
        // cursor stays at s.cursorPos (chars removed AFTER cursor)
        s.redrawLine();
        return true;
      }

      // ── yank (Ctrl+Y) ──
      case '\x19': {
        if (!this.killRing) return true;
        const buf = s.lineBuffer as string;
        s.lineBuffer = buf.slice(0, s.cursorPos) + this.killRing + buf.slice(s.cursorPos);
        s.cursorPos += this.killRing.length;
        s.redrawLine();
        return true;
      }

      // ── transpose (Ctrl+T) ──
      case '\x14': {
        const buf = s.lineBuffer as string;
        if (buf.length < 2) return true;
        let pos = s.cursorPos;
        // bash behaviour: at end of line, swap last two chars without
        // advancing the cursor. Mid-line: swap char-before with
        // char-at, advance cursor by one.
        if (pos >= buf.length) {
          const a = buf[buf.length - 2];
          const b = buf[buf.length - 1];
          s.lineBuffer = buf.slice(0, -2) + b + a;
        } else if (pos === 0) {
          // bash: bell, no-op.
          return true;
        } else {
          const before = buf[pos - 1];
          const at = buf[pos];
          s.lineBuffer = buf.slice(0, pos - 1) + at + before + buf.slice(pos + 1);
          s.cursorPos = pos + 1;
        }
        s.redrawLine();
        return true;
      }

      // ── Ctrl+L: clear screen, redraw current line ──
      case '\x0c':
        // \x1b[H = cursor to top-left, \x1b[2J = erase screen
        this.terminal.write('\x1b[H\x1b[2J');
        // Reset the screen-row tracker so redrawLine doesn't try to
        // ANSI-up past the (now-cleared) top of screen.
        s.screenCursorRow = 0;
        s.redrawLine();
        return true;

      // ── Ctrl+D mid-line: delete char at cursor (bash readline) ──
      case '\x04': {
        const buf = s.lineBuffer as string;
        // If line is non-empty AND cursor not at end, delete char at cursor.
        if (s.cursorPos < buf.length) {
          s.lineBuffer = buf.slice(0, s.cursorPos) + buf.slice(s.cursorPos + 1);
          s.redrawLine();
          return true;
        }
        // Otherwise fall through to the upstream handler (which treats
        // Ctrl+D on an empty line as EOF / no-op).
        return false;
      }

      // ── Alt+. — yank-last-arg ──
      case '\x1b.': {
        return this._yankLastArg();
      }

      // ── Alt+U / Alt+L / Alt+C — uppercase / lowercase / capitalize word ──
      case '\x1bu':
      case '\x1bU':
        return this._caseTransformWord('upper');
      case '\x1bl':
      case '\x1bL':
        return this._caseTransformWord('lower');
      case '\x1bc':
      case '\x1bC':
        return this._caseTransformWord('capitalize');

      // ── Ctrl+R — enter reverse-i-search ──
      case '\x12':
        this._rsearchEnter();
        return true;
    }

    return false;
  }

  // ── Word-boundary helpers ──

  /** Move from `pos` to the start of the previous readline word. */
  private _prevWordStart(buf: string, pos: number): number {
    let i = pos;
    // Skip non-word chars (whitespace, punctuation) backward.
    while (i > 0 && !LineEditorExtender.isWordChar(buf[i - 1])) i--;
    // Then skip the word backward.
    while (i > 0 && LineEditorExtender.isWordChar(buf[i - 1])) i--;
    return i;
  }

  /** Move from `pos` to the end of the next readline word. */
  private _nextWordEnd(buf: string, pos: number): number {
    let i = pos;
    // Skip non-word chars forward.
    while (i < buf.length && !LineEditorExtender.isWordChar(buf[i])) i++;
    // Then skip the word forward.
    while (i < buf.length && LineEditorExtender.isWordChar(buf[i])) i++;
    return i;
  }

  // ── Case transforms ──

  private _caseTransformWord(mode: 'upper' | 'lower' | 'capitalize'): boolean {
    const s = this.shell;
    const buf = s.lineBuffer as string;
    let i = s.cursorPos;
    // Skip non-word forward.
    while (i < buf.length && !LineEditorExtender.isWordChar(buf[i])) i++;
    const wordStart = i;
    while (i < buf.length && LineEditorExtender.isWordChar(buf[i])) i++;
    const wordEnd = i;
    if (wordEnd === wordStart) return true; // no word to transform
    const word = buf.slice(wordStart, wordEnd);
    let transformed: string;
    if (mode === 'upper') transformed = word.toUpperCase();
    else if (mode === 'lower') transformed = word.toLowerCase();
    else transformed = word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    s.lineBuffer = buf.slice(0, wordStart) + transformed + buf.slice(wordEnd);
    s.cursorPos = wordEnd;
    s.redrawLine();
    return true;
  }

  // ── Yank-last-arg (Alt+.) ──

  private _yankLastArg(): boolean {
    const s = this.shell;
    const history: string[] = s.history ?? [];
    if (history.length === 0) return true;

    // Advance the history index. First press → 0 (most-recent).
    // Repeat press → 1 (previous), 2, ... wrap at end.
    this.yankLastArgIndex = (this.yankLastArgIndex < 0)
      ? 0
      : Math.min(this.yankLastArgIndex + 1, history.length - 1);

    const histLine = history[history.length - 1 - this.yankLastArgIndex] ?? '';
    // bash: "last arg" = the LAST whitespace-delimited word of the
    // previous command (after expansion). We don't expand here; the
    // raw last word is what users expect.
    const m = histLine.match(/(\S+)\s*$/);
    const lastArg = m ? m[1] : '';

    const buf = s.lineBuffer as string;
    // Remove the previous Alt+. insertion (if any) before inserting
    // the next.
    const removedFrom = s.cursorPos - this.yankLastArgInsertedLen;
    const removedTo = s.cursorPos;
    const newBuf = buf.slice(0, removedFrom) + lastArg + buf.slice(removedTo);
    s.lineBuffer = newBuf;
    s.cursorPos = removedFrom + lastArg.length;
    this.yankLastArgInsertedLen = lastArg.length;
    s.redrawLine();
    return true;
  }

  // ── Reverse-i-search (Ctrl+R sub-mode) ──

  private _rsearchEnter(): void {
    this.rsearchActive = true;
    this.rsearchQuery = '';
    this.rsearchMatchIndex = -1;
    this._rsearchRender();
  }

  private _rsearchHandle(data: string): void {
    const s = this.shell;

    // Esc / Ctrl+G → abort, keep the partial line buffer as it was.
    if (data === '\x1b' || data === '\x07') {
      this._rsearchExit(/*restoreLine=*/ true);
      return;
    }

    // Enter → accept the current match and execute it.
    if (data === '\r' || data === '\n') {
      const accepted = this._rsearchCurrentMatch();
      this._rsearchExit(/*restoreLine=*/ false);
      if (accepted) {
        s.lineBuffer = accepted;
        s.cursorPos = accepted.length;
      }
      s.redrawLine();
      // Defer to the original handler to execute the (now-restored)
      // line. Sending '\r' triggers the same path Enter would.
      this.originalHandleInput!('\r');
      return;
    }

    // Another Ctrl+R → step to the next-older match.
    if (data === '\x12') {
      this._rsearchAdvance();
      this._rsearchRender();
      return;
    }

    // Backspace / Ctrl+H → remove last query char and re-search.
    if (data === '\x7f' || data === '\x08') {
      this.rsearchQuery = this.rsearchQuery.slice(0, -1);
      this.rsearchMatchIndex = -1; // restart search from most-recent
      this._rsearchSearch();
      this._rsearchRender();
      return;
    }

    // Any other escape sequence aborts (cursor arrows etc).
    if (data.startsWith('\x1b')) {
      // Bash: arrow keys exit search and keep the current match in
      // the buffer for further editing.
      const accepted = this._rsearchCurrentMatch();
      this._rsearchExit(/*restoreLine=*/ false);
      if (accepted) {
        s.lineBuffer = accepted;
        s.cursorPos = accepted.length;
      }
      s.redrawLine();
      return;
    }

    // Ctrl+C → cancel out of search and clear the line.
    if (data === '\x03') {
      this._rsearchExit(/*restoreLine=*/ true);
      s.lineBuffer = '';
      s.cursorPos = 0;
      this.terminal.write('^C\r\n');
      // Use the shell's prompt path.
      if (typeof s.printPrompt === 'function') s.printPrompt();
      return;
    }

    // Otherwise: append printable to the query and search.
    if (data >= ' ' && !data.startsWith('\x1b')) {
      this.rsearchQuery += data;
      this.rsearchMatchIndex = -1;
      this._rsearchSearch();
      this._rsearchRender();
    }
  }

  /** Step the match index forward (older) and re-search from there. */
  private _rsearchAdvance(): void {
    const history: string[] = this.shell.history ?? [];
    let idx = this.rsearchMatchIndex < 0 ? 0 : this.rsearchMatchIndex + 1;
    for (; idx < history.length; idx++) {
      const line = history[history.length - 1 - idx];
      if (line && line.includes(this.rsearchQuery)) {
        this.rsearchMatchIndex = idx;
        return;
      }
    }
    // No further match — keep the current one.
  }

  /** Find the most-recent history line containing the query. */
  private _rsearchSearch(): void {
    if (!this.rsearchQuery) {
      this.rsearchMatchIndex = -1;
      return;
    }
    const history: string[] = this.shell.history ?? [];
    for (let idx = 0; idx < history.length; idx++) {
      const line = history[history.length - 1 - idx];
      if (line && line.includes(this.rsearchQuery)) {
        this.rsearchMatchIndex = idx;
        return;
      }
    }
    this.rsearchMatchIndex = -1;
  }

  private _rsearchCurrentMatch(): string | null {
    if (this.rsearchMatchIndex < 0) return null;
    const history: string[] = this.shell.history ?? [];
    return history[history.length - 1 - this.rsearchMatchIndex] ?? null;
  }

  /** Render the search-prompt line. */
  private _rsearchRender(): void {
    const match = this._rsearchCurrentMatch();
    // Clear the current screen row + redraw the search prompt.
    this.terminal.write('\r\x1b[K');
    if (match) {
      this.terminal.write(`(reverse-i-search)\`${this.rsearchQuery}': ${match}`);
    } else {
      this.terminal.write(`(failed reverse-i-search)\`${this.rsearchQuery}': `);
    }
  }

  /**
   * Exit the search sub-mode. If `restoreLine` is true, the line
   * buffer is left as it was when search began (no insertion). The
   * caller is expected to call `redrawLine()` afterward if needed.
   */
  private _rsearchExit(restoreLine: boolean): void {
    this.rsearchActive = false;
    this.rsearchQuery = '';
    this.rsearchMatchIndex = -1;
    // Clear the search prompt line.
    this.terminal.write('\r\x1b[K');
    if (restoreLine) {
      // Caller wants the original buffer kept; nothing to do here —
      // the caller will redraw.
    }
  }
}
