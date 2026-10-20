import type { CompoundCommandNode } from './types.js';
import { ProcessView } from '../../../runtime/process-files.js';
import type { NimbusFilesystemAuthority } from '../../../runtime/os-contracts.js';
import { type CommandRegistry } from '../commands/registry.js';
import type { ChildExit, CommandOutputStream, CommandInputStream, CommandRunAsHost, TerminalInputStream } from '../commands/types.js';
import type { VfsCred } from '../../../runtime/os-contracts.js';
import { type CapturedCommand } from './expander.js';
import { type ArrayLiteral } from './variables.js';
import { type ShellState } from './state.js';
import { WorkThread } from './work-thread.js';
import { DiscardSignal } from './discard.js';
export declare class BreakSignal {
    levels: number;
    constructor(levels: number);
}
export declare class ContinueSignal {
    levels: number;
    constructor(levels: number);
}
export declare class ReturnSignal {
    exitCode: number;
    constructor(exitCode: number);
}
export declare class ErrexitSignal {
    exitCode: number;
    constructor(exitCode: number);
}
export declare class ExitSignal {
    exitCode: number;
    constructor(exitCode: number);
}
/** A syntax error in the text eval or `.` reads (not one met running it, a command substitution's): theirs to answer. */
export declare class TextSyntaxError extends Error {
}
/** A function call past the nesting bound (functionNestingLimit). */
export declare class FunctionNestingSignal extends DiscardSignal {
}
/**
 * A command of assignments alone that could not assign (a readonly name, a
 * bad array subscript), as bash's expand_word_list_internal discards it.
 */
export declare class AssignmentErrorSignal extends DiscardSignal {
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
export type BuiltinFn = (args: string[], stdout: CommandOutputStream, stderr: CommandOutputStream, stdin: CommandInputStream | undefined, context: BuiltinExecutionContext) => Promise<number>;
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
    dispatched?: {
        readonly shell: Interpreter;
        last: string | null;
    };
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
export type TerminalFdState = {
    stdin?: boolean;
    stdout?: boolean;
    stderr?: boolean;
};
type PositionalFrame = {
    args: string[];
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
export declare class Interpreter {
    private config;
    private lastExitCode;
    private functions;
    private persistentOutputFds;
    private persistentInputFds;
    private persistentTerminalOutputFds;
    private persistentTerminalInputFds;
    /** Bridge handles held open past the `exec` that opened them, by descriptor. */
    private persistentOutputHandles;
    private persistentInputHandles;
    private errexitSuppressionDepth;
    private exitTrapDepth;
    /** While the EXIT trap's action runs: the status the shell was ending with, a bare `exit`'s there. */
    private trapEntryStatus;
    /** One frame per running function call, holding the bindings `local` shadowed. */
    private localFrames;
    /** A child shell (fork): a discarded line ends it (finishChild). */
    private child;
    constructor(config: InterpreterConfig);
    /** The functions this shell defines, for a run whose own definitions must not outlast it (restoreFunctions). */
    saveFunctions(): FunctionTable;
    restoreFunctions(saved: FunctionTable): void;
    /**
     * A child shell, as fork(2) makes one: its own copy of the shell's state
     * (forkShellState) and of its functions, $? and open descriptors, so
     * nothing it changes reaches this shell. Shared: the filesystem, command
     * registry and terminal; `$$` stays this shell's. The child runs its own
     * EXIT trap when it finishes (`finishChild`).
     */
    fork(): Interpreter;
    /**
     * `child`, forked for a substitution or a simple command (a pipeline's
     * element, a job), runs inside the EXIT trap's action still: a bare `exit`
     * there ends with the trap's entry status, and an EXIT trap set there does
     * not run. bash keeps running_trap for these, and clears it in the
     * subshell of a compound command, `( … )` among them.
     */
    private inTrapAction;
    getLastExitCode(): number;
    setLastExitCode(exitCode: number): void;
    /** `input`'s lines, read as they run: the aliases defined when each is read are expanded in it. */
    private linesOf;
    /**
     * Runs `script`'s lists. As lines a shell reads (`readsLines`: its own,
     * a sourced file's, a trap's; not an alias's text, which is part of the
     * line it is in), a line a nested call discards ends, and the next runs
     * with $? 1, in a shell that is no child: a child's ends (finishChild).
     * Text run `inline` (eval's, a sourced file's, an alias's) leaves an `exit`,
     * and an end by `set -e` or a fatal error, to the shell that runs it.
     */
    private executeScriptWithIo;
    executeLine(input: string, terminalStdin?: TerminalInputStream, options?: {
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
    }): Promise<number>;
    private executeList;
    private getListCommandText;
    private executeListEntries;
    private executePipeline;
    private executePipelineCommands;
    private executeCommand;
    private executeIf;
    private executeDoubleBracket;
    private loopTicks;
    /**
     * A loop whose body never waits on I/O would run entirely on microtasks,
     * and no timer, Ctrl-C or `kill` could reach it. Every 64 iterations it
     * lets the event loop run. (Counted, not timed: workerd's clock stands
     * still while code runs.)
     */
    private loopTick;
    private executeFor;
    private executeLoop;
    private executeCase;
    private executeFunctionDef;
    private executeGroup;
    private executeSubshell;
    private executeCompoundList;
    private executeSimpleCommand;
    /**
     * execvp(3) of `argv`: argv[0] is found as a program is found (the
     * registry, then a path from `spec.cwd`), never as a function, an alias or
     * a builtin, and runs as a process on the streams it is handed. A program
     * that is not there is ENOENT, as execvp fails, for the caller to report.
     * One whose write finds its reader gone ends there, by SIGPIPE, and its
     * caller goes on, as the parent of a process SIGPIPE kills does.
     */
    runProgram(argv: readonly string[], spec: ProgramSpec): Promise<ChildExit>;
    /**
     * A resolved command, run as the process `spec.identity` names: aborted
     * with `spec.signal`, and its failure (a closed pipe, an abort, a throw)
     * turned into the status a process would end with.
     */
    private runCommand;
    private assignEnv;
    /**
     * `name=value`, `name+=value`, `name[expr]=value` and `name=(element …)`.
     * Returns the diagnostics for the caller to report, in order, and whether
     * the assignment failed: a readonly name, or a subscript before the first
     * element (bash's bad array subscript). An array literal's refused
     * elements are reported, and the rest of it is assigned.
     */
    private applyAssignment;
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
    private arrayLiteral;
    /** Bash's PIPESTATUS: `statuses`, its array alone. */
    private setPipestatus;
    /**
     * How many function calls may be running at once: FUNCNEST where it is a
     * number above 0, as bash reads it at each call (a `local FUNCNEST` included),
     * but never past MAX_FUNCTION_NESTING, which applies where it is not.
     */
    private functionNestingLimit;
    private executeFunction;
    /**
     * Bind a name to the running function, unset, so an assignment to it does
     * not outlive the call. Shell variables are dynamically scoped, so a callee
     * still sees its caller's locals — which is what bash does. Returns false
     * outside a function, where `local` is an error.
     */
    private declareLocal;
    executeCapture(input: string, io?: ExecutionIo): Promise<CapturedCommand>;
    private executeInline;
    private executeLineWithIo;
    /**
     * A child shell's run and end: it holds the files its io inherited while it
     * runs, its EXIT trap runs, an `exit` inside it ends only it, and its
     * descriptors close.
     */
    private finishChild;
    private runExitTrap;
    private createTerminalIo;
    private createCommandIo;
    /** Per-execution direct-terminal write, isolated from a nested capture. */
    private writeTerminal;
    /** Late-bound fallback sink for command stdout/stderr with no fd target. */
    private terminalSink;
    private forkPositionals;
    private createExpandContext;
    private createIoFromFds;
    private readPositionals;
    private writePositionals;
    private createCommandFds;
    private executeWithRedirections;
    private applyRedirections;
    private persistFdState;
    /**
     * The shell's end: its descriptors close, as a process's do at exit(2). A
     * file closes with them unless something else still holds it.
     */
    closeDescriptors(): Promise<void>;
    /** Empty the descriptor table, returning one file per descriptor it held. */
    private takeDescriptors;
    /** Let go of one reference per entry; a file nothing holds any more closes. */
    private release;
    /** One entry per descriptor, so a file `exec 4>&3` shares appears twice. */
    private persistentHandles;
    /**
     * Point a descriptor `exec` keeps past its command at `stream`, holding a
     * reference on the file behind it: one this `exec` opened, one an enclosing
     * redirection holds (`{ exec 3>&1; } >f`), or one another descriptor names
     * (`exec 4>&3`). The file it named before goes to `released`.
     */
    private repointPersistentHandle;
    private setOutputFd;
    private setInputFd;
    private dupOutputFd;
    private dupInputFd;
    private openOutputTarget;
    private openInputTarget;
    /**
     * Run `body`, whose answer is an exit status, and end its descriptors
     * (flushFds) whether it returned or threw. A file it wrote that could not
     * be written fails it: status 1 where it would have been 0.
     */
    private withFdFlush;
    /**
     * End a command's descriptors: flush its output streams, and write what
     * each file its redirections opened still holds (the VFS may hold a
     * file's last appends until fsync), then let go of those files. A write
     * that fails there is the command's failure, not the shell's: it is
     * reported on the command's stderr, as `name`'s, and the answer is true,
     * for the command's status. A close that fails still throws.
     */
    private flushFds;
    /**
     * Byte-faithful redirected input: bounded range reads keep >64 KiB
     * redirections intact and preserve bytes that are not valid UTF-8, while
     * the text view still decodes progressively across chunk boundaries.
     *
     * Only a zero-length range means EOF. Devices and some mounts answer with
     * fewer bytes than asked whenever their internal bound is hit; those short
     * nonempty reads advance the offset and continue, exactly like read(2).
     */
    private createFileReader;
    private resolveOutputFd;
    private resolveInputFd;
    private parseFdTarget;
    private createNullWriter;
    private createEmptyReader;
    private isFdTerminal;
    /** bash's report_error: under `set -e`, an error the shell reports ends it, wherever it is (an `if`'s condition too). */
    private exitOnReportedError;
    private enforceErrexit;
    private withErrexitSuppressed;
    private abortExitCode;
}
export {};
//# sourceMappingURL=interpreter.d.ts.map