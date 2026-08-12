import type { ITerminal } from '../terminal/ITerminal.js';
import type { VFS } from '../kernel/vfs/index.js';
import type { CommandRegistry } from '../commands/registry.js';
import type { CommandInputStream, CommandOutputStream } from '../commands/types.js';
import type { CommandContext, CommandRunAsHost } from '../commands/types.js';
import type { VfsCred } from '../../../runtime/os-contracts.js';
import type { TerminalInputStream } from '../commands/types.js';
import { resolve } from '../utils/path.js';
import { BOLD, GREEN, BLUE, RESET } from '../utils/colors.js';
import { VFSError } from '../kernel/vfs/index.js';
import {
  ExitSignal,
  Interpreter,
  type BuiltinExecutionContext,
  type BuiltinFn,
  type InterpreterConfig,
  type ShellOptions,
  type TerminalFdState,
} from './interpreter.js';
import { HistoryManager } from './history.js';
import { JobTable } from './jobs.js';
import { ProcessRegistry } from './ProcessRegistry.js';
import { signalAbortReason } from './signals.js';
import { complete, type CompletionContext } from './completer.js';
import { evaluateTest } from './test-builtin.js';
import { TerminalStdin } from './terminal-stdin.js';
import { normalizeTerminalNewlines } from '../../../_shared/terminal.js';
import { readDefaultShell } from './default-shell.js';

function shellPromptParts(env: Record<string, string>, cwd: string): {
  displayPath: string;
  user: string;
  host: string;
} {
  const home = env['HOME'] ?? '/home/user';
  let displayPath = cwd;
  if (cwd === home) {
    displayPath = '~';
  } else if (cwd.startsWith(home + '/')) {
    displayPath = '~' + cwd.slice(home.length);
  }
  return {
    displayPath,
    user: env['USER'] ?? 'user',
    host: env['HOSTNAME'] ?? 'lifo',
  };
}

export function formatShellPrompt(env: Record<string, string>, cwd: string): string {
  const { displayPath, user, host } = shellPromptParts(env, cwd);
  return `${BOLD}${GREEN}${user}@${host}${RESET}:${BOLD}${BLUE}${displayPath}${RESET}$ `;
}

export interface ExecuteOptions {
  cwd?: string;
  env?: Record<string, string>;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  stdin?: string;
  terminalStdin?: TerminalInputStream;
  signal?: AbortSignal;
  runExitTrap?: boolean;
  isolateShellState?: boolean;
  shellOptions?: Partial<ShellOptions>;
  scriptMode?: boolean;
  terminalFds?: TerminalFdState;
  /**
   * Host-supplied fields merged into the `CommandContext` of every command in
   * this execution. The shell substrate treats them as opaque; Nimbus runtime
   * commands read `__nimbusBinSpawn`/bundle hints off the context. Used to hand
   * a long-running registry command (vite/wrangler/serve) the wrapper pid the
   * caller already allocated instead of letting it spawn a second one.
   */
  commandContext?: Record<string, unknown>;
  runAs?: CommandRunAsHost;
}

export interface ShellCommandIdentity {
  pid: number;
  cred: VfsCred;
  setUmask(mask: number): void;
  runAs?: CommandRunAsHost;
}

export class Shell {
  private terminal: ITerminal;
  private vfs: VFS;
  private registry: CommandRegistry;
  cwd: string;
  env: Record<string, string>;

  // Alias map
  private aliases = new Map<string, string>();

  // Line editing state
  lineBuffer: string = '';
  cursorPos: number = 0;
  screenCursorRow: number = 0; // tracks the actual terminal row (relative to prompt start)

  // History (legacy array kept for backward compat with tests)
  history: string[] = [];
  historyIndex: number = -1;
  private savedLine: string = '';

  // Running command
  running: boolean = false;
  private abortController: AbortController | null = null;
  private terminalStdin: TerminalStdin | null = null;
  private stdinLineBuffer: string = '';
  private stdinCursorPos: number = 0;

  // New Sprint 2 components
  private interpreter: Interpreter;
  private interpreterConfig: InterpreterConfig;
  private historyManager: HistoryManager;
  private jobTable: JobTable;
  private processRegistry: ProcessRegistry;
  private builtins: Map<string, BuiltinFn>;
  private shellOptions: ShellOptions = {
    errexit: false,
    nounset: false,
    pipefail: false,
  };
  private traps = new Map<string, string>();
  private readonlyNames = new Set<string>();
  private commandIdentity: ShellCommandIdentity;

  // Tab completion state
  private tabCount: number = 0;

  // Paste queue for multiline paste support
  pasteQueue: string[] = [];

  /**
   * Keystrokes that arrived while a foreground command owned the terminal and
   * nothing was reading stdin. A tty buffers type-ahead and hands it to the
   * shell when the job exits; dropping it loses whatever the user typed, and
   * when a dispatch never settles it leaves that connection with no feedback
   * whatsoever. Held as whole chunks so a multi-byte escape sequence replays
   * as one keystroke rather than three.
   */
  typeAhead: string[] = [];

  constructor(
    terminal: ITerminal,
    vfs: VFS,
    registry: CommandRegistry,
    env: Record<string, string>,
    processRegistry: ProcessRegistry,
    commandIdentity?: ShellCommandIdentity,
  ) {
    this.terminal = terminal;
    this.vfs = vfs;
    this.registry = registry;
    this.cwd = env['HOME'] ?? '/home/user';
    this.env = { ...env };
    if (!this.env['0']) this.env['0'] = 'nimbus-sh';
    if (!this.env['$']) this.env['$'] = String(processRegistry.registerShell(this.cwd, this.env));
    let defaultCred: VfsCred = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
    this.commandIdentity = commandIdentity ?? {
      pid: Number(this.env['$']),
      get cred() { return defaultCred; },
      setUmask: (mask) => {
        defaultCred = { ...defaultCred, umask: mask };
      },
    };

    // Initialize builtins
    this.builtins = new Map<string, BuiltinFn>();
    this.registerBuiltins();

    // Initialize job table (legacy - still used for backward compat)
    this.jobTable = new JobTable();

    // Use shared process registry from Kernel
    this.processRegistry = processRegistry;

    // Initialize history manager
    this.historyManager = new HistoryManager(vfs);
    this.historyManager.load();

    // Initialize interpreter
    this.interpreterConfig = {
      env: this.env,
      getCwd: () => this.cwd,
      setCwd: (cwd: string) => { this.cwd = cwd; },
      vfs: this.vfs,
      registry: this.registry,
      builtins: this.builtins,
      jobTable: this.jobTable,
      processRegistry: this.processRegistry,
      writeToTerminal: (text: string) => this.writeToTerminal(text),
      aliases: this.aliases,
      getAbortSignal: () => this.abortController?.signal ?? new AbortController().signal,
      options: this.shellOptions,
      traps: this.traps,
      readonlyNames: this.readonlyNames,
    };
    this.interpreter = new Interpreter(this.interpreterConfig);
  }

  private registerBuiltins(): void {
    this.builtins.set('cd', (args, _stdout, stderr) => this.builtinCd(args, stderr));
    this.builtins.set('pwd', (_args, stdout) => this.builtinPwd(stdout));
    this.builtins.set('echo', (args, stdout) => this.builtinEcho(args, stdout));
    this.builtins.set('clear', () => this.builtinClear());
    this.builtins.set('export', (args, _stdout, stderr) => this.builtinExport(args, stderr));
    this.builtins.set('exit', (args, _stdout, stderr) => this.builtinExit(args, stderr));
    this.builtins.set('true', () => Promise.resolve(0));
    this.builtins.set('false', () => Promise.resolve(1));
    this.builtins.set(':', () => Promise.resolve(0));
    this.builtins.set('set', (args, stdout, stderr, _stdin, context) => this.builtinSet(args, stdout, stderr, context));
    this.builtins.set('shift', (args, _stdout, stderr, _stdin, context) => this.builtinShift(args, stderr, context));
    this.builtins.set('trap', (args, stdout, stderr) => this.builtinTrap(args, stdout, stderr));
    this.builtins.set('hash', (args, stdout, stderr) => this.builtinHash(args, stdout, stderr));
    this.builtins.set('readonly', (args, stdout, stderr) => this.builtinReadonly(args, stdout, stderr));
    this.builtins.set('read', (args, _stdout, stderr, stdin, context) => this.builtinRead(args, stdin, stderr, context));
    this.builtins.set('wait', (args, _stdout, stderr) => this.builtinWait(args, stderr));
    this.builtins.set('unset', (args, _stdout, stderr) => this.builtinUnset(args, stderr));
    this.builtins.set('jobs', (_args, stdout) => this.builtinJobs(stdout));
    this.builtins.set('fg', (args, stdout, stderr) => this.builtinFg(args, stdout, stderr));
    this.builtins.set('bg', (args, stdout, stderr) => this.builtinBg(args, stdout, stderr));
    this.builtins.set('history', (_args, stdout) => this.builtinHistory(stdout));
    this.builtins.set('source', (args, stdout, stderr, _stdin, context) => this.builtinSource(args, stdout, stderr, context));
    this.builtins.set('.', (args, stdout, stderr, _stdin, context) => this.builtinSource(args, stdout, stderr, context));
    this.builtins.set('alias', (args, stdout) => this.builtinAlias(args, stdout));
    this.builtins.set('unalias', (args, _stdout, stderr) => this.builtinUnalias(args, stderr));
    this.builtins.set('test', (args, _stdout, stderr, _stdin, context) =>
      evaluateTest(args, context?.vfs ?? this.vfs, stderr, context));
    this.builtins.set('[', (args, _stdout, stderr, _stdin, context) =>
      evaluateTest(args, context?.vfs ?? this.vfs, stderr, context));
  }

  getJobTable(): JobTable {
    return this.jobTable;
  }

  getProcessRegistry(): ProcessRegistry {
    return this.processRegistry;
  }

  getCwd(): string {
    return this.cwd;
  }

  setCwd(cwd: string): void {
    this.cwd = cwd;
  }

  getEnv(): Record<string, string> {
    return this.env;
  }

  getVfs(): VFS {
    return this.vfs;
  }

  getRegistry(): CommandRegistry {
    return this.registry;
  }

  /**
   * Programmatic command execution with captured stdout/stderr.
   * Used by Sandbox.commands.run() for headless mode.
   */
  private _executeDepth = 0;

  async execute(
    cmd: string,
    options?: ExecuteOptions,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    this._executeDepth++;
    if (this._executeDepth > 10) {
      this._executeDepth--;
      const msg = `shell.execute: recursion depth exceeded (cmd="${cmd}")\n`;
      options?.onStderr?.(msg);
      return { stdout: '', stderr: msg, exitCode: 1 };
    }
    let stdoutBuf = '';
    let stderrBuf = '';

    const stdoutStream: CommandOutputStream = {
      write: (text: string) => {
        stdoutBuf += text;
        options?.onStdout?.(text);
      },
    };
    const stderrStream: CommandOutputStream = {
      write: (text: string) => {
        stderrBuf += text;
        options?.onStderr?.(text);
      },
    };

    // Save current state
    const prevCwd = options?.cwd ? this.cwd : undefined;
    const savedShellState = options?.isolateShellState ? this.snapshotShellState() : null;
    const envOverrideSnapshot = !savedShellState && options?.env
      ? snapshotEnvKeys(this.env, Object.keys(options.env))
      : null;
    const optionSnapshot = !savedShellState && options?.shellOptions ? { ...this.shellOptions } : null;
    const abortController = new AbortController();
    const abortFromCaller = () => abortController.abort(options?.signal?.reason);
    if (options?.signal) {
      if (options.signal.aborted) abortFromCaller();
      else options.signal.addEventListener('abort', abortFromCaller, { once: true });
    }
    // Per-execution capture sink for shell-level direct-terminal writes
    // (`/dev/tty`, command-stdout fallback). Threaded through `executeLine`
    // options so a nested `execute` never mutates shared interpreter config the
    // parent command's late-bound closures read.
    const writeToTerminal = (text: string) => {
      stderrBuf += text;
      options?.onStderr?.(text);
    };

    // Apply per-call overrides
    if (options?.cwd) {
      this.cwd = options.cwd;
    }
    if (options?.env) {
      Object.assign(this.env, options.env);
    }
    if (options?.shellOptions) {
      Object.assign(this.shellOptions, options.shellOptions);
    }

    let stdinStream: CommandInputStream | undefined;
    if (options?.stdin !== undefined) {
      const fixedStdin = new TerminalStdin();
      fixedStdin.feed(options.stdin);
      fixedStdin.close();
      stdinStream = fixedStdin;
    }

    try {
      const exitCode = await this.interpreter.executeLine(
        cmd,
        options?.terminalStdin,
        {
          runExitTrap: options?.runExitTrap === true,
          stdin: stdinStream,
          stdout: stdoutStream,
          stderr: stderrStream,
          writeToTerminal,
          terminalFds: options?.terminalFds,
          scriptMode: options?.scriptMode === true,
          commandContext: options?.commandContext,
          commandIdentity: this.resolveCommandIdentity(options?.commandContext),
          runAs: options?.runAs ?? this.commandIdentity.runAs,
          signal: abortController.signal,
        },
      );
      return { stdout: stdoutBuf, stderr: stderrBuf, exitCode };
    } catch (e) {
      const msg = e instanceof Error ? (e.stack || e.message) : String(e);
      stderrBuf += msg + '\n';
      options?.onStderr?.(msg + '\n');
      return { stdout: stdoutBuf, stderr: stderrBuf, exitCode: 1 };
    } finally {
      this._executeDepth--;
      // Restore state
      if (options?.signal) {
        options.signal.removeEventListener('abort', abortFromCaller);
      }
      if (savedShellState) {
        this.restoreShellState(savedShellState);
      } else {
        if (envOverrideSnapshot) restoreEnvKeys(this.env, envOverrideSnapshot);
        if (optionSnapshot) restoreShellOptions(this.shellOptions, optionSnapshot);
      }
      if (prevCwd !== undefined) {
        this.cwd = prevCwd;
      }
    }
  }

  private resolveCommandIdentity(overrides: Record<string, unknown> | undefined): ShellCommandIdentity {
    const pid = overrides?.['pid'];
    const cred = overrides?.['cred'];
    const setUmask = overrides?.['setUmask'];
    return {
      pid: typeof pid === 'number' ? pid : this.commandIdentity.pid,
      cred: isVfsCred(cred) ? cred : this.commandIdentity.cred,
      setUmask: typeof setUmask === 'function'
        ? (mask) => setUmask(mask)
        : this.commandIdentity.setUmask,
      runAs: this.commandIdentity.runAs,
    };
  }

  start(): void {
    // Register this shell instance as a process
    // First shell gets PID 1, subsequent shells get PID 2, 3, etc.
    const pid = this.processRegistry.registerShell(this.cwd, this.env);
    this.env['$'] = String(pid);

    this.terminal.onData((data) => this.handleInput(data));

    // Source rc files on startup (like bash/zsh)
    this.sourceRcFiles().then(async () => {
      const home = this.env['HOME'] ?? '/home/user';
      if (readDefaultShell(this.vfs, home) === 'bash') {
        await this.executeLine('bash -i');
      } else {
        this.printPrompt();
      }
    });
  }

  private async sourceRcFiles(): Promise<void> {
    const home = this.env['HOME'] ?? '/home/user';

    // Source system-wide profile first
    await this.sourceFile('/etc/profile');

    // Then user rc files (first one found wins, like bash)
    const rcFiles = [
      `${home}/.liforc`,
      `${home}/.bashrc`,
      `${home}/.profile`,
    ];

    for (const rc of rcFiles) {
      if (this.vfs.exists(rc)) {
        await this.sourceFile(rc);
        break;
      }
    }
  }

  printPrompt(): void {
    // Report finished background jobs from JobTable (legacy)
    const doneJobs = this.jobTable.collectDone();
    for (const job of doneJobs) {
      this.writeToTerminal(`[${job.id}] Done    ${job.command}\n`);
    }

    // Collect and reap zombie processes from ProcessRegistry
    this.processRegistry.collectZombies();
    // Zombies are already logged by JobTable above, so no need to log again

    this.terminal.write(formatShellPrompt(this.env, this.cwd));
  }

  handleInput(data: string): void {
    // Raw mode: bypass all shell line editing, deliver keypresses directly
    if (this.running && this.terminalStdin?.rawMode) {
      this.terminalStdin.feed(data);
      return;
    }

    // Multiline paste detection: if data contains newlines and has multiple chars,
    // split into lines and execute them sequentially via the paste queue
    if (!this.running && data.length > 1 && /[\r\n]/.test(data)) {
      const lines = data.split(/\r\n|\r|\n/);
      for (let i = 0; i < lines.length; i++) {
        const segment = lines[i];
        if (i === 0) {
          // First segment: append to current lineBuffer and execute
          if (segment) {
            this.lineBuffer = this.lineBuffer.slice(0, this.cursorPos) + segment + this.lineBuffer.slice(this.cursorPos);
            this.cursorPos += segment.length;
          }
          if (i < lines.length - 1) {
            // There's a newline after this segment, execute it
            this.redrawLine();
            this.terminal.write('\r\n');
            const line = this.lineBuffer.trim();
            this.lineBuffer = '';
            this.cursorPos = 0;
            this.historyIndex = -1;
            if (line) {
              this.history.push(line);
              // Queue remaining lines before executing
              for (let j = 1; j < lines.length - 1; j++) {
                if (lines[j]) this.pasteQueue.push(lines[j]);
              }
              // Last segment (after final newline) goes into lineBuffer without executing
              const lastSegment = lines[lines.length - 1];
              if (lastSegment) {
                this.pasteQueue.push(lastSegment);
              }
              this.executeLine(line);
              return;
            } else {
              // Empty first line, queue the rest
              for (let j = 1; j < lines.length - 1; j++) {
                if (lines[j]) this.pasteQueue.push(lines[j]);
              }
              const lastSegment = lines[lines.length - 1];
              if (lastSegment) {
                this.pasteQueue.push(lastSegment);
              }
              this.drainPasteQueue();
              return;
            }
          }
        }
      }
      // If we get here, data had newlines but only one segment (shouldn't happen)
      // Fall through to normal handling
      if (this.lineBuffer) this.redrawLine();
      return;
    }

    // ESC sequences. Cursor motion and history are line EDITING, so they only
    // belong to a shell that owns the line. While a command runs they must
    // fall through: to the stdin reader that has its own cursor (and its own
    // handlers for these very sequences), or to the type-ahead buffer.
    if (!this.running) {
      if (data === '\x1b[D') { this.moveCursorLeft(); return; }
      if (data === '\x1b[C') { this.moveCursorRight(); return; }
      if (data === '\x1b[A') { this.historyUp(); return; }
      if (data === '\x1b[B') { this.historyDown(); return; }
      if (data === '\x1b[H' || data === '\x01') { this.moveCursorHome(); return; } // Home / Ctrl+A
      if (data === '\x1b[F' || data === '\x05') { this.moveCursorEnd(); return; }  // End / Ctrl+E
    }

    // Ctrl+C (SIGINT) and Ctrl+\ (SIGQUIT) — the terminal's two signal keys.
    // Both go to the foreground command; with no foreground job, Ctrl+C
    // cancels the line and Ctrl+\ is absorbed, as readline does.
    if (data === '\x03' || data === '\x1c') {
      const signal = data === '\x03' ? 'INT' : 'QUIT';
      if (this.running && this.abortController) {
        this.terminalStdin?.close();
        this.stdinLineBuffer = '';
        this.stdinCursorPos = 0;
        this.abortController.abort(signalAbortReason(signal));
      } else if (signal === 'INT') {
        this.terminal.write('^C\r\n');
        this.lineBuffer = '';
        this.cursorPos = 0;
        this.screenCursorRow = 0;
        this.printPrompt();
      }
      return;
    }

    // Ctrl+D (EOF)
    if (data === '\x04') {
      if (this.running && this.terminalStdin && this.stdinLineBuffer.length === 0) {
        this.terminalStdin.close();
        return;
      }
      // When not running, Ctrl+D on empty line does nothing (or could exit)
      return;
    }

    // Ctrl+U -- clear line
    if (data === '\x15') {
      if (this.running && this.terminalStdin?.isWaiting) {
        // Clear the stdin line buffer
        if (this.stdinCursorPos > 0) {
          this.terminal.write(`\x1b[${this.stdinCursorPos}D`);
        }
        this.terminal.write('\x1b[K');
        this.stdinLineBuffer = '';
        this.stdinCursorPos = 0;
        return;
      }
      // Use redrawLine to clear wrapped content, then reset
      this.lineBuffer = '';
      this.cursorPos = 0;
      this.redrawLine();
      return;
    }

    // When a command is running and waiting for stdin, forward input
    if (this.running && this.terminalStdin?.isWaiting) {
      this.handleStdinInput(data);
      return;
    }

    // A foreground command owns the line editor and nothing is reading stdin,
    // so this is type-ahead. Echo it — that is what a tty does, and it is the
    // only sign of life a wedged dispatch can give — then hold it for replay.
    if (this.running) {
      this.typeAhead.push(data);
      if (data === '\r') this.terminal.write('\r\n');
      else if (data >= ' ' && data !== '\x7f') this.terminal.write(normalizeTerminalNewlines(data));
      return;
    }

    // Tab completion
    if (data === '\t') {
      this.handleTab();
      return;
    }

    // Reset tab state on any non-tab input
    this.tabCount = 0;

    // Enter
    if (data === '\r') {
      this.terminal.write('\r\n');
      const line = this.lineBuffer.trim();
      this.lineBuffer = '';
      this.cursorPos = 0;
      this.screenCursorRow = 0;
      this.historyIndex = -1;

      if (line) {
        this.history.push(line);
        this.executeLine(line);
      } else {
        this.printPrompt();
      }
      return;
    }

    // Backspace
    if (data === '\x7f' || data === '\b') {
      if (this.cursorPos > 0) {
        const before = this.lineBuffer.slice(0, this.cursorPos - 1);
        const after = this.lineBuffer.slice(this.cursorPos);
        this.lineBuffer = before + after;
        this.cursorPos--;
        this.redrawLine();
      }
      return;
    }

    // Delete
    if (data === '\x1b[3~') {
      if (this.cursorPos < this.lineBuffer.length) {
        const before = this.lineBuffer.slice(0, this.cursorPos);
        const after = this.lineBuffer.slice(this.cursorPos + 1);
        this.lineBuffer = before + after;
        this.redrawLine();
      }
      return;
    }

    // Printable characters
    if (data >= ' ') {
      // Insert at cursor
      const before = this.lineBuffer.slice(0, this.cursorPos);
      const after = this.lineBuffer.slice(this.cursorPos);
      this.lineBuffer = before + data + after;
      this.cursorPos += data.length;
      this.redrawLine();
    }
  }

  private handleTab(): void {
    const completionCtx: CompletionContext = {
      line: this.lineBuffer,
      cursorPos: this.cursorPos,
      cwd: this.cwd,
      env: this.env,
      vfs: this.vfs,
      registry: this.registry,
      builtinNames: [...this.builtins.keys()],
    };

    const result = complete(completionCtx);
    const currentWord = this.lineBuffer.slice(result.replacementStart, result.replacementEnd);

    if (result.completions.length === 0) {
      // No completions -- bell
      this.terminal.write('\x07');
      return;
    }

    if (result.completions.length === 1) {
      // Single completion -- insert it
      const completion = result.completions[0];
      const suffix = completion.endsWith('/') ? '' : ' ';
      this.applyCompletion(result.replacementStart, result.replacementEnd, completion + suffix);
      this.tabCount = 0;
      return;
    }

    // Multiple completions
    if (result.commonPrefix.length > currentWord.length) {
      // Extend to common prefix
      this.applyCompletion(result.replacementStart, result.replacementEnd, result.commonPrefix);
      this.tabCount = 0;
      return;
    }

    // Same word as before -- second tab shows all completions
    this.tabCount++;
    if (this.tabCount >= 2) {
      this.terminal.write('\r\n');
      this.writeToTerminal(result.completions.join('  ') + '\n');
      this.printPrompt();
      this.terminal.write(this.lineBuffer);
      // Move cursor to correct position
      const diff = this.lineBuffer.length - this.cursorPos;
      if (diff > 0) {
        this.terminal.write(`\x1b[${diff}D`);
      }
      this.tabCount = 0;
    }
  }

  private handleStdinInput(data: string): void {
    if (data.length > 1 && !isTerminalControlSequence(data)) {
      for (const ch of data) this.handleStdinInput(ch);
      return;
    }

    // Arrow keys for line editing
    if (data === '\x1b[D') {
      // Left arrow
      if (this.stdinCursorPos > 0) {
        this.stdinCursorPos--;
        this.terminal.write('\x1b[D');
      }
      return;
    }
    if (data === '\x1b[C') {
      // Right arrow
      if (this.stdinCursorPos < this.stdinLineBuffer.length) {
        this.stdinCursorPos++;
        this.terminal.write('\x1b[C');
      }
      return;
    }
    if (data === '\x1b[H' || data === '\x01') {
      // Home / Ctrl+A
      if (this.stdinCursorPos > 0) {
        this.terminal.write(`\x1b[${this.stdinCursorPos}D`);
        this.stdinCursorPos = 0;
      }
      return;
    }
    if (data === '\x1b[F' || data === '\x05') {
      // End / Ctrl+E
      const diff = this.stdinLineBuffer.length - this.stdinCursorPos;
      if (diff > 0) {
        this.terminal.write(`\x1b[${diff}C`);
        this.stdinCursorPos = this.stdinLineBuffer.length;
      }
      return;
    }

    // Ignore other escape sequences (up/down arrows, etc.)
    if (data.startsWith('\x1b')) return;

    // Enter -- feed line to stdin
    if (data === '\r') {
      this.terminal.write('\r\n');
      this.terminalStdin!.feed(this.stdinLineBuffer + '\n');
      this.stdinLineBuffer = '';
      this.stdinCursorPos = 0;
      return;
    }

    // Backspace
    if (data === '\x7f' || data === '\b') {
      if (this.stdinCursorPos > 0) {
        const before = this.stdinLineBuffer.slice(0, this.stdinCursorPos - 1);
        const after = this.stdinLineBuffer.slice(this.stdinCursorPos);
        this.stdinLineBuffer = before + after;
        this.stdinCursorPos--;
        // Redraw: move back, write rest + space to clear, reposition cursor
        this.terminal.write('\b' + after + ' ');
        // Move cursor back to position
        const moveBack = after.length + 1;
        if (moveBack > 0) {
          this.terminal.write(`\x1b[${moveBack}D`);
        }
      }
      return;
    }

    // Printable characters
    if (data >= ' ') {
      const before = this.stdinLineBuffer.slice(0, this.stdinCursorPos);
      const after = this.stdinLineBuffer.slice(this.stdinCursorPos);
      this.stdinLineBuffer = before + data + after;
      this.stdinCursorPos += data.length;
      // Write char + rest of line, reposition cursor
      this.terminal.write(data + after);
      if (after.length > 0) {
        this.terminal.write(`\x1b[${after.length}D`);
      }
    }
  }

  private applyCompletion(start: number, end: number, text: string): void {
    const before = this.lineBuffer.slice(0, start);
    const after = this.lineBuffer.slice(end);
    this.lineBuffer = before + text + after;
    this.cursorPos = start + text.length;
    this.redrawLine();
  }

  private getPromptWidth(): number {
    const { displayPath, user, host } = shellPromptParts(this.env, this.cwd);
    // "user@host:path$ " — count visible chars only (no ANSI codes)
    return user.length + 1 + host.length + 1 + displayPath.length + 2;
  }

  redrawLine(): void {
    const cols = this.terminal.cols;
    const promptWidth = this.getPromptWidth();
    const totalLen = promptWidth + this.lineBuffer.length;

    // Move up from wherever the cursor actually is to the prompt start row
    if (this.screenCursorRow > 0) {
      this.terminal.write(`\x1b[${this.screenCursorRow}A`);
    }
    this.terminal.write('\r');

    // Clear from here to end of screen
    this.terminal.write('\x1b[J');

    // Rewrite prompt + buffer
    this.terminal.write(formatShellPrompt(this.env, this.cwd));
    this.terminal.write(this.lineBuffer);

    // After writing all content, figure out which row the cursor is on.
    // If content exactly fills N rows, the terminal auto-wraps cursor to the next row.
    let endRow: number;
    if (totalLen > 0 && totalLen % cols === 0) {
      endRow = totalLen / cols; // cursor wraps to one row past the last content row
    } else {
      endRow = Math.floor(totalLen / cols);
    }

    // Position cursor at the desired column
    const desiredCol = promptWidth + this.cursorPos;
    const desiredRow = Math.floor(desiredCol / cols);

    // Move up from content end to desired row
    const rowDiff = endRow - desiredRow;
    if (rowDiff > 0) {
      this.terminal.write(`\x1b[${rowDiff}A`);
    }
    // Move to correct column within the row
    const colInRow = desiredCol % cols;
    this.terminal.write('\r');
    if (colInRow > 0) {
      this.terminal.write(`\x1b[${colInRow}C`);
    }

    // Track where we left the cursor
    this.screenCursorRow = desiredRow;
  }

  /**
   * Replay buffered type-ahead through the line editor. Stops the moment a
   * replayed keystroke starts a command: the rest stays queued and is
   * delivered when that one settles, so a queued line is never fed into a
   * shell that is busy again.
   */
  drainTypeAhead(): void {
    while (!this.running && this.typeAhead.length > 0) {
      this.handleInput(this.typeAhead.shift()!);
    }
  }

  drainPasteQueue(): void {
    const next = this.pasteQueue.shift();
    if (next !== undefined) {
      const line = next.trim();
      if (line) {
        this.terminal.write(line);
        this.terminal.write('\r\n');
        this.history.push(line);
        this.executeLine(line);
      } else {
        // Skip empty lines, try next
        this.drainPasteQueue();
      }
    }
  }

  private moveCursorLeft(): void {
    if (this.cursorPos > 0) {
      this.cursorPos--;
      this.terminal.write('\x1b[D');
    }
  }

  private moveCursorRight(): void {
    if (this.cursorPos < this.lineBuffer.length) {
      this.cursorPos++;
      this.terminal.write('\x1b[C');
    }
  }

  private moveCursorHome(): void {
    if (this.cursorPos > 0) {
      this.terminal.write(`\x1b[${this.cursorPos}D`);
      this.cursorPos = 0;
    }
  }

  private moveCursorEnd(): void {
    const diff = this.lineBuffer.length - this.cursorPos;
    if (diff > 0) {
      this.terminal.write(`\x1b[${diff}C`);
      this.cursorPos = this.lineBuffer.length;
    }
  }

  private historyUp(): void {
    if (this.history.length === 0) return;

    if (this.historyIndex === -1) {
      this.savedLine = this.lineBuffer;
      this.historyIndex = this.history.length - 1;
    } else if (this.historyIndex > 0) {
      this.historyIndex--;
    } else {
      return;
    }

    this.lineBuffer = this.history[this.historyIndex];
    this.cursorPos = this.lineBuffer.length;
    this.redrawLine();
  }

  private historyDown(): void {
    if (this.historyIndex === -1) return;

    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex++;
      this.lineBuffer = this.history[this.historyIndex];
    } else {
      this.historyIndex = -1;
      this.lineBuffer = this.savedLine;
    }

    this.cursorPos = this.lineBuffer.length;
    this.redrawLine();
  }

  async executeLine(line: string): Promise<void> {
    // History expansion
    const expanded = this.historyManager.expand(line);
    const actualLine = expanded ?? line;

    if (expanded !== null) {
      // Show the expanded command
      this.writeToTerminal(actualLine + '\n');
    }

    // Add to history
    this.historyManager.add(actualLine);

    this.running = true;
    this.abortController = new AbortController();
    this.terminalStdin = new TerminalStdin();

    try {
      await this.interpreter.executeLine(actualLine, this.terminalStdin, {
        commandIdentity: this.commandIdentity,
        runAs: this.commandIdentity.runAs,
        signal: this.abortController.signal,
      });
    } finally {
      this.terminalStdin?.close();
      this.terminalStdin = null;
      this.stdinLineBuffer = '';
      this.stdinCursorPos = 0;
      this.running = false;
      this.abortController = null;
    }

    this.printPrompt();
    this.drainPasteQueue();
    this.drainTypeAhead();
  }

  // ─── Builtins (now with stdout/stderr params for pipe support) ───

  private async builtinCd(args: string[], stderr: CommandOutputStream): Promise<number> {
    const target = args[0] ?? this.env['HOME'] ?? '/home/user';
    let newPath: string;

    if (target === '-') {
      newPath = this.env['OLDPWD'] ?? this.cwd;
    } else if (target === '~' || target.startsWith('~/')) {
      const home = this.env['HOME'] ?? '/home/user';
      newPath = target === '~' ? home : resolve(home, target.slice(2));
    } else {
      newPath = resolve(this.cwd, target);
    }

    try {
      const stat = this.vfs.stat(newPath);
      if (stat.type !== 'directory') {
        stderr.write(`cd: ${target}: Not a directory\n`);
        return 1;
      }
      this.env['OLDPWD'] = this.cwd;
      this.cwd = newPath;
      return 0;
    } catch (e) {
      if (e instanceof VFSError) {
        stderr.write(`cd: ${target}: ${e.message}\n`);
        return 1;
      }
      throw e;
    }
  }

  private async builtinPwd(stdout: CommandOutputStream): Promise<number> {
    stdout.write(this.cwd + '\n');
    return 0;
  }

  private async builtinEcho(args: string[], stdout: CommandOutputStream): Promise<number> {
    let interpretEscapes = false;
    let suppressNewline = false;
    let i = 0;

    while (i < args.length) {
      const arg = args[i];
      if (arg === '--') {
        i++;
        break;
      }
      if (arg === '-n') {
        suppressNewline = true;
        i++;
        continue;
      }
      if (arg === '-e') {
        interpretEscapes = true;
        i++;
        continue;
      }
      if (arg === '-E') {
        interpretEscapes = false;
        i++;
        continue;
      }
      if (isEchoFlagCluster(arg)) {
        for (const ch of arg.slice(1)) {
          if (ch === 'n') suppressNewline = true;
          else if (ch === 'e') interpretEscapes = true;
          else if (ch === 'E') interpretEscapes = false;
        }
        i++;
        continue;
      }
      break;
    }

    const body = args.slice(i).join(' ');
    const output = interpretEscapes ? decodeEchoEscapes(body) : body;
    stdout.write(suppressNewline ? output : `${output}\n`);
    return 0;
  }

  private async builtinClear(): Promise<number> {
    this.terminal.clear();
    return 0;
  }

  private async builtinExport(args: string[], stderr: CommandOutputStream): Promise<number> {
    let exitCode = 0;
    for (const arg of args) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        const key = arg.slice(0, eqIdx);
        const value = arg.slice(eqIdx + 1);
        if (!this.assignEnv(key, value, stderr)) exitCode = 1;
      }
    }
    return exitCode;
  }

  private async builtinSet(
    args: string[],
    stdout: CommandOutputStream,
    stderr: CommandOutputStream,
    context?: BuiltinExecutionContext,
  ): Promise<number> {
    if (args.length === 0) {
      for (const key of Object.keys(this.env).sort()) {
        stdout.write(`${key}=${quoteSetValue(this.env[key] ?? '')}\n`);
      }
      return 0;
    }

    let positionalsStart = -1;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--') {
        positionalsStart = i + 1;
        break;
      }
      if (arg === '-') {
        continue;
      }
      if (arg === '-o' || arg === '+o') {
        const option = args[i + 1];
        if (!option) {
          this.printShellOptions(stdout);
          return 0;
        }
        if (!this.setShellOptionByName(option, arg[0] === '-')) {
          stderr.write(`set: ${option}: invalid option name\n`);
          return 2;
        }
        i++;
        continue;
      }
      if (isSetOptionCluster(arg)) {
        const enabled = arg[0] === '-';
        for (let j = 1; j < arg.length; j++) {
          const flag = arg[j];
          if (flag === 'o') {
            const option = j === arg.length - 1 ? args[i + 1] : arg.slice(j + 1);
            if (!option) {
              this.printShellOptions(stdout);
              return 0;
            }
            if (!this.setShellOptionByName(option, enabled)) {
              stderr.write(`set: ${option}: invalid option name\n`);
              return 2;
            }
            if (j === arg.length - 1) i++;
            break;
          }
          if (!this.setShellOptionByFlag(flag, enabled)) {
            stderr.write(`set: -${flag}: invalid option\n`);
            return 2;
          }
        }
        continue;
      }
      positionalsStart = i;
      break;
    }

    if (positionalsStart >= 0) {
      this.setPositionals(args.slice(positionalsStart), context);
    }
    return 0;
  }

  private async builtinShift(
    args: string[],
    stderr: CommandOutputStream,
    context?: BuiltinExecutionContext,
  ): Promise<number> {
    if (args.length > 1) {
      stderr.write('shift: too many arguments\n');
      return 1;
    }

    const raw = args[0] ?? '1';
    if (!isDecimalInteger(raw)) {
      stderr.write(`shift: ${raw}: numeric argument required\n`);
      return 1;
    }

    const count = Number.parseInt(raw, 10);
    const positionals = this.currentPositionals(context);
    if (count > positionals.length) {
      stderr.write('shift: shift count out of range\n');
      return 1;
    }

    this.setPositionals(positionals.slice(count), context);
    return 0;
  }

  private async builtinTrap(args: string[], stdout: CommandOutputStream, stderr: CommandOutputStream): Promise<number> {
    if (args.length === 0) {
      for (const [signal, action] of this.traps.entries()) {
        stdout.write(`trap -- ${quoteSetValue(action)} ${signal}\n`);
      }
      return 0;
    }

    let index = 0;
    if (args[index] === '--') index++;
    const action = args[index];
    if (action === undefined) {
      stderr.write('trap: missing action\n');
      return 2;
    }
    index++;

    if (index >= args.length) {
      stderr.write('trap: missing signal\n');
      return 2;
    }

    for (; index < args.length; index++) {
      const signal = normalizeTrapSignal(args[index]);
      if (!signal) {
        stderr.write(`trap: ${args[index]}: invalid signal\n`);
        return 2;
      }
      if (action === '-') this.traps.delete(signal);
      else this.traps.set(signal, action);
    }
    return 0;
  }

  private async builtinHash(args: string[], stdout: CommandOutputStream, stderr: CommandOutputStream): Promise<number> {
    if (args.length === 0 || (args.length === 1 && args[0] === '-r')) return 0;
    let exitCode = 0;
    for (const arg of args) {
      if (arg.startsWith('-')) {
        stderr.write(`hash: ${arg}: invalid option\n`);
        exitCode = 2;
        continue;
      }
      const command = await this.registry.resolve(arg);
      if (!command) {
        stderr.write(`hash: ${arg}: not found\n`);
        exitCode = 1;
      } else {
        stdout.write(`${arg}\n`);
      }
    }
    return exitCode;
  }

  private printShellOptions(stdout: CommandOutputStream): void {
    stdout.write(`errexit         ${this.shellOptions.errexit ? 'on' : 'off'}\n`);
    stdout.write(`nounset         ${this.shellOptions.nounset ? 'on' : 'off'}\n`);
    stdout.write(`pipefail        ${this.shellOptions.pipefail ? 'on' : 'off'}\n`);
  }

  private setShellOptionByName(option: string, enabled: boolean): boolean {
    switch (option) {
      case 'errexit':
        this.shellOptions.errexit = enabled;
        return true;
      case 'nounset':
        this.shellOptions.nounset = enabled;
        return true;
      case 'pipefail':
        this.shellOptions.pipefail = enabled;
        return true;
      default:
        return false;
    }
  }

  private setShellOptionByFlag(flag: string, enabled: boolean): boolean {
    switch (flag) {
      case 'e':
        this.shellOptions.errexit = enabled;
        return true;
      case 'u':
        this.shellOptions.nounset = enabled;
        return true;
      default:
        return false;
    }
  }

  private setPositionals(args: string[], context?: BuiltinExecutionContext): void {
    if (context) {
      context.setPositionals(args);
      return;
    }
    for (const key of Object.keys(this.env)) {
      if (key === '@' || key === '#' || isPositionalKey(key)) delete this.env[key];
    }
    this.env['#'] = String(args.length);
    this.env['@'] = args.join(' ');
    for (let i = 0; i < args.length; i++) {
      this.env[String(i + 1)] = args[i];
    }
  }

  private currentPositionals(context?: BuiltinExecutionContext): string[] {
    if (context) return [...context.getPositionals()];
    const count = Number.parseInt(this.env['#'] ?? '0', 10);
    const args: string[] = [];
    for (let i = 1; i <= count; i++) args.push(this.env[String(i)] ?? '');
    return args;
  }

  private async builtinReadonly(args: string[], stdout: CommandOutputStream, stderr: CommandOutputStream): Promise<number> {
    if (args.length === 0 || (args.length === 1 && args[0] === '-p')) {
      for (const name of Array.from(this.readonlyNames).sort()) {
        const value = this.env[name];
        stdout.write(value === undefined
          ? `readonly ${name}\n`
          : `readonly ${name}=${quoteSetValue(value)}\n`);
      }
      return 0;
    }

    let exitCode = 0;
    for (const arg of args) {
      if (arg.startsWith('-')) {
        stderr.write(`readonly: ${arg}: invalid option\n`);
        exitCode = 2;
        continue;
      }
      const eqIdx = arg.indexOf('=');
      if (eqIdx > 0) {
        const name = arg.slice(0, eqIdx);
        if (!isShellIdentifier(name)) {
          stderr.write(`readonly: ${name}: not a valid identifier\n`);
          exitCode = 1;
          continue;
        }
        if (this.assignEnv(name, arg.slice(eqIdx + 1), stderr)) {
          this.readonlyNames.add(name);
        } else {
          exitCode = 1;
        }
        continue;
      }
      if (!isShellIdentifier(arg)) {
        stderr.write(`readonly: ${arg}: not a valid identifier\n`);
        exitCode = 1;
        continue;
      }
      this.readonlyNames.add(arg);
    }
    return exitCode;
  }

  private async builtinRead(
    args: string[],
    stdin: CommandInputStream | undefined,
    stderr: CommandOutputStream,
    context?: BuiltinExecutionContext,
  ): Promise<number> {
    const options = parseReadArgs(args);
    if (!options.ok) {
      stderr.write(`read: ${options.error}\n`);
      return 1;
    }
    if (options.prompt && context?.isFdTerminal(0)) {
      stderr.write(options.prompt);
    }

    const line = await readLineStdin(stdin);
    if (line === null) {
      // EOF: bash clears every named variable before returning non-zero.
      for (const name of options.names) {
        if (!this.assignEnv(name, '', stderr)) return 1;
      }
      return 1;
    }

    const assignments = splitReadAssignments(line, options.names);
    for (const [name, value] of assignments) {
      if (!this.assignEnv(name, value, stderr)) return 1;
    }
    return 0;
  }

  private async builtinWait(args: string[], stderr: CommandOutputStream): Promise<number> {
    const targets: Array<{ value: number; byJob: boolean }> = [];
    for (const arg of args) {
      const parsed = parseWaitTarget(arg);
      if (parsed === null) {
        stderr.write(`wait: ${arg}: not a valid job id\n`);
        return 127;
      }
      targets.push({ value: parsed.value, byJob: parsed.byJob });
    }

    const waitables = targets.length === 0
      ? this.jobTable.list()
        .filter((job) => job.status === 'running')
        .map((job) => job.promise)
      : targets.map((target) => this.resolveWaitTarget(target.value, target.byJob, stderr));

    let last = 0;
    for (const waitable of waitables) {
      if (!waitable) {
        last = 127;
        continue;
      }
      try {
        const result = await waitable;
        last = typeof result === 'number' ? result : 0;
      } catch {
        last = 1;
      }
    }
    return last;
  }

  private resolveWaitTarget(
    value: number,
    byJob: boolean,
    stderr: CommandOutputStream,
  ): Promise<number> | null {
    if (byJob) {
      const job = this.jobTable.get(value);
      if (!job) {
        stderr.write(`wait: %${value}: no such job\n`);
        return null;
      }
      return job.promise;
    }

    const proc = this.processRegistry.get(value);
    if (proc) return proc.promise;

    const job = this.jobTable.get(value);
    if (job) return job.promise;

    stderr.write(`wait: ${value}: no such process\n`);
    return null;
  }

  private async builtinUnset(args: string[], stderr: CommandOutputStream): Promise<number> {
    let exitCode = 0;
    for (const name of args) {
      if (!isShellIdentifier(name)) continue;
      if (this.readonlyNames.has(name)) {
        stderr.write(`${name}: readonly variable\n`);
        exitCode = 1;
        continue;
      }
      delete this.env[name];
    }
    return exitCode;
  }

  private assignEnv(name: string, value: string, stderr: CommandOutputStream): boolean {
    if (this.readonlyNames.has(name)) {
      stderr.write(`${name}: readonly variable\n`);
      return false;
    }
    this.env[name] = value;
    return true;
  }

  private snapshotShellState(): ShellStateFrame {
    return {
      cwd: this.cwd,
      env: { ...this.env },
      shellOptions: { ...this.shellOptions },
      traps: new Map(this.traps),
      readonlyNames: new Set(this.readonlyNames),
    };
  }

  private restoreShellState(frame: ShellStateFrame): void {
    this.cwd = frame.cwd;
    replaceRecord(this.env, frame.env);
    restoreShellOptions(this.shellOptions, frame.shellOptions);
    replaceMap(this.traps, frame.traps);
    replaceSet(this.readonlyNames, frame.readonlyNames);
  }

  private async builtinExit(args: string[], stderr: CommandOutputStream): Promise<number> {
    if (args.length > 1) {
      stderr.write('exit: too many arguments\n');
      return 1;
    }

    if (args.length === 0) {
      throw new ExitSignal(this.interpreter.getLastExitCode());
    }

    const status = parseShellExitStatus(args[0] ?? '');
    if (status === null) {
      stderr.write(`exit: ${args[0]}: numeric argument required\n`);
      throw new ExitSignal(2);
    }

    throw new ExitSignal(status);
  }

  private async builtinJobs(stdout: CommandOutputStream): Promise<number> {
    const jobs = this.jobTable.list();
    for (const job of jobs) {
      stdout.write(`[${job.id}] ${job.status}    ${job.command}\n`);
    }
    return 0;
  }

  private async builtinFg(args: string[], stdout: CommandOutputStream, stderr: CommandOutputStream): Promise<number> {
    const id = args[0] ? parseInt(args[0], 10) : undefined;
    const jobs = this.jobTable.list();

    if (jobs.length === 0) {
      stderr.write('fg: no current job\n');
      return 1;
    }

    const job = id ? this.jobTable.get(id) : jobs[jobs.length - 1];
    if (!job) {
      stderr.write(`fg: ${id}: no such job\n`);
      return 1;
    }

    stdout.write(`${job.command}\n`);
    const exitCode = await job.promise;
    this.jobTable.remove(job.id);
    return exitCode;
  }

  private async builtinBg(args: string[], stdout: CommandOutputStream, stderr: CommandOutputStream): Promise<number> {
    const id = args[0] ? parseInt(args[0], 10) : undefined;
    const jobs = this.jobTable.list();

    if (jobs.length === 0) {
      stderr.write('bg: no current job\n');
      return 1;
    }

    const job = id ? this.jobTable.get(id) : jobs[jobs.length - 1];
    if (!job) {
      stderr.write(`bg: ${id}: no such job\n`);
      return 1;
    }

    stdout.write(`[${job.id}] ${job.command} &\n`);
    return 0;
  }

  private async builtinHistory(stdout: CommandOutputStream): Promise<number> {
    const entries = this.historyManager.getAll();
    for (let i = 0; i < entries.length; i++) {
      stdout.write(`  ${i + 1}  ${entries[i]}\n`);
    }
    return 0;
  }

  async sourceFile(path: string): Promise<void> {
    try {
      const content = this.vfs.readFileString(path);
      await this.interpreter.executeLine(content);
    } catch {
      // Silently ignore missing config files
    }
  }

  private async builtinSource(
    args: string[],
    stdout: CommandOutputStream,
    stderr: CommandOutputStream,
    context?: BuiltinExecutionContext,
  ): Promise<number> {
    if (args.length === 0) {
      stderr.write('source: missing filename\n');
      return 1;
    }
    const path = resolve(this.cwd, args[0]);
    let content: string;
    try {
      content = this.vfs.readFileString(path);
    } catch {
      stderr.write(`source: ${args[0]}: No such file\n`);
      return 1;
    }

    if (!context) {
      stderr.write('source: execution context unavailable\n');
      return 1;
    }

    const sourceArgs = args.slice(1);
    return context.executeInline(
      content,
      sourceArgs.length > 0 ? { positionals: sourceArgs } : undefined,
    );
  }

  private async builtinAlias(args: string[], stdout: CommandOutputStream): Promise<number> {
    if (args.length === 0) {
      for (const [name, value] of this.aliases) {
        stdout.write(`alias ${name}='${value}'\n`);
      }
      return 0;
    }

    for (const arg of args) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        const name = arg.slice(0, eqIdx);
        const value = arg.slice(eqIdx + 1);
        this.aliases.set(name, value);
      } else {
        const value = this.aliases.get(arg);
        if (value !== undefined) {
          stdout.write(`alias ${arg}='${value}'\n`);
        } else {
          stdout.write(`alias: ${arg}: not found\n`);
        }
      }
    }
    return 0;
  }

  private async builtinUnalias(args: string[], stderr: CommandOutputStream): Promise<number> {
    if (args.length === 0) {
      stderr.write('unalias: usage: unalias name ...\n');
      return 1;
    }
    for (const name of args) {
      if (!this.aliases.delete(name)) {
        stderr.write(`unalias: ${name}: not found\n`);
      }
    }
    return 0;
  }

  private writeToTerminal(text: string): void {
    this.terminal.write(normalizeTerminalNewlines(text));
  }

}

function isEchoFlagCluster(arg: string): boolean {
  if (arg.length < 2 || arg[0] !== '-') return false;
  for (const ch of arg.slice(1)) {
    if (ch !== 'n' && ch !== 'e' && ch !== 'E') return false;
  }
  return true;
}

function decodeEchoEscapes(input: string): string {
  let output = '';
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch !== '\\' || i + 1 >= input.length) {
      output += ch;
      continue;
    }

    const next = input[++i];
    switch (next) {
      case '\\': output += '\\'; break;
      case 'n': output += '\n'; break;
      case 't': output += '\t'; break;
      case 'r': output += '\r'; break;
      case 'b': output += '\b'; break;
      case 'f': output += '\f'; break;
      case 'v': output += '\v'; break;
      case 'a': output += '\x07'; break;
      case 'x': {
        const parsed = readHexEscape(input, i + 1);
        if (parsed) {
          output += String.fromCharCode(parsed.value);
          i = parsed.end - 1;
        } else {
          output += 'x';
        }
        break;
      }
      case '0': {
        const parsed = readOctalEscape(input, i + 1);
        output += String.fromCharCode(parsed.value);
        i = parsed.end - 1;
        break;
      }
      default:
        output += next;
        break;
    }
  }
  return output;
}

function readHexEscape(input: string, pos: number): { value: number; end: number } | null {
  let value = 0;
  let end = pos;
  while (end < input.length && end - pos < 2) {
    const digit = hexValue(input.charCodeAt(end));
    if (digit === null) break;
    value = value * 16 + digit;
    end++;
  }
  return end === pos ? null : { value, end };
}

function readOctalEscape(input: string, pos: number): { value: number; end: number } {
  let value = 0;
  let end = pos;
  while (end < input.length && end - pos < 3) {
    const code = input.charCodeAt(end);
    if (code < 48 || code > 55) break;
    value = value * 8 + (code - 48);
    end++;
  }
  return { value, end };
}

function hexValue(code: number): number | null {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 65 && code <= 70) return code - 55;
  if (code >= 97 && code <= 102) return code - 87;
  return null;
}

type ReadArgs =
  | { ok: true; names: string[]; prompt?: string }
  | { ok: false; error: string };

function parseReadArgs(args: string[]): ReadArgs {
  const names: string[] = [];
  let prompt: string | undefined;
  let parsingOptions = true;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (parsingOptions && arg === '--') {
      parsingOptions = false;
      continue;
    }

    if (parsingOptions && arg.startsWith('-') && arg !== '-') {
      if (arg === '-r') continue;
      if (arg === '-p' || arg === '-rp' || arg === '-pr') {
        const next = args[++i];
        if (next === undefined) return { ok: false, error: `${arg}: option requires an argument` };
        prompt = next;
        continue;
      }
      if (arg.startsWith('-p') && arg.length > 2) {
        prompt = arg.slice(2);
        continue;
      }
      return { ok: false, error: `${arg}: unsupported option` };
    }

    parsingOptions = false;
    names.push(arg);
  }

  const resolvedNames = names.length > 0 ? names : ['REPLY'];
  for (const name of resolvedNames) {
    if (!isShellIdentifier(name)) return { ok: false, error: `${name}: not a valid identifier` };
  }
  return prompt === undefined
    ? { ok: true, names: resolvedNames }
    : { ok: true, names: resolvedNames, prompt };
}

async function readLineStdin(stdin: CommandInputStream | undefined): Promise<string | null> {
  if (!stdin) return null;
  if (stdin.readLine) return stdin.readLine();

  let line = '';
  let readChunk = false;
  while (true) {
    const chunk = await stdin.read();
    if (chunk === null) break;

    readChunk = true;
    const newline = chunk.indexOf('\n');
    if (newline >= 0) return line + chunk.slice(0, newline);
    line += chunk;
  }
  if (readChunk) return line;

  const content = await stdin.readAll();
  if (content.length === 0) return null;

  const newline = content.indexOf('\n');
  return newline >= 0 ? content.slice(0, newline) : content;
}

function splitReadAssignments(line: string, names: string[]): Array<[string, string]> {
  if (names.length === 1) return [[names[0], line]];

  const fields = splitWhitespaceFields(line);
  const assignments: Array<[string, string]> = [];
  for (let i = 0; i < names.length; i++) {
    if (i === names.length - 1) {
      assignments.push([names[i], fields.slice(i).join(' ')]);
    } else {
      assignments.push([names[i], fields[i] ?? '']);
    }
  }
  return assignments;
}

function splitWhitespaceFields(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  for (let i = 0; i < line.length; i++) {
    const code = line.charCodeAt(i);
    const whitespace = code === 32 || code === 9;
    if (whitespace) {
      if (current.length > 0) {
        fields.push(current);
        current = '';
      }
    } else {
      current += line[i];
    }
  }
  if (current.length > 0) fields.push(current);
  return fields;
}

function isTerminalControlSequence(data: string): boolean {
  return data.startsWith('\x1b[') || data.startsWith('\x1b(') || data.startsWith('\x1b)');
}

function parseWaitTarget(arg: string): { value: number; byJob: boolean } | null {
  const byJob = arg[0] === '%';
  const text = byJob ? arg.slice(1) : arg;
  if (!isDecimalInteger(text)) return null;
  return { value: Number.parseInt(text, 10), byJob };
}

function isShellIdentifier(value: string): boolean {
  if (value.length === 0) return false;
  const first = value.charCodeAt(0);
  if (!isIdentifierStart(first)) return false;
  for (let i = 1; i < value.length; i++) {
    if (!isIdentifierPart(value.charCodeAt(i))) return false;
  }
  return true;
}

function isPositionalKey(key: string): boolean {
  return isDecimalInteger(key);
}

function isSetOptionCluster(arg: string): boolean {
  if (arg.length < 2) return false;
  if (arg[0] !== '-' && arg[0] !== '+') return false;
  return arg !== '--' && arg !== '++';
}

function normalizeTrapSignal(raw: string): string | null {
  const signal = raw.toUpperCase();
  if (signal === '0' || signal === 'EXIT') return 'EXIT';
  if (signal.startsWith('SIG') && signal.length > 3) return signal.slice(3);
  if (isShellIdentifier(signal)) return signal;
  return null;
}

function quoteSetValue(value: string): string {
  if (value.length === 0) return "''";
  if (isPlainSetValue(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function isPlainSetValue(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const ok =
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      code === 95 ||
      code === 45 ||
      code === 46 ||
      code === 47 ||
      code === 58;
    if (!ok) return false;
  }
  return true;
}

function isIdentifierStart(code: number): boolean {
  return code === 95 || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isIdentifierPart(code: number): boolean {
  return isIdentifierStart(code) || (code >= 48 && code <= 57);
}

function isDecimalInteger(value: string): boolean {
  if (value.length === 0) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

function parseShellExitStatus(raw: string): number | null {
  if (raw.length === 0) return null;

  const sign = raw[0] === '-' ? -1n : 1n;
  const digits = raw[0] === '-' || raw[0] === '+' ? raw.slice(1) : raw;
  if (!isDecimalInteger(digits)) return null;

  const value = BigInt(digits) * sign;
  const normalized = ((value % 256n) + 256n) % 256n;
  return Number(normalized);
}

type ShellStateFrame = {
  cwd: string;
  env: Record<string, string>;
  shellOptions: ShellOptions;
  traps: Map<string, string>;
  readonlyNames: Set<string>;
};

function snapshotEnvKeys(env: Record<string, string>, keys: string[]): Map<string, string | undefined> {
  const snapshot = new Map<string, string | undefined>();
  for (const key of keys) snapshot.set(key, env[key]);
  return snapshot;
}

function restoreEnvKeys(env: Record<string, string>, snapshot: Map<string, string | undefined>): void {
  for (const [key, value] of snapshot.entries()) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
}

function replaceRecord(target: Record<string, string>, source: Record<string, string>): void {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source);
}

function restoreShellOptions(target: ShellOptions, source: ShellOptions): void {
  target.errexit = source.errexit;
  target.nounset = source.nounset;
  target.pipefail = source.pipefail;
}

function replaceMap<K, V>(target: Map<K, V>, source: Map<K, V>): void {
  target.clear();
  for (const [key, value] of source.entries()) target.set(key, value);
}

function replaceSet<T>(target: Set<T>, source: Set<T>): void {
  target.clear();
  for (const value of source.values()) target.add(value);
}

function isVfsCred(value: unknown): value is VfsCred {
  if (typeof value !== 'object' || value === null) return false;
  if (!('uid' in value) || typeof value.uid !== 'number') return false;
  if (!('gid' in value) || typeof value.gid !== 'number') return false;
  if (!('umask' in value) || typeof value.umask !== 'number') return false;
  return 'groups' in value && Array.isArray(value.groups)
    && value.groups.every((group) => typeof group === 'number');
}
