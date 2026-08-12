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
} from './types.js';
import type { VFS } from '../kernel/vfs/index.js';
import type { CommandRegistry } from '../commands/registry.js';
import type {
  CommandOutputStream,
  CommandInputStream,
  CommandContext,
  CommandRunAsHost,
  TerminalInputStream,
} from '../commands/types.js';
import type { VfsCred } from '../../../runtime/os-contracts.js';
import { lex } from './lexer.js';
import { parse } from './parser.js';
import { expandWords, expandWord, ExpansionError, type ExpandContext } from './expander.js';
import { evaluateDoubleBracketWords } from './test-builtin.js';
import { PipeChannel } from './pipe.js';
import { JobTable } from './jobs.js';
import { ProcessRegistry } from './ProcessRegistry.js';
import { exitCodeForAbortSignal } from './signals.js';
import { resolve } from '../utils/path.js';
import { encode } from '../utils/encoding.js';
import { globMatch } from '../utils/glob.js';

/**
 * Bytes a file-backed descriptor holds before committing. Matches the stream
 * chunk size used elsewhere and keeps a line-at-a-time producer from paying a
 * store write per line.
 */
const FILE_WRITE_BLOCK_BYTES = 64 * 1024;

function concatBytes(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

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
  vfs: VFS;
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
  commandIdentity?: {
    pid: number;
    cred: VfsCred;
    setUmask(mask: number): void;
  };
  runAs?: CommandRunAsHost;
  vfs?: VFS;
};

export type TerminalFdState = {
  stdin?: boolean;
  stdout?: boolean;
  stderr?: boolean;
};

type PositionalFrame = {
  args: string[];
};

export interface InterpreterConfig {
  env: Record<string, string>;
  getCwd: () => string;
  setCwd: (cwd: string) => void;
  vfs: VFS;
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

export class Interpreter {
  private config: InterpreterConfig;
  private lastExitCode = 0;
  private functions = new Map<string, CompoundCommandNode>();
  private persistentOutputFds = new Map<number, CommandOutputStream>();
  private persistentInputFds = new Map<number, CommandInputStream | undefined>();
  private persistentTerminalOutputFds = new Set<number>();
  private persistentTerminalInputFds = new Set<number>();
  private errexitSuppressionDepth = 0;
  private exitTrapDepth = 0;

  constructor(config: InterpreterConfig) {
    this.config = config;
  }

  getLastExitCode(): number {
    return this.lastExitCode;
  }

  async executeScript(script: ScriptNode, terminalStdin?: TerminalInputStream): Promise<number> {
    return this.executeScriptWithIo(script, this.createTerminalIo(terminalStdin));
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
      commandIdentity?: {
        pid: number;
        cred: VfsCred;
        setUmask(mask: number): void;
      };
      runAs?: CommandRunAsHost;
      signal?: AbortSignal;
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
    if (options?.commandIdentity) io.vfs = this.config.vfs.as(options.commandIdentity.cred);
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

      const promise = (async (): Promise<number> => {
        return await this.executeListEntries(list.entries, backgroundIo);
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
      const jobId = this.config.jobTable.add(commandText, waitable, abortController);
      this.config.env['!'] = String(pid);

      this.writeTerminal(io, `[${jobId}] ${pid} (background)\n`);

      // Don't auto-reap - let Shell collect zombies before next prompt
      // This matches Linux behavior where zombies persist until reaped

      return 0;
    }

    return this.executeListEntries(list.entries, io);
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
        exitCode = await this.executePipeline(entry.pipeline, io);
      }
      skipNext = false;

      this.enforceErrexit(entry.connector, exitCode);

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

    if (commands.length === 1) {
      // Single command -- no piping needed
      exitCode = await this.executeCommand(commands[0], io);
    } else {
      exitCode = await this.executePipelineCommands(commands, io);
    }

    if (pipeline.negated) {
      exitCode = exitCode === 0 ? 1 : 0;
    }

    return exitCode;
  }

  private async executePipelineCommands(commands: CompoundCommandNode[], io: ExecutionIo): Promise<number> {
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
        if (abortCode !== null) return abortCode;

        const stdin = i > 0 ? pipes[i - 1].reader : undefined;
        let stdout: CommandOutputStream | undefined;

        if (i < commands.length - 1) {
          const pipe = new PipeChannel();
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
        const cmdPromise = (async (): Promise<number> => {
          try {
            return await this.executeCommand(cmd, cmdIo);
          } catch (e) {
            if (e instanceof ExitSignal) {
              return e.exitCode;
            }
            throw e;
          } finally {
            if (i < commands.length - 1) {
              pipes[i].close();
            }
            if (isLast) {
              pipelineAbortController.abort();
              for (const pipe of pipes) pipe.close();
            }
          }
        })();

        promises.push(cmdPromise);
      }

      const results = await Promise.all(promises);
      if (this.config.options.pipefail) {
        for (let i = results.length - 1; i >= 0; i--) {
          if (results[i] !== 0) return results[i] ?? 1;
        }
      }
      return results[results.length - 1] ?? 0;
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
        return this.executeSimpleCommand(cmd, io);
      case 'double_bracket':
        return this.executeDoubleBracket(cmd, io);
      case 'if':
        return this.executeIf(cmd, io);
      case 'for':
        return this.executeFor(cmd, io);
      case 'while':
        return this.executeWhile(cmd, io);
      case 'until':
        return this.executeUntil(cmd, io);
      case 'case':
        return this.executeCase(cmd, io);
      case 'group':
        return this.executeGroup(cmd, io);
      case 'subshell':
        return this.executeSubshell(cmd, io);
      case 'function_def':
        return this.executeFunctionDef(cmd);
    }
  }

  private async executeIf(node: IfNode, io: ExecutionIo): Promise<number> {
    return this.executeWithRedirections(node.redirections, io, async (redirIo) => {
      let exitCode = 0;

      for (const clause of node.clauses) {
        const condCode = await this.withErrexitSuppressed(() => this.executeCompoundList(clause.condition, redirIo));
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
    });
  }

  private async executeDoubleBracket(node: DoubleBracketNode, io: ExecutionIo): Promise<number> {
    return this.executeWithRedirections(node.redirections, io, async (redirIo) => {
      const stdout = redirIo.stdout ?? this.terminalSink(redirIo);
      const stderr = redirIo.stderr ?? this.terminalSink(redirIo);
      const fds = this.createCommandFds(stdout, stderr, redirIo.stdin, redirIo);
      const builtinIo = this.createIoFromFds(redirIo, fds);
      const exitCode = await this.withFdFlush(fds, () => evaluateDoubleBracketWords(
        node.words,
        this.createExpandContext(redirIo),
        redirIo.vfs ?? this.config.vfs,
        stderr,
        {
          vfs: builtinIo.vfs ?? this.config.vfs,
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
          executeInline: (input, options) => this.executeInline(input, builtinIo, options),
        },
      ));
      this.lastExitCode = exitCode;
      return exitCode;
    });
  }

  private async executeFor(node: ForNode, io: ExecutionIo): Promise<number> {
    return this.executeWithRedirections(node.redirections, io, async (redirIo) => {
      const expandCtx = this.createExpandContext(redirIo);
      let exitCode = 0;

      let values: string[];
      if (node.words !== null) {
        values = await expandWords(node.words, expandCtx);
      } else {
        values = [...this.readPositionals(redirIo)];
      }

      for (const val of values) {
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
    });
  }

  private async executeWhile(node: WhileNode, io: ExecutionIo): Promise<number> {
    return this.executeWithRedirections(node.redirections, io, async (redirIo) => {
      let exitCode = 0;

      while (true) {
        const abortCode = this.abortExitCode(redirIo);
        if (abortCode !== null) return abortCode;

        const condCode = await this.withErrexitSuppressed(() => this.executeCompoundList(node.condition, redirIo));
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
    });
  }

  private async executeUntil(node: UntilNode, io: ExecutionIo): Promise<number> {
    return this.executeWithRedirections(node.redirections, io, async (redirIo) => {
      let exitCode = 0;

      while (true) {
        const abortCode = this.abortExitCode(redirIo);
        if (abortCode !== null) return abortCode;

        const condCode = await this.withErrexitSuppressed(() => this.executeCompoundList(node.condition, redirIo));
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
    });
  }

  private async executeCase(node: CaseNode, io: ExecutionIo): Promise<number> {
    return this.executeWithRedirections(node.redirections, io, async (redirIo) => {
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
    });
  }

  private async executeFunctionDef(node: FunctionDefNode): Promise<number> {
    this.functions.set(node.name, node.body);
    return 0;
  }

  private async executeGroup(node: GroupNode, io: ExecutionIo): Promise<number> {
    const exitCode = await this.executeWithRedirections(
      node.redirections,
      io,
      (redirIo) => this.executeCompoundList(node.body, redirIo),
    );
    this.lastExitCode = exitCode;
    return exitCode;
  }

  private async executeSubshell(node: SubshellNode, io: ExecutionIo): Promise<number> {
    const savedCwd = this.config.getCwd();
    const savedEnv = { ...this.config.env };
    let exitCode = 0;
    const subshellIo = this.createCommandIo(io);
    subshellIo.positionals = this.forkPositionals(io);
    try {
      exitCode = await this.executeWithRedirections(
        node.redirections,
        subshellIo,
        (redirIo) => this.executeCompoundList(node.body, redirIo),
      );
    } catch (e) {
      if (e instanceof ExitSignal) {
        exitCode = e.exitCode;
      } else {
        throw e;
      }
    } finally {
      this.config.setCwd(savedCwd);
      for (const key of Object.keys(this.config.env)) delete this.config.env[key];
      Object.assign(this.config.env, savedEnv);
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

    const expandCtx = this.createExpandContext(io);

    // Expand words
    const expandedArgs = await expandWords(cmd.words, expandCtx);
    if (expandedArgs.length === 0 && cmd.assignments.length > 0) {
      // Bare assignment -- set env vars
      for (const assign of cmd.assignments) {
        const value = await expandWord(assign.value, expandCtx);
        if (!this.assignEnv(assign.name, value)) {
          this.writeTerminal(io, `${assign.name}: readonly variable\n`);
          if (io.scriptMode === true) throw new ErrexitSignal(1);
          return 1;
        }
      }
      return 0;
    }

    if (expandedArgs.length === 0) {
      return 0;
    }

    const [name, ...args] = expandedArgs;

    // Check alias expansion
    const aliases = this.config.aliases;
    if (aliases) {
      const aliasValue = aliases.get(name);
      if (aliasValue !== undefined) {
        // Rebuild the command line with the alias expanded
        const expandedLine = aliasValue + (args.length > 0 ? ' ' + args.join(' ') : '');
        return this.executeLineWithIo(expandedLine, io);
      }
    }

    // Apply per-command assignments (temporary env)
    const savedEnv: Record<string, string | undefined> = {};
    for (const assign of cmd.assignments) {
      const value = await expandWord(assign.value, expandCtx);
      if (this.config.readonlyNames.has(assign.name)) {
        (io.stderr ?? this.terminalSink(io)).write(`${assign.name}: readonly variable\n`);
        return 1;
      }
      savedEnv[assign.name] = this.config.env[assign.name];
      this.assignEnv(assign.name, value);
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
      redirStderr.write(error instanceof RedirectionOpenError
        ? redirectionDiagnostic(error)
        : `${error instanceof Error ? error.message : String(error)}\n`);
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
        this.persistFdState(fds);
        exitCode = 0;
      } else {
        // Check functions
        const funcBody = this.functions.get(name);
        if (funcBody) {
          exitCode = await this.executeFunction(funcBody, args, this.createIoFromFds(io, fds));
        } else {
          // Check builtins
          const builtin = this.config.builtins.get(name);
          if (builtin) {
            const builtinIo = this.createIoFromFds(io, fds);
            exitCode = await builtin(args, stdout, stderr, stdin, {
              vfs: builtinIo.vfs ?? this.config.vfs,
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
              executeInline: (input, options) => this.executeInline(input, builtinIo, options),
            });
          } else {
            // Check registry
            const command = await this.config.registry.resolve(name);
            if (!command) {
              stderr.write(`${name}: command not found\n`);
              exitCode = 127;
            } else {
              const shouldRegister = io.registerProcess !== false;
              let pid: number | undefined;
              const abortController = new AbortController();
              let unlinkShellSignal: (() => void) | undefined;

              const shellSignal = io.signal ?? this.config.getAbortSignal?.() ?? new AbortController().signal;
              unlinkShellSignal = linkAbortSignal(shellSignal, abortController);

              const terminalStdin = io.terminalStdin;
              const identity = io.commandIdentity;
              if (!identity) throw new Error('shell command identity is unavailable');
              let ctx: CommandContext;
              ctx = {
                ...io.commandContext,
                pid: identity.pid,
                cred: identity.cred,
                args,
                env: { ...this.config.env },
                cwd: this.config.getCwd(),
                vfs: io.vfs ?? this.config.vfs,
                stdout,
                stderr,
                signal: abortController.signal,
                stdin,
                terminalStdin,
                setRawMode: terminalStdin
                  ? (v: boolean) => { terminalStdin.rawMode = v; }
                  : undefined,
                getRawMode: terminalStdin
                  ? () => terminalStdin.rawMode
                  : undefined,
                isFdTerminal: (fd: number) => this.isFdTerminal(fds, fd),
                setUmask: identity.setUmask,
                runAs: (cred, argv) => io.runAs
                  ? io.runAs(ctx, cred, argv)
                  : Promise.resolve(126),
              };

              // Register process BEFORE executing so ps can see itself
              let commandPromise: Promise<number>;

              if (shouldRegister) {
                let resolvePromise: ((code: number) => void) | undefined;
                let rejectPromise: ((err: unknown) => void) | undefined;
                const registeredPromise = new Promise<number>((resolve, reject) => {
                  resolvePromise = resolve;
                  rejectPromise = reject;
                });

                pid = this.config.processRegistry.spawn({
                  command: name,
                  args: [name, ...args],
                  cwd: this.config.getCwd(),
                  env: { ...this.config.env },
                  isForeground: true,
                  promise: registeredPromise,
                  abortController,
                });

                commandPromise = command(ctx).then(
                  (code) => {
                    resolvePromise?.(code);
                    return code;
                  },
                  (err) => {
                    rejectPromise?.(err);
                    if (err instanceof Error && err.name === 'AbortError') return 130;
                    // Surface the failure: this rejection handler resolves
                    // commandPromise to an exit code, so the catch below
                    // never sees the error — without this write a throwing
                    // registered command dies silently at the prompt.
                    stderr.write(`${name}: ${err instanceof Error ? err.message : String(err)}\n`);
                    return 1;
                  }
                );
              } else {
                commandPromise = command(ctx);
              }

              try {
                exitCode = await commandPromise;
              } catch (e) {
                if (e instanceof Error && e.name === 'AbortError') {
                  exitCode = 130;
                } else {
                  stderr.write(`${name}: ${e instanceof Error ? e.message : String(e)}\n`);
                  exitCode = 1;
                }
              } finally {
                unlinkShellSignal?.();
                if (shouldRegister && pid !== undefined) {
                  await Promise.resolve();
                  this.config.processRegistry.reap(pid);
                }
              }

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
      this.flushFds(fds);
      // Restore env from per-command assignments
      for (const [key, val] of Object.entries(savedEnv)) {
        if (val === undefined) {
          delete this.config.env[key];
        } else {
          this.config.env[key] = val;
        }
      }
    }

    const fatalSpecialBuiltin = io.scriptMode === true
      && exitCode !== 0
      && isFatalSpecialBuiltin(name);
    this.lastExitCode = exitCode;
    if (fatalSpecialBuiltin) throw new ErrexitSignal(exitCode);
    return exitCode;
  }

  private assignEnv(name: string, value: string): boolean {
    if (this.config.readonlyNames.has(name)) return false;
    this.config.env[name] = value;
    return true;
  }

  private async executeFunction(body: CompoundCommandNode, args: string[], io: ExecutionIo): Promise<number> {
    let exitCode: number;
    const functionIo = this.createCommandIo(io);
    functionIo.positionals = { args: [...args] };
    try {
      exitCode = await this.executeCommand(body, functionIo);
    } catch (e) {
      if (e instanceof ReturnSignal) {
        exitCode = e.exitCode;
      } else {
        throw e;
      }
    }

    this.lastExitCode = exitCode;
    return exitCode;
  }

  async executeCapture(input: string, io: ExecutionIo = {}): Promise<string> {
    let captured = '';
    const stdout: CommandOutputStream = {
      write: (text: string) => { captured += text; },
    };

    const captureIo = this.createCommandIo(io);
    captureIo.stdout = stdout;
    captureIo.positionals = this.forkPositionals(io);
    await this.executeLineWithIo(input, captureIo);

    return captured;
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
    return this.executeLineWithIo(input, inlineIo);
  }

  private async executeLineWithIo(input: string, io: ExecutionIo): Promise<number> {
    const tokens = lex(input);
    const script = parse(tokens);
    return this.executeScriptWithIo(script, io);
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
      positionals: this.readPositionals(io),
      lastExitCode: this.lastExitCode,
      cwd: this.config.getCwd(),
      vfs: io.vfs ?? this.config.vfs,
      options: this.config.options,
      executeCapture: (input) => this.executeCapture(input, io),
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
    };
  }

  private async executeWithRedirections(
    redirections: RedirectionNode[],
    io: ExecutionIo,
    execute: (io: ExecutionIo) => Promise<number>,
  ): Promise<number> {
    if (redirections.length === 0) {
      return execute(io);
    }

    const expandCtx = this.createExpandContext(io);
    const stdout = io.stdout ?? this.terminalSink(io);
    const stderr = io.stderr ?? this.terminalSink(io);
    const fds = this.createCommandFds(stdout, stderr, io.stdin, io);
    try {
      await this.applyRedirections(redirections, fds, expandCtx, io, io.terminalStdin);
    } catch (error) {
      if (!(error instanceof RedirectionOpenError)) throw error;
      const redirStderr = fds.outputFds.get(2) ?? stderr;
      redirStderr.write(redirectionDiagnostic(error));
      this.lastExitCode = 1;
      return 1;
    }

    return this.withFdFlush(fds, () => execute(this.createIoFromFds(io, fds)));
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
        this.setInputFd(fds, redir.fd ?? 0, { stream: this.createStringReader(body), terminal: false });
        continue;
      }

      const target = await expandWord(redir.target, expandCtx);
      switch (redir.operator) {
        case 'write':
          this.setOutputFd(fds, redir.fd ?? 1, this.openOutputTarget(io, target, 'write', fds, terminalStdin));
          break;
        case 'append':
          this.setOutputFd(fds, redir.fd ?? 1, this.openOutputTarget(io, target, 'append', fds, terminalStdin));
          break;
        case 'read':
          this.setInputFd(fds, redir.fd ?? 0, this.openInputTarget(io, target, fds, terminalStdin));
          break;
        case 'readWrite': {
          const fd = redir.fd ?? 0;
          this.setInputFd(fds, fd, this.openInputTarget(io, target, fds, terminalStdin));
          this.setOutputFd(fds, fd, this.openOutputTarget(io, target, 'append', fds, terminalStdin));
          break;
        }
        case 'writeAll': {
          const writer = this.openOutputTarget(io, target, 'write', fds, terminalStdin);
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

  private persistFdState(fds: FdState): void {
    for (const fd of fds.changedOutputFds) {
      const stream = fds.outputFds.get(fd);
      if (stream) this.persistentOutputFds.set(fd, stream);
      else this.persistentOutputFds.delete(fd);
      if (fds.terminalOutputFds.has(fd)) this.persistentTerminalOutputFds.add(fd);
      else this.persistentTerminalOutputFds.delete(fd);
    }
    for (const fd of fds.changedInputFds) {
      const isTerminal = fds.terminalInputFds.has(fd);
      if (fds.inputFds.has(fd)) {
        this.persistentInputFds.set(fd, isTerminal ? undefined : fds.inputFds.get(fd));
      } else {
        this.persistentInputFds.delete(fd);
      }
      if (isTerminal) this.persistentTerminalInputFds.add(fd);
      else this.persistentTerminalInputFds.delete(fd);
    }
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

  private openOutputTarget(
    io: ExecutionIo,
    target: string,
    mode: 'write' | 'append',
    fds: FdState,
    terminalStdin?: TerminalInputStream,
  ): OutputTarget {
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
      if (mode === 'write') {
        vfs.writeFile(targetPath, '');
        return { stream: this.createFileWriter(vfs, targetPath, 'truncate'), terminal: false };
      }
      if (vfs.exists(targetPath)) {
        if (vfs.stat(targetPath).type === 'directory') {
          throw Object.assign(new Error(`EISDIR: ${targetPath}`), { code: 'EISDIR' });
        }
        vfs.access(targetPath, 0o2);
      } else {
        vfs.writeFile(targetPath, '');
      }
      return { stream: this.createFileWriter(vfs, targetPath, 'append'), terminal: false };
    } catch (error) {
      throw new RedirectionOpenError(target, error);
    }
  }

  private openInputTarget(
    io: ExecutionIo,
    target: string,
    fds: FdState,
    terminalStdin?: TerminalInputStream,
  ): InputTarget {
    if (target === '/dev/null') return { stream: this.createEmptyReader(), terminal: false };
    if (target === '/dev/tty') {
      if (!terminalStdin) throw new Error('/dev/tty: no controlling terminal');
      return { stream: terminalStdin, terminal: true };
    }
    if (target === '/dev/stdin') return this.resolveInputFd('0', fds.inputFds, fds.terminalInputFds);
    try {
      return {
        stream: this.createFileReader(io.vfs ?? this.config.vfs, resolve(this.config.getCwd(), target)),
        terminal: false,
      };
    } catch (error) {
      throw new RedirectionOpenError(target, error);
    }
  }

  /**
   * A file-backed descriptor: an open file plus a write offset.
   *
   * Each write lands at the offset and advances it, the way write(2) does.
   * Restating the whole file per write — which is what this used to do —
   * makes every multi-write producer (`cat a b c`, a streaming `curl`, any
   * line-at-a-time filter) persist only its final write and silently drop
   * everything before it.
   *
   * Writes buffer to a block, as stdio does, so a line-at-a-time producer
   * costs one store write per block rather than one per line. `mode`
   * distinguishes `>` (a plain offset from the truncation point) from `>>`,
   * which is O_APPEND: every block lands at whatever the current end is, so
   * two descriptors appending to one file cannot overwrite each other.
   */
  private createFileWriter(vfs: VFS, path: string, mode: 'truncate' | 'append'): CommandOutputStream {
    let offset = 0;
    let pending: Uint8Array[] = [];
    let pendingBytes = 0;

    const endOfFile = (): number => (vfs.exists(path) ? vfs.stat(path).size : 0);

    const flush = (): void => {
      if (pendingBytes === 0) return;
      const block = pending.length === 1 ? pending[0] : concatBytes(pending, pendingBytes);
      pending = [];
      pendingBytes = 0;
      const at = mode === 'append' ? endOfFile() : offset;
      vfs.writeRange(path, at, block);
      offset = at + block.length;
    };

    const push = (bytes: Uint8Array): void => {
      if (bytes.length === 0) return;
      pending.push(bytes);
      pendingBytes += bytes.length;
      if (pendingBytes >= FILE_WRITE_BLOCK_BYTES) flush();
    };

    return {
      write: (text: string) => push(encode(text)),
      writeBytes: (bytes: Uint8Array) => push(bytes),
      flush,
    };
  }

  /**
   * Run `body` and commit every file-backed descriptor it wrote through,
   * whether it returned or threw. This is the close(2) side of the buffering
   * in createFileWriter: buffered bytes must reach the store before the next
   * command can read the file.
   */
  private async withFdFlush<T>(fds: FdState, body: () => Promise<T>): Promise<T> {
    try {
      return await body();
    } finally {
      this.flushFds(fds);
    }
  }

  private flushFds(fds: FdState): void {
    for (const stream of fds.outputFds.values()) stream.flush?.();
  }

  private createFileReader(vfs: VFS, path: string): CommandInputStream {
    const content = vfs.readFileString(path);
    return this.createStringReader(content);
  }

  private createStringReader(content: string): CommandInputStream {
    let offset = 0;
    return {
      read: async () => {
        if (offset >= content.length) return null;
        const chunk = content.slice(offset);
        offset = content.length;
        return chunk;
      },
      readAll: async () => {
        if (offset >= content.length) return '';
        const chunk = content.slice(offset);
        offset = content.length;
        return chunk;
      },
      readLine: async () => {
        if (offset >= content.length) return null;
        const newline = content.indexOf('\n', offset);
        if (newline < 0) {
          const line = content.slice(offset);
          offset = content.length;
          return line;
        }
        const line = content.slice(offset, newline);
        offset = newline + 1;
        return line;
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
