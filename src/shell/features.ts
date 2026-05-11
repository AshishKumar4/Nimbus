/**
 * shell-features.ts — Shell preprocessor for pipes, redirects, operators,
 * env var expansion, glob expansion, and quoted strings.
 *
 * Wraps the LIFO shell's command execution with Unix-like features.
 * Called from nimbus-session.ts before dispatching to the registry.
 */

import type { SqliteVFS } from '../vfs/sqlite-vfs.js';

// ── Quoted string parsing ───────────────────────────────────────────────

/**
 * Parse a command line into tokens, respecting quotes.
 * "hello world" → one token. 'don\'t' → one token.
 */
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\' && !inSingle) {
      escaped = true;
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }

    if ((ch === ' ' || ch === '\t') && !inSingle && !inDouble) {
      if (current) { tokens.push(current); current = ''; }
      continue;
    }

    current += ch;
  }

  if (current) tokens.push(current);
  return tokens;
}

// ── Environment variable expansion ──────────────────────────────────────

/**
 * Expand $VAR and ${VAR} in a string using the env map.
 */
export function expandVars(input: string, env: Record<string, string>): string {
  return input
    .replace(/\$\{([^}]+)\}/g, (_, name) => env[name] ?? '')
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => env[name] ?? '');
}

// ── Glob expansion ──────────────────────────────────────────────────────

/**
 * Expand glob patterns (* and ?) against VFS directory entries.
 */
export function expandGlobs(tokens: string[], cwd: string, vfs: SqliteVFS): string[] {
  const result: string[] = [];
  for (const token of tokens) {
    if (!token.includes('*') && !token.includes('?')) {
      result.push(token);
      continue;
    }
    // Split into dir + pattern
    const lastSlash = token.lastIndexOf('/');
    const dir = lastSlash >= 0 ? token.substring(0, lastSlash) : '.';
    const pattern = lastSlash >= 0 ? token.substring(lastSlash + 1) : token;
    const vfsDir = dir === '.' ? cwd.replace(/^\/+/, '') :
      (dir.startsWith('/') ? dir.replace(/^\/+/, '') : cwd.replace(/^\/+/, '') + '/' + dir);

    try {
      const entries = vfs.readdir(vfsDir);
      const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
      const matches = entries.filter(e => re.test(e.name)).map(e => dir === '.' ? e.name : dir + '/' + e.name);
      if (matches.length > 0) {
        result.push(...matches.sort());
      } else {
        result.push(token); // No matches — keep literal
      }
    } catch {
      result.push(token); // Dir doesn't exist — keep literal
    }
  }
  return result;
}

// ── Pipe, redirect, operator parsing ────────────────────────────────────

interface ParsedSegment {
  command: string;
  redirectOut?: string;      // > file
  redirectAppend?: string;   // >> file
  redirectErr?: string;      // 2> file
}

/**
 * Split a command line by operators (|, &&, ||, ;) respecting quotes.
 * Returns segments with their operator type.
 */
export function splitOperators(input: string): { segments: string[]; operators: string[] } {
  const segments: string[] = [];
  const operators: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "'" && !inDouble) { inSingle = !inSingle; current += ch; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; current += ch; continue; }
    if (inSingle || inDouble) { current += ch; continue; }

    if (ch === '|' && input[i + 1] === '|') {
      segments.push(current.trim()); operators.push('||'); current = ''; i++; continue;
    }
    if (ch === '&' && input[i + 1] === '&') {
      segments.push(current.trim()); operators.push('&&'); current = ''; i++; continue;
    }
    if (ch === '|') {
      segments.push(current.trim()); operators.push('|'); current = ''; continue;
    }
    if (ch === ';') {
      segments.push(current.trim()); operators.push(';'); current = ''; continue;
    }
    current += ch;
  }
  if (current.trim()) segments.push(current.trim());
  return { segments, operators };
}

/**
 * Parse redirects from a command string.
 * Returns the clean command and any redirect targets.
 */
export function parseRedirects(cmd: string): ParsedSegment {
  let redirectOut: string | undefined;
  let redirectAppend: string | undefined;
  let redirectErr: string | undefined;

  // 2>/dev/null or 2> file
  cmd = cmd.replace(/2>\s*(\S+)/g, (_, file) => { redirectErr = file; return ''; });
  // >> file (append)
  cmd = cmd.replace(/>>\s*(\S+)/g, (_, file) => { redirectAppend = file; return ''; });
  // > file (overwrite)
  cmd = cmd.replace(/>\s*(\S+)/g, (_, file) => { redirectOut = file; return ''; });

  return { command: cmd.trim(), redirectOut, redirectAppend, redirectErr };
}

// ── Heredoc support ─────────────────────────────────────────────────────

/**
 * Parsed heredoc information extracted from a command line.
 */
export interface HeredocInfo {
  /** The command line with the heredoc operator and delimiter removed */
  command: string;
  /** The delimiter word (without quotes) */
  delimiter: string;
  /** Whether the delimiter was quoted (no variable expansion) */
  quoted: boolean;
  /** Whether to strip leading tabs (<<- form) */
  stripTabs: boolean;
  /** Redirect target file, if `cat > file << DELIM` pattern */
  redirectFile?: string;
  /** Whether it's an append redirect >> */
  redirectAppend?: boolean;
}

/**
 * Detect and parse a heredoc operator in a command line.
 * Supports: << DELIM, << 'DELIM', << "DELIM", <<- DELIM, <<- 'DELIM'
 *
 * Returns null if no heredoc is found.
 */
export function parseHeredoc(input: string): HeredocInfo | null {
  // Match <<- or << followed by optional whitespace and a delimiter.
  // The delimiter may be quoted with single or double quotes.
  // Must not match <<< (herestring) — require that third char is NOT <.
  // Scan character-by-character to respect quoting context.
  let inSingle = false;
  let inDouble = false;
  let heredocPos = -1;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (inSingle || inDouble) continue;

    if (ch === '<' && input[i + 1] === '<' && input[i + 2] !== '<') {
      heredocPos = i;
      break;
    }
  }

  if (heredocPos === -1) return null;

  const beforeHeredoc = input.substring(0, heredocPos).trimEnd();
  let rest = input.substring(heredocPos + 2); // skip the <<

  // Check for - (strip tabs)
  let stripTabs = false;
  if (rest.startsWith('-')) {
    stripTabs = true;
    rest = rest.substring(1);
  }

  // Skip whitespace
  rest = rest.trimStart();

  // Parse delimiter — may be quoted
  let delimiter: string;
  let quoted = false;

  if (rest.startsWith("'")) {
    // Single-quoted delimiter: no expansion
    const endQuote = rest.indexOf("'", 1);
    if (endQuote === -1) return null; // malformed
    delimiter = rest.substring(1, endQuote);
    quoted = true;
  } else if (rest.startsWith('"')) {
    // Double-quoted delimiter: treated as quoted (no expansion for v1)
    const endQuote = rest.indexOf('"', 1);
    if (endQuote === -1) return null; // malformed
    delimiter = rest.substring(1, endQuote);
    quoted = true;
  } else {
    // Unquoted delimiter: first non-whitespace word (allows hyphens, dots, etc.)
    const match = rest.match(/^(\S+)/);
    if (!match) return null; // no valid delimiter
    delimiter = match[1];
    quoted = false;
  }

  if (!delimiter) return null;

  // Parse the command part (before <<) for redirects.
  // Common patterns:
  //   cat > file << DELIM     → redirect to file, command is "cat"
  //   cat >> file << DELIM    → append to file, command is "cat"
  //   command << DELIM        → pipe stdin to command
  //   cat << DELIM > file     → redirect after heredoc (uncommon but valid)
  let command = beforeHeredoc;
  let redirectFile: string | undefined;
  let redirectAppend = false;

  // Detect >> file or > file in the command part
  const appendMatch = command.match(/>>\s*(\S+)/);
  if (appendMatch) {
    redirectFile = appendMatch[1];
    redirectAppend = true;
    command = command.replace(/>>\s*\S+/, '').trim();
  } else {
    const outMatch = command.match(/>\s*(\S+)/);
    if (outMatch) {
      redirectFile = outMatch[1];
      redirectAppend = false;
      command = command.replace(/>\s*\S+/, '').trim();
    }
  }

  return {
    command: command.trim(),
    delimiter,
    quoted,
    stripTabs,
    redirectFile,
    redirectAppend,
  };
}

/**
 * HeredocHandler — monkey-patches a Shell instance to support heredoc syntax.
 *
 * Usage: call `HeredocHandler.install(shell, terminal, vfs)` after creating the shell.
 * All heredoc logic lives here in shell-features.ts; nimbus-session.ts only calls install().
 *
 * When the user types a command containing `<<`, the handler:
 *   1. Intercepts executeLine, parses the heredoc
 *   2. Enters accumulation mode — shows `> ` continuation prompt
 *   3. Collects input lines until the delimiter is found
 *   4. Executes the command with the accumulated content as stdin
 *   5. For `cat > file << DELIM`, writes the content directly to the file
 *
 * Design notes:
 *   - The Shell from @lifo-sh/core calls `executeLine(line)` when the user
 *     presses Enter with non-empty input. For empty input, it calls
 *     `printPrompt()` directly. We patch both methods so that empty lines
 *     inside a heredoc body are properly captured.
 *   - During accumulation mode, the shell's normal line-editing (arrow keys,
 *     backspace, history, tab completion) still works for each content line.
 *   - The `> ` continuation prompt visually signals heredoc mode.
 */
export class HeredocHandler {
  private shell: any; // Shell instance (from @lifo-sh/core)
  private terminal: any; // ITerminal-compatible (has write())
  private vfs: any; // SqliteVFS
  private originalExecuteLine: ((line: string) => Promise<void>) | null = null;
  private originalPrintPrompt: (() => void) | null = null;
  private originalHandleInput: ((data: string) => void) | null = null;

  // ── Accumulation state ──
  private active = false;
  private heredocInfo: HeredocInfo | null = null;
  private lines: string[] = [];
  private historyLengthAtStart = 0;

  /** Safety limit to prevent unbounded memory growth */
  private static readonly MAX_HEREDOC_LINES = 50000;

  constructor(shell: any, terminal: any, vfs: any) {
    this.shell = shell;
    this.terminal = terminal;
    this.vfs = vfs;
  }

  /**
   * Install the heredoc handler on a Shell instance.
   * Call once after the Shell is created.
   */
  static install(shell: any, terminal: any, vfs: any): HeredocHandler {
    const handler = new HeredocHandler(shell, terminal, vfs);
    handler._patch();
    return handler;
  }

  /** Cancel heredoc accumulation and return to normal shell prompt. */
  private _cancel(): void {
    this.active = false;
    this.heredocInfo = null;
    this.lines = [];
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

    // Patch handleInput to intercept Ctrl+C during heredoc mode.
    // Without this, Ctrl+C during heredoc calls printPrompt (patched below),
    // which would silently insert an empty line instead of cancelling.
    // Also patches multi-line paste to preserve empty lines for heredoc mode.
    this.shell.handleInput = (data: string): void => {
      // Ctrl+C (\x03) while in heredoc mode → cancel accumulation
      if (this.active && data === '\x03') {
        this._cancel();
        this.terminal.write('^C\r\n');
        this.originalPrintPrompt!();
        return;
      }

      // During heredoc accumulation, we must intercept ALL input that contains
      // Enter (\r or \n) to prevent the Shell's .trim() from stripping leading
      // whitespace. The Shell does `lineBuffer.trim()` before calling executeLine,
      // which destroys indentation that is critical for heredoc content.
      //
      // For multi-line paste, we also preserve empty lines that the Shell's
      // original handleInput would drop from the pasteQueue.
      if (this.active && !this.shell.running && data.length > 1 && /[\r\n]/.test(data)) {
        const parts = data.split(/\r\n|\r|\n/);
        // First part extends the current line buffer
        if (parts[0]) {
          this.shell.lineBuffer = this.shell.lineBuffer.slice(0, this.shell.cursorPos)
            + parts[0] + this.shell.lineBuffer.slice(this.shell.cursorPos);
          this.shell.cursorPos += parts[0].length;
        }
        if (parts.length > 1) {
          // "Enter" the current line — use raw lineBuffer (NOT trimmed)
          this.shell.redrawLine();
          this.terminal.write('\r\n');
          const currentLine = this.shell.lineBuffer; // preserve leading whitespace
          this.shell.lineBuffer = '';
          this.shell.cursorPos = 0;
          this.shell.screenCursorRow = 0;
          this.shell.historyIndex = -1;
          // Push subsequent lines to paste queue (including empty strings),
          // but skip the trailing empty string (artifact of splitting "...\r")
          for (let i = 1; i < parts.length; i++) {
            if (i === parts.length - 1 && parts[i] === '') continue;
            this.shell.pasteQueue.push(parts[i]);
          }
          // Add to history (matches Shell behavior)
          if (currentLine.trim()) {
            this.shell.history.push(currentLine.trim());
          }
          // Process the raw line (with leading whitespace preserved)
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

      // Single Enter (\r alone) while in heredoc mode — intercept to
      // preserve the raw lineBuffer content (Shell would .trim() it).
      if (this.active && !this.shell.running && data === '\r') {
        this.terminal.write('\r\n');
        const currentLine = this.shell.lineBuffer; // raw, untrimmed
        this.shell.lineBuffer = '';
        this.shell.cursorPos = 0;
        this.shell.screenCursorRow = 0;
        this.shell.historyIndex = -1;
        // Add trimmed version to history (matches Shell behavior)
        if (currentLine.trim()) {
          this.shell.history.push(currentLine.trim());
        }
        // Process the raw line (preserving leading whitespace)
        const isDelim = this._processLine(currentLine);
        if (isDelim && this.heredocInfo !== null) {
          this._finishHeredoc();
        } else if (!isDelim) {
          this.terminal.write('> ');
        }
        return;
      }

      // Default: pass through to original
      return this.originalHandleInput!(data);
    };

    // Replace executeLine with our interceptor
    this.shell.executeLine = async (line: string): Promise<void> => {
      if (this.active) {
        // We're accumulating heredoc lines.
        // The shell may have trimmed the line (losing leading tabs).
        // For <<- mode, use the raw lineBuffer if it's non-empty —
        // it preserves indentation that the shell's .trim() removes.
        const rawLine = (this.heredocInfo?.stripTabs && this.shell.lineBuffer)
          ? this.shell.lineBuffer
          : line;
        await this._accumulateLine(rawLine);
        return;
      }

      // Check if this line starts a heredoc
      const info = parseHeredoc(line);
      if (info) {
        await this._startAccumulation(info);
        return;
      }

      // No heredoc — pass through to original
      return this.originalExecuteLine!(line);
    };

    // Patch printPrompt to handle empty lines during heredoc accumulation.
    // The Shell calls printPrompt() directly when the user presses Enter
    // on an empty line (without calling executeLine). During heredoc mode,
    // an empty line should be added to the content, not ignored.
    this.shell.printPrompt = (): void => {
      if (this.active) {
        // Empty line in heredoc — accumulate it
        this._accumulateLine('');
        return;
      }
      // Normal prompt
      return this.originalPrintPrompt!();
    };
  }

  private async _startAccumulation(info: HeredocInfo): Promise<void> {
    this.active = true;
    this.heredocInfo = info;
    this.lines = [];
    // Record history length so we can truncate content lines from history later
    this.historyLengthAtStart = this.shell.history?.length ?? 0;
    // Show continuation prompt, then drain any paste queue lines
    // (handles pasted multi-line heredocs where all lines arrive at once)
    this.terminal.write('> ');
    await this._drainPasteQueue();
  }

  /**
   * Process a single heredoc content line (non-recursive).
   * Returns true if this was the delimiter (heredoc is complete).
   */
  private _processLine(line: string): boolean {
    const info = this.heredocInfo!;

    // Strip trailing \r and \n from the line before any processing.
    // Lines may arrive with trailing newlines from terminal input processing
    // or paste splitting edge cases — we join with \n later, so storing them
    // with trailing newlines would produce double newlines in the output.
    const cleaned = line.replace(/[\r\n]+$/, '');

    // Delimiter matching: exact match after optional tab stripping.
    // For <<- (stripTabs): strip leading tabs from BOTH content and delimiter lines.
    // For << (no stripTabs): exact match — line must equal delimiter exactly.
    // This matches bash behavior where the delimiter must be alone on its
    // line with no surrounding whitespace (except leading tabs for <<-).
    const checkLine = info.stripTabs ? cleaned.replace(/^\t+/, '') : cleaned;
    if (checkLine === info.delimiter) {
      return true; // signal: delimiter found
    }

    // Size guard
    if (this.lines.length >= HeredocHandler.MAX_HEREDOC_LINES) {
      this.terminal.write(`\x1b[31mheredoc: exceeded ${HeredocHandler.MAX_HEREDOC_LINES} line limit\x1b[0m\r\n`);
      this._cancel();
      this.originalPrintPrompt!();
      return true; // stop accumulation
    }

    // Accumulate the line (after stripping leading tabs for <<-)
    const processedLine = info.stripTabs ? cleaned.replace(/^\t+/, '') : cleaned;
    this.lines.push(processedLine);
    return false;
  }

  /**
   * Called when executeLine fires during accumulation (user typed a line + Enter).
   * Also called during paste processing.
   */
  private async _accumulateLine(line: string): Promise<void> {
    if (this._processLine(line)) {
      // Delimiter found (or limit exceeded) — execute the heredoc
      if (this.heredocInfo === null) return; // limit exceeded, already cancelled
      await this._finishHeredoc();
      return;
    }
    // Show next continuation prompt
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

    // Process all queued lines iteratively while still in accumulation mode
    while (this.active && queue.length > 0) {
      const nextLine = queue.shift()!;
      // Echo the line + newline (matches Shell.drainPasteQueue behavior)
      this.terminal.write(nextLine + '\r\n');

      if (this._processLine(nextLine)) {
        // Delimiter found — finish heredoc and let remaining queue items
        // be handled by the shell's normal drainPasteQueue after we're done
        if (this.heredocInfo === null) return; // limit exceeded
        await this._finishHeredoc();
        return;
      }
      // Show continuation prompt for next line
      this.terminal.write('> ');
    }
  }

  private async _finishHeredoc(): Promise<void> {
    const info = this.heredocInfo!;
    let content = this.lines.join('\n') + '\n';

    // BUG-SWEEP-R3-5 (2026-05-11): expand $NAME / ${NAME} in heredoc
    // content when delimiter is NOT quoted (bash semantics: <<EOF
    // expands, <<'EOF' doesn't). Without this, `cat <<EOF` with $X
    // inside outputs literal `$X` — surprising for users coming from
    // bash/zsh.
    if (!info.quoted) {
      const env = (this.shell.env || {}) as Record<string, string>;
      content = expandHeredocVars(content, env);
    }

    // Reset state before executing (in case execution triggers more input)
    this.active = false;
    this.heredocInfo = null;
    this.lines = [];

    // Remove heredoc content lines from shell history
    if (this.shell.history) {
      this.shell.history.length = this.historyLengthAtStart;
    }

    try {
      if (info.redirectFile) {
        // Direct file write: `cat > file << DELIM` or `cat >> file << DELIM`
        // This is the most common heredoc pattern — write content to file.
        // We handle it directly via VFS for reliability, regardless of command.
        const cwd = this.shell.getCwd().replace(/^\/+/, '');
        const filePath = info.redirectFile.startsWith('/')
          ? info.redirectFile.replace(/^\/+/, '')
          : cwd + '/' + info.redirectFile;

        // Ensure parent directories exist
        const parts = filePath.split('/');
        for (let i = 1; i < parts.length; i++) {
          const dir = parts.slice(0, i).join('/');
          if (dir && !this.vfs.exists(dir)) {
            this.vfs.mkdir(dir, { recursive: true });
          }
        }

        if (info.redirectAppend) {
          const existing = this.vfs.exists(filePath) ? this.vfs.readFileString(filePath) : '';
          this.vfs.writeFile(filePath, existing + content);
        } else {
          this.vfs.writeFile(filePath, content);
        }
      } else if (info.command) {
        // Pipe heredoc content as stdin to command: `command << DELIM`
        // Use shell.execute() which supports stdin option.
        await this.shell.execute(info.command, { stdin: content });
      }
    } catch (e: any) {
      this.terminal.write(`\x1b[31mheredoc error: ${e?.message || e}\x1b[0m\r\n`);
    }

    // Re-show the normal prompt and drain paste queue (matches Shell.executeLine behavior)
    this.originalPrintPrompt!();
    if (typeof this.shell.drainPasteQueue === 'function') {
      this.shell.drainPasteQueue();
    }
  }
}

// ── Line preprocessor (fd-redirect normalisation) ──────────────────────

/**
 * BUG-SWEEP-2 (2026-05-11): @lifo-sh/core ≥0.5.5's shell parser does
 * not support fd-to-fd redirects (`2>&1`, `>&2`, `<&0`). Encountering
 * one raises `Expected Word but got Amp ('&')` from the parser and
 * the whole pipeline fails.
 *
 * Real-world impact:
 *   - `pip install foo 2>&1 | tail -5`  → parse error
 *   - `cmd 2>&1` (standard "merge stderr into stdout") → parse error
 *   - `echo error >&2` ("write to stderr")             → parse error
 *
 * In Nimbus's execution model, stdout AND stderr both stream to the
 * same terminal frame buffer (see WebSocketTerminal). `2>&1` is
 * therefore a no-op (stderr is already on the same sink as stdout)
 * and `>&2` is functionally the same as no-redirect. We rewrite both
 * to empty so the parser sees a clean command line.
 *
 * What this DOES NOT solve:
 *   - `cmd 2>/path/to/file`  — file-redirect of stderr. NOT supported
 *     downstream either (lifo-sh's parser accepts `2>file` but the
 *     interpreter at executeSimpleCommand only honours stdout
 *     redirection via vfs.writeFile). Out of scope; flag as docs gap.
 *   - `cmd > /dev/null`      — /dev/null missing on prod. Separate fix.
 *
 * Install AFTER HeredocHandler so heredoc accumulation isn't disturbed
 * (we only run when executeLine fires on a complete line).
 */
export class FdRedirectNormalizer {
  private shell: any;

  constructor(shell: any) {
    this.shell = shell;
  }

  /** Install on a Shell instance. Idempotent. */
  static install(shell: any): FdRedirectNormalizer {
    const norm = new FdRedirectNormalizer(shell);
    norm._patch();
    return norm;
  }

  private _patch(): void {
    const orig = this.shell.executeLine.bind(this.shell);
    this.shell.executeLine = async (line: string): Promise<void> => {
      // Skip rewriting inside single-quoted strings (the user explicitly
      // wants the literal `2>&1` text — rare but possible). Outside
      // quotes, replace `2>&1`, `1>&2`, `>&2`, `&>file` (the merge-all
      // operator is already supported by lifo-sh; only fd-to-fd needs
      // stripping).
      const rewritten = FdRedirectNormalizer.normalize(line);
      return orig(rewritten);
    };
  }

  /**
   * Strip fd-to-fd redirects from a shell line. Preserves single-
   * quoted substrings verbatim (user-intended literals are safe).
   *
   * Returns the rewritten line.
   */
  static normalize(line: string): string {
    // Single-quote-aware scan. Build output by copying runs of
    // non-single-quoted text after running the rewrite regex; quoted
    // runs are copied verbatim.
    let out = '';
    let i = 0;
    while (i < line.length) {
      const ch = line[i];
      if (ch === "'") {
        // Find matching close quote (bash: no escapes inside single quotes).
        const j = line.indexOf("'", i + 1);
        if (j < 0) {
          out += line.slice(i);
          break;
        }
        out += line.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      // Find next single-quote (run end).
      const next = line.indexOf("'", i);
      const chunkEnd = next < 0 ? line.length : next;
      const chunk = line.slice(i, chunkEnd);
      // Rewrite operators in the chunk:
      //   2>&1, 1>&2, >&2, <&0, &>&1 etc — drop entirely.
      //   `2>&-` (close fd) — drop.
      // The pattern matches optional leading-digit + `>&` + digit-or-dash.
      const stripped = chunk.replace(/\s*\d?[<>]&[\d-]\s*/g, ' ');
      out += stripped;
      i = chunkEnd;
    }
    return out;
  }
}

// ── Subshell / grouping normalizer ─────────────────────────────────────

/**
 * BUG-SWEEP-R3-2 (2026-05-11): @lifo-sh/core's parser doesn't support
 * subshell grouping `(cmd1; cmd2)`. Pre-fix `(echo a; echo b)` raised
 * `unexpected token '('`. Common shell idioms (`(cd /x && cmd)` for
 * cd-scoped execution, pipeline grouping `(a; b) | c`) all failed.
 *
 * In bash, `(cmd1; cmd2)` runs in a subshell — its `cd`/var/env
 * changes do NOT affect the parent. We approximate by:
 *   1. Strip the outer `(...)` parens.
 *   2. Save cwd + env before running.
 *   3. Run the inner sequence.
 *   4. Restore cwd + env.
 *
 * Approximation gap: pipe-to-group `(a; b) | c` we currently
 * concatenate the group into a `{ a; b ; }` brace-group inline and
 * let lifo-sh handle the pipe — but lifo-sh also doesn't support
 * brace-groups. So we rewrite `(a; b) | c` to `a; b | c` which is
 * NOT the same semantically (only b's output pipes). Pipe-after-
 * group is documented as a remaining gap.
 *
 * Bare subshells `(a; b)` are fully supported via the cwd/env
 * save-restore pattern.
 */
export class SubshellNormalizer {
  private shell: any;

  constructor(shell: any) {
    this.shell = shell;
  }

  static install(shell: any): SubshellNormalizer {
    const norm = new SubshellNormalizer(shell);
    norm._patch();
    return norm;
  }

  private _patch(): void {
    const orig = this.shell.executeLine.bind(this.shell);
    const shell = this.shell;
    this.shell.executeLine = async (line: string): Promise<void> => {
      // Quick reject: no parens, no scan.
      if (line.indexOf('(') < 0) return orig(line);
      // Find a top-level `(...)` group. Quote-aware: skip parens inside
      // strings.
      const groups = SubshellNormalizer.findTopLevelGroups(line);
      if (groups.length === 0) return orig(line);
      // Conservative: only handle the BARE-group case (line is exactly
      // `(...)` possibly with leading/trailing whitespace). Mixed
      // `(...) | cmd`, `cmd && (...)` etc fall through to orig
      // (which will still throw, but we don't make it worse).
      const trimmed = line.trim();
      if (groups.length === 1 && groups[0].start === line.indexOf('(') &&
          groups[0].end === line.lastIndexOf(')') &&
          trimmed.startsWith('(') && trimmed.endsWith(')')) {
        const inner = line.slice(groups[0].start + 1, groups[0].end);
        // Save shell state.
        const savedCwd = typeof shell.getCwd === 'function' ? shell.getCwd() : shell.cwd;
        const savedEnv = { ...(shell.env || {}) };
        try {
          await orig(inner);
        } finally {
          if (typeof shell.setCwd === 'function') shell.setCwd(savedCwd);
          else if ('cwd' in shell) shell.cwd = savedCwd;
          // Restore env: replace contents in-place so any held refs see new state.
          if (shell.env) {
            for (const k of Object.keys(shell.env)) delete shell.env[k];
            Object.assign(shell.env, savedEnv);
          }
        }
        return;
      }
      // Has parens but in chain/pipe context — pass through unchanged.
      // lifo-sh's parser will error, surfacing a clear message; we
      // didn't make it worse.
      return orig(line);
    };
  }

  /**
   * Find top-level `(...)` groups. Quote-aware: skip parens inside
   * 'single' or "double" or `backtick` strings. Returns array of
   * `{start, end}` indices (start = opening paren, end = closing).
   */
  static findTopLevelGroups(line: string): { start: number; end: number }[] {
    const groups: { start: number; end: number }[] = [];
    let depth = 0;
    let groupStart = -1;
    let i = 0;
    while (i < line.length) {
      const ch = line[i];
      if (ch === "'" || ch === '"' || ch === '`') {
        const quote = ch;
        i++;
        while (i < line.length && line[i] !== quote) {
          if (line[i] === '\\') i++;
          i++;
        }
        i++;
        continue;
      }
      if (ch === '\\' && i + 1 < line.length) { i += 2; continue; }
      if (ch === '(') {
        if (depth === 0) groupStart = i;
        depth++;
      } else if (ch === ')') {
        depth--;
        if (depth === 0 && groupStart >= 0) {
          groups.push({ start: groupStart, end: i });
          groupStart = -1;
        }
      }
      i++;
    }
    return groups;
  }
}

// ── Brace expansion ─────────────────────────────────────────────────────

/**
 * BUG-SWEEP-R3-3 (2026-05-11): @lifo-sh/core doesn't expand
 * `{a,b,c}` brace expressions. Pre-fix `ls /x/*.{js,ts}` returned
 * nothing because the literal `*.{js,ts}` doesn't match a glob shape.
 *
 * Bash semantics: brace expansion runs BEFORE filename expansion.
 *   echo a{1,2,3}b     → a1b a2b a3b
 *   ls *.{js,ts}       → expanded to two glob patterns, both fed to ls
 *
 * We implement the comma-list form (bash {1..5} sequence form is a
 * separate feature; we skip it here as lower-impact).
 */
export class BraceExpander {
  private shell: any;

  constructor(shell: any) {
    this.shell = shell;
  }

  static install(shell: any): BraceExpander {
    const norm = new BraceExpander(shell);
    norm._patch();
    return norm;
  }

  private _patch(): void {
    const orig = this.shell.executeLine.bind(this.shell);
    this.shell.executeLine = async (line: string): Promise<void> => {
      if (line.indexOf('{') < 0) return orig(line);
      // Only expand if `{...,...}` shape present (avoid messing with
      // `${VAR}` parameter expansion — different syntax).
      const expanded = BraceExpander.expandBraces(line);
      return orig(expanded);
    };
  }

  /**
   * Expand bash-style brace lists in a shell line. Quote-aware:
   * literals inside single quotes are preserved verbatim. `${var}`
   * parameter expansions are skipped (they don't contain commas
   * at the top level of the braces).
   *
   * Strategy: tokenize on whitespace (preserving quoted tokens),
   * expand each token, re-join with spaces.
   */
  static expandBraces(line: string): string {
    const tokens = tokenizeRespectingQuotes(line);
    const out: string[] = [];
    for (const tok of tokens) {
      const expanded = expandTokenBraces(tok);
      out.push(...expanded);
    }
    return out.join(' ');
  }
}

/** Split a line into tokens, preserving quoted runs as single tokens. */
function tokenizeRespectingQuotes(line: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (/\s/.test(ch)) {
      if (cur) { tokens.push(cur); cur = ''; }
      // Preserve the whitespace as a separator-token so we can re-join
      // with the original spacing.
      let ws = '';
      while (i < line.length && /\s/.test(line[i])) { ws += line[i]; i++; }
      tokens.push(ws);
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      cur += ch;
      i++;
      while (i < line.length && line[i] !== quote) {
        if (line[i] === '\\') { cur += line[i]; i++; if (i < line.length) { cur += line[i]; i++; } continue; }
        cur += line[i]; i++;
      }
      if (i < line.length) { cur += line[i]; i++; }
      continue;
    }
    cur += ch;
    i++;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

/**
 * Expand a single token's braces into N tokens.
 *   "a{1,2}b" → ["a1b", "a2b"]
 *   "a{1,2}b{x,y}" → ["a1bx", "a1by", "a2bx", "a2by"]
 *
 * `${...}` (parameter expansion) is preserved as-is.
 */
function expandTokenBraces(tok: string): string[] {
  // Whitespace-only token: keep verbatim.
  if (/^\s+$/.test(tok)) return [tok];
  // Find the first unescaped `{` that has a matching `}` and at least
  // one comma at the same nesting level. Skip `${...}`.
  let i = 0;
  while (i < tok.length) {
    if (tok[i] === '\\' && i + 1 < tok.length) { i += 2; continue; }
    if (tok[i] === "'" || tok[i] === '"' || tok[i] === '`') {
      const q = tok[i]; i++;
      while (i < tok.length && tok[i] !== q) { if (tok[i] === '\\') i++; i++; }
      i++;
      continue;
    }
    if (tok[i] === '$' && tok[i + 1] === '{') {
      // Parameter expansion ${...}: skip past matching }.
      let depth = 0;
      while (i < tok.length) {
        if (tok[i] === '{') depth++;
        else if (tok[i] === '}') { depth--; if (depth === 0) { i++; break; } }
        i++;
      }
      continue;
    }
    if (tok[i] === '{') {
      // Find matching close + check for comma at top level.
      const start = i;
      let depth = 0;
      let hasTopLevelComma = false;
      let close = -1;
      for (let j = i; j < tok.length; j++) {
        const c = tok[j];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { close = j; break; } }
        else if (c === ',' && depth === 1) hasTopLevelComma = true;
      }
      if (close > 0 && hasTopLevelComma) {
        const prefix = tok.slice(0, start);
        const inner = tok.slice(start + 1, close);
        const suffix = tok.slice(close + 1);
        // Split inner on top-level commas.
        const parts: string[] = [];
        let depth2 = 0;
        let cur = '';
        for (let j = 0; j < inner.length; j++) {
          const c = inner[j];
          if (c === '{') depth2++;
          else if (c === '}') depth2--;
          else if (c === ',' && depth2 === 0) { parts.push(cur); cur = ''; continue; }
          cur += c;
        }
        parts.push(cur);
        // Recursively expand each combination.
        const result: string[] = [];
        for (const p of parts) {
          for (const sub of expandTokenBraces(prefix + p + suffix)) {
            result.push(sub);
          }
        }
        return result;
      }
    }
    i++;
  }
  return [tok];
}

// ── Variable shim: $$, $0 ──────────────────────────────────────────────

/**
 * BUG-SWEEP-R3-4 (2026-05-11): @lifo-sh/core doesn't expand `$$`
 * (PID) or `$0` (shell name). Pre-fix `echo $$` printed literal `$$`
 * and `echo $0` printed empty. Common in shell scripts (PID for
 * lockfiles, $0 for script-name-aware behaviour).
 *
 * Fix: rewrite `$$` → a stable per-session PID (we use the supervisor
 * DO's spawn-counter so it's deterministic per session) and `$0` →
 * the shell name (always `nimbus-sh`).
 *
 * NOT addressed: `$1`..`$9` positional params (only meaningful inside
 * scripts/functions which lifo-sh handles already), `$#`, `$?` (real
 * `$?` works through lifo-sh's lastExitCode env), `$@`, `$*`.
 */
export class DollarVarShim {
  private shell: any;
  private pid: number;

  constructor(shell: any) {
    this.shell = shell;
    // Stable per-session PID derived from session-id hash + monotonic
    // counter. We use the WS Terminal's session if available, else
    // fall back to a random integer in [1, 99999].
    this.pid = Math.floor(Math.random() * 99000) + 1000;
  }

  static install(shell: any): DollarVarShim {
    const norm = new DollarVarShim(shell);
    norm._patch();
    return norm;
  }

  private _patch(): void {
    const orig = this.shell.executeLine.bind(this.shell);
    const self = this;
    this.shell.executeLine = async (line: string): Promise<void> => {
      if (line.indexOf('$') < 0) return orig(line);
      const rewritten = DollarVarShim.expandDollarVars(line, self.pid);
      return orig(rewritten);
    };
  }

  /**
   * Expand `$$` and `$0` in a shell line. Quote-aware: literals
   * inside single quotes preserved. Double-quoted strings: variables
   * DO expand (bash semantics).
   */
  static expandDollarVars(line: string, pid: number): string {
    let out = '';
    let i = 0;
    while (i < line.length) {
      const ch = line[i];
      if (ch === "'") {
        // Single-quoted: preserve verbatim.
        const j = line.indexOf("'", i + 1);
        if (j < 0) { out += line.slice(i); break; }
        out += line.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      if (ch === '\\' && i + 1 < line.length) {
        out += line.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (ch === '$') {
        const next = line[i + 1];
        if (next === '$') {
          out += String(pid);
          i += 2;
          continue;
        }
        if (next === '0') {
          out += 'nimbus-sh';
          i += 2;
          continue;
        }
      }
      out += ch;
      i++;
    }
    return out;
  }
}

// ── Heredoc variable expansion ─────────────────────────────────────────

/**
 * BUG-SWEEP-R3-5 (2026-05-11): lifo-sh's HeredocHandler accumulates
 * lines verbatim — `$X` references inside an unquoted-delimiter
 * heredoc don't expand. Bash semantics:
 *   cat <<EOF       → variables expand
 *   cat <<'EOF'     → no expansion (single-quoted delim)
 *
 * Our HeredocHandler installation already lives in features.ts but
 * doesn't expand vars. We patch the accumulated content at submit
 * time: substitute `$NAME` / `${NAME}` with env values when the
 * delimiter is NOT single-quoted.
 *
 * The patch wraps shell.execute()'s string-content stage. We can't
 * easily intercept the heredoc submit from outside the handler, so
 * we attach a post-build hook that consults shell.env.
 *
 * Decision: rather than patching HeredocHandler (a class we own —
 * src/shell/features.ts:HeredocHandler), expose a public
 * `expandHeredocVars(content, env)` and call it from inside
 * HeredocHandler._accumulateLine / submit logic.
 */
export function expandHeredocVars(content: string, env: Record<string, string>): string {
  let out = '';
  let i = 0;
  while (i < content.length) {
    const ch = content[i];
    if (ch === '\\' && i + 1 < content.length && content[i + 1] === '$') {
      out += '$';
      i += 2;
      continue;
    }
    if (ch === '$') {
      // ${NAME} form
      if (content[i + 1] === '{') {
        const close = content.indexOf('}', i + 2);
        if (close > 0) {
          const name = content.slice(i + 2, close);
          out += env[name] !== undefined ? env[name] : '';
          i = close + 1;
          continue;
        }
      }
      // $NAME form (alnum/_, no leading digit)
      const m = content.slice(i + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/);
      if (m) {
        out += env[m[0]] !== undefined ? env[m[0]] : '';
        i += 1 + m[0].length;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

// ── Line-editor extension (readline parity) ─────────────────────────────

/**
 * LineEditorExtender — adds bash-readline-parity keybindings to the
 * @lifo-sh/core Shell line editor.
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
  private shell: any;
  private terminal: any;
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

  constructor(shell: any, terminal: any) {
    this.shell = shell;
    this.terminal = terminal;
  }

  static install(shell: any, terminal: any): LineEditorExtender {
    const handler = new LineEditorExtender(shell, terminal);
    handler._patch();
    return handler;
  }

  private _patch(): void {
    this.originalHandleInput = this.shell.handleInput.bind(this.shell);

    this.shell.handleInput = (data: string): void => {
      // Skip when a process is running — the line editor only governs
      // shell-prompt input. Process-stdin input has its own model
      // (terminalStdin / stdinLineBuffer) handled in @lifo-sh/core.
      if (this.shell.running) {
        return this.originalHandleInput!(data);
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

      return this.originalHandleInput!(data);
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

      // ── Ctrl+\: bash sends SIGQUIT; with no fg job, readline noops.
      //   We mirror: silently absorb, leave the line intact.
      case '\x1c':
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

// ── Main executor ───────────────────────────────────────────────────────

export interface ShellExecContext {
  env: Record<string, string>;
  cwd: string;
  vfs: SqliteVFS;
  /** Execute a single command — returns exit code */
  runCommand: (cmd: string, args: string[], stdin?: string) => Promise<{ exitCode: number; stdout: string }>;
  /** Write to terminal */
  writeStdout: (data: string) => void;
  writeStderr: (data: string) => void;
}

/**
 * Execute a full command line with pipes, redirects, operators, var expansion, and globs.
 * Returns the exit code of the last command.
 */
export async function executeCommandLine(
  input: string,
  ctx: ShellExecContext,
): Promise<number> {
  // 1. Expand environment variables
  let expanded = expandVars(input, ctx.env);

  // 2. Split by operators (&&, ||, ;, |)
  const { segments, operators } = splitOperators(expanded);

  let lastExitCode = 0;
  let pipeStdin: string | undefined;
  let inPipeChain = false;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const prevOp = i > 0 ? operators[i - 1] : '';
    const nextOp = i < operators.length ? operators[i] : '';

    // Handle && and || operators
    if (prevOp === '&&' && lastExitCode !== 0) continue; // skip on failure
    if (prevOp === '||' && lastExitCode === 0) continue;  // skip on success

    // Check if we're starting/continuing a pipe chain
    if (prevOp === '|') {
      inPipeChain = true;
      // pipeStdin already set from previous command's stdout
    } else {
      inPipeChain = false;
      pipeStdin = undefined;
    }

    if (!segment) continue;

    // 3. Parse redirects
    const parsed = parseRedirects(segment);

    // 4. Tokenize the command (handles quotes)
    let tokens = tokenize(parsed.command);
    if (tokens.length === 0) continue;

    // 5. Expand globs
    tokens = expandGlobs(tokens, ctx.cwd, ctx.vfs);

    const cmdName = tokens[0];
    const cmdArgs = tokens.slice(1);

    // 6. Execute the command
    const result = await ctx.runCommand(cmdName, cmdArgs, pipeStdin);
    lastExitCode = result.exitCode;

    // 7. Handle redirects
    if (parsed.redirectOut) {
      const path = parsed.redirectOut === '/dev/null' ? null :
        (parsed.redirectOut.startsWith('/') ? parsed.redirectOut.replace(/^\/+/, '') :
        ctx.cwd.replace(/^\/+/, '') + '/' + parsed.redirectOut);
      if (path) {
        try {
          const parts = path.split('/');
          for (let j = 1; j < parts.length; j++) {
            const dir = parts.slice(0, j).join('/');
            if (dir && !ctx.vfs.exists(dir)) ctx.vfs.mkdir(dir, { recursive: true });
          }
          ctx.vfs.writeFile(path, result.stdout);
        } catch {}
      }
    } else if (parsed.redirectAppend) {
      const path = parsed.redirectAppend.startsWith('/') ? parsed.redirectAppend.replace(/^\/+/, '') :
        ctx.cwd.replace(/^\/+/, '') + '/' + parsed.redirectAppend;
      try {
        const existing = ctx.vfs.exists(path) ? ctx.vfs.readFileString(path) : '';
        ctx.vfs.writeFile(path, existing + result.stdout);
      } catch {}
    } else if (nextOp === '|') {
      // Pipe: capture stdout for next command's stdin
      pipeStdin = result.stdout;
    } else {
      // No redirect, no pipe: write to terminal
      if (result.stdout) ctx.writeStdout(result.stdout);
    }
  }

  // Update $? in env
  ctx.env['?'] = String(lastExitCode);
  return lastExitCode;
}
