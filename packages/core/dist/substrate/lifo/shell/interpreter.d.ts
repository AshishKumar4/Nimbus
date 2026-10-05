import type { ScriptNode, CompoundCommandNode } from './types.js';
import { ProcessView } from '../../../runtime/process-files.js';
import type { NimbusFilesystemAuthority } from '../../../runtime/os-contracts.js';
import { type CommandRegistry } from '../commands/registry.js';
import type { ChildExit, CommandOutputStream, CommandInputStream, CommandRunAsHost, TerminalInputStream } from '../commands/types.js';
import type { VfsCred } from '../../../runtime/os-contracts.js';
import { type CapturedCommand } from './expander.js';
import { JobTable } from './jobs.js';
import { ProcessRegistry } from './ProcessRegistry.js';
import { WorkThread } from './work-thread.js';
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
export type BuiltinFn = (args: string[], stdout: CommandOutputStream, stderr: CommandOutputStream, stdin?: CommandInputStream, context?: BuiltinExecutionContext) => Promise<number>;
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
    terminalStdin?: TerminalInputStream;
    terminalFds?: TerminalFdState;
    scriptMode?: boolean;
    signal?: AbortSignal;
    registerProcess?: boolean;
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
export declare function assignScalar(env: Record<string, string>, arrays: Map<string, (string | undefined)[]>, name: string, value: string): void;
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
    /** One frame per running function call, holding the bindings `local` shadowed. */
    private localFrames;
    constructor(config: InterpreterConfig);
    /** The functions this shell defines, for a run whose own definitions must not outlast it (restoreFunctions). */
    saveFunctions(): FunctionTable;
    restoreFunctions(saved: FunctionTable): void;
    /**
     * A child shell, as fork(2) makes one: its own copy of every piece of shell
     * state (variables and arrays, cwd, options, traps, readonly names,
     * aliases, functions, $?, the open descriptors), so nothing it changes
     * reaches this shell. Shared: the process registry and filesystem,
     * command registry and terminal; `$$` stays this shell's. Traps reset to
     * the default, except ignored ones, and the child runs its own EXIT trap
     * when it finishes (`finishChild`).
     */
    fork(): Interpreter;
    getLastExitCode(): number;
    executeScript(script: ScriptNode, terminalStdin?: TerminalInputStream): Promise<number>;
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
    private executeWhile;
    private executeUntil;
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
     * A resolved command, run as a process of this shell's: listed for ps,
     * jobs and kill while it runs, aborted with `spec.signal`, and its failure
     * (a closed pipe, an abort, a throw) turned into the status a process
     * would end with.
     */
    private runCommand;
    private assignEnv;
    /**
     * `name=value`, `name+=value`, `name[expr]=value` and `name=(word …)`.
     * Returns false when the name is readonly, which the caller reports.
     */
    private applyAssignment;
    /** One variable's whole binding, so a scope can put it back exactly. */
    private saveVariable;
    private restoreVariable;
    /** The array behind a subscripted assignment, promoting a scalar if needed. */
    private arrayFor;
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
    private enforceErrexit;
    private withErrexitSuppressed;
    private abortExitCode;
}
export {};
//# sourceMappingURL=interpreter.d.ts.map