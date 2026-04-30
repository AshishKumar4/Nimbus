/**
 * shell-features.ts — Shell preprocessor for pipes, redirects, operators,
 * env var expansion, glob expansion, and quoted strings.
 *
 * Wraps the LIFO shell's command execution with Unix-like features.
 * Called from nimbus-session.ts before dispatching to the registry.
 */

import type { SqliteVFS } from './sqlite-vfs.js';

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
    const content = this.lines.join('\n') + '\n';

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
