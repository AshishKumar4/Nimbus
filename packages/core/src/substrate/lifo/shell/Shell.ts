import type { ITerminal } from '../terminal/ITerminal.js';
import { ProcessView, bindProcessView } from '../../../runtime/process-files.js';
import type { CommandRegistry } from '../commands/registry.js';
import type { CommandInputStream, CommandOutputStream } from '../commands/types.js';
import type { ChildExit, CommandContext, CommandRunAsHost } from '../commands/types.js';
import { isVfsCred, type NimbusFilesystemAuthority, type VfsCred } from '../../../runtime/os-contracts.js';
import type { TerminalInputStream } from '../commands/types.js';
import { DEFAULT_HOME } from '../../../constants.js';
import { BOLD, GREEN, BLUE, RESET } from '../utils/colors.js';

import { Interpreter, type BuiltinFn, type ProgramSpec, type TerminalFdState } from './interpreter.js';
import { createShellState, restoreShellState, snapshotShellState, type ShellOptions, type ShellState } from './state.js';
import { shellBuiltins } from './builtins.js';
import { continuationState } from './lexer.js';
import { HistoryManager } from './history.js';
import { JobTable } from './jobs.js';
import { ProcessRegistry } from './ProcessRegistry.js';
import { signalAbortReason } from './signals.js';
import { complete, type CompletionContext } from './completer.js';
import { TerminalStdin } from './terminal-stdin.js';
import { normalizeTerminalNewlines } from '../../../_shared/terminal.js';
import { enc } from '../../../_shared/bytes.js';
import { readDefaultShell } from './default-shell.js';
import type { HostProcessSignals } from '../commands/system/kill.js';
import { ShellInputSubmission, ShellInputExecution, type ShellQueuedInput } from '../../../shell/input-submission.js';
import type { ProcessExitNotice, ProcessExitNoticeSource } from '../../../runtime/process-exit-notices.js';

function shellPromptParts(env: Record<string, string>, cwd: string): {
  displayPath: string;
  user: string;
  host: string;
} {
  const home = env['HOME'] ?? DEFAULT_HOME;
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

/** PS2 — shown while an accepted line has not closed into a command yet. */
const CONTINUATION_PROMPT = '> ';

/**
 * Shell-integration marks (FinalTerm's OSC 133), the ones bash and zsh write
 * for VS Code, iTerm2 and WezTerm: A where a fresh prompt starts, B where it
 * ends and input begins, C when an accepted command starts executing, D with
 * its status when it ends. A client learns from them that a command returned,
 * and how, instead of matching text that looks like a prompt. Only a fresh
 * prompt is marked; a redraw of the line being edited rewrites the row the
 * marks already name and finishes no command. Terminals that do not know
 * them ignore them, as xterm.js does.
 */
const PROMPT_START = '\x1b]133;A\x07';
const PROMPT_END = '\x1b]133;B\x07';
const COMMAND_START = '\x1b]133;C\x07';
/** D, with the status when the command returned one. */
const commandEnd = (status: number | null): string => `\x1b]133;D${status === null ? '' : `;${status}`}\x07`;

export interface ExecuteOptions {
  cwd?: string;
  env?: Record<string, string>;
  /**
   * Streaming output, as bytes: a process's stdio is a byte stream, and this
   * is the seam a child's output crosses on its way to a parent process. The
   * shell's own command output is text, encoded here at the producer's edge;
   * a text consumer decodes at its own edge with a streaming decoder.
   * A stream with a sink is not also captured into the result, and the
   * command's next write waits on a promise the sink returns.
   */
  onStdout?: (data: Uint8Array) => void | Promise<void>;
  onStderr?: (data: Uint8Array) => void | Promise<void>;
  /** The commands' stdin: text, read to its end, or a stream they read as it arrives. */
  stdin?: string | CommandInputStream;
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
  /**
   * A unit of process `pid`'s own work, while a command runs as it
   * (interpreter CommandIdentity.beginWork; SessionProcessSupervisor.beginWork).
   * Session-wide: every command counts for the pid it runs as, whichever
   * shell runs it, so no command of a process goes uncounted.
   */
  accountWork?(pid: number): () => void;
}

export class Shell {
  private terminal: ITerminal;
  private get vfs(): ProcessView {
    return bindProcessView(this.filesystem, { pid: this.commandIdentity.pid, cred: this.commandIdentity.cred });
  }
  private registry: CommandRegistry;
  /** The shell's own state (state.ts): what its builtins act on, and its child shells copy. */
  private readonly state: ShellState;

  // Line editing state
  lineBuffer: string = '';
  cursorPos: number = 0;
  screenCursorRow: number = 0; // tracks the actual terminal row (relative to prompt start)

  /** Where Up/Down stands in the history: -1 is the line being typed. */
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
  private historyManager: HistoryManager;
  private processRegistry: ProcessRegistry;
  /** The host's own processes, which `kill` reaches by pid (see setHostProcessSignals). */
  private hostProcessSignals: HostProcessSignals | undefined;
  private builtins: Map<string, BuiltinFn>;
  private commandIdentity: ShellCommandIdentity;

  // Tab completion state
  private tabCount: number = 0;

  // Paste queue for multiline paste support
  pasteQueue: ShellQueuedInput[] = [];
  private lineSubmission: ShellInputSubmission | undefined;
  private activeInput: ShellInputExecution | undefined;
  private lineInputs: Array<{ submission: ShellInputSubmission; release: () => void }> = [];
  private promptMode: 'unprinted' | 'primary' | 'continuation' = 'unprinted';
  private readonly exitNotices = new Map<number, ProcessExitNotice>();
  private exitNoticeSource: ProcessExitNoticeSource | undefined;
  private renderExitNotice: ((notice: ProcessExitNotice, source: ProcessExitNoticeSource) => string) | undefined;

  /**
   * Accepted lines that do not form a complete command yet: an unclosed
   * quote or a trailing `\` keeps the shell reading under PS2, as bash
   * does, instead of executing a truncated command.
   */
  private pendingLine: string | null = null;

  /**
   * Keystrokes that arrived while a foreground command owned the terminal and
   * nothing was reading stdin. A tty buffers type-ahead and hands it to the
   * shell when the job exits; dropping it loses whatever the user typed, and
   * when a dispatch never settles it leaves that connection with no feedback
   * whatsoever. Held as whole chunks so a multi-byte escape sequence replays
   * as one keystroke rather than three.
   */
  typeAhead: ShellQueuedInput[] = [];

  constructor(
    terminal: ITerminal,
    readonly filesystem: NimbusFilesystemAuthority,
    registry: CommandRegistry,
    env: Record<string, string>,
    processRegistry: ProcessRegistry,
    commandIdentity?: ShellCommandIdentity,
  ) {
    this.terminal = terminal;
    this.registry = registry;
    this.state = createShellState(env, env['HOME'] ?? DEFAULT_HOME, new JobTable(processRegistry));
    const shellEnv = this.state.env;
    if (!shellEnv['0']) shellEnv['0'] = 'nimbus-sh';
    if (!shellEnv['$']) shellEnv['$'] = String(processRegistry.registerShell(this.state.getCwd(), shellEnv));
    let defaultCred: VfsCred = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
    this.commandIdentity = commandIdentity ?? {
      pid: Number(shellEnv['$']),
      get cred() { return defaultCred; },
      setUmask: (mask) => {
        defaultCred = { ...defaultCred, umask: mask };
      },
    };

    // Use shared process registry from Kernel
    this.processRegistry = processRegistry;

    // Initialize history manager
    this.historyManager = new HistoryManager(() => this.vfs, () => this.state.env.HOME ?? DEFAULT_HOME);

    this.builtins = shellBuiltins({
      vfs: () => this.vfs,
      registry,
      processRegistry,
      hostProcessSignals: () => this.hostProcessSignals,
      clearTerminal: () => this.terminal.clear(),
      history: () => this.historyManager.getAll(),
    });

    this.interpreter = new Interpreter({
      ...this.state,
      vfs: this.vfs,
      filesystem,
      registry: this.registry,
      builtins: this.builtins,
      processRegistry: this.processRegistry,
      writeToTerminal: (text: string) => this.writeToTerminal(text),
      getAbortSignal: () => this.abortController?.signal ?? new AbortController().signal,
    });
  }

  /**
   * The command history, oldest first: the one store (HistoryManager, kept
   * in ~/.bash_history) that Up/Down, reverse search, Alt+. and the history
   * builtin all read, each line as it ran (after `!` expansion).
   */
  get history(): readonly string[] {
    return this.historyManager.getAll();
  }

  /** The names this shell runs itself, as help and completion list them. */
  builtinNames(): string[] {
    return [...this.builtins.keys()];
  }

  getJobTable(): JobTable {
    return this.state.jobTable;
  }

  /**
   * Let `kill` signal the host's processes: a numeric pid this shell's own
   * registry does not hold is handed to `host`. Child-shell views read the
   * shell they were forked from.
   */
  setHostProcessSignals(host: HostProcessSignals): void {
    this.hostProcessSignals = host;
  }

  /** The host processes `kill` reaches, for a shell built alongside this one. */
  getHostProcessSignals(): HostProcessSignals | undefined {
    return this.hostProcessSignals;
  }

  getProcessRegistry(): ProcessRegistry {
    return this.processRegistry;
  }

  getCwd(): string {
    return this.state.getCwd();
  }

  setCwd(cwd: string): void {
    this.state.setCwd(cwd);
  }

  getEnv(): Record<string, string> {
    return this.state.env;
  }

  getVfs(): ProcessView {
    return this.vfs;
  }

  /** Transfer terminal I/O without replacing shell state or sourcing login files. */
  bindTerminal(terminal: ITerminal): void {
    if (this.terminal === terminal) return;
    this.terminal.onData(() => {});
    this.terminal = terminal;
    this.bindTerminalInput();
  }

  takeQueuedInput(): string[] {
    return this.pasteQueue.splice(0).map((entry) => {
      if (typeof entry === 'string') return entry;
      this.activeInput?.bind(entry.submission);
      entry.release();
      return entry.data;
    });
  }

  queuePasteInput(data: string, submission?: ShellInputSubmission): void {
    this.pasteQueue.push(submission ? { data, submission, release: submission.retain() } : data);
  }

  rejectQueuedInput(): void {
    this.lineSubmission?.inherit(null);
    for (const { submission } of this.lineInputs) submission.inherit(null);
    for (const entry of this.pasteQueue.splice(0)) {
      if (typeof entry === 'string') continue;
      entry.submission.inherit(null);
      this.lineInputs.push(entry);
    }
  }

  private bindTerminalInput(): void {
    this.terminal.onData((data, submission) => this.handleInput(data, submission));
    this.terminal.onSubmission?.((data, id, deliver, repl) => {
      const submission = new ShellInputSubmission(id, (event) => this.terminal.shellIntegration?.(event));
      const stdin = this.running && (repl || this.terminalStdin?.rawMode || this.terminalStdin?.isWaiting);
      const owner = stdin ? this.activeInput?.owner : (!this.running ? this.lineSubmission : undefined);
      if (stdin) this.activeInput?.bind(submission);
      else if (owner) this.lineInputs.push({ submission, release: submission.retain() });
      if (!this.running && !this.lineSubmission) this.lineSubmission = submission;
      this.terminal.shellIntegration?.({ type: 'shell-integration', event: 'input', submissionId: id, ownerId: owner?.id ?? id });
      try {
        const pending = deliver(submission);
        submission.release();
        return pending;
      } catch (error) {
        submission.release();
        throw error;
      }
    });
  }

  /**
   * The `runAs` host this shell re-credentials through. A caller building a
   * second Shell over the same kernel needs it, or its commands lose the
   * identity-transition path `sudo` and `su` are dispatched on.
   */
  getRunAsHost(): CommandRunAsHost | undefined {
    return this.commandIdentity.runAs;
  }

  getRegistry(): CommandRegistry {
    return this.registry;
  }

  /** execvp(3) of `argv` as a process of this shell's kernel (Interpreter.runProgram). */
  runProgram(argv: readonly string[], spec: ProgramSpec): Promise<ChildExit> {
    return this.interpreter.runProgram(argv, spec);
  }

  /**
   * End a shell that is done: the descriptors an `exec` left open close, as a
   * process's do when it exits. A shell built for one call ends with it.
   */
  closeDescriptors(): Promise<void> {
    return this.interpreter.closeDescriptors();
  }

  /**
   * Programmatic command execution. Each stream goes to its sink when one is
   * given, and is otherwise captured into the result; never both, so a
   * streaming caller's output is not also held for the length of the command.
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
      if (options?.onStderr) {
        await options.onStderr(enc.encode(msg));
        return { stdout: '', stderr: '', exitCode: 1 };
      }
      return { stdout: '', stderr: msg, exitCode: 1 };
    }
    let stdoutBuf = '';
    let stderrBuf = '';

    const onStdout = options?.onStdout;
    const onStderr = options?.onStderr;
    const stdoutStream: CommandOutputStream = {
      ...(onStdout ? { writeBytes: (bytes: Uint8Array) => onStdout(bytes) } : {}),
      write: async (text: string) => {
        if (onStdout) return (await onStdout(enc.encode(text)));
        stdoutBuf += text;
      },
    };
    const stderrStream: CommandOutputStream = {
      ...(onStderr ? { writeBytes: (bytes: Uint8Array) => onStderr(bytes) } : {}),
      write: async (text: string) => {
        if (onStderr) return (await onStderr(enc.encode(text)));
        stderrBuf += text;
      },
    };

    // Save current state
    const prevCwd = options?.cwd ? this.state.getCwd() : undefined;
    const savedShellState = options?.isolateShellState
      ? { state: snapshotShellState(this.state), functions: this.interpreter.saveFunctions() }
      : null;
    const envOverrideSnapshot = !savedShellState && options?.env
      ? snapshotEnvKeys(this.state.env, Object.keys(options.env))
      : null;
    const optionSnapshot = !savedShellState && options?.shellOptions ? { ...this.state.options } : null;
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
    const writeToTerminal = (text: string) => stderrStream.write(text);

    // Apply per-call overrides
    if (options?.cwd) {
      this.setCwd(options.cwd);
    }
    if (options?.env) {
      Object.assign(this.state.env, options.env);
    }
    if (options?.shellOptions) {
      Object.assign(this.state.options, options.shellOptions);
    }

    let stdinStream: CommandInputStream | undefined;
    if (typeof options?.stdin === 'string') {
      const fixedStdin = new TerminalStdin();
      fixedStdin.feed(options.stdin);
      fixedStdin.close();
      stdinStream = fixedStdin;
    } else {
      stdinStream = options?.stdin;
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
      await stderrStream.write(msg + '\n');
      return { stdout: stdoutBuf, stderr: stderrBuf, exitCode: 1 };
    } finally {
      this._executeDepth--;
      // Restore state
      if (options?.signal) {
        options.signal.removeEventListener('abort', abortFromCaller);
      }
      if (savedShellState) {
        restoreShellState(this.state, savedShellState.state);
        this.interpreter.restoreFunctions(savedShellState.functions);
      } else {
        if (envOverrideSnapshot) restoreEnvKeys(this.state.env, envOverrideSnapshot);
        if (optionSnapshot) Object.assign(this.state.options, optionSnapshot);
      }
      if (prevCwd !== undefined) {
        this.setCwd(prevCwd);
      }
    }
  }

  private resolveCommandIdentity(overrides: Record<string, unknown> | undefined): ShellCommandIdentity & { beginWork?(): () => void } {
    const pid = overrides?.['pid'];
    const cred = overrides?.['cred'];
    const setUmask = overrides?.['setUmask'];
    const resolvedPid = typeof pid === 'number' ? pid : this.commandIdentity.pid;
    const base = this.commandIdentity;
    const accountWork = base.accountWork;
    return {
      pid: resolvedPid,
      // Read when used, as the shell's own identity is: the process's
      // credentials can change while a line runs.
      get cred() { return isVfsCred(cred) ? cred : base.cred; },
      setUmask: typeof setUmask === 'function'
        ? (mask) => setUmask(mask)
        : this.commandIdentity.setUmask,
      runAs: this.commandIdentity.runAs,
      accountWork,
      // Counted for the pid the command runs as, whichever it is.
      ...(accountWork ? { beginWork: () => accountWork(resolvedPid) } : {}),
    };
  }

  /**
   * Begin reading the terminal and apply the rc files.
   *
   * Resolves once the rc files have been applied and the first prompt is
   * on the terminal (or the user's bash has been launched in its place).
   * A host that has a line of input waiting for this shell — one that
   * rebuilt it under a peer who was already typing — delivers the line
   * after this, so the prompt precedes the echo the way it does on a
   * fresh terminal. Input arriving earlier is still taken; it just runs
   * alongside the rc files.
   */
  async start(): Promise<void> {
    // Register this shell instance as a process
    // First shell gets PID 1, subsequent shells get PID 2, 3, etc.
    const pid = this.processRegistry.registerShell(this.state.getCwd(), this.state.env);
    this.state.env['$'] = String(pid);

    this.bindTerminalInput();

    // The saved history, so Up recalls the last session's commands, as bash's does.
    await this.historyManager.load();

    // Source rc files on startup (like bash/zsh)
    const sourced = this.sourceRcFiles();
    // The bash launch is deliberately not part of the returned promise: an
    // interactive bash runs until the user exits it.
    return sourced.then(async () => {
      const home = this.state.env['HOME'] ?? DEFAULT_HOME;
      if ((await readDefaultShell(this.vfs, home)) === 'bash') {
        void this.executeLine('bash -i').catch(error => {
          this.writeToTerminal(`${error instanceof Error ? error.message : String(error)}\n`);
          this.printPrompt();
        });
      } else {
        this.printPrompt();
      }
    });
  }

  private async sourceRcFiles(): Promise<void> {
    const home = this.state.env['HOME'] ?? DEFAULT_HOME;

    // Source system-wide profile first
    await this.sourceFile('/etc/profile');

    // Then user rc files (first one found wins, like bash)
    const rcFiles = [
      `${home}/.liforc`,
      `${home}/.bashrc`,
      `${home}/.profile`,
    ];

    for (const rc of rcFiles) {
      if ((await this.vfs.exists(rc))) {
        await this.sourceFile(rc);
        break;
      }
    }
  }

  printPrompt(): void {
    if (this.pendingLine !== null) {
      this.printContinuationPrompt();
      return;
    }

    // Report the jobs that finished, then reap their processes (and any other zombie).
    for (const job of this.state.jobTable.collectDone()) {
      this.writeToTerminal(`[${job.id}] Done    ${job.command}\n`);
    }
    this.processRegistry.collectZombies();

    const source = this.exitNoticeSource;
    if (source) {
      for (const notice of this.exitNotices.values()) {
        if (source.retainsLogs(notice.pid)) this.writeToTerminal(this.renderExitNotice?.(notice, source) ?? '');
      }
    }
    this.exitNotices.clear();

    this.terminal.write(PROMPT_START + formatShellPrompt(this.state.env, this.state.getCwd()) + PROMPT_END);
    this.promptMode = 'primary';
    this.announcePrompt();
    const submission = this.lineSubmission;
    this.lineSubmission = undefined;
    submission?.prompt();
    for (const { submission: input, release } of this.lineInputs.splice(0)) {
      input.prompt();
      release();
    }
  }

  /** A newly attached client learns current readiness, never a replayed completion. */
  announcePrompt(): void {
    if (!this.running && this.promptMode === 'primary') this.terminal.shellIntegration?.({ type: 'shell-integration', event: 'prompt' });
  }

  printContinuationPrompt(): void {
    this.promptMode = 'continuation';
    this.terminal.write(CONTINUATION_PROMPT);
  }

  queueProcessExitNotice(notice: ProcessExitNotice, source: ProcessExitNoticeSource, render: (notice: ProcessExitNotice, source: ProcessExitNoticeSource) => string): boolean {
    this.exitNoticeSource = source;
    this.renderExitNotice = render;
    for (const pid of this.exitNotices.keys()) if (!source.retainsLogs(pid)) this.exitNotices.delete(pid);
    if (this.exitNotices.has(notice.pid)) return false;
    this.exitNotices.set(notice.pid, notice);
    return true;
  }

  async handleInput(data: string, submission?: ShellInputSubmission): Promise<void> {
    // Raw mode: bypass all shell line editing, deliver keypresses directly
    if (this.running && this.terminalStdin?.rawMode) {
      this.terminalStdin.feed(data);
      return;
    }

    // Multiline paste detection: if data contains newlines and has multiple
    // chars, split into lines and accept them sequentially via the paste
    // queue. Middle segments are queued even when empty — a blank pasted
    // line is a newline inside an open quote; only the tail after the final
    // newline is dropped when empty, because no Enter followed it.
    if (!this.running && data.length > 1 && /[\r\n]/.test(data)) {
      const lines = data.split(/\r\n|\r|\n/);
      const first = lines[0];
      if (first) {
        this.lineBuffer = this.lineBuffer.slice(0, this.cursorPos) + first + this.lineBuffer.slice(this.cursorPos);
        this.cursorPos += first.length;
      }
      this.redrawLine();
      this.terminal.write('\r\n');
      const line = this.lineBuffer;
      this.lineBuffer = '';
      this.cursorPos = 0;
      this.historyIndex = -1;
      for (let j = 1; j < lines.length - 1; j++) {
        this.queuePasteInput(lines[j], submission);
      }
      const lastSegment = lines[lines.length - 1];
      if (lastSegment) {
        this.queuePasteInput(lastSegment, submission);
      }
      (await this.acceptLine(line, submission));
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
    // cancels the line and Ctrl+\ is absorbed, as readline does. A command
    // that turned the signal keys off (termios ISIG) takes them as input,
    // the line typed so far discarded, as a REPL's readline does.
    if (data === '\x03' || data === '\x1c') {
      const signal = data === '\x03' ? 'INT' : 'QUIT';
      if (this.running && this.terminalStdin && !this.terminalStdin.signalKeys) {
        this.terminal.write(signal === 'INT' ? '^C\r\n' : '^\\\r\n');
        this.stdinLineBuffer = '';
        this.stdinCursorPos = 0;
        this.terminalStdin.feed(data);
      } else if (this.running && this.abortController) {
        this.terminalStdin?.close();
        this.stdinLineBuffer = '';
        this.stdinCursorPos = 0;
        this.abortController.abort(signalAbortReason(signal));
      } else if (signal === 'INT') {
        this.terminal.write('^C\r\n');
        this.pendingLine = null;
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
      let pending: Promise<void> | undefined;
      if (submission) {
        const release = submission.retain();
        pending = new Promise((resolve, reject) => { this.typeAhead.push({ data, submission, release, resolve, reject }); });
      } else this.typeAhead.push(data);
      if (data === '\r') this.terminal.write('\r\n');
      else if (data >= ' ' && data !== '\x7f') this.terminal.write(normalizeTerminalNewlines(data));
      return pending;
    }

    // Tab completion
    if (data === '\t') {
      (await this.handleTab());
      return;
    }

    // Reset tab state on any non-tab input
    this.tabCount = 0;

    // Enter
    if (data === '\r') {
      this.terminal.write('\r\n');
      const line = this.lineBuffer;
      this.lineBuffer = '';
      this.cursorPos = 0;
      this.screenCursorRow = 0;
      this.historyIndex = -1;
      (await this.acceptLine(line, submission));
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

  private async handleTab(): Promise<void> {
    const completionCtx: CompletionContext = {
      line: this.lineBuffer,
      cursorPos: this.cursorPos,
      cwd: this.state.getCwd(),
      env: this.state.env,
      vfs: this.vfs,
      registry: this.registry,
      builtinNames: this.builtinNames(),
    };

    const result = (await complete(completionCtx));
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
    if (this.promptMode === 'continuation') return CONTINUATION_PROMPT.length;
    const { displayPath, user, host } = shellPromptParts(this.state.env, this.state.getCwd());
    // "user@host:path$ " — count visible chars only (no ANSI codes)
    return user.length + 1 + host.length + 1 + displayPath.length + 2;
  }

  /**
   * An asynchronous notice. While a command runs it is ordinary output; at an
   * idle prompt it goes above the prompt, which is redrawn with the line being
   * edited, so the prompt stays the last thing on screen.
   */
  writeNotice(text: string): void {
    if (this.running) {
      this.terminal.write(text);
      return;
    }
    if (this.screenCursorRow > 0) this.terminal.write(`\x1b[${this.screenCursorRow}A`);
    this.terminal.write('\r\x1b[J');
    this.terminal.write(text.endsWith('\n') ? text : `${text}\r\n`);
    this.screenCursorRow = 0;
    this.redrawLine();
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
    this.terminal.write(
      this.promptMode === 'continuation' ? CONTINUATION_PROMPT : formatShellPrompt(this.state.env, this.state.getCwd()),
    );
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
  async drainTypeAhead(): Promise<void> {
    while (!this.running && this.typeAhead.length > 0) {
      const next = this.typeAhead.shift();
      if (next === undefined) return;
      if (typeof next === 'string') { await this.handleInput(next); continue; }
      try {
        const pending = this.handleInput(next.data, next.submission);
        next.release();
        await pending;
        next.resolve?.();
      } catch (error) {
        next.reject?.(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    }
  }

  async drainPasteQueue(): Promise<void> {
    const next = this.pasteQueue.shift();
    if (next === undefined) return;
    const data = typeof next === 'string' ? next : next.data;
    const submission = typeof next === 'string' ? undefined : next.submission;
    this.terminal.write(data);
    this.terminal.write('\r\n');
    const pending = this.acceptLine(data, submission);
    if (typeof next !== 'string') next.release();
    await pending;
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

  /**
   * A line the user finished with Enter. If it leaves a quote open or ends
   * in a line continuation it is not a command yet: bash buffers it, shows
   * PS2 and keeps reading, and so does this shell. A `\<newline>` join drops
   * both characters; a quoted join keeps the newline in the string.
   */
  private async acceptLine(rawLine: string, submission?: ShellInputSubmission): Promise<void> {
    this.promptMode = 'unprinted';
    submission?.leavePrompt();
    if (!this.lineSubmission) this.lineSubmission = submission;
    let command: string;
    if (this.pendingLine === null) {
      command = rawLine.trim();
      if (!command) {
        this.printPrompt();
        (await this.drainPasteQueue());
        return;
      }
    } else {
      command = continuationState(this.pendingLine) === 'backslash'
        ? this.pendingLine.slice(0, -1) + rawLine
        : this.pendingLine + '\n' + rawLine;
    }

    if (continuationState(command) !== null) {
      this.pendingLine = command;
      this.printPrompt();
      (await this.drainPasteQueue());
      return;
    }

    this.pendingLine = null;
    (await this.executeLine(command, this.lineSubmission ?? submission));
  }

  async executeLine(line: string, submission: ShellInputSubmission | undefined = this.lineSubmission): Promise<void> {
    this.promptMode = 'unprinted';
    const release = submission?.retain();
    this.lineSubmission = undefined;
    this.running = true;
    this.abortController = new AbortController();
    this.terminalStdin = new TerminalStdin(() => this.consumeQueuedStdin());
    // History expansion
    const expanded = this.historyManager.expand(line);
    const actualLine = expanded ?? line;

    if (expanded !== null) {
      // Show the expanded command
      this.writeToTerminal(actualLine + '\n');
    }

    const execution = submission?.start() ?? new ShellInputExecution();
    this.activeInput = execution;
    for (const { submission: input, release } of this.lineInputs.splice(0)) {
      execution?.bind(input);
      release();
    }
    this.terminal.write(COMMAND_START);
    let status: number | null = null;
    try {
      await this.historyManager.add(actualLine);
      status = await this.interpreter.executeLine(actualLine, this.terminalStdin, {
        interactive: true,
        commandIdentity: this.resolveCommandIdentity(undefined),
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
      this.terminal.write(commandEnd(status));
      execution?.finish(status);
      release?.();
      this.activeInput = undefined;
      this.lineSubmission = submission;
      this.printPrompt();
      execution?.prompt();
    }

    (await this.drainPasteQueue());
    (await this.drainTypeAhead());
  }

  private consumeQueuedStdin(): void {
    const stdin = this.terminalStdin;
    if (!stdin) return;
    const pasted = this.pasteQueue.length > 0;
    const next = pasted ? this.pasteQueue.shift() : this.typeAhead.shift();
    if (next === undefined) return;
    const queued = typeof next === 'string' ? next : next.data;
    const data = pasted ? `${queued}\n` : queued.replace(/\r\n?|\n/g, '\n');
    if (typeof next !== 'string') {
      this.activeInput?.bind(next.submission);
      next.release();
      next.resolve?.();
    }
    const eof = data.indexOf('\x04');
    stdin.feed(eof < 0 ? data : data.slice(0, eof));
    if (eof >= 0) stdin.close();
  }

  async sourceFile(path: string): Promise<void> {
    try {
      const content = (await this.vfs.readFileString(path));
      await this.interpreter.executeLine(content);
    } catch {
      // Silently ignore missing config files
    }
  }

  private writeToTerminal(text: string): void {
    this.terminal.write(normalizeTerminalNewlines(text));
  }

}


function isTerminalControlSequence(data: string): boolean {
  return data.startsWith('\x1b[') || data.startsWith('\x1b(') || data.startsWith('\x1b)');
}

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
