import type {
  ListNode,
  PipelineNode,
  SimpleCommandNode,
  CompoundCommandNode,
  DoubleBracketNode,
  IfNode,
  ForNode,
  LoopNode,
  CaseNode,
  FunctionDefNode,
  GroupNode,
  SubshellNode,
  RedirectionNode,
  ArithmeticCommandNode,
  ArithmeticForNode,
  ArrayElementNode,
  AssignmentNode,
  WordPart,
} from './types.js';
import { TokenKind } from './types.js';
import { ProcessView, bindProcessView } from '../../../runtime/process-files.js';
import { LOCAL_PLACEMENT, type ProgramPlacement } from '../../../runtime/program-start.js';
import { ProgramRefusal, runDelegatedProgram, shellStatusOf } from '../../../runtime/delegated-program.js';
import { outputHooks } from '../../../_shared/byte-stream.js';
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
import { execRefusal } from '../../../shell/exec-dispatch.js';
import { withRecall } from '../../../vfs/recall.js';
import { parseAssignment, ParseError, ScriptLines } from './parser.js';
import {
  expandArithmetic, expandBraceWord, expandWords, expandWord, expandPatternWord, expandSubscript, arithmeticOf, arithmeticValue, ArithmeticError, ExpansionError, reportWarnings, SubscriptArithmeticError,
  type ExpandContext, type CapturedCommand,
} from './expander.js';
import { evaluateDoubleBracketWords } from './test-builtin.js';
import { isPipeEnd, PipeChannel } from './pipe.js';
import {
  arrayFor, arrayIndex, assignArray, assignVariable, exportedEnvironment, lastIndex, restoreVariable, saveVariable, type ArrayLiteral, type SavedVariable,
} from './variables.js';
import { forkShellState, type ShellState } from './state.js';
import { exitCodeForAbortSignal, KILLED_BY_SIGPIPE } from './signals.js';
import { isBrokenPipe, isRefusedWrite, textCapture } from '../utils/bytes-io.js';
import { operandPath } from '../utils/path.js';
import { encode } from '../utils/encoding.js';
import { shellMatch } from '../utils/glob.js';
import { staticStdinReader } from '../../../shell/stdin-adapter.js';
import { BASH_BUILTINS } from './bash-builtins.js';
import { isDecimalInteger } from './names.js';
import { statOrThrow } from '../../../vfs/vfs.js';
import { yieldToEventLoop } from '../utils/event-loop.js';
import { WorkThread } from './work-thread.js';
import { DiscardSignal } from './discard.js';

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

/** A syntax error in the text eval or `.` reads (not one met running it, a command substitution's): theirs to answer. */
export class TextSyntaxError extends Error {}

/** A function call past the nesting bound (functionNestingLimit). */
export class FunctionNestingSignal extends DiscardSignal {}

/**
 * A command of assignments alone that could not assign (a readonly name, a
 * bad array subscript), as bash's expand_word_list_internal discards it.
 */
export class AssignmentErrorSignal extends DiscardSignal {}

/**
 * The deepest shell functions nest where FUNCNEST does not lower it. Bash
 * has no bound then, and recurses until its stack is gone (a segfault); a
 * call holds about 9 KiB of the session's heap (8.6 KiB measured at 6000
 * levels), so a runaway function ends here, with bash's message, long
 * before the heap does.
 */
const MAX_FUNCTION_NESTING = 1000;

/** FUNCNEST as bash reads it (legal_number): a decimal integer, signed, blanks around it. */
const FUNCNEST_NUMBER = /^\s*[+-]?\d+\s*$/;

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

export interface BuiltinExecutionContext {
  interactive?: boolean;
  /** A declaration builtin's arguments written as array assignments, `name=(…)`, by index: their arrays (Interpreter.arrayLiteral). */
  arrayElements?: ReadonlyMap<number, ArrayLiteral>;
  /** bash's report_error, after a builtin reports an error the shell's own: under `set -e` the shell ends there. */
  reportedError?(): void;
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
  /** The names the running function has bound (`local`), in order; null outside a function. */
  localNames(): readonly string[] | null;
  /** Whether `name` is a function of the shell running the builtin. */
  isFunction(name: string): boolean;
  /** Keep `name`'s command-prefix binding, value and attributes, past the command: the builtin declared it (bash's tempenv promotion, `x=1 export x`). */
  promote(name: string): void;
  /** Remove a function from the shell running the builtin (a child shell's own, after a fork); false when none is defined. */
  unsetFunction(name: string): boolean;
  /** The state of the shell running the builtin: a child shell's own, after a fork. */
  shell: ShellState;
  getLastExitCode(): number;
  /** The status a bare `exit` ends the shell with: the last command's, or in a trap's action the one before the trap (POSIX). */
  exitStatus(): number;
  /** The process the builtin runs as: a kill's caller, a wait's waiter. */
  identity(): Pick<CommandIdentity, 'pid' | 'cred'>;
}

export interface InlineExecutionOptions {
  positionals?: string[];
}

export type BuiltinFn = (
  args: string[],
  stdout: CommandOutputStream,
  stderr: CommandOutputStream,
  stdin: CommandInputStream | undefined,
  context: BuiltinExecutionContext,
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
  /** The controlling terminal: fd 0 by default, and what `/dev/tty` opens. */
  terminalStdin?: TerminalInputStream;
  terminalFds?: TerminalFdState;
  /**
   * A job started with `&`, and what it runs: it still has the controlling
   * terminal (an explicit `/dev/tty` opens it) but is not its foreground
   * job, so it does not read it by default or own its modes.
   */
  background?: boolean;
  scriptMode?: boolean;
  /**
   * The command word this shell's text last dispatched (null for a
   * function's call), before its redirections: bash's this_shell_builtin,
   * which decides whether a syntax error in eval's or `.`'s text is theirs
   * (evalstring). One per line a shell reads (a nested bash or sh has its
   * own), and only that shell's dispatches count: a child's (a subshell's, a
   * substitution's, a pipeline's) are another process's.
   */
  dispatched?: { readonly shell: Interpreter; last: string | null };
  signal?: AbortSignal;
  positionals?: PositionalFrame;
  /** Host-supplied fields merged into each command's CommandContext. */
  commandContext?: Record<string, unknown>;
  commandIdentity?: CommandIdentity;
  /** The thread of control this runs on, as its process's work (WorkThread). */
  workThread?: WorkThread;
  runAs?: CommandRunAsHost;
  vfs?: ProcessView;
  /** The terminal's own shell (bash -i): job notices are printed. */
  interactive?: boolean;
  /** Files the enclosing redirections hold open, by their stream. */
  openFiles?: ReadonlyMap<CommandInputStream | CommandOutputStream, OpenFile>;
};

/** The command word as written when it is one unquoted part with no substitution in it: the text an alias or a declaration builtin is named by. */
function literalWordText(word: readonly WordPart[]): string | null {
  const [only] = word;
  return word.length === 1 && only !== undefined && only.quoted === 'none' && only.commandSubstitution === undefined
    && !only.text.includes('$') && !only.text.includes('`') ? only.text : null;
}

function commandWordText(cmd: SimpleCommandNode): string | null {
  const [word] = cmd.words;
  return word === undefined ? null : literalWordText(word);
}

/** A declaration builtin's name, written unquoted: its compound array assignments are arrays. */
/** What an assignment leaves its caller to report (Interpreter.applyAssignment). */
interface AssignmentOutcome {
  readonly diagnostics: readonly string[];
  readonly failed: boolean;
}

/** An assignment that did what it was asked, with nothing to report. */
const ASSIGNED: AssignmentOutcome = { diagnostics: [], failed: false };

/** bash's declaration builtins: an argument written `name=(…)` is an array assignment. */
function isDeclarationWord(word: readonly WordPart[]): boolean {
  const text = literalWordText(word);
  return text === 'declare' || text === 'typeset' || text === 'local' || text === 'export' || text === 'readonly';
}

function terminalStdinFd(io: ExecutionIo, stdin = io.stdin): boolean {
  return io.terminalFds?.stdin ?? ((!stdin || stdin === io.terminalStdin) && Boolean(io.terminalStdin));
}

/** A shell's function definitions, by name. */
export type FunctionTable = ReadonlyMap<string, CompoundCommandNode>;

/** The process a command runs as: its pid and credential, and how it sets its umask. */
export interface CommandIdentity {
  readonly pid: number;
  readonly cred: VfsCred;
  setUmask(mask: number): void;
  /**
   * The process has a unit of in-flight work while a command of its runs,
   * until the returned function is called: how its session tells a shell
   * doing nothing but await its children (SessionProcessSupervisor.beginWork).
   */
  beginWork?(): () => void;
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
 * and whether it is the shell's own builtin, whose write to a closed pipe
 * ends the shell's pipeline element and not just itself.
 */
interface CommandSpec extends ProgramSpec {
  readonly vfs: ProcessView;
  readonly shellBuiltin: boolean;
  /** CommandContext.searchPath. */
  readonly searchPath?: string;
  /** The command says its program takes the shell's signals (CommandContext.takesSignals). */
  readonly takesSignals?: () => void;
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

/** How a script's lists are run (executeScriptWithIo). */
type ScriptRun = {
  readsLines?: boolean;
  inline?: boolean;
};


/** A shell's state, and what every shell of the interactive one shares. */
export interface InterpreterConfig extends ShellState {
  vfs: ProcessView;
  filesystem: NimbusFilesystemAuthority;
  registry: CommandRegistry;
  builtins: Map<string, BuiltinFn>;
  writeToTerminal: (text: string) => void;
  /** Returns the current abort signal for foreground commands */
  getAbortSignal?: () => AbortSignal;
}

/**
 * Assign a plain value to a name. A name that already holds an array keeps it:
 * `a=(x y); a=plain` sets `a[0]` and leaves `a[1]` alone, which is bash's rule
 * and the reason a variable's type only changes through `unset`.
 */



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
  /** While the EXIT trap's action runs: the status the shell was ending with, a bare `exit`'s there. */
  private trapEntryStatus: number | null = null;
  /** One frame per running function call, holding the bindings `local` shadowed. */
  private localFrames: Array<Map<string, SavedVariable>> = [];
  /** A child shell (fork): a discarded line ends it (finishChild). */
  private child = false;

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
   * A child shell, as fork(2) makes one: its own copy of the shell's state
   * (forkShellState) and of its functions, $? and open descriptors, so
   * nothing it changes reaches this shell. Shared: the filesystem, command
   * registry and terminal; `$$` stays this shell's. The child runs its own
   * EXIT trap when it finishes (`finishChild`).
   */
  fork(): Interpreter {
    const child = new Interpreter({ ...this.config, ...forkShellState(this.config) });
    child.child = true;
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

  /**
   * `child`, forked for a substitution or a simple command (a pipeline's
   * element, a job), runs inside the EXIT trap's action still: a bare `exit`
   * there ends with the trap's entry status, and an EXIT trap set there does
   * not run. bash keeps running_trap for these, and clears it in the
   * subshell of a compound command, `( … )` among them.
   */
  private inTrapAction(child: Interpreter): Interpreter {
    child.trapEntryStatus = this.trapEntryStatus;
    child.exitTrapDepth = this.exitTrapDepth;
    return child;
  }

  getLastExitCode(): number {
    return this.lastExitCode;
  }

  setLastExitCode(exitCode: number): void {
    this.lastExitCode = exitCode;
  }

  /** `input`'s lines, read as they run: the aliases defined when each is read are expanded in it. */
  private linesOf(input: string): ScriptLines {
    return new ScriptLines(input, { aliases: (name) => this.config.aliases.get(name) });
  }

  /**
   * Runs `script`'s lists. As lines a shell reads (`readsLines`: its own,
   * a sourced file's, a trap's; not an alias's text, which is part of the
   * line it is in), a line a nested call discards ends, and the next runs
   * with $? 1, in a shell that is no child: a child's ends (finishChild).
   * Text run `inline` (eval's, a sourced file's, an alias's) leaves an `exit`,
   * and an end by `set -e` or a fatal error, to the shell that runs it.
   */
  private async executeScriptWithIo(
    lines: { nextLine(): readonly ListNode[] | null },
    io: ExecutionIo,
    { readsLines = false, inline = false }: ScriptRun = {},
  ): Promise<number> {
    let exitCode = 0;
    try {
      for (let line = lines.nextLine(); line !== null; line = lines.nextLine()) {
        for (const list of line) {
          try {
            exitCode = await this.executeList(list, io);
          } catch (error) {
            if (!(error instanceof DiscardSignal) || !readsLines || this.child) throw error;
            exitCode = error.exitCode;
            this.lastExitCode = exitCode;
            this.setPipestatus([exitCode]);
            // The rest of its line is not run.
            break;
          }
        }
      }
    } catch (error) {
      if ((error instanceof ErrexitSignal || error instanceof ExitSignal) && !inline) {
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
    // The line is a thread of its process's work, from its first word to its
    // last: between its commands it is the shell's own (WorkThread).
    const beginWork = io.commandIdentity?.beginWork?.bind(io.commandIdentity);
    if (beginWork) io.workThread = new WorkThread(beginWork);
    try {
      const exitCode = await this.executeScriptWithIo(this.linesOf(input), io, { readsLines: true });
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
    } finally {
      io.workThread?.close();
    }
  }

  private async executeList(list: ListNode, io: ExecutionIo = {}): Promise<number> {
    const abortCode = this.abortExitCode(io);
    if (abortCode !== null) return abortCode;

    if (list.background) {
      const parent = io.commandIdentity;
      if (!parent) throw new Error('shell command identity is unavailable');
      const backgroundIo = this.createCommandIo(io);
      // A job does not read the terminal by default: before any redirection
      // of its own, its stdin is /dev/null, as POSIX gives an asynchronous
      // list (bash's, for a shell without job control). It keeps the
      // controlling terminal for `/dev/tty`, but only the foreground job
      // owns the terminal's modes: a background REPL (`node &`) never takes
      // the Ctrl-C meant for the foreground.
      if (terminalStdinFd(io)) {
        backgroundIo.stdin = this.createEmptyReader();
        backgroundIo.terminalFds = { ...io.terminalFds, stdin: false };
      }
      backgroundIo.background = true;
      backgroundIo.positionals = this.forkPositionals(io);

      // A job is a process of its own, as a fork makes one: its commands run
      // as it, on its own thread of work, until a kill of it stops them.
      // A job that is one pipeline goes on in the trap's action, as its simple elements do (a pipeline of
      // several decides per element); an and-or list or a compound command does not.
      const [only] = list.entries;
      const commands = list.entries.length === 1 ? only?.pipeline.commands ?? [] : [];
      const inAction = commands.length > 1 || commands[0]?.type === 'simple_command';
      const child = inAction ? this.inTrapAction(this.fork()) : this.fork();
      const job = this.config.jobTable.start(
        { command: this.getListCommandText(list), cwd: this.config.getCwd(), parent },
        async ({ identity, signal }) => {
          backgroundIo.commandIdentity = identity;
          backgroundIo.signal = signal;
          backgroundIo.vfs = bindProcessView(this.config.filesystem, { pid: identity.pid, cred: identity.cred, signal });
          const workThread = new WorkThread(identity.beginWork);
          backgroundIo.workThread = workThread;
          try {
            return await child.finishChild(async () => (await child.executeListEntries(list.entries, backgroundIo)), backgroundIo);
          } finally {
            workThread.close();
          }
        },
      );
      this.config.env['!'] = String(job.pid);

      // An interactive bash reports the job; a script (bash -c) says nothing.
      if (io.interactive) this.writeTerminal(io, `[${job.id}] ${job.pid}\n`);
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
    this.setPipestatus(statuses);

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
        // Each element is a thread of its own, which the pipeline's waits on.
        cmdIo.workThread = io.workThread?.fork();
        // Each element runs in a child shell (bash forks every one), its pipe ends its own fd 0 and 1
        // over what it inherited (an `exec`'s among it).
        const element = cmd.type === 'simple_command' ? this.inTrapAction(this.fork()) : this.fork();
        const cmdPromise = (async (): Promise<number> => {
          try {
            const inherited = [stdin && element.dupChildFd(0, { input: stdin }), stdout && element.dupChildFd(1, { output: stdout })]
              .filter((file): file is OpenFile => file !== undefined);
            if (inherited.length > 0) await element.release(inherited);
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
            cmdIo.workThread?.close();
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
      case 'arithmetic':
        return (await this.executeArithmetic(cmd, io));
      case 'arithmetic_for':
        return (await this.executeArithmeticFor(cmd, io));
      case 'if':
        return (await this.executeIf(cmd, io));
      case 'for':
        return (await this.executeFor(cmd, io));
      case 'while':
      case 'until':
        return (await this.executeLoop(cmd, io));
      case 'case':
        return (await this.executeCase(cmd, io));
      case 'group':
        return (await this.executeGroup(cmd, io));
      case 'subshell':
        return (await this.executeSubshell(cmd, io));
      case 'function_def':
        return (await this.executeFunctionDef(cmd, io));
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
      const exitCode = await this.withFdFlush(fds, async () => (await evaluateDoubleBracketWords(
        node.words,
        this.createExpandContext(redirIo),
        redirIo.vfs ?? this.config.vfs,
        stderr,
        {
          cwd: this.config.getCwd(),
          isFdTerminal: (fd) => this.isFdTerminal(fds, fd),
          // A new BASH_REMATCH, as bash 5.2 makes one: whatever the old one was, readonly too, it is gone.
          setRematch: (values) => {
            this.config.readonlyNames.delete('BASH_REMATCH');
            assignArray(this.config, 'BASH_REMATCH', [...values]);
          },
        },
      )));
      this.lastExitCode = exitCode;
      return exitCode;
    }));
  }

  /** `((expression))`: 0 where its value is not 0; 1 where it is 0, or an error, reported as `((`'s. */
  private async executeArithmetic(node: ArithmeticCommandNode, io: ExecutionIo): Promise<number> {
    return (await this.executeWithRedirections(node.redirections, io, async (redirIo) => {
      const value = await this.arithmeticCommandValue(node.expression, redirIo);
      const exitCode = value === null || value === 0 ? 1 : 0;
      this.lastExitCode = exitCode;
      return exitCode;
    }));
  }

  /**
   * `for ((init; test; step))`: init once; then while test is not 0 (an empty
   * one is true), the body, then step (after a `continue` too). Its status
   * the body's last, 0 where it never ran, 1 where an expression fails.
   */
  private async executeArithmeticFor(node: ArithmeticForNode, io: ExecutionIo): Promise<number> {
    return (await this.executeWithRedirections(node.redirections, io, async (redirIo) => {
      let exitCode = 0;
      const failed = async (expression: string): Promise<boolean> => (
        expression.trim() !== '' && (await this.arithmeticCommandValue(expression, redirIo)) === null
      );
      if (await failed(node.init)) exitCode = 1;
      else {
        while (true) {
          await this.loopTick();
          const abortCode = this.abortExitCode(redirIo);
          if (abortCode !== null) return abortCode;
          if (node.test.trim() !== '') {
            const test = await this.arithmeticCommandValue(node.test, redirIo);
            if (test === null) exitCode = 1;
            if (test === null || test === 0) break;
          }
          try {
            exitCode = await this.executeCompoundList(node.body, redirIo);
          } catch (e) {
            if (e instanceof BreakSignal) {
              if (e.levels > 1) throw new BreakSignal(e.levels - 1);
              break;
            }
            if (!(e instanceof ContinueSignal)) throw e;
            if (e.levels > 1) throw new ContinueSignal(e.levels - 1);
          }
          if (await failed(node.step)) {
            exitCode = 1;
            break;
          }
        }
      }
      this.lastExitCode = exitCode;
      return exitCode;
    }));
  }

  /** An arithmetic command's expression, expanded (as a double-quoted word, its quotes removed) and evaluated: null where that fails, reported as `((`'s. */
  private async arithmeticCommandValue(expression: string, io: ExecutionIo): Promise<number | null> {
    const ctx = this.createExpandContext(io);
    const text = await expandArithmetic(expression, ctx);
    let value: number | null;
    let failure: ArithmeticError | null = null;
    try {
      value = arithmeticOf(text, ctx);
    } catch (error) {
      if (!(error instanceof ArithmeticError)) throw error;
      value = null;
      failure = error;
    }
    await reportWarnings(ctx, ctx.report);
    if (failure !== null) await ctx.report(failure.reportedBy('(('));
    // A subscript's error is an expansion's: the line's.
    if (failure instanceof SubscriptArithmeticError) throw new DiscardSignal();
    return value;
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
      // Its variable is not a name (bash's check_identifier): said, and the loop not run.
      if (node.variableError !== undefined) {
        (await (redirIo.stderr ?? this.terminalSink(redirIo)).write(`${node.variableError}\n`));
        return 1;
      }
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

  private async executeLoop(node: LoopNode, io: ExecutionIo): Promise<number> {
    return (await this.executeWithRedirections(node.redirections, io, async (redirIo) => {
      let exitCode = 0;

      while (true) {
        await this.loopTick();
        const abortCode = this.abortExitCode(redirIo);
        if (abortCode !== null) return abortCode;

        const condCode = await this.withErrexitSuppressed(async () => (await this.executeCompoundList(node.condition, redirIo)));
        // while goes on while its condition succeeds, until while it fails.
        if ((condCode === 0) !== (node.type === 'while')) break;

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
          // Its quoted characters match only themselves.
          if (shellMatch((await expandPatternWord(pattern, expandCtx)).pattern, wordValue)) {
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

  private async executeFunctionDef(node: FunctionDefNode, io: ExecutionIo): Promise<number> {
    if (node.nameError !== undefined) {
      (await (io.stderr ?? this.terminalSink(io)).write(`${node.nameError}\n`));
      return 1;
    }
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

    // Expand words. A declaration builtin's (declare, typeset, local, export, readonly) array
    // assignments, `b=("$v" z)`, are read as an assignment's are (parseAssignment):
    // each element expanded as a word, and the argument only names the array.
    let arrayElements: Map<number, ArrayLiteral> | undefined;
    let expandedArgs: string[];
    const [commandWord] = cmd.words;
    if (commandWord !== undefined && isDeclarationWord(commandWord)) {
      expandedArgs = [];
      for (const [index, parts] of cmd.words.entries()) {
        const assignment = index === 0 ? null : parseAssignment({ kind: TokenKind.Word, value: parts.map((part) => part.text).join(''), pos: 0, parts });
        if (assignment?.elements !== undefined && assignment.subscript === undefined && assignment.append !== true) {
          (arrayElements ??= new Map()).set(expandedArgs.length - 1, await this.arrayLiteral(assignment.name, assignment.elements, false, expandCtx));
          expandedArgs.push(`${assignment.name}=`);
        } else if (index === 0) {
          expandedArgs.push(...await expandWords([parts], expandCtx));
        } else {
          // An assignment as written, one brace expansion leaves as it is, expands as an
          // assignment's value: not split, no pathname expansion. Any other word, and
          // every word brace expansion makes, is fields (bash's subst.c keeps the flags
          // only for an unchanged word).
          const words = expandBraceWord(parts);
          const [only] = words;
          const unchanged = words.length === 1 && only !== undefined && only.map((part) => part.text).join('') === parts.map((part) => part.text).join('');
          if (assignment !== null && assignment.elements === undefined && unchanged) {
            const subscript = assignment.subscript === undefined ? '' : `[${assignment.subscript}]`;
            expandedArgs.push(`${assignment.name}${subscript}${assignment.append === true ? '+' : ''}=${await expandWord(assignment.value, expandCtx)}`);
          } else {
            expandedArgs.push(...await expandWords(words, expandCtx, true));
          }
        }
      }
    } else {
      expandedArgs = await expandWords(cmd.words, expandCtx);
    }
    if (expandedArgs.length === 0 && cmd.assignments.length > 0) {
      // Bare assignment -- set env vars
      for (const assign of cmd.assignments) {
        const { diagnostics, failed } = await this.applyAssignment(assign, expandCtx);
        for (const diagnostic of diagnostics) {
          this.writeTerminal(io, `${diagnostic}\n`);
          this.exitOnReportedError();
        }
        // A non-interactive POSIX shell ends (bash's FORCE_EOF); any other discards the line.
        if (failed) throw io.scriptMode === true && this.config.options.posix ? new ErrexitSignal(1) : new AssignmentErrorSignal();
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
    // `command name [args]` runs name as a builtin or a program, never as a
    // function or an alias (bash); `command -v`/`-V` describe, by the
    // registry's. A function or an alias named `command` is that instead.
    const viaCommand = name === 'command' && !replacesShell && !this.functions.has(name) && !this.config.aliases.has(name)
      && args.length > 0 && (args[0] === '--' ? args.length > 1 : !args[0].startsWith('-'));
    if (viaCommand) [name, ...args] = args[0] === '--' ? args.slice(1) : args;
    if (io.dispatched?.shell === this) io.dispatched.last = this.functions.has(name) && !viaCommand ? null : name;

    // Apply per-command assignments (temporary env, exported for the command, as bash's tempenv is).
    // Each is restored, value and attributes, however the command ends, unless the builtin
    // run declared it (BuiltinExecutionContext.promote: `x=1 export x` keeps x).
    const saved = new Map<string, SavedVariable>();
    const promoted = new Set<string>();
    const restorePrefix = (): void => {
      for (const [variable, value] of saved) if (!promoted.has(variable)) restoreVariable(this.config, variable, value);
    };
    let exitCode: number;
    let writeFailed = false;
    // eval's and `.`'s status is their text's once it runs: its failure is not theirs.
    let ranText = false;
    // The prefix bindings' lifetime: however the command ends, an expansion's throw included.
    try {
      for (const assign of cmd.assignments) {
        if (!saved.has(assign.name)) saved.set(assign.name, saveVariable(this.config, assign.name));
        const { diagnostics, failed } = await this.applyAssignment(assign, expandCtx);
        for (const diagnostic of diagnostics) (await (io.stderr ?? this.terminalSink(io)).write(`${diagnostic}\n`));
        if (failed) return 1;
        this.config.exportedNames.add(assign.name);
      }

      // Set up stdout/stderr (per-execution io target, then the terminal sink)
      let stdout: CommandOutputStream = io.stdout ?? this.terminalSink(io);
      let stderr: CommandOutputStream = io.stderr ?? this.terminalSink(io);
      let stdin: CommandInputStream | undefined = io.stdin;
      const fds = this.createCommandFds(stdout, stderr, stdin, io);
      try {
        await this.applyRedirections(cmd.redirections, fds, expandCtx, io, io.terminalStdin);
      } catch (error) {
        // A discard met expanding a target (an arithmetic error's) is the line's, reported where it was met.
        if (error instanceof DiscardSignal) {
          await this.flushFds(fds);
          throw error;
        }
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

      // If no stdin from pipe or redirect, fall back to terminal stdin (the
      // foreground job's: a background job's fd 0 never falls back to it)
      if (!stdin && io.terminalStdin && !io.background) {
        stdin = io.terminalStdin;
      }


      // A program start is placed by its cwd before anything here (Kinu ask 66).
      const placing = this.placeCommand(name, replacesShell, viaCommand, io);
      const placement = placing instanceof Promise ? await placing : placing;

      try {
        // Check for break/continue/return builtins
        if (name === 'break' && placement.kind === 'local') {
          const levels = args[0] ? parseInt(args[0], 10) : 1;
          throw new BreakSignal(levels);
        }
        if (name === 'continue' && placement.kind === 'local') {
          const levels = args[0] ? parseInt(args[0], 10) : 1;
          throw new ContinueSignal(levels);
        }
        if (name === 'return' && placement.kind === 'local') {
          const code = args[0] ? parseInt(args[0], 10) : this.lastExitCode;
          throw new ReturnSignal(code);
        }
        if (name === 'exec' && args.length === 0) {
          await this.persistFdState(fds);
          exitCode = 0;
        } else if (placement.kind !== 'local') {
          exitCode = await this.runPlacedProgram(placement, name, args, { stdin, stdout, stderr }, io);
        } else {
          // Check functions
          const funcBody = replacesShell || viaCommand ? undefined : this.functions.get(name);
          if (funcBody) {
            if (this.localFrames.length >= this.functionNestingLimit()) {
              // On the call's own stderr, its redirections applied, with the depth reached, as bash writes it.
              (await stderr.write(`${name}: maximum function nesting level exceeded (${this.localFrames.length})\n`));
              throw new FunctionNestingSignal();
            }
            exitCode = await this.withInstalledFds(fds, async () => (await this.executeFunction(funcBody, args, this.createIoFromFds(io, fds))));
          } else {
            // Check builtins
            const builtin = this.config.builtins.get(name);
            if (builtin) {
              const builtinIo = this.createIoFromFds(io, fds);
              // A builtin is work of the shell's own (a `sleep`, a `read`, a
              // `wait`), never an await of a child; its thread lends it its unit.
              const endWork = io.workThread ? io.workThread.beginWork() : io.commandIdentity?.beginWork?.();
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
                  ...(arrayElements === undefined || name !== commandWordText(cmd) ? {} : { arrayElements }),
                  reportedError: () => this.exitOnReportedError(),
                  isFdTerminal: (fd) => this.isFdTerminal(fds, fd),
                  getPositionals: () => this.readPositionals(builtinIo),
                  setPositionals: (nextArgs) => this.writePositionals(builtinIo, nextArgs),
                  executeInline: async (input, options) => {
                    ranText = true;
                    try {
                      // Its text runs over the builtin's redirections in the shell's table (`eval … 2>f`).
                      return (await this.withInstalledFds(fds, async () => (await this.executeInline(input, builtinIo, options))));
                    } catch (error) {
                      // A syntax error while eval or `.` is still the builtin last dispatched (no
                      // other command of the text has been, or one was, an eval or `.`) is the
                      // builtin's own failure, as bash's evalstring has it: fatal in a POSIX script.
                      const last = io.dispatched?.last;
                      if (error instanceof TextSyntaxError && (last === 'eval' || last === '.' || last === 'source')) ranText = false;
                      throw error;
                    }
                  },
              declareLocal: (name) => this.declareLocal(name),
              localNames: () => {
                const frame = this.localFrames[this.localFrames.length - 1];
                return frame === undefined ? null : Array.from(frame.keys());
              },
              isFunction: (name) => this.functions.has(name),
              promote: (variable) => { promoted.add(variable); },
              unsetFunction: (name) => this.functions.delete(name),
              shell: this.config,
              interactive: io.interactive,
              getLastExitCode: () => this.lastExitCode,
              exitStatus: () => this.trapEntryStatus ?? this.lastExitCode,
              identity: () => {
                if (!io.commandIdentity) throw new Error('shell command identity is unavailable');
                return io.commandIdentity;
              },
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
              } finally {
                endWork?.();
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
                // A command is a unit of the process's work; one that runs a
                // program as a child of its own counts that as its await. Its
                // thread lends it its unit while it runs.
                const endWork = io.workThread ? io.workThread.beginWork() : identity.beginWork?.();
                let ended: ChildExit;
                let tookSignals = false;
                try {
                  ended = await this.runCommand(command, name, args, {
                    takesSignals: () => { tookSignals = true; },
                    commandContext: io.commandContext,
                    identity,
                    cwd: this.config.getCwd(),
                    env: exportedEnvironment(this.config),
                    searchPath: this.config.env.PATH,
                    vfs: io.vfs ?? this.config.vfs,
                    stdout,
                    stderr,
                    stdin,
                    // The terminal whose modes it may set: the foreground job's.
                    terminalStdin: io.background ? undefined : io.terminalStdin,
                    isFdTerminal: (fd: number) => this.isFdTerminal(fds, fd),
                    isFdPipe: (fd: number) => isPipeEnd(fds.outputFds.get(fd) ?? fds.inputFds.get(fd)),
                    signal: io.signal ?? this.config.getAbortSignal?.() ?? new AbortController().signal,
                    runAs: io.runAs,
                    shellBuiltin: BASH_BUILTINS.has(name),
                  });
                } finally {
                  endWork?.();
                }
                exitCode = ended.status;

                // A signalled command reports the SIGNAL's status, not whatever
                // code it returned on its way out: `sleep` observes only that
                // ctx.signal aborted, and cannot tell SIGINT (130) from
                // SIGQUIT (131). The shell holds the reason, so it decides.
                const signalledCode = this.abortExitCode(io);
                // A program that took the signal itself ends as it decided (git dies of it, or handles it).
                if (signalledCode !== null && !tookSignals) exitCode = signalledCode;
              }
            }
          }
        }
      } finally {
        writeFailed = await this.flushFds(fds, name);
      }
    } finally {
      restorePrefix();
    }
    if (writeFailed && exitCode === 0) exitCode = 1;

    // `command` takes a special builtin's failure from fatal to an ordinary status (POSIX).
    const fatalSpecialBuiltin = io.scriptMode === true
      && this.config.options.posix
      && exitCode !== 0
      && !viaCommand
      && !ranText
      && isFatalSpecialBuiltin(name);
    this.lastExitCode = exitCode;
    if (fatalSpecialBuiltin) throw new ErrexitSignal(exitCode);
    if (replacesShell) throw new ExitSignal(exitCode);
    return exitCode;
  }

  /**
   * Where the simple command `name` starts a program (Kinu ask 66): nowhere
   * for what bash runs without execve (a function, a builtin, `command` of
   * a builtin), so here; otherwise by its cwd's mount (placeProgram). `exec
   * name` always starts one, as bash's does.
   */
  private placeCommand(name: string, replacesShell: boolean, viaCommand: boolean, io: ExecutionIo): ProgramPlacement | Promise<ProgramPlacement> {
    const identity = io.commandIdentity;
    if (identity === undefined) return LOCAL_PLACEMENT;
    if (!replacesShell && ((!viaCommand && this.functions.has(name)) || this.config.builtins.has(name) || BASH_BUILTINS.has(name))) return LOCAL_PLACEMENT;
    return this.config.filesystem.placeProgram(identity.cred, this.config.getCwd());
  }

  /**
   * A program placed on its mount's machine (placeCommand), run with the
   * command's streams and its exported environment. Its status is bash's:
   * the program's exit code, 128+n for the signal that ended it, 127 for a
   * program its machine cannot find, 126 for any other refusal or an absent
   * mount, 1 for a stream that failed once it ran.
   */
  private async runPlacedProgram(
    placement: Exclude<ProgramPlacement, { kind: 'local' }>,
    name: string,
    args: string[],
    streams: { stdin: CommandInputStream | undefined; stdout: CommandOutputStream; stderr: CommandOutputStream },
    io: ExecutionIo,
  ): Promise<number> {
    if (placement.kind === 'absent') {
      await streams.stderr.write(`${name}: ${placement.reason}\n`);
      return 126;
    }
    const output = outputHooks({ stdout: streams.stdout, stderr: streams.stderr });
    const endWork = io.workThread ? io.workThread.beginWork() : io.commandIdentity?.beginWork?.();
    try {
      const exit = await runDelegatedProgram(
        placement.delegate,
        { argv: [name, ...args], env: exportedEnvironment(this.config), cwd: placement.cwd },
        { stdin: streams.stdin ?? null, stdout: output.onStdout, stderr: output.onStderr },
        io.signal ?? this.config.getAbortSignal?.() ?? new AbortController().signal,
      );
      return shellStatusOf(exit);
    } catch (error) {
      // A start the caller stopped (Ctrl-C while it was pending) ends as the stop says.
      const stopped = this.abortExitCode(io);
      if (stopped !== null) return stopped;
      if (error instanceof ProgramRefusal) {
        await streams.stderr.write(error.code === 'ENOENT' ? `${name}: command not found\n` : `${name}: ${error.message}\n`);
        return error.code === 'ENOENT' ? 127 : 126;
      }
      await streams.stderr.write(`${name}: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    } finally {
      try {
        await output.end();
      } finally {
        endWork?.();
      }
    }
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
    // Placed by its cwd before anything here (Kinu ask 66): one on its mount's machine fails there as execvp would.
    const placing = this.config.filesystem.placeProgram(spec.identity.cred, spec.cwd);
    const placement = placing instanceof Promise ? await placing : placing;
    if (placement.kind === 'absent') throw syscallError('EIO', 'execvp', name, { detail: placement.reason });
    if (placement.kind === 'delegated') return await this.runDelegatedChild(placement, name, args, spec);
    // The program is found, as it runs, under the child's credential.
    const vfs = bindProcessView(this.config.filesystem, { pid: spec.identity.pid, cred: spec.identity.cred, signal: spec.signal });
    const command = await this.config.registry.resolve(name, resolveContext(spec.cwd, spec.env, vfs));
    if (!command) throw syscallError('ENOENT', 'execvp', name);
    // execve(2) refuses a directory or a file the child may not execute: its caller reports that, as it does a missing one.
    const refused = await execRefusal(name, spec.cwd, command, vfs);
    if (refused !== null) throw syscallError(refused, 'execvp', name);
    return await this.runCommand(command, name, args, {
      ...spec,
      vfs,
      shellBuiltin: false,
    });
  }

  /** CommandContext.locateProgram: the delegate's answer for a cwd its mount places, undefined for one placed here. */
  private async locateProgram(name: string, cwd: string, env: Record<string, string>, cred: VfsCred): Promise<string | null | undefined> {
    const placement = await this.config.filesystem.placeProgram(cred, cwd);
    if (placement.kind === 'local') return undefined;
    if (placement.kind === 'absent') return null;
    return await placement.delegate.locate(name, placement.cwd, env);
  }

  /**
   * execvp of a program placed on its mount's machine (runProgram): run with
   * the child's streams, environment and stop; a start its machine refuses
   * is execvp failing, ENOENT for a program it cannot find, EIO with its
   * words otherwise.
   */
  private async runDelegatedChild(
    placement: Extract<ProgramPlacement, { kind: 'delegated' }>,
    name: string,
    args: string[],
    spec: ProgramSpec,
  ): Promise<ChildExit> {
    const output = outputHooks({ stdout: spec.stdout, stderr: spec.stderr });
    try {
      const exit = await runDelegatedProgram(
        placement.delegate,
        { argv: [name, ...args], env: spec.env, cwd: placement.cwd },
        { stdin: spec.stdin ?? null, stdout: output.onStdout, stderr: output.onStderr },
        spec.signal,
      );
      return { status: shellStatusOf(exit), signal: exit.signal === null ? null : exit.signal.replace(/^SIG/, '') };
    } catch (error) {
      if (!(error instanceof ProgramRefusal)) throw error;
      throw error.code === 'ENOENT' ? syscallError('ENOENT', 'execvp', name) : syscallError('EIO', 'execvp', name, { detail: error.message });
    } finally {
      await output.end();
    }
  }

  /**
   * A resolved command, run as the process `spec.identity` names: aborted
   * with `spec.signal`, and its failure (a closed pipe, an abort, a throw)
   * turned into the status a process would end with.
   */
  private async runCommand(command: Command, name: string, args: string[], spec: CommandSpec): Promise<ChildExit> {
    // The command's own signal, linked to the shell's, so what it listens on
    // goes with it rather than staying on the line's: made when it first
    // asks, as most commands never do.
    let own: { signal: AbortSignal; unlink: () => void } | undefined;
    const signalOf = (): AbortSignal => {
      if (own === undefined) {
        const controller = new AbortController();
        own = { signal: controller.signal, unlink: linkAbortSignal(spec.signal, controller) };
      }
      return own.signal;
    };
    const { identity, terminalStdin, stderr } = spec;
    const ctx: CommandContext = {
      ...spec.commandContext,
      pid: identity.pid,
      cred: identity.cred,
      args,
      env: spec.env,
      ...(spec.searchPath === undefined ? {} : { searchPath: spec.searchPath }),
      cwd: spec.cwd,
      vfs: spec.vfs,
      vfsUntilExit: () => bindProcessView(this.config.filesystem, { pid: identity.pid, cred: identity.cred }),
      locateProgram: (program) => this.locateProgram(program, spec.cwd, spec.env, identity.cred),
      stdout: spec.stdout,
      stderr,
      get signal() { return signalOf(); },
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
      takesSignals: spec.takesSignals,
      isShellBuiltin: (builtin) => this.config.builtins.has(builtin),
      setUmask: identity.setUmask,
      runAs: async (cred, argv, options) => spec.runAs
        ? (await spec.runAs(options?.parent ?? ctx, cred, argv))
        : exited(126),
    };

    try {
      return exited(await command(ctx));
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
      own?.unlink();
    }
  }

  private assignEnv(name: string, value: string): boolean {
    return assignVariable(this.config, name, value);
  }

  /**
   * `name=value`, `name+=value`, `name[expr]=value` and `name=(element …)`.
   * Returns the diagnostics for the caller to report, in order, and whether
   * the assignment failed: a readonly name, or a subscript before the first
   * element (bash's bad array subscript). An array literal's refused
   * elements are reported, and the rest of it is assigned.
   */
  private async applyAssignment(assign: AssignmentNode, ctx: ExpandContext): Promise<AssignmentOutcome> {
    const { name } = assign;
    if (this.config.readonlyNames.has(name)) return { diagnostics: [`${name}: readonly variable`], failed: true };
    if (assign.elements !== undefined) {
      const literal = await this.arrayLiteral(name, assign.elements, assign.append === true, ctx);
      if (assign.append !== true) assignArray(this.config, name, literal.array);
      return { diagnostics: literal.refused, failed: false };
    }

    const value = await expandWord(assign.value, ctx);
    if (assign.subscript !== undefined) {
      const subscript = await expandSubscript(assign.subscript, ctx);
      const array = arrayFor(this.config, name);
      const index = subscript === '' ? -1 : arrayIndex(array, await arithmeticValue(subscript, ctx));
      if (index < 0) return { diagnostics: [`${name}[${assign.subscript}]: bad array subscript`], failed: true };
      array[index] = assign.append ? (array[index] ?? '') + value : value;
      return ASSIGNED;
    }
    // On an array name, `arr=x` and `arr+=x` land on its first element.
    assignVariable(this.config, name, value, assign.append);
    return ASSIGNED;
  }

  /**
   * `name=(…)`'s array, as bash's assign_compound_array_list builds it, or
   * with `append` (`name+=(…)`) `name`'s own, extended in place (a scalar
   * becomes its element 0). Every element is expanded first; then a word's
   * values go on at the next index (past the last that holds one, for
   * `append`), and a `[subscript]=` element at its subscript's arithmetic (a
   * negative one counted back from past the last), the next index after it.
   * An element whose subscript is empty, `@` or `*`, or before the first is
   * refused with bash's diagnostic and skipped; under `set -e` the first
   * refusal ends the assignment, what it assigned before kept, as the shell
   * ends there (exitOnReportedError).
   */
  private async arrayLiteral(name: string, elements: readonly ArrayElementNode[], append: boolean, ctx: ExpandContext): Promise<ArrayLiteral> {
    const expanded: ({ values: string[] } | { subscript: string; value: string; append: boolean })[] = [];
    for (const element of elements) {
      expanded.push(element.subscript === undefined
        ? { values: await expandWords([element.word], ctx) }
        : { subscript: await expandSubscript(element.subscript, ctx), value: await expandWord(element.word, ctx), append: element.append === true });
    }
    const array = append ? arrayFor(this.config, name) : [];
    const refused: string[] = [];
    let next = append ? lastIndex(array) + 1 : 0;
    for (const element of expanded) {
      if ('values' in element) {
        for (const value of element.values) array[next++] = value;
        continue;
      }
      const { subscript, value } = element;
      const written = `[${subscript}]${element.append ? '+=' : '='}${value}`;
      const index = subscript === '' || subscript === '@' || subscript === '*' ? -1 : arrayIndex(array, await arithmeticValue(subscript, ctx));
      if (index < 0) {
        refused.push(`${written}: ${subscript === '@' || subscript === '*' ? 'cannot assign to non-numeric index' : 'bad array subscript'}`);
        if (this.config.options.errexit) break;
        continue;
      }
      array[index] = element.append ? (array[index] ?? '') + value : value;
      next = index + 1;
    }
    return { array, refused };
  }

  /** Bash's PIPESTATUS: `statuses`, its array alone. */
  private setPipestatus(statuses: readonly number[]): void {
    this.config.arrays.set('PIPESTATUS', statuses.map(String));
    delete this.config.env.PIPESTATUS;
  }

  /**
   * How many function calls may be running at once: FUNCNEST where it is a
   * number above 0, as bash reads it at each call (a `local FUNCNEST` included),
   * but never past MAX_FUNCTION_NESTING, which applies where it is not.
   */
  private functionNestingLimit(): number {
    const funcnest = this.config.env.FUNCNEST;
    const set = funcnest !== undefined && FUNCNEST_NUMBER.test(funcnest) ? Number.parseInt(funcnest, 10) : 0;
    return set > 0 ? Math.min(set, MAX_FUNCTION_NESTING) : MAX_FUNCTION_NESTING;
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
        for (const [name, saved] of frame) restoreVariable(this.config, name, saved);
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
    if (!frame.has(name)) frame.set(name, saveVariable(this.config, name));
    delete this.config.env[name];
    this.config.arrays.delete(name);
    return true;
  }

  async executeCapture(input: string, io: ExecutionIo = {}): Promise<CapturedCommand> {
    let captured = '';
    const capture = textCapture((text) => { captured += text; });

    const captureIo = this.createCommandIo(io);
    captureIo.stdout = capture.stream;
    captureIo.positionals = this.forkPositionals(io);
    // $( ) runs in a child shell, its capture its fd 1.
    const child = this.inTrapAction(this.fork());
    const exitCode = await child.finishChild(async () => {
      const inherited = child.dupChildFd(1, { output: capture.stream });
      if (inherited !== undefined) await child.release([inherited]);
      return (await child.executeLineWithIo(input, captureIo));
    }, captureIo);
    capture.end();

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
    const lines = this.linesOf(input);
    // A syntax error in the text read here is the runner's (TextSyntaxError); one met running it is not.
    const reader = {
      nextLine: (): ListNode[] | null => {
        try {
          return lines.nextLine();
        } catch (error) {
          if (error instanceof ParseError) throw new TextSyntaxError(error.message);
          throw error;
        }
      },
    };
    return (await this.executeScriptWithIo(reader, inlineIo, { readsLines: true, inline: true }));
  }

  private async executeLineWithIo(input: string, io: ExecutionIo, run: ScriptRun = {}): Promise<number> {
    return (await this.executeScriptWithIo(this.linesOf(input), io, run));
  }

  /**
   * A child shell's run and end: it holds the files its io inherited while it
   * runs, its EXIT trap runs, an `exit` inside it ends only it, and its
   * descriptors close.
   */
  private async finishChild(run: () => Promise<number>, io: ExecutionIo): Promise<number> {
    // The child's own dispatches, from none (its io is its own: each caller made it).
    io.dispatched = { shell: this, last: null };
    // Taken before the first await: a background child starts here while its
    // parent goes on to close what it opened.
    const inherited = [...(io.openFiles?.values() ?? [])];
    for (const file of inherited) file.refs++;
    try {
      let exitCode: number;
      try {
        exitCode = await run();
      } catch (e) {
        // An `exit` inside it ends only it; so do `set -e`, a fatal error and a discard.
        if (!(e instanceof ExitSignal) && !(e instanceof ErrexitSignal) && !(e instanceof DiscardSignal)) throw e;
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
    const savedTrapEntryStatus = this.trapEntryStatus;
    this.lastExitCode = exitCode;
    this.trapEntryStatus = exitCode;
    this.exitTrapDepth++;
    try {
      // Run as the shell's own text: an `exit` in it, or an end by `set -e`, is the shell's status.
      await this.executeLineWithIo(action, io, { readsLines: true, inline: true });
    } catch (e) {
      if (e instanceof ExitSignal || e instanceof ErrexitSignal) return e.exitCode;
      // A discard ends the action, a child shell's too; the status stays (bash 5.2).
      if (!(e instanceof DiscardSignal)) throw e;
    } finally {
      this.exitTrapDepth--;
      this.lastExitCode = savedLastExitCode;
      this.trapEntryStatus = savedTrapEntryStatus;
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
    else if (terminalStdin && !scriptMode) io.stdin = terminalStdin;
    if (terminalStdin) io.terminalStdin = terminalStdin;
    if (terminalFds) io.terminalFds = terminalFds;
    if (scriptMode) io.scriptMode = true;
    io.dispatched = { shell: this, last: null };
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
    if (io.background) next.background = true;
    if (io.scriptMode) next.scriptMode = true;
    if (io.dispatched) next.dispatched = io.dispatched;
    if (io.signal) next.signal = io.signal;
    if (io.positionals) next.positionals = io.positionals;
    if (io.commandContext) next.commandContext = io.commandContext;
    if (io.commandIdentity) next.commandIdentity = io.commandIdentity;
    if (io.workThread) next.workThread = io.workThread;
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
      readonlyNames: this.config.readonlyNames,
      positionals: this.readPositionals(io),
      warnings: [],
      lastExitCode: this.lastExitCode,
      cwd: this.config.getCwd(),
      vfs: io.vfs ?? this.config.vfs,
      options: this.config.options,
      executeCapture: async (input) => (await this.executeCapture(input, io)),
      // The shell's fd 2 when it is met, as a command's descriptors resolve it (createCommandFds).
      report: async (diagnostic) => {
        (await (this.persistentOutputFds.get(2) ?? io.stderr ?? this.terminalSink(io)).write(`${diagnostic}\n`));
      },
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
      terminalStdinFd(io, stdin),
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
      return (await this.withInstalledFds(fds, async () => (await execute(this.createIoFromFds(io, fds)))));
    }));
  }

  private async applyRedirections(
    redirections: RedirectionNode[],
    fds: FdState,
    expandCtx: ExpandContext,
    io: ExecutionIo,
    terminalStdin?: TerminalInputStream,
  ): Promise<void> {
    // A target's diagnostic goes to fd 2 as the redirections before it have left it.
    const targetCtx: ExpandContext = {
      ...expandCtx,
      report: async (diagnostic) => {
        (await (fds.outputFds.get(2) ?? this.createNullWriter()).write(`${diagnostic}\n`));
      },
    };
    for (const redir of redirections) {
      if (redir.operator === 'heredoc') {
        const heredoc = redir.heredoc ?? { body: '', quoted: false, stripTabs: false };
        const body = heredoc.quoted
          ? heredoc.body
          : await expandWord([{ text: heredoc.body, quoted: 'double' }], { ...targetCtx, hereDocument: true });
        this.setInputFd(fds, redir.fd ?? 0, { stream: staticStdinReader(body), terminal: false });
        continue;
      }

      const target = await expandWord(redir.target, targetCtx);
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

  /**
   * Run `body` with the descriptors `fds` changed (a compound command's, a
   * function call's, a builtin's redirections) in this shell's table, over
   * what `exec` left there, as bash applies a redirection; then put each back
   * as it was, whatever `body` did to it (an `exec` inside is undone with
   * the redirection, as bash undoes it). An installed descriptor holds a
   * reference on its file, as `exec`'s do, so one an inner `exec` copies
   * stays open; the reference each holds at the end is let go, and the
   * shadowed one, held all along, is put back.
   */
  private withInstalledFds<T>(fds: FdState, body: () => Promise<T>): Promise<T> {
    // Nothing to install (most function calls): `body`'s own promise, no step of its own.
    if (fds.changedOutputFds.size === 0 && fds.changedInputFds.size === 0) return body();
    return this.runInstalled(fds, body);
  }

  private async runInstalled<T>(fds: FdState, body: () => Promise<T>): Promise<T> {
    const outputs = [...fds.changedOutputFds].map((fd) => ({
      fd,
      stream: this.persistentOutputFds.get(fd),
      handle: this.persistentOutputHandles.get(fd),
      terminal: this.persistentTerminalOutputFds.has(fd),
    }));
    const inputs = [...fds.changedInputFds].map((fd) => ({
      fd,
      present: this.persistentInputFds.has(fd),
      stream: this.persistentInputFds.get(fd),
      handle: this.persistentInputHandles.get(fd),
      terminal: this.persistentTerminalInputFds.has(fd),
    }));
    // The files behind what is installed: the shadowed ones too (`2>&2` names fd 2's own file).
    const shadowed = [...outputs, ...inputs].flatMap(({ handle }) => (handle === undefined ? [] : [handle]));
    const fileOf = (stream: CommandInputStream | CommandOutputStream | undefined): OpenFile | undefined => (
      stream === undefined ? undefined : this.fileBehind(stream, fds, shadowed)
    );
    for (const { fd } of outputs) {
      const stream = fds.outputFds.get(fd);
      this.installOutputFd(fd, stream, fds.terminalOutputFds.has(fd));
      this.holdHandle(this.persistentOutputHandles, fd, fileOf(stream));
    }
    for (const { fd } of inputs) {
      const stream = fds.inputFds.get(fd);
      this.installInputFd(fd, fds.inputFds.has(fd), stream, fds.terminalInputFds.has(fd));
      this.holdHandle(this.persistentInputHandles, fd, fds.terminalInputFds.has(fd) ? undefined : fileOf(stream));
    }
    try {
      return (await body());
    } finally {
      const released: OpenFile[] = [];
      for (const saved of outputs) {
        const held = this.persistentOutputHandles.get(saved.fd);
        if (held !== undefined) released.push(held);
        this.installOutputFd(saved.fd, saved.stream, saved.terminal);
        this.holdHandle(this.persistentOutputHandles, saved.fd, saved.handle, false);
      }
      for (const saved of inputs) {
        const held = this.persistentInputHandles.get(saved.fd);
        if (held !== undefined) released.push(held);
        this.installInputFd(saved.fd, saved.present, saved.stream, saved.terminal);
        this.holdHandle(this.persistentInputHandles, saved.fd, saved.handle, false);
      }
      await this.release(released);
    }
  }

  /** `fd`'s handle in `handles`: `file` (a new reference on it, unless `take` is false: one held already), or none. */
  private holdHandle(handles: Map<number, OpenFile>, fd: number, file: OpenFile | undefined, take = true): void {
    if (file === undefined) return;
    if (take) file.refs++;
    handles.set(fd, file);
  }

  /**
   * A child's own descriptor `fd` (a pipe's end, a substitution's capture),
   * as dup2(2) makes it over what the child inherited: where `exec` left an
   * entry for it (otherwise the child's io already is the stream). The file
   * the entry held, if any, for the caller to let go.
   */
  private dupChildFd(fd: number, end: { readonly output: CommandOutputStream } | { readonly input: CommandInputStream }): OpenFile | undefined {
    const output = 'output' in end;
    if (!(output ? this.persistentOutputFds : this.persistentInputFds).has(fd)) return undefined;
    const held = (output ? this.persistentOutputHandles : this.persistentInputHandles).get(fd);
    if ('output' in end) this.installOutputFd(fd, end.output, false);
    else this.installInputFd(fd, true, end.input, false);
    return held;
  }

  /** Table entry `fd` for output: `stream`, or none (closed); its handle dropped from the table, not let go (the caller's). */
  private installOutputFd(fd: number, stream: CommandOutputStream | undefined, terminal: boolean): void {
    if (stream) this.persistentOutputFds.set(fd, stream);
    else this.persistentOutputFds.delete(fd);
    this.persistentOutputHandles.delete(fd);
    setMembership(this.persistentTerminalOutputFds, fd, terminal);
  }

  /** Table entry `fd` for input, as persistFdState keeps one: present (a terminal's with no stream), or none. */
  private installInputFd(fd: number, present: boolean, stream: CommandInputStream | undefined, terminal: boolean): void {
    if (present) this.persistentInputFds.set(fd, terminal ? undefined : stream);
    else this.persistentInputFds.delete(fd);
    this.persistentInputHandles.delete(fd);
    setMembership(this.persistentTerminalInputFds, fd, terminal);
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
  /**
   * The open file behind `stream`: one a descriptor of the table holds, or
   * one in `held` (references just taken out of it), or one the command's
   * redirections opened, or one an enclosing redirection holds.
   */
  private fileBehind(stream: CommandInputStream | CommandOutputStream, fds: FdState, held: readonly OpenFile[]): OpenFile | undefined {
    return [...this.persistentHandles(), ...held].find((open) => open.stream === stream)
      ?? fds.opened.get(stream)
      ?? fds.enclosing.get(stream);
  }

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
    const file = this.fileBehind(stream, fds, released);
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
    const targetPath = operandPath(this.config.getCwd(), target);
    const vfs = io.vfs ?? this.config.vfs;
    try {
      // Each call is made again once a delegation it meets is recalled
      // (withRecall): a redirection into a subtree a process holds waits for
      // it, as any caller that can wait does. What it changes ahead of a
      // reader's recall is published by the time the command ends (`held`).
      const bridge = vfs.process;
      const held = new Set<Promise<void>>();
      const handle = await withRecall(() => bridge.open(targetPath, { write: true, create: true, append: mode === 'append', truncate: mode === 'write' }), undefined, held);
      const push = async (bytes: Uint8Array) => {
        let offset = 0;
        while (offset < bytes.length) {
          const written = await withRecall(() => bridge.write(handle.id, null, bytes.subarray(offset)), undefined, held);
          if (written <= 0 || written > bytes.length - offset) throw new Error('EIO: invalid redirection write length');
          offset += written;
        }
      };
      const stream: CommandOutputStream = { write: text => push(encode(text)), writeBytes: push };
      fds.opened.set(stream, {
        stream,
        // What the VFS still holds for the file is written as the command
        // whose redirection opened it ends (flushFds), and a failure is its.
        flush: async () => {
          await withRecall(() => bridge.fsync(handle.id), undefined, held);
          await Promise.all(held);
        },
        close: async () => {
          await bridge.close(handle.id);
          await Promise.all(held);
        },
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
    const targetPath = operandPath(this.config.getCwd(), target);
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
      const handle = await withRecall(() => bridge.open(targetPath, { read: true }));
      const stream = this.createFileReader(vfs, targetPath, (offset, length) => withRecall(() => bridge.read(handle.id, offset, length)), true);
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
    // A redirected file is read as its bytes: a leading U+FEFF stays.
    const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
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

  /** bash's report_error: under `set -e`, an error the shell reports ends it, wherever it is (an `if`'s condition too). */
  private exitOnReportedError(): void {
    if (this.config.options.errexit) throw new ErrexitSignal(1);
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

function isFatalSpecialBuiltin(name: string): boolean {
  switch (name) {
    case ':':
    case '.':
    // bash's source_builtin is `.`'s: either name fails alike.
    case 'source':
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
