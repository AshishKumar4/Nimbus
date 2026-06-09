import type { ScriptNode } from './types.js';
import type { VFS } from '../kernel/vfs/index.js';
import type { CommandRegistry } from '../commands/registry.js';
import type { CommandOutputStream, CommandInputStream, TerminalInputStream } from '../commands/types.js';
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
    terminalStdin?: TerminalInputStream;
    terminalFds?: TerminalFdState;
    scriptMode?: boolean;
    signal?: AbortSignal;
    registerProcess?: boolean;
    positionals?: PositionalFrame;
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
    /** Override default stdout for programmatic capture */
    defaultStdout?: CommandOutputStream;
    /** Override default stderr for programmatic capture */
    defaultStderr?: CommandOutputStream;
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
        terminalFds?: TerminalFdState;
        scriptMode?: boolean;
    }): Promise<number>;
    private executeList;
    private getListCommandText;
    private executeListEntries;
    private executePipeline;
    private executePipelineCommands;
    private executeCommand;
    private executeIf;
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
    private createFileWriter;
    private createFileAppender;
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