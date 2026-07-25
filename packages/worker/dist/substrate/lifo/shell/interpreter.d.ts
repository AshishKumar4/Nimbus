import type { ScriptNode } from './types.js';
import type { VFS } from '../kernel/vfs/index.js';
import type { CommandRegistry } from '../commands/registry.js';
import type { CommandOutputStream, CommandInputStream, CommandRunAsHost, TerminalInputStream } from '../commands/types.js';
import type { VfsCred } from '../../../runtime/os-contracts.js';
import { JobTable } from './jobs.js';
import { ProcessRegistry } from './ProcessRegistry.js';
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
export type BuiltinFn = (args: string[], stdout: CommandOutputStream, stderr: CommandOutputStream, stdin?: CommandInputStream, context?: BuiltinExecutionContext) => Promise<number>;
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
export declare class Interpreter {
    private config;
    private lastExitCode;
    private functions;
    private persistentOutputFds;
    private persistentInputFds;
    private persistentTerminalOutputFds;
    private persistentTerminalInputFds;
    private errexitSuppressionDepth;
    private exitTrapDepth;
    constructor(config: InterpreterConfig);
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
        commandIdentity?: {
            pid: number;
            cred: VfsCred;
            setUmask(mask: number): void;
        };
        runAs?: CommandRunAsHost;
    }): Promise<number>;
    private executeList;
    private getListCommandText;
    private executeListEntries;
    private executePipeline;
    private executePipelineCommands;
    private executeCommand;
    private executeIf;
    private executeDoubleBracket;
    private executeFor;
    private executeWhile;
    private executeUntil;
    private executeCase;
    private executeFunctionDef;
    private executeGroup;
    private executeSubshell;
    private executeCompoundList;
    private executeSimpleCommand;
    private assignEnv;
    private executeFunction;
    executeCapture(input: string, io?: ExecutionIo): Promise<string>;
    private executeInline;
    private executeLineWithIo;
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
    private setOutputFd;
    private setInputFd;
    private dupOutputFd;
    private dupInputFd;
    private openOutputTarget;
    private openInputTarget;
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
    private createFileWriter;
    /**
     * Run `body` and commit every file-backed descriptor it wrote through,
     * whether it returned or threw. This is the close(2) side of the buffering
     * in createFileWriter: buffered bytes must reach the store before the next
     * command can read the file.
     */
    private withFdFlush;
    private flushFds;
    private createFileReader;
    private createStringReader;
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