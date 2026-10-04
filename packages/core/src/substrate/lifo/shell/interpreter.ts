import type {
  ScriptNode,
  ListNode,
  PipelineNode,
  SimpleCommandNode,
  CompoundCommandNode,
  DoubleBracketNode,
  IfNode,
  ForNode,
  WhileNode,
  UntilNode,
  CaseNode,
  FunctionDefNode,
  GroupNode,
  SubshellNode,
  RedirectionNode,
  AssignmentNode,
} from './types.js';
import { ProcessView, bindProcessView } from '../../../runtime/process-files.js';
import type { NimbusFilesystemAuthority } from '../../../runtime/os-contracts.js';
import { resolveContext, type CommandRegistry } from '../commands/registry.js';
import type {
  ChildExit,
  Command,
  CommandOutputStream,
  CommandInputStream,
  CommandContext,
  CommandRunAsHost,
  TerminalInputStream,
} from '../commands/types.js';
import type { VfsCred } from '../../../runtime/os-contracts.js';
import { syscallError } from '../../../vfs/vfs-error.js';
import { lex } from './lexer.js';
import { parse } from './parser.js';
import {
  expandWords, expandWord, evaluateSubscript, ExpansionError,
  type ExpandContext, type CapturedCommand,
} from './expander.js';
import { evaluateDoubleBracketWords } from './test-builtin.js';
import { isPipeEnd, PipeChannel } from './pipe.js';
import { JobTable } from './jobs.js';
import { ProcessRegistry } from './ProcessRegistry.js';
import { exitCodeForAbortSignal, KILLED_BY_SIGPIPE } from './signals.js';
import { isBrokenPipe, isRefusedWrite } from '../utils/bytes-io.js';
import { resolve } from '../utils/path.js';
import { encode } from '../utils/encoding.js';
import { globMatch } from '../utils/glob.js';
import { staticStdinReader } from '../../../shell/stdin-adapter.js';
import { BASH_BUILTINS } from './bash-builtins.js';
import { statOrThrow } from '../../../vfs/vfs.js';
import { yieldToEventLoop } from '../utils/event-loop.js';

// ─── Signal classes for control flow ───

export class BreakSignal {
  constructor(public levels: number) {}
}

export class ContinueSignal {
  constructor(public levels: number) {}
}

export class ReturnSignal {
  constructor(public exitCode: number) {}
}

export class ErrexitSignal {
  constructor(public exitCode: number) {}
}

export class ExitSignal {
  constructor(public exitCode: number) {}
}

class RedirectionOpenError extends Error {
  constructor(
    readonly target: string,
    readonly fsError: unknown,
  ) {
    super(fsError instanceof Error ? fsError.message : String(fsError));
  }
}

function redirectionDiagnostic(error: RedirectionOpenError): string {
  const code = typeof error.fsError === 'object' && error.fsError !== null
    && 'code' in error.fsError && typeof error.fsError.code === 'string'
    ? error.fsError.code
    : /^([A-Z][A-Z0-9]+):/.exec(error.message)?.[1];
  const reason = code === 'EACCES' || code === 'EPERM'
    ? 'Permission denied'
    : code === 'ENOENT'
      ? 'No such file or directory'
      : code === 'ENOTDIR'
        ? 'Not a directory'
        : code === 'EISDIR'
          ? 'Is a directory'
          : error.message;
  return `sh: ${error.target}: ${reason}\n`;
}

export interface ShellOptions {
  errexit: boolean;
  nounset: boolean;
  pipefail: boolean;
}

export interface TrapTable {
  get(signal: string): string | undefined;
  set(signal: string, action: string): void;
  delete(signal: string): void;
  entries(): IterableIterator<[string, string]>;
}

export interface BuiltinExecutionContext {
  interactive?: boolean;
  vfs: ProcessView;
  /** The working directory a builtin resolves its relative path operands against. */
  cwd: string;
  stdin?: CommandInputStream;
  stdout: CommandOutputStream;
  stderr: CommandOutputStream;
  terminalStdin?: TerminalInputStream;
  terminalFds: TerminalFdState;
  scriptMode?: boolean;
  isFdTerminal(fd: number): boolean;
  getPositionals(): readonly string[];
  setPositionals(args: string[]): void;
  executeInline(input: string, options?: InlineExecutionOptions): Promise<number>;
  /** Bind a name to the running function. False outside one, where it is an error. */
  declareLocal(name: string): boolean;
  /** Remove a function from the shell running the builtin (a child shell's own, after a fork); false when none is defined. */
  unsetFunction(name: string): boolean;
  /** The state of the shell running the builtin: a child shell's own, after a fork. */
  shell: InterpreterConfig;
  getLastExitCode(): number;
}

export interface InlineExecutionOptions {
  positionals?: string[];
}

export type BuiltinFn = (
  args: string[],
  stdout: CommandOutputStream,
  stderr: CommandOutputStream,
  stdin?: CommandInputStream,
  context?: BuiltinExecutionContext,
) => Promise<number>;

type FdState = {
  outputFds: Map<number, CommandOutputStream>;
  inputFds: Map<number, CommandInputStream | undefined>;
  terminalOutputFds: Set<number>;
  terminalInputFds: Set<number>;
  changedOutputFds: Set<number>;
  changedInputFds: Set<number>;
  /** Files this command's redirections opened; it holds each until its flush. */
  opened: Map<CommandInputStream | CommandOutputStream, OpenFile>;
  /** Files the enclosing redirections hold, which `exec` may keep past them. */
  enclosing: ReadonlyMap<CommandInputStream | CommandOutputStream, OpenFile>;
};

/**
 * A file a redirection opened. `refs` counts what holds it, as the kernel
 * counts references to an open file description: the redirection's command
 * until it ends, each descriptor `exec` keeps on it, and each child shell that
 * inherited it, the way fork(2) dups descriptors. It closes when the last of
 * them lets go.
 */
type OpenFile = {
  stream: CommandInputStream | CommandOutputStream;
  /** An output file's: write what the VFS still holds for it (fsync), throwing what that failed with. */
  flush?: () => Promise<void>;
  close: () => Promise<void>;
  refs: number;
};

type OutputTarget = {
  stream: CommandOutputStream;
  terminal: boolean;
};

type InputTarget = {
  stream: CommandInputStream | undefined;
  terminal: boolean;
};

type ExecutionIo = {
  stdin?: CommandInputStream;
  stdout?: CommandOutputStream;
  stderr?: CommandOutputStream;
  /**
   * Per-execution sink for shell-level direct-terminal writes (the
   * `/dev/tty` target and the late-bound command-stdout fallback). Scoping
   * this through `io` keeps a nested `Shell.execute` capture isolated: the
   * parent command's closures resolve to the parent's terminal writer, never
   * to a field a nested execute reassigns.
   */
  writeToTerminal?: (text: string) => void;
  terminalStdin?: TerminalInputStream;
  terminalFds?: TerminalFdState;
  scriptMode?: boolean;
  signal?: AbortSignal;
  registerProcess?: boolean;
  positionals?: PositionalFrame;
  /** Host-supplied fields merged into each command's CommandContext. */
  commandContext?: Record<string, unknown>;
  commandIdentity?: CommandIdentity;
  runAs?: CommandRunAsHost;
  vfs?: ProcessView;
  /** The terminal's own shell (bash -i): job notices are printed. */
  interactive?: boolean;
  /** Files the enclosing redirections hold open, by their stream. */
  openFiles?: ReadonlyMap<CommandInputStream | CommandOutputStream, OpenFile>;
};

/** A shell's function definitions, by name. */
export type FunctionTable = ReadonlyMap<string, CompoundCommandNode>;

/** The process a command runs as: its pid and credential, and how it sets its umask. */
export interface CommandIdentity {
  readonly pid: number;
  readonly cred: VfsCred;
  setUmask(mask: number): void;
}

/** What a program started by runProgram runs with: its identity, directory, environment and inherited streams. */
export interface ProgramSpec {
  readonly identity: CommandIdentity;
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly stdin?: CommandInputStream;
  readonly stdout: CommandOutputStream;
  readonly stderr: CommandOutputStream;
  readonly terminalStdin?: TerminalInputStream;
  readonly isFdTerminal?: (fd: number) => boolean;
  readonly isFdPipe?: (fd: number) => boolean;
  readonly signal: AbortSignal;
  /** How the program's own runAs starts a child, as its parent's did. */
  readonly runAs?: CommandRunAsHost;
  /** Host-supplied fields merged into the program's CommandContext. */
  readonly commandContext?: Record<string, unknown>;
}

/**
 * A resolved command run as a process: the program's spec, its bound view,
 * whether ps lists it, and whether it is the shell's own builtin, whose write
 * to a closed pipe ends the shell's pipeline element and not just itself.
 */
interface CommandSpec extends ProgramSpec {
  readonly vfs: ProcessView;
  readonly register: boolean;
  readonly shellBuiltin: boolean;
}


function exited(status: number): ChildExit {
  return { status, signal: null };
}

export type TerminalFdState = {
  stdin?: boolean;
  stdout?: boolean;
  stderr?: boolean;
};

type PositionalFrame = {
  args: string[];
};

/** A variable's complete binding: its scalar value, or its array, or neither. */
type SavedVariable = {
  scalar: string | undefined;
  array: (string | undefined)[] | undefined;
};

export interface InterpreterConfig {
  env: Record<string, string>;
  /**
   * Indexed arrays; `env` holds the scalars. A name lives in exactly one of
   * them, so `$arr` and `${arr[0]}` cannot disagree, and only `unset` moves a
   * name from one to the other.
   */
  arrays: Map<string, (string | undefined)[]>;
  getCwd: () => string;
  setCwd: (cwd: string) => void;
  vfs: ProcessView;
  filesystem: NimbusFilesystemAuthority;
  registry: CommandRegistry;
  builtins: Map<string, BuiltinFn>;
  jobTable: JobTable;
  processRegistry: ProcessRegistry;
  writeToTerminal: (text: string) => void;
  aliases?: Map<string, string>;
  /** Returns the current abort signal for foreground commands */
  getAbortSignal?: () => AbortSignal;
  options: ShellOptions;
  traps: TrapTable;
  readonlyNames: ReadonlySet<string>;
}

/**
 * Assign a plain value to a name. A name that already holds an array keeps it:
 * `a=(x y); a=plain` sets `a[0]` and leaves `a[1]` alone, which is bash's rule
 * and the reason a variable's type only changes through `unset`.
 */
export function assignScalar(
  env: Record<string, string>,
  arrays: Map<string, (string | undefined)[]>,
  name: string,
  value: string,
): void {
  const array = arrays.get(name);
  if (array === undefined) env[name] = value;
  else array[0] = value;
}



export class Interpreter {
  private config: InterpreterConfig;
  private lastExitCode = 0;
  private functions = new Map<string, CompoundCommandNode>();
  private persistentOutputFds = new Map<number, CommandOutputStream>();
  private persistentInputFds = new Map<number, CommandInputStream | undefined>();
  private persistentTerminalOutputFds = new Set<number>();
  private persistentTerminalInputFds = new Set<number>();
  /** Bridge handles held open past the `exec` that opened them, by descriptor. */
  private persistentOutputHandles = new Map<number, OpenFile>();
  private persistentInputHandles = new Map<number, OpenFile>();
  private errexitSuppressionDepth = 0;
  private exitTrapDepth = 0;
  /** One frame per running function call, holding the bindings `local` shadowed. */
  private localFrames: Array<Map<string, SavedVariable>> = [];

  constructor(config: InterpreterConfig) {
    this.config = config;
  }

  /** The functions this shell defines, for a run whose own definitions must not outlast it (restoreFunctions). */
  saveFunctions(): FunctionTable {
    return new Map(this.functions);
  }

  restoreFunctions(saved: FunctionTable): void {
    this.functions = new Map(saved);
  }

  /**
   * A child shell, as fork(2) makes one: its own copy of every piece of shell
   * state (variables and arrays, cwd, options, traps, readonly names,
   * aliases, functions, $?, the open descriptors), so nothing it changes
   * reaches this shell. Shared: the process registry and filesystem,
   * command registry and terminal; `$$` stays this shell's. Traps reset to
   * the default, except ignored ones, and the child runs its own EXIT trap
   * when it finishes (`finishChild`).
   */
  fork(): Interpreter {
    const parent = this.config;
    let cwd = parent.getCwd();
    const env: Record<string, string> = { ...parent.env };
    const config: InterpreterConfig = {
      ...parent,
      env,
      jobTable: parent.jobTable.fork(),
      arrays: new Map(Array.from(parent.arrays, ([name, elements]) => [name, [...elements]])),
      getCwd: () => cwd,
      setCwd: (next: string) => { cwd = next; env.PWD = next; },
      options: { ...parent.options },
      traps: new Map(Array.from(parent.traps.entries()).filter(([, action]) => action === '')),
      readonlyNames: new Set(parent.readonlyNames),
      aliases: parent.aliases ? new Map(parent.aliases) : undefined,
    };
    const child = new Interpreter(config);
    child.lastExitCode = this.lastExitCode;
    child.functions = new Map(this.functions);
    child.persistentOutputFds = new Map(this.persistentOutputFds);
    child.persistentInputFds = new Map(this.persistentInputFds);
    child.persistentTerminalOutputFds = new Set(this.persistentTerminalOutputFds);
    child.persistentTerminalInputFds = new Set(this.persistentTerminalInputFds);
    child.persistentOutputHandles = new Map(this.persistentOutputHandles);
    child.persistentInputHandles = new Map(this.persistentInputHandles);
    for (const handle of child.persistentHandles()) handle.refs++;
    child.localFrames = this.localFrames.map((frame) => new Map(frame));
    child.errexitSuppressionDepth = this.errexitSuppressionDepth;
    return child;
  }

  getLastExitCode(): number {
    return this.lastExitCode;
  }

  async executeScript(script: ScriptNode, terminalStdin?: TerminalInputStream): Promise<number> {
    return (await this.executeScriptWithIo(script, this.createTerminalIo(terminalStdin)));
  }

  private async executeScriptWithIo(script: ScriptNode, io: ExecutionIo): Promise<number> {
    let exitCode = 0;
    try {
      for (const list of script.lists) {
        exitCode = await this.executeList(list, io);
      }
    } catch (error) {
      if (error instanceof ErrexitSignal) {
        exitCode = error.exitCode;
      } else if (error instanceof ExitSignal) {
        exitCode = error.exitCode;
      } else {
        throw error;
      }
    }
    this.lastExitCode = exitCode;
    return exitCode;
  }

  async executeLine(
    input: string,
    terminalStdin?: TerminalInputStream,
    options?: {
      runExitTrap?: boolean;
      stdin?: CommandInputStream;
      stdout?: CommandOutputStream;
      stderr?: CommandOutputStream;
      writeToTerminal?: (text: string) => void;
      terminalFds?: TerminalFdState;
      scriptMode?: boolean;
      commandContext?: Record<string, unknown>;
      commandIdentity?: CommandIdentity;
      runAs?: CommandRunAsHost;
      signal?: AbortSignal;
      interactive?: boolean;
    },
  ): Promise<number> {
    const io = this.createTerminalIo(
      terminalStdin,
      options?.terminalFds,
      options?.scriptMode === true,
      options?.stdin,
    );
    if (options?.stdout) io.stdout = options.stdout;
    if (options?.stderr) io.stderr = options.stderr;
    if (options?.writeToTerminal) io.writeToTerminal = options.writeToTerminal;
    if (options?.commandContext) io.commandContext = options.commandContext;
    if (options?.commandIdentity) io.commandIdentity = options.commandIdentity;
    if (options?.runAs) io.runAs = options.runAs;
    if (options?.signal) io.signal = options.signal;
    if (options?.interactive) io.interactive = true;
    if (io.commandIdentity) io.vfs = bindProcessView(this.config.filesystem, {
      pid: io.commandIdentity.pid, cred: io.commandIdentity.cred, signal: io.signal,
    });
    try {
      const tokens = lex(input);
      const script = parse(tokens);
      const exitCode = await this.executeScriptWithIo(script, io);
      return await this.runExitTrap(exitCode, io, options?.runExitTrap === true);
    } catch (e) {
      if (e instanceof BreakSignal || e instanceof ContinueSignal || e instanceof ReturnSignal) {
        throw e;
      }
      if (e instanceof ErrexitSignal) {
        this.lastExitCode = e.exitCode;
        return e.exitCode;
      }
      if (e instanceof Error) {
        this.writeTerminal(io, `${e.message}\n`);
      }
      // A failed expansion aborts with 1, the way bash does; 2 is reserved for
      // the shell's own usage errors (syntax, bad builtin invocation).
      const exitCode = e instanceof ExpansionError ? 1 : 2;
      this.lastExitCode = exitCode;
      return exitCode;
    }
  }

  private async executeList(list: ListNode, io: ExecutionIo = {}): Promise<number> {
    const abortCode = this.abortExitCode(io);
    if (abortCode !== null) return abortCode;

    if (list.background) {
      const abortController = new AbortController();
      const commandText = this.getListCommandText(list);
      const backgroundIo = this.createCommandIo(io);
      backgroundIo.signal = abortController.signal;
      backgroundIo.registerProcess = false;
      backgroundIo.positionals = this.forkPositionals(io);

      const child = this.fork();
      const promise = (async (): Promise<number> => {
        return await child.finishChild(async () => (await child.executeListEntries(list.entries, backgroundIo)), backgroundIo);
      })();

      const pid = this.config.processRegistry.spawn({
        command: commandText.split(' ')[0] || 'unknown',
        args: commandText.split(' '),
        cwd: this.config.getCwd(),
        env: { ...this.config.env },
        isForeground: false,
        promise,
        abortController,
      });
      const waitable = this.config.processRegistry.get(pid)?.promise ?? promise;
      const jobId = this.config.jobTable.add(commandText, waitable, abortController, pid);
      // `%N` (kill, fg, wait) names the job by the table's number.
      const registered = this.config.processRegistry.get(pid);
      if (registered) registered.jobId = jobId;
      this.config.env['!'] = String(pid);

      // An interactive bash reports the job; a script (bash -c) says nothing.
      if (io.interactive) this.writeTerminal(io, `[${jobId}] ${pid}\n`);

      // Don't auto-reap - let Shell collect zombies before next prompt
      // This matches Linux behavior where zombies persist until reaped

      return 0;
    }

    return (await this.executeListEntries(list.entries, io));
  }

  private getListCommandText(list: ListNode): string {
    return list.entries.map((e) =>
      e.pipeline.commands.map((c) => {
        if (c.type === 'simple_command') {
          return c.words.map((w) => w.map((p) => p.text).join('')).join(' ');
        }
        return c.type;
      }).join(' | '),
    ).join(' ');
  }

  private async executeListEntries(entries: ListNode['entries'], io: ExecutionIo = {}): Promise<number> {
    let exitCode = 0;
    let skipNext = false;

    for (const entry of entries) {
      const abortCode = this.abortExitCode(io);
      if (abortCode !== null) return abortCode;

      if (!skipNext) {
        // Every command of an and-or list but the last runs with errexit ignored.
        exitCode = entry.connector === '&&' || entry.connector === '||'
          ? await this.withErrexitSuppressed(async () => (await this.executePipeline(entry.pipeline, io)))
          : await this.executePipeline(entry.pipeline, io);
      }
      // A status carried past a skipped command came from a guarded one.
      if (!skipNext) this.enforceErrexit(entry.connector, exitCode);
      skipNext = false;

      if (entry.connector === '&&' && exitCode !== 0) {
        skipNext = true;
      } else if (entry.connector === '||' && exitCode === 0) {
        skipNext = true;
      }
    }

    this.lastExitCode = exitCode;
    return exitCode;
  }

  private async executePipeline(pipeline: PipelineNode, io: ExecutionIo = {}): Promise<number> {
    const abortCode = this.abortExitCode(io);
    if (abortCode !== null) return abortCode;

    const commands = pipeline.commands;

    let exitCode: number;

    let statuses: number[];
    if (commands.length === 1) {
      // Single command -- no piping needed
      exitCode = await this.executeCommand(commands[0], io);
      statuses = [exitCode];
    } else {
      ({ exitCode, statuses } = await this.executePipelineCommands(commands, io));
    }
    // Every element's status, as bash's PIPESTATUS (before `!` negates the pipeline's).
    this.config.arrays.set('PIPESTATUS', statuses.map(String));
    delete this.config.env.PIPESTATUS;

    if (pipeline.negated) {
      exitCode = exitCode === 0 ? 1 : 0;
    }

    return exitCode;
  }

  private async executePipelineCommands(commands: CompoundCommandNode[], io: ExecutionIo): Promise<{ exitCode: number; statuses: number[] }> {
    const pipes: PipeChannel[] = [];
    const promises: Promise<number>[] = [];
    const pipelineAbortController = new AbortController();
    const parentSignal = io.signal ?? this.config.getAbortSignal?.();
    let unlinkParentSignal: (() => void) | undefined;

    if (parentSignal?.aborted) {
      pipelineAbortController.abort(parentSignal.reason);
    } else if (parentSignal) {
      unlinkParentSignal = linkAbortSignal(parentSignal, pipelineAbortController);
    }

    try {
      for (let i = 0; i < commands.length; i++) {
        const abortCode = this.abortExitCode(io);
        if (abortCode !== null) return { exitCode: abortCode, statuses: [abortCode] };

        const stdin = i > 0 ? pipes[i - 1].reader : undefined;
        let stdout: CommandOutputStream | undefined;

        if (i < commands.length - 1) {
          const pipe = new PipeChannel(pipelineAbortController.signal);
          pipes.push(pipe);
          stdout = pipe.writer;
        }

        const cmd = commands[i];
        const isLast = i === commands.length - 1;
        const commandStdin = stdin ?? (i === 0 ? io.stdin : undefined);
        const commandStdout = stdout ?? (isLast ? io.stdout : undefined);
        const cmdIo = this.createCommandIo(io);
        if (commandStdin) cmdIo.stdin = commandStdin;
        else delete cmdIo.stdin;
        if (commandStdout) cmdIo.stdout = commandStdout;
        else delete cmdIo.stdout;
        cmdIo.terminalFds = {
          stdin: stdin ? false : io.terminalFds?.stdin,
          stdout: stdout ? false : io.terminalFds?.stdout,
          stderr: io.terminalFds?.stderr,
        };
        cmdIo.signal = pipelineAbortController.signal;
        cmdIo.positionals = this.forkPositionals(io);
        // Each element runs in a child shell (bash forks every one).
        const element = this.fork();
        const cmdPromise = (async (): Promise<number> => {
          try {
            return await element.finishChild(async () => (await element.executeCommand(cmd, cmdIo)), cmdIo);
          } catch (e) {
            if (e instanceof ExitSignal) {
              return e.exitCode;
            }
            // A builtin wrote to a pipe whose reader is gone: in bash that kills
            // the element's own subshell, so the element ends with SIGPIPE's status.
            if ((e as { code?: string })?.code === 'EPIPE') return 141;
            throw e;
          } finally {
            // Only the closed pipe reaches the other elements: each goes on
            // until it writes to a pipe nobody reads (bash; no abort here).
            if (i > 0) pipes[i - 1].cancel();
            if (i < commands.length - 1) {
              pipes[i].close();
            }
          }
        })();

        promises.push(cmdPromise);
      }

      const results = await Promise.all(promises);
      if (this.config.options.pipefail) {
        for (let i = results.length - 1; i >= 0; i--) {
          if (results[i] !== 0) return { exitCode: results[i] ?? 1, statuses: results };
        }
      }
      return { exitCode: results[results.length - 1] ?? 0, statuses: results };
    } finally {
      unlinkParentSignal?.();
    }
  }

  private async executeCommand(
    cmd: CompoundCommandNode,
    io: ExecutionIo = {},
  ): Promise<number> {
    const abortCode = this.abortExitCode(io);
    if (abortCode !== null) return abortCode;

    switch (cmd.type) {
      case 'simple_command':
        return (await this.executeSimpleCommand(cmd, io));
      case 'double_bracket':
        return (await this.executeDoubleBracket(cmd, io));
      case 'if':
        return (await this.executeIf(cmd, io));
      case 'for':
        return (await this.executeFor(cmd, io));
      case 'while':
        return (await this.executeWhile(cmd, io));
      case 'until':
        return (await this.executeUntil(cmd, io));
      case 'case':
        return (await this.executeCase(cmd, io));
      case 'group':
        return (await this.executeGroup(cmd, io));
      case 'subshell':
        return (await this.executeSubshell(cmd, io));
      case 'function_def':
        return (await this.executeFunctionDef(cmd));
    }
  }

  private async executeIf(node: IfNode, io: ExecutionIo): Promise<number> {
    return (await this.executeWithRedirections(node.redirections, io, async (redirIo) => {
      let exitCode = 0;

      for (const clause of node.clauses) {
        const condCode = await this.withErrexitSuppressed(async () => (await this.executeCompoundList(clause.condition, redirIo)));
        if (condCode === 0) {
          exitCode = await this.executeCompoundList(clause.body, redirIo);
          this.lastExitCode = exitCode;
          return exitCode;
        }
      }

      if (node.elseBody) {
        exitCode = await this.executeCompoundList(node.elseBody, redirIo);
      }

      this.lastExitCode = exitCode;
      return exitCode;
    }));
  }

  private async executeDoubleBracket(node: DoubleBracketNode, io: ExecutionIo): Promise<number> {
    return (await this.executeWithRedirections(node.redirections, io, async (redirIo) => {
      const stdout = redirIo.stdout ?? this.terminalSink(redirIo);
      const stderr = redirIo.stderr ?? this.terminalSink(redirIo);
      const fds = this.createCommandFds(stdout, stderr, redirIo.stdin, redirIo);
      const builtinIo = this.createIoFromFds(redirIo, fds);
      const exitCode = await this.withFdFlush(fds, async () => (await evaluateDoubleBracketWords(
        node.words,
        this.createExpandContext(redirIo),
        redirIo.vfs ?? this.config.vfs,
        stderr,
        {
          vfs: builtinIo.vfs ?? this.config.vfs,
          cwd: this.config.getCwd(),
          stdin: builtinIo.stdin,
          stdout,
          stderr,
          terminalStdin: redirIo.terminalStdin,
          terminalFds: {
            stdin: fds.terminalInputFds.has(0),
            stdout: fds.terminalOutputFds.has(1),
            stderr: fds.terminalOutputFds.has(2),
          },
          scriptMode: redirIo.scriptMode,
          isFdTerminal: (fd) => this.isFdTerminal(fds, fd),
          getPositionals: () => this.readPositionals(builtinIo),
          setPositionals: (nextArgs) => this.writePositionals(builtinIo, nextArgs),
          executeInline: async (input, options) => (await this.executeInline(input, builtinIo, options)),
          declareLocal: (name) => this.declareLocal(name),
          unsetFunction: (name) => this.functions.delete(name),
          shell: this.config,
          interactive: redirIo.interactive,
          getLastExitCode: () => this.lastExitCode,
        },
      )));
      this.lastExitCode = exitCode;
      return exitCode;
    }));
  }

  private loopTicks = 0;

  /**
   * A loop whose body never waits on I/O would run entirely on microtasks,
   * and no timer, Ctrl-C or `kill` could reach it. Every 64 iterations it
   * lets the event loop run. (Counted, not timed: workerd's clock stands
   * still while code runs.)
   */
  private async loopTick(): Promise<void> {
    if (++this.loopTicks % 64 === 0) await yieldToEventLoop();
  }

  private async executeFor(node: ForNode, io: ExecutionIo): Promise<number> {
    return (await this.executeWithRedirections(node.redirections, io, async (redirIo) => {
      const expandCtx = this.createExpandContext(redirIo);
      let exitCode = 0;

      let values: string[];
      if (node.words !== null) {
        values = await expandWords(node.words, expandCtx);
      } else {
        values = [...this.readPositionals(redirIo)];
      }

      for (const val of values) {
        await this.loopTick();
        const abortCode = this.abortExitCode(redirIo);
        if (abortCode !== null) return abortCode;

        if (!this.assignEnv(node.variable, val)) {
          this.writeTerminal(redirIo, `${node.variable}: readonly variable\n`);
          return 1;
        }
        try {
          exitCode = await this.executeCompoundList(node.body, redirIo);
        } catch (e) {
          if (e instanceof BreakSignal) {
            if (e.levels > 1) throw new BreakSignal(e.levels - 1);
            break;
          }
          if (e instanceof ContinueSignal) {
            if (e.levels > 1) throw new ContinueSignal(e.levels - 1);
            continue;
          }
          throw e;
        }
      }

      this.lastExitCode = exitCode;
      return exitCode;
    }));
  }

  private async executeWhile(node: WhileNode, io: ExecutionIo): Promise<number> {
    return (await this.executeWithRedirections(node.redirections, io, async (redirIo) => {
      let exitCode = 0;

      while (true) {
        await this.loopTick();
        const abortCode = this.abortExitCode(redirIo);
        if (abortCode !== null) return abortCode;

        const condCode = await this.withErrexitSuppressed(async () => (await this.executeCompoundList(node.condition, redirIo)));
        if (condCode !== 0) break;

        try {
          exitCode = await this.executeCompoundList(node.body, redirIo);
        } catch (e) {
          if (e instanceof BreakSignal) {
            if (e.levels > 1) throw new BreakSignal(e.levels - 1);
            break;
          }
          if (e instanceof ContinueSignal) {
            if (e.levels > 1) throw new ContinueSignal(e.levels - 1);
            continue;
          }
          throw e;
        }
      }

      this.lastExitCode = exitCode;
      return exitCode;
    }));
  }

  private async executeUntil(node: UntilNode, io: ExecutionIo): Promise<number> {
    return (await this.executeWithRedirections(node.redirections, io, async (redirIo) => {
      let exitCode = 0;

      while (true) {
        await this.loopTick();
        const abortCode = this.abortExitCode(redirIo);
        if (abortCode !== null) return abortCode;

        const condCode = await this.withErrexitSuppressed(async () => (await this.executeCompoundList(node.condition, redirIo)));
        if (condCode === 0) break;

        try {
          exitCode = await this.executeCompoundList(node.body, redirIo);
        } catch (e) {
          if (e instanceof BreakSignal) {
            if (e.levels > 1) throw new BreakSignal(e.levels - 1);
            break;
          }
          if (e instanceof ContinueSignal) {
            if (e.levels > 1) throw new ContinueSignal(e.levels - 1);
            continue;
          }
          throw e;
        }
      }

      this.lastExitCode = exitCode;
      return exitCode;
    }));
  }

  private async executeCase(node: CaseNode, io: ExecutionIo): Promise<number> {
    return (await this.executeWithRedirections(node.redirections, io, async (redirIo) => {
      const expandCtx = this.createExpandContext(redirIo);
      const wordValue = await expandWord(node.word, expandCtx);
      let exitCode = 0;

      for (const item of node.items) {
        for (const pattern of item.patterns) {
          const patternValue = await expandWord(pattern, expandCtx);
          if (globMatch(patternValue, wordValue)) {
            exitCode = await this.executeCompoundList(item.body, redirIo);
            this.lastExitCode = exitCode;
            return exitCode;
          }
        }
      }

      this.lastExitCode = exitCode;
      return exitCode;
    }));
  }

  private async executeFunctionDef(node: FunctionDefNode): Promise<number> {
    this.functions.set(node.name, node.body);
    return 0;
  }

  private async executeGroup(node: GroupNode, io: ExecutionIo): Promise<number> {
    const exitCode = await this.executeWithRedirections(
      node.redirections,
      io,
      async (redirIo) => (await this.executeCompoundList(node.body, redirIo)),
    );
    this.lastExitCode = exitCode;
    return exitCode;
  }

  private async executeSubshell(node: SubshellNode, io: ExecutionIo): Promise<number> {
    const child = this.fork();
    const subshellIo = this.createCommandIo(io);
    subshellIo.positionals = this.forkPositionals(io);
    let exitCode: number;
    try {
      exitCode = await child.executeWithRedirections(
        node.redirections,
        subshellIo,
        async (redirIo) => (await child.finishChild(async () => (await child.executeCompoundList(node.body, redirIo)), redirIo)),
      );
    } finally {
      // A redirection that fails ends the child before its body, and so
      // before finishChild, runs.
      await child.closeDescriptors();
    }
    this.lastExitCode = exitCode;
    return exitCode;
  }


  private async executeCompoundList(lists: ListNode[], io: ExecutionIo): Promise<number> {
    let exitCode = 0;
    for (const list of lists) {
      const abortCode = this.abortExitCode(io);
      if (abortCode !== null) return abortCode;
      exitCode = await this.executeList(list, io);
    }
    return exitCode;
  }

  private async executeSimpleCommand(
    cmd: SimpleCommandNode,
    io: ExecutionIo,
  ): Promise<number> {
    const abortCode = this.abortExitCode(io);
    if (abortCode !== null) return abortCode;
    if (io.commandIdentity) io = { ...io, vfs: bindProcessView(this.config.filesystem, {
      pid: io.commandIdentity.pid, cred: io.commandIdentity.cred, signal: io.signal,
    }) };

    const expandCtx = this.createExpandContext(io);

    // Expand words
    const expandedArgs = await expandWords(cmd.words, expandCtx);
    if (expandedArgs.length === 0 && cmd.assignments.length > 0) {
      // Bare assignment -- set env vars
      for (const assign of cmd.assignments) {
        if (!await this.applyAssignment(assign, expandCtx)) {
          this.writeTerminal(io, `${assign.name}: readonly variable\n`);
          if (io.scriptMode === true) throw new ErrexitSignal(1);
          return 1;
        }
      }
      // A command that is only assignments exits with the status of the last
      // command substitution it ran, so `out="$(cmd)" || die` sees cmd fail.
      return expandCtx.lastSubstitutionExitCode ?? 0;
    }

    if (expandedArgs.length === 0) {
      return 0;
    }

    let [name, ...args] = expandedArgs;
    // `exec utility [args]` runs the utility in place of this shell: its
    // status becomes the shell's exit status and nothing after it runs.
    const replacesShell = name === 'exec' && args.length > 0 && !(args.length === 1 && args[0] === '--');
    if (replacesShell) [name, ...args] = args[0] === '--' ? args.slice(1) : args;

    // Check alias expansion
    const aliases = replacesShell ? undefined : this.config.aliases;
    if (aliases) {
      const aliasValue = aliases.get(name);
      if (aliasValue !== undefined) {
        // Rebuild the command line with the alias expanded
        const expandedLine = aliasValue + (args.length > 0 ? ' ' + args.join(' ') : '');
        return (await this.executeLineWithIo(expandedLine, io));
      }
    }

    // Apply per-command assignments (temporary env)
    const saved = new Map<string, SavedVariable>();
    for (const assign of cmd.assignments) {
      if (!saved.has(assign.name)) saved.set(assign.name, this.saveVariable(assign.name));
      if (!await this.applyAssignment(assign, expandCtx)) {
        (await (io.stderr ?? this.terminalSink(io)).write(`${assign.name}: readonly variable\n`));
        return 1;
      }
    }

    // Set up stdout/stderr (per-execution io target, then the terminal sink)
    let stdout: CommandOutputStream = io.stdout ?? this.terminalSink(io);
    let stderr: CommandOutputStream = io.stderr ?? this.terminalSink(io);
    let stdin: CommandInputStream | undefined = io.stdin;
    const fds = this.createCommandFds(stdout, stderr, stdin, io);
    try {
      await this.applyRedirections(cmd.redirections, fds, expandCtx, io, io.terminalStdin);
    } catch (error) {
      const redirStderr = fds.outputFds.get(2) ?? stderr;
      (await redirStderr.write(error instanceof RedirectionOpenError
        ? redirectionDiagnostic(error)
        : `${error instanceof Error ? error.message : String(error)}\n`));
      await this.flushFds(fds);
      this.lastExitCode = 1;
      return 1;
    }
    stdout = fds.outputFds.get(1) ?? this.createNullWriter();
    stderr = fds.outputFds.get(2) ?? this.createNullWriter();
    stdin = fds.inputFds.get(0);

    // If no stdin from pipe or redirect, fall back to terminal stdin
    if (!stdin && io.terminalStdin) {
      stdin = io.terminalStdin;
    }

    let exitCode: number;
    let writeFailed = false;

    try {
      // Check for break/continue/return builtins
      if (name === 'break') {
        const levels = args[0] ? parseInt(args[0], 10) : 1;
        throw new BreakSignal(levels);
      }
      if (name === 'continue') {
        const levels = args[0] ? parseInt(args[0], 10) : 1;
        throw new ContinueSignal(levels);
      }
      if (name === 'return') {
        const code = args[0] ? parseInt(args[0], 10) : this.lastExitCode;
        throw new ReturnSignal(code);
      }
      if (name === 'exec' && args.length === 0) {
        await this.persistFdState(fds);
        exitCode = 0;
      } else {
        // Check functions
        const funcBody = replacesShell ? undefined : this.functions.get(name);
        if (funcBody) {
          exitCode = await this.executeFunction(funcBody, args, this.createIoFromFds(io, fds));
        } else {
          // Check builtins
          const builtin = this.config.builtins.get(name);
          if (builtin) {
            const builtinIo = this.createIoFromFds(io, fds);
            try {
              exitCode = await builtin(args, stdout, stderr, stdin, {
                vfs: builtinIo.vfs ?? this.config.vfs,
                cwd: this.config.getCwd(),
                stdin,
                stdout,
                stderr,
                terminalStdin: io.terminalStdin,
                terminalFds: {
                  stdin: fds.terminalInputFds.has(0),
                  stdout: fds.terminalOutputFds.has(1),
                  stderr: fds.terminalOutputFds.has(2),
                },
                scriptMode: io.scriptMode,
                isFdTerminal: (fd) => this.isFdTerminal(fds, fd),
                getPositionals: () => this.readPositionals(builtinIo),
                setPositionals: (nextArgs) => this.writePositionals(builtinIo, nextArgs),
                executeInline: async (input, options) => (await this.executeInline(input, builtinIo, options)),
            declareLocal: (name) => this.declareLocal(name),
            unsetFunction: (name) => this.functions.delete(name),
            shell: this.config,
            interactive: io.interactive,
            getLastExitCode: () => this.lastExitCode,
              });
            } catch (error) {
              // A write the store or a device refused fails the builtin, as it
              // fails a registered command (runCommand): its message on its
              // stderr, status 1. A broken pipe and the shell's signals pass.
              if (!isRefusedWrite(error)) throw error;
              try {
                await stderr.write(`${name}: ${error instanceof Error ? error.message : String(error)}\n`);
              } catch {
                // Its stderr may be what refused; the status still says so.
              }
              exitCode = 1;
            }
          } else {
            // Check registry; a bare name not registered is searched for on the
            // PATH this command runs with, a `PATH=x cmd` prefix included.
            const command = await this.config.registry.resolve(name, resolveContext(this.config.getCwd(), this.config.env, io.vfs ?? this.config.vfs));
            if (!command) {
              (await stderr.write(`${name}: command not found\n`));
              exitCode = 127;
            } else {
              const identity = io.commandIdentity;
              if (!identity) throw new Error('shell command identity is unavailable');
              const ended = await this.runCommand(command, name, args, {
                commandContext: io.commandContext,
                identity,
                cwd: this.config.getCwd(),
                env: { ...this.config.env },
                vfs: io.vfs ?? this.config.vfs,
                stdout,
                stderr,
                stdin,
                terminalStdin: io.terminalStdin,
                isFdTerminal: (fd: number) => this.isFdTerminal(fds, fd),
                isFdPipe: (fd: number) => isPipeEnd(fds.outputFds.get(fd) ?? fds.inputFds.get(fd)),
                signal: io.signal ?? this.config.getAbortSignal?.() ?? new AbortController().signal,
                runAs: io.runAs,
                register: io.registerProcess !== false,
                shellBuiltin: BASH_BUILTINS.has(name),
              });
              exitCode = ended.status;

              // A signalled command reports the SIGNAL's status, not whatever
              // code it returned on its way out: `sleep` observes only that
              // ctx.signal aborted, and cannot tell SIGINT (130) from
              // SIGQUIT (131). The shell holds the reason, so it decides.
              const signalledCode = this.abortExitCode(io);
              if (signalledCode !== null) exitCode = signalledCode;
            }
          }
        }
      }
    } finally {
      writeFailed = await this.flushFds(fds, name);
      // Restore env from per-command assignments
      for (const [name, value] of saved) this.restoreVariable(name, value);
    }
    if (writeFailed && exitCode === 0) exitCode = 1;

    const fatalSpecialBuiltin = io.scriptMode === true
      && exitCode !== 0
      && isFatalSpecialBuiltin(name);
    this.lastExitCode = exitCode;
    if (fatalSpecialBuiltin) throw new ErrexitSignal(exitCode);
    if (replacesShell) throw new ExitSignal(exitCode);
    return exitCode;
  }

  /**
   * execvp(3) of `argv`: argv[0] is found as a program is found (the
   * registry, then a path from `spec.cwd`), never as a function, an alias or
   * a builtin, and runs as a process on the streams it is handed. A program
   * that is not there is ENOENT, as execvp fails, for the caller to report.
   * One whose write finds its reader gone ends there, by SIGPIPE, and its
   * caller goes on, as the parent of a process SIGPIPE kills does.
   */
  async runProgram(argv: readonly string[], spec: ProgramSpec): Promise<ChildExit> {
    const [name, ...args] = argv;
    if (name === undefined) return exited(0);
    // The program is found, as it runs, under the child's credential.
    const vfs = bindProcessView(this.config.filesystem, { pid: spec.identity.pid, cred: spec.identity.cred, signal: spec.signal });
    const command = await this.config.registry.resolve(name, resolveContext(spec.cwd, spec.env, vfs));
    if (!command) throw syscallError('ENOENT', 'execvp', name);
    return await this.runCommand(command, name, args, {
      ...spec,
      vfs,
      register: true,
      shellBuiltin: false,
    });
  }

  /**
   * A resolved command, run as a process of this shell's: listed for ps,
   * jobs and kill while it runs, aborted with `spec.signal`, and its failure
   * (a closed pipe, an abort, a throw) turned into the status a process
   * would end with.
   */
  private async runCommand(command: Command, name: string, args: string[], spec: CommandSpec): Promise<ChildExit> {
    const abortController = new AbortController();
    const unlinkShellSignal = linkAbortSignal(spec.signal, abortController);
    const { identity, terminalStdin, stderr } = spec;
    let pid: number | undefined;
    const ctx: CommandContext = {
      ...spec.commandContext,
      pid: identity.pid,
      cred: identity.cred,
      args,
      env: spec.env,
      cwd: spec.cwd,
      vfs: spec.vfs,
      stdout: spec.stdout,
      stderr,
      signal: abortController.signal,
      stdin: spec.stdin,
      terminalStdin,
      setRawMode: terminalStdin
        ? (v: boolean) => { terminalStdin.rawMode = v; }
        : undefined,
      getRawMode: terminalStdin
        ? () => terminalStdin.rawMode
        : undefined,
      isFdTerminal: spec.isFdTerminal,
      isFdPipe: spec.isFdPipe,
      setUmask: identity.setUmask,
      runAs: async (cred, argv, options) => spec.runAs
        ? (await spec.runAs(options?.parent ?? ctx, cred, argv))
        : exited(126),
    };

    // Register process BEFORE executing so ps can see itself
    let commandPromise: Promise<ChildExit>;

    if (spec.register) {
      let resolvePromise: ((code: number) => void) | undefined;
      let rejectPromise: ((err: unknown) => void) | undefined;
      const registeredPromise = new Promise<number>((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
      });

      pid = this.config.processRegistry.spawn({
        command: name,
        args: [name, ...args],
        cwd: spec.cwd,
        env: { ...spec.env },
        isForeground: true,
        promise: registeredPromise,
        abortController,
      });

      commandPromise = command(ctx).then(
        (code) => {
          resolvePromise?.(code);
          return exited(code);
        },
        async (err) => {
          if (isBrokenPipe(err)) {
            // SIGPIPE: a builtin's ends its element (the catch below
            // rethrows it); any other command alone dies, silently.
            resolvePromise?.(KILLED_BY_SIGPIPE.status);
            if (spec.shellBuiltin) throw err;
            return KILLED_BY_SIGPIPE;
          }
          rejectPromise?.(err);
          if (err instanceof Error && err.name === 'AbortError') return exited(130);
          // Surface the failure: this rejection handler resolves
          // commandPromise to an exit code, so the catch below
          // never sees the error — without this write a throwing
          // registered command dies silently at the prompt.
          (await stderr.write(`${name}: ${err instanceof Error ? err.message : String(err)}\n`));
          return exited(1);
        }
      );
    } else {
      commandPromise = command(ctx).then(exited);
    }

    try {
      return await commandPromise;
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return exited(130);
      if (isBrokenPipe(e)) {
        // A bash builtin's write is the shell's own: in bash SIGPIPE
        // kills the element's subshell, so its element ends.
        if (spec.shellBuiltin) throw e;
        // Any other command is its own process: it alone dies, silently.
        return KILLED_BY_SIGPIPE;
      }
      (await stderr.write(`${name}: ${e instanceof Error ? e.message : String(e)}\n`));
      return exited(1);
    } finally {
      unlinkShellSignal();
      if (spec.register && pid !== undefined) {
        await Promise.resolve();
        this.config.processRegistry.reap(pid);
      }
    }
  }

  private assignEnv(name: string, value: string): boolean {
    if (this.config.readonlyNames.has(name)) return false;
    assignScalar(this.config.env, this.config.arrays, name, value);
    return true;
  }

  /**
   * `name=value`, `name+=value`, `name[expr]=value` and `name=(word …)`.
   * Returns false when the name is readonly, which the caller reports.
   */
  private async applyAssignment(assign: AssignmentNode, ctx: ExpandContext): Promise<boolean> {
    const { name } = assign;
    if (this.config.readonlyNames.has(name)) return false;

    if (assign.elements !== undefined) {
      const values = await expandWords(assign.elements, ctx);
      const existing = assign.append ? this.config.arrays.get(name) ?? [] : [];
      delete this.config.env[name];
      this.config.arrays.set(name, [...existing, ...values]);
      return true;
    }

    const value = await expandWord(assign.value, ctx);

    if (assign.subscript !== undefined) {
      const array = this.arrayFor(name);
      const index = await evaluateSubscript(assign.subscript, array.length, ctx);
      array[index] = assign.append ? (array[index] ?? '') + value : value;
      return true;
    }

    // A plain assignment to an array name lands on its first element, and
    // `arr+=x` appends to that element rather than adding one.
    const array = this.config.arrays.get(name);
    if (array !== undefined) {
      array[0] = assign.append ? (array[0] ?? '') + value : value;
      return true;
    }

    this.config.env[name] = assign.append ? (this.config.env[name] ?? '') + value : value;
    return true;
  }

  /** One variable's whole binding, so a scope can put it back exactly. */
  private saveVariable(name: string): SavedVariable {
    return { scalar: this.config.env[name], array: this.config.arrays.get(name) };
  }

  private restoreVariable(name: string, saved: SavedVariable): void {
    if (saved.array === undefined) this.config.arrays.delete(name);
    else this.config.arrays.set(name, saved.array);
    if (saved.scalar === undefined) delete this.config.env[name];
    else this.config.env[name] = saved.scalar;
  }

  /** The array behind a subscripted assignment, promoting a scalar if needed. */
  private arrayFor(name: string): (string | undefined)[] {
    const existing = this.config.arrays.get(name);
    if (existing !== undefined) return existing;
    const scalar = this.config.env[name];
    const array: (string | undefined)[] = scalar === undefined ? [] : [scalar];
    delete this.config.env[name];
    this.config.arrays.set(name, array);
    return array;
  }

  private async executeFunction(body: CompoundCommandNode, args: string[], io: ExecutionIo): Promise<number> {
    let exitCode: number;
    const functionIo = this.createCommandIo(io);
    functionIo.positionals = { args: [...args] };
    this.localFrames.push(new Map());
    try {
      exitCode = await this.executeCommand(body, functionIo);
    } catch (e) {
      if (e instanceof ReturnSignal) {
        exitCode = e.exitCode;
      } else {
        throw e;
      }
    } finally {
      const frame = this.localFrames.pop();
      if (frame !== undefined) {
        for (const [name, saved] of frame) this.restoreVariable(name, saved);
      }
    }

    this.lastExitCode = exitCode;
    return exitCode;
  }

  /**
   * Bind a name to the running function, unset, so an assignment to it does
   * not outlive the call. Shell variables are dynamically scoped, so a callee
   * still sees its caller's locals — which is what bash does. Returns false
   * outside a function, where `local` is an error.
   */
  private declareLocal(name: string): boolean {
    const frame = this.localFrames[this.localFrames.length - 1];
    if (frame === undefined) return false;
    if (!frame.has(name)) frame.set(name, this.saveVariable(name));
    delete this.config.env[name];
    this.config.arrays.delete(name);
    return true;
  }

  async executeCapture(input: string, io: ExecutionIo = {}): Promise<CapturedCommand> {
    let captured = '';
    const stdout: CommandOutputStream = {
      write: (text: string) => { captured += text; },
    };

    const captureIo = this.createCommandIo(io);
    captureIo.stdout = stdout;
    captureIo.positionals = this.forkPositionals(io);
    // $( ) runs in a child shell.
    const child = this.fork();
    const exitCode = await child.finishChild(async () => (await child.executeLineWithIo(input, captureIo)), captureIo);

    return { output: captured, exitCode };
  }

  private async executeInline(
    input: string,
    io: ExecutionIo,
    options: InlineExecutionOptions = {},
  ): Promise<number> {
    const inlineIo = this.createCommandIo(io);
    if (options.positionals !== undefined) {
      inlineIo.positionals = { args: [...options.positionals] };
    }
    return (await this.executeLineWithIo(input, inlineIo));
  }

  private async executeLineWithIo(input: string, io: ExecutionIo): Promise<number> {
    const tokens = lex(input);
    const script = parse(tokens);
    return (await this.executeScriptWithIo(script, io));
  }

  /**
   * A child shell's run and end: it holds the files its io inherited while it
   * runs, its EXIT trap runs, an `exit` inside it ends only it, and its
   * descriptors close.
   */
  private async finishChild(run: () => Promise<number>, io: ExecutionIo): Promise<number> {
    // Taken before the first await: a background child starts here while its
    // parent goes on to close what it opened.
    const inherited = [...(io.openFiles?.values() ?? [])];
    for (const file of inherited) file.refs++;
    try {
      let exitCode: number;
      try {
        exitCode = await run();
      } catch (e) {
        if (!(e instanceof ExitSignal)) throw e;
        exitCode = e.exitCode;
      }
      return (await this.runExitTrap(exitCode, io, true));
    } finally {
      await this.release([...this.takeDescriptors(), ...inherited]);
    }
  }

  private async runExitTrap(exitCode: number, io: ExecutionIo, enabled: boolean): Promise<number> {
    if (!enabled || this.exitTrapDepth > 0) return exitCode;
    const action = this.config.traps.get('EXIT');
    if (action === undefined) return exitCode;

    const savedLastExitCode = this.lastExitCode;
    this.lastExitCode = exitCode;
    this.exitTrapDepth++;
    try {
      await this.executeLineWithIo(action, io);
    } finally {
      this.exitTrapDepth--;
      this.lastExitCode = savedLastExitCode;
    }
    return exitCode;
  }

  private createTerminalIo(
    terminalStdin?: TerminalInputStream,
    terminalFds?: TerminalFdState,
    scriptMode?: boolean,
    stdin?: CommandInputStream,
  ): ExecutionIo {
    const io: ExecutionIo = {};
    if (stdin) io.stdin = stdin;
    if (terminalStdin) io.terminalStdin = terminalStdin;
    if (terminalFds) io.terminalFds = terminalFds;
    if (scriptMode) io.scriptMode = true;
    return io;
  }

  private createCommandIo(io: ExecutionIo): ExecutionIo {
    const next: ExecutionIo = {};
    if (io.stdin) next.stdin = io.stdin;
    if (io.stdout) next.stdout = io.stdout;
    if (io.stderr) next.stderr = io.stderr;
    if (io.writeToTerminal) next.writeToTerminal = io.writeToTerminal;
    if (io.terminalStdin) next.terminalStdin = io.terminalStdin;
    if (io.terminalFds) next.terminalFds = io.terminalFds;
    if (io.scriptMode) next.scriptMode = true;
    if (io.signal) next.signal = io.signal;
    if (io.registerProcess === false) next.registerProcess = false;
    if (io.positionals) next.positionals = io.positionals;
    if (io.commandContext) next.commandContext = io.commandContext;
    if (io.commandIdentity) next.commandIdentity = io.commandIdentity;
    if (io.runAs) next.runAs = io.runAs;
    if (io.vfs) next.vfs = io.vfs;
    if (io.interactive) next.interactive = true;
    if (io.openFiles) next.openFiles = io.openFiles;
    return next;
  }

  /** Per-execution direct-terminal write, isolated from a nested capture. */
  private writeTerminal(io: ExecutionIo, text: string): void {
    (io.writeToTerminal ?? this.config.writeToTerminal)(text);
  }

  /** Late-bound fallback sink for command stdout/stderr with no fd target. */
  private terminalSink(io: ExecutionIo): CommandOutputStream {
    return { write: (text: string) => this.writeTerminal(io, text) };
  }

  private forkPositionals(io: ExecutionIo): PositionalFrame {
    return { args: [...this.readPositionals(io)] };
  }

  private createExpandContext(io: ExecutionIo = {}): ExpandContext {
    return {
      env: this.config.env,
      arrays: this.config.arrays,
      positionals: this.readPositionals(io),
      lastExitCode: this.lastExitCode,
      cwd: this.config.getCwd(),
      vfs: io.vfs ?? this.config.vfs,
      options: this.config.options,
      executeCapture: async (input) => (await this.executeCapture(input, io)),
    };
  }

  private createIoFromFds(io: ExecutionIo, fds: FdState): ExecutionIo {
    const next = this.createCommandIo(io);
    next.stdout = fds.outputFds.get(1) ?? this.createNullWriter();
    next.stderr = fds.outputFds.get(2) ?? this.createNullWriter();
    const stdin = fds.inputFds.get(0);
    if (stdin) next.stdin = stdin;
    else delete next.stdin;
    next.terminalFds = {
      stdin: fds.terminalInputFds.has(0),
      stdout: fds.terminalOutputFds.has(1),
      stderr: fds.terminalOutputFds.has(2),
    };
    if (fds.opened.size > 0) next.openFiles = new Map([...(io.openFiles ?? []), ...fds.opened]);
    return next;
  }

  private readPositionals(io: ExecutionIo): readonly string[] {
    if (io.positionals) return io.positionals.args;
    const count = Number.parseInt(this.config.env['#'] ?? '0', 10);
    const args: string[] = [];
    for (let i = 1; i <= count; i++) {
      args.push(this.config.env[String(i)] ?? '');
    }
    return args;
  }

  private writePositionals(io: ExecutionIo, args: string[]): void {
    if (io.positionals) {
      io.positionals.args = [...args];
      return;
    }
    for (const key of Object.keys(this.config.env)) {
      if (key === '@' || key === '#' || /^[1-9][0-9]*$/.test(key)) {
        delete this.config.env[key];
      }
    }
    this.config.env['#'] = String(args.length);
    this.config.env['@'] = args.join(' ');
    for (let i = 0; i < args.length; i++) {
      this.config.env[String(i + 1)] = args[i];
    }
  }

  private createCommandFds(
    stdout: CommandOutputStream,
    stderr: CommandOutputStream,
    stdin: CommandInputStream | undefined,
    io: ExecutionIo,
  ): FdState {
    const outputFds = new Map<number, CommandOutputStream>([
      [1, stdout],
      [2, stderr],
      ...this.persistentOutputFds,
    ]);
    const inputFds = new Map<number, CommandInputStream | undefined>([
      [0, stdin],
      ...this.persistentInputFds,
    ]);
    const terminalOutputFds = new Set<number>(this.persistentTerminalOutputFds);
    setMembership(
      terminalOutputFds,
      1,
      io.terminalFds?.stdout ?? !io.stdout,
    );
    setMembership(
      terminalOutputFds,
      2,
      io.terminalFds?.stderr ?? !io.stderr,
    );
    const terminalInputFds = new Set<number>(this.persistentTerminalInputFds);
    setMembership(
      terminalInputFds,
      0,
      io.terminalFds?.stdin ?? (!stdin && Boolean(io.terminalStdin)),
    );
    if (io.terminalStdin) {
      for (const fd of terminalInputFds) {
        inputFds.set(fd, io.terminalStdin);
      }
    }
    return {
      outputFds,
      inputFds,
      terminalOutputFds,
      terminalInputFds,
      changedOutputFds: new Set(),
      changedInputFds: new Set(),
      opened: new Map(),
      enclosing: io.openFiles ?? new Map(),
    };
  }

  private async executeWithRedirections(
    redirections: RedirectionNode[],
    io: ExecutionIo,
    execute: (io: ExecutionIo) => Promise<number>,
  ): Promise<number> {
    if (redirections.length === 0) {
      return (await execute(io));
    }

    const expandCtx = this.createExpandContext(io);
    const stdout = io.stdout ?? this.terminalSink(io);
    const stderr = io.stderr ?? this.terminalSink(io);
    const fds = this.createCommandFds(stdout, stderr, io.stdin, io);
    // The flush owns every file the redirections open, including those opened
    // before one that fails to open or to expand.
    return (await this.withFdFlush(fds, async () => {
      try {
        await this.applyRedirections(redirections, fds, expandCtx, io, io.terminalStdin);
      } catch (error) {
        if (!(error instanceof RedirectionOpenError)) throw error;
        const redirStderr = fds.outputFds.get(2) ?? stderr;
        (await redirStderr.write(redirectionDiagnostic(error)));
        this.lastExitCode = 1;
        return 1;
      }
      return (await execute(this.createIoFromFds(io, fds)));
    }));
  }

  private async applyRedirections(
    redirections: RedirectionNode[],
    fds: FdState,
    expandCtx: ExpandContext,
    io: ExecutionIo,
    terminalStdin?: TerminalInputStream,
  ): Promise<void> {
    for (const redir of redirections) {
      if (redir.operator === 'heredoc') {
        const heredoc = redir.heredoc ?? { body: '', quoted: false, stripTabs: false };
        const body = heredoc.quoted
          ? heredoc.body
          : await expandWord([{ text: heredoc.body, quoted: 'double' }], expandCtx);
        this.setInputFd(fds, redir.fd ?? 0, { stream: staticStdinReader(body), terminal: false });
        continue;
      }

      const target = await expandWord(redir.target, expandCtx);
      switch (redir.operator) {
        case 'write':
          this.setOutputFd(fds, redir.fd ?? 1, (await this.openOutputTarget(io, target, 'write', fds, terminalStdin)));
          break;
        case 'append':
          this.setOutputFd(fds, redir.fd ?? 1, (await this.openOutputTarget(io, target, 'append', fds, terminalStdin)));
          break;
        case 'read':
          this.setInputFd(fds, redir.fd ?? 0, (await this.openInputTarget(io, target, fds, terminalStdin)));
          break;
        case 'readWrite': {
          const fd = redir.fd ?? 0;
          this.setInputFd(fds, fd, (await this.openInputTarget(io, target, fds, terminalStdin)));
          this.setOutputFd(fds, fd, (await this.openOutputTarget(io, target, 'append', fds, terminalStdin)));
          break;
        }
        case 'writeAll': {
          const writer = (await this.openOutputTarget(io, target, 'write', fds, terminalStdin));
          this.setOutputFd(fds, 1, writer);
          this.setOutputFd(fds, 2, writer);
          break;
        }
        case 'dupOutput':
          this.dupOutputFd(fds, redir.fd ?? 1, target);
          break;
        case 'dupInput':
          this.dupInputFd(fds, redir.fd ?? 0, target);
          break;
      }
    }
  }

  private async persistFdState(fds: FdState): Promise<void> {
    const released: OpenFile[] = [];
    for (const fd of fds.changedOutputFds) {
      const stream = fds.outputFds.get(fd);
      if (stream) this.persistentOutputFds.set(fd, stream);
      else this.persistentOutputFds.delete(fd);
      this.repointPersistentHandle(this.persistentOutputHandles, fd, stream, fds, released);
      if (fds.terminalOutputFds.has(fd)) this.persistentTerminalOutputFds.add(fd);
      else this.persistentTerminalOutputFds.delete(fd);
    }
    for (const fd of fds.changedInputFds) {
      const isTerminal = fds.terminalInputFds.has(fd);
      const stream = isTerminal ? undefined : fds.inputFds.get(fd);
      if (fds.inputFds.has(fd)) {
        this.persistentInputFds.set(fd, stream);
      } else {
        this.persistentInputFds.delete(fd);
      }
      this.repointPersistentHandle(this.persistentInputHandles, fd, stream, fds, released);
      if (isTerminal) this.persistentTerminalInputFds.add(fd);
      else this.persistentTerminalInputFds.delete(fd);
    }
    // Every new reference is taken before any old one is let go, so a file
    // this `exec` moves to another descriptor (`exec 4>&3 3>&-`) stays open.
    await this.release(released);
  }

  /**
   * The shell's end: its descriptors close, as a process's do at exit(2). A
   * file closes with them unless something else still holds it.
   */
  async closeDescriptors(): Promise<void> {
    await this.release(this.takeDescriptors());
  }

  /** Empty the descriptor table, returning one file per descriptor it held. */
  private takeDescriptors(): OpenFile[] {
    const files = this.persistentHandles();
    this.persistentOutputFds.clear();
    this.persistentInputFds.clear();
    this.persistentTerminalOutputFds.clear();
    this.persistentTerminalInputFds.clear();
    this.persistentOutputHandles.clear();
    this.persistentInputHandles.clear();
    return files;
  }

  /** Let go of one reference per entry; a file nothing holds any more closes. */
  private async release(files: readonly OpenFile[]): Promise<void> {
    for (const file of files) file.refs--;
    const closing = new Set(files.filter((file) => file.refs === 0));
    const results = await Promise.allSettled([...closing].map((file) => file.close()));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) throw failure.reason;
  }

  /** One entry per descriptor, so a file `exec 4>&3` shares appears twice. */
  private persistentHandles(): OpenFile[] {
    return [...this.persistentOutputHandles.values(), ...this.persistentInputHandles.values()];
  }

  /**
   * Point a descriptor `exec` keeps past its command at `stream`, holding a
   * reference on the file behind it: one this `exec` opened, one an enclosing
   * redirection holds (`{ exec 3>&1; } >f`), or one another descriptor names
   * (`exec 4>&3`). The file it named before goes to `released`.
   */
  private repointPersistentHandle(
    handles: Map<number, OpenFile>,
    fd: number,
    stream: CommandInputStream | CommandOutputStream | undefined,
    fds: FdState,
    released: OpenFile[],
  ): void {
    const held = handles.get(fd);
    if (held?.stream === stream) return;
    if (held) {
      handles.delete(fd);
      released.push(held);
    }
    if (stream === undefined) return;
    const file = [...this.persistentHandles(), ...released].find((open) => open.stream === stream)
      ?? fds.opened.get(stream)
      ?? fds.enclosing.get(stream);
    if (!file) return;
    file.refs++;
    handles.set(fd, file);
  }

  private setOutputFd(fds: FdState, fd: number, target: OutputTarget): void {
    fds.outputFds.set(fd, target.stream);
    setMembership(fds.terminalOutputFds, fd, target.terminal);
    fds.changedOutputFds.add(fd);
  }

  private setInputFd(fds: FdState, fd: number, target: InputTarget): void {
    fds.inputFds.set(fd, target.stream);
    setMembership(fds.terminalInputFds, fd, target.terminal);
    fds.changedInputFds.add(fd);
  }

  private dupOutputFd(fds: FdState, fd: number, target: string): void {
    fds.changedOutputFds.add(fd);
    if (target === '-') {
      fds.outputFds.delete(fd);
      fds.terminalOutputFds.delete(fd);
      return;
    }
    const resolved = this.resolveOutputFd(target, fds.outputFds, fds.terminalOutputFds);
    fds.outputFds.set(fd, resolved.stream);
    setMembership(fds.terminalOutputFds, fd, resolved.terminal);
  }

  private dupInputFd(fds: FdState, fd: number, target: string): void {
    fds.changedInputFds.add(fd);
    if (target === '-') {
      fds.inputFds.delete(fd);
      fds.terminalInputFds.delete(fd);
      return;
    }
    const resolved = this.resolveInputFd(target, fds.inputFds, fds.terminalInputFds);
    fds.inputFds.set(fd, resolved.stream);
    setMembership(fds.terminalInputFds, fd, resolved.terminal);
  }

  private async openOutputTarget(
    io: ExecutionIo,
    target: string,
    mode: 'write' | 'append',
    fds: FdState,
    terminalStdin?: TerminalInputStream,
  ): Promise<OutputTarget> {
    if (target === '/dev/null') return { stream: this.createNullWriter(), terminal: false };
    if (target === '/dev/tty') {
      if (!terminalStdin) throw new Error('/dev/tty: no controlling terminal');
      return { stream: this.terminalSink(io), terminal: true };
    }
    // /dev/stdout and /dev/stderr name the process's own descriptors, not
    // files. Writing them into the device provider would silently discard.
    if (target === '/dev/stdout') return this.resolveOutputFd('1', fds.outputFds, fds.terminalOutputFds);
    if (target === '/dev/stderr') return this.resolveOutputFd('2', fds.outputFds, fds.terminalOutputFds);
    const targetPath = resolve(this.config.getCwd(), target);
    const vfs = io.vfs ?? this.config.vfs;
    try {
      const bridge = vfs.process;
      const handle = await bridge.open(targetPath, { write: true, create: true, append: mode === 'append', truncate: mode === 'write' });
      const push = async (bytes: Uint8Array) => {
        let offset = 0;
        while (offset < bytes.length) {
          const written = await bridge.write(handle.id, null, bytes.subarray(offset));
          if (written <= 0 || written > bytes.length - offset) throw new Error('EIO: invalid redirection write length');
          offset += written;
        }
      };
      const stream: CommandOutputStream = { write: text => push(encode(text)), writeBytes: push };
      fds.opened.set(stream, {
        stream,
        // What the VFS still holds for the file is written as the command
        // whose redirection opened it ends (flushFds), and a failure is its.
        flush: async () => { await bridge.fsync(handle.id); },
        close: async () => { await bridge.close(handle.id); },
        refs: 1,
      });
      return { stream, terminal: false };
    } catch (error) {
      throw new RedirectionOpenError(target, error);
    }
  }

  private async openInputTarget(
    io: ExecutionIo,
    target: string,
    fds: FdState,
    terminalStdin?: TerminalInputStream,
  ): Promise<InputTarget> {
    if (target === '/dev/null') return { stream: this.createEmptyReader(), terminal: false };
    if (target === '/dev/tty') {
      if (!terminalStdin) throw new Error('/dev/tty: no controlling terminal');
      return { stream: terminalStdin, terminal: true };
    }
    if (target === '/dev/stdin') return this.resolveInputFd('0', fds.inputFds, fds.terminalInputFds);
    const targetPath = resolve(this.config.getCwd(), target);
    const vfs = io.vfs ?? this.config.vfs;
    try {
      // Open-authorize before the command runs, the way open(2) would: a
      // missing, unreadable, or directory target fails the redirection even
      // when the command never reads a byte.
      if ((await statOrThrow(vfs, targetPath)).type === 'directory') {
        throw Object.assign(new Error(`EISDIR: ${targetPath}`), { code: 'EISDIR' });
      }
      await vfs.access(targetPath, 0o4);
      const bridge = vfs.process;
      const handle = await bridge.open(targetPath, { read: true });
      const stream = this.createFileReader(vfs, targetPath, (offset, length) => Promise.resolve(bridge.read(handle.id, offset, length)), true);
      fds.opened.set(stream, { stream, close: async () => { await bridge.close(handle.id); }, refs: 1 });
      return { stream, terminal: false };
    } catch (error) {
      throw new RedirectionOpenError(target, error);
    }
  }

  /**
   * Run `body`, whose answer is an exit status, and end its descriptors
   * (flushFds) whether it returned or threw. A file it wrote that could not
   * be written fails it: status 1 where it would have been 0.
   */
  private async withFdFlush(fds: FdState, body: () => Promise<number>): Promise<number> {
    let status: number;
    try {
      status = await body();
    } catch (error) {
      await this.flushFds(fds);
      throw error;
    }
    if (!(await this.flushFds(fds)) || status !== 0) return status;
    this.lastExitCode = 1;
    return 1;
  }

  /**
   * End a command's descriptors: flush its output streams, and write what
   * each file its redirections opened still holds (the VFS may hold a
   * file's last appends until fsync), then let go of those files. A write
   * that fails there is the command's failure, not the shell's: it is
   * reported on the command's stderr, as `name`'s, and the answer is true,
   * for the command's status. A close that fails still throws.
   */
  private async flushFds(fds: FdState, name?: string): Promise<boolean> {
    const opened = [...fds.opened.values()];
    fds.opened.clear();
    const flushed = await Promise.allSettled([
      ...[...new Set(fds.outputFds.values())].map(async (stream) => (await stream.flush?.())),
      ...opened.map(async (file) => (await file.flush?.())),
    ]);
    let failed = false;
    for (const result of flushed) {
      if (result.status === 'fulfilled') continue;
      failed = true;
      const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
      try {
        await fds.outputFds.get(2)?.write(`${name === undefined ? '' : `${name}: `}${message}\n`);
      } catch {
        // Its stderr may be the file that failed; the status still says so.
      }
    }
    await this.release(opened);
    return failed;
  }

  /**
   * Byte-faithful redirected input: bounded range reads keep >64 KiB
   * redirections intact and preserve bytes that are not valid UTF-8, while
   * the text view still decodes progressively across chunk boundaries.
   *
   * Only a zero-length range means EOF. Devices and some mounts answer with
   * fewer bytes than asked whenever their internal bound is hit; those short
   * nonempty reads advance the offset and continue, exactly like read(2).
   */
  private createFileReader(
    vfs: ProcessView,
    path: string,
    readRange = async (offset: number, length: number) => (await vfs.readRange(path, offset, length)),
    /** A `< file` redirect: name the file and position (CommandInputStream.file), so a program's fd 0 can be the file. */
    namesFile = false,
  ): CommandInputStream {
    const decoder = new TextDecoder('utf-8');
    let offset = 0;
    let eof = false;
    const file = namesFile ? { path, get offset() { return offset; } } : undefined;
    const pull = async (max: number): Promise<Uint8Array | null> => {
      if (eof) return null;
      const chunk = await readRange(offset, max);
      if (chunk.length === 0) {
        eof = true;
        return null;
      }
      offset += chunk.length;
      return chunk;
    };
    return {
      ...(file ? { file } : {}),
      readBytes: async (maxLength: number) => {
        if (maxLength <= 0) return new Uint8Array(0);
        return (await pull(maxLength));
      },
      read: async () => {
        while (true) {
          const bytes = (await pull(65536));
          if (bytes === null) {
            const tail = decoder.decode();
            return tail.length > 0 ? tail : null;
          }
          const text = decoder.decode(bytes, { stream: true });
          if (text.length > 0) return text;
        }
      },
      readAll: async () => {
        let out = '';
        while (true) {
          const bytes = (await pull(65536));
          if (bytes === null) break;
          out += decoder.decode(bytes, { stream: true });
        }
        out += decoder.decode();
        return out;
      },
      readLine: async () => {
        let line = '';
        let sawAny = false;
        while (true) {
          const bytes = (await pull(65536));
          if (bytes === null) break;
          sawAny = true;
          // Split on the raw 0x0A byte so pushback returns ORIGINAL bytes;
          // decoded-text pushback would corrupt multibyte sequences that
          // straddle the chunk boundary or mis-measure invalid UTF-8.
          const newline = bytes.indexOf(0x0a);
          if (newline >= 0) {
            offset -= bytes.length - (newline + 1);
            eof = false;
            line += decoder.decode(bytes.subarray(0, newline), { stream: true });
            const flushed = decoder.decode();
            return line + flushed;
          }
          line += decoder.decode(bytes, { stream: true });
        }
        line += decoder.decode();
        return sawAny || line.length > 0 ? line : null;
      },
    };
  }

  private resolveOutputFd(
    target: string,
    outputFds: Map<number, CommandOutputStream>,
    terminalOutputFds: Set<number>,
  ): OutputTarget {
    if (target === '-') return { stream: this.createNullWriter(), terminal: false };
    const fd = this.parseFdTarget(target);
    const stream = outputFds.get(fd);
    if (!stream) throw new Error(`bad output file descriptor: ${target}`);
    return { stream, terminal: terminalOutputFds.has(fd) };
  }

  private resolveInputFd(
    target: string,
    inputFds: Map<number, CommandInputStream | undefined>,
    terminalInputFds: Set<number>,
  ): InputTarget {
    if (target === '-') return { stream: this.createEmptyReader(), terminal: false };
    const fd = this.parseFdTarget(target);
    if (!inputFds.has(fd)) throw new Error(`bad input file descriptor: ${target}`);
    return { stream: inputFds.get(fd), terminal: terminalInputFds.has(fd) };
  }

  private parseFdTarget(target: string): number {
    if (!isDecimalInteger(target)) throw new Error(`bad file descriptor: ${target}`);
    return Number.parseInt(target, 10);
  }

  private createNullWriter(): CommandOutputStream {
    return { write: () => {}, writeBytes: () => {} };
  }

  private createEmptyReader(): CommandInputStream {
    return { read: async () => null, readAll: async () => '', readLine: async () => null };
  }

  private isFdTerminal(fds: FdState, fd: number): boolean {
    if (fd === 0) return fds.terminalInputFds.has(fd);
    return fds.terminalOutputFds.has(fd);
  }

  private enforceErrexit(connector: '&&' | '||' | null, exitCode: number): void {
    if (!this.config.options.errexit) return;
    if (this.errexitSuppressionDepth > 0) return;
    if (exitCode === 0) return;
    if (connector === '&&' || connector === '||') return;
    throw new ErrexitSignal(exitCode);
  }

  private async withErrexitSuppressed<T>(fn: () => Promise<T>): Promise<T> {
    this.errexitSuppressionDepth++;
    try {
      return await fn();
    } finally {
      this.errexitSuppressionDepth--;
    }
  }

  private abortExitCode(io: ExecutionIo): number | null {
    const signal = io.signal ?? this.config.getAbortSignal?.();
    return signal?.aborted ? exitCodeForAbortSignal(signal) : null;
  }
}

function setMembership(set: Set<number>, value: number, present: boolean): void {
  if (present) set.add(value);
  else set.delete(value);
}

function isDecimalInteger(value: string): boolean {
  if (value.length === 0) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

function isFatalSpecialBuiltin(name: string): boolean {
  switch (name) {
    case ':':
    case '.':
    case 'break':
    case 'continue':
    case 'eval':
    case 'exec':
    case 'exit':
    case 'export':
    case 'readonly':
    case 'return':
    case 'set':
    case 'shift':
    case 'times':
    case 'trap':
    case 'unset':
      return true;
    default:
      return false;
  }
}

function linkAbortSignal(parent: AbortSignal, child: AbortController): () => void {
  if (parent.aborted) {
    child.abort(parent.reason);
    return () => {};
  }
  const onAbort = () => child.abort(parent.reason);
  parent.addEventListener('abort', onAbort, { once: true });
  return () => parent.removeEventListener('abort', onAbort);
}
