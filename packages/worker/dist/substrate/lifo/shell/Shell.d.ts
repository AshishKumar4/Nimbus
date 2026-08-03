import type { ITerminal } from '../terminal/ITerminal.js';
import type { VFS } from '../kernel/vfs/index.js';
import type { CommandRegistry } from '../commands/registry.js';
import type { CommandRunAsHost } from '../commands/types.js';
import type { VfsCred } from '../../../runtime/os-contracts.js';
import type { TerminalInputStream } from '../commands/types.js';
import { type ShellOptions, type TerminalFdState } from './interpreter.js';
import { JobTable } from './jobs.js';
import { ProcessRegistry } from './ProcessRegistry.js';
export declare function formatShellPrompt(env: Record<string, string>, cwd: string): string;
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
export declare class Shell {
    private terminal;
    private vfs;
    private registry;
    cwd: string;
    env: Record<string, string>;
    private aliases;
    lineBuffer: string;
    cursorPos: number;
    screenCursorRow: number;
    history: string[];
    historyIndex: number;
    private savedLine;
    running: boolean;
    private abortController;
    private terminalStdin;
    private stdinLineBuffer;
    private stdinCursorPos;
    private interpreter;
    private interpreterConfig;
    private historyManager;
    private jobTable;
    private processRegistry;
    private builtins;
    private shellOptions;
    private traps;
    private readonlyNames;
    private commandIdentity;
    private tabCount;
    pasteQueue: string[];
    /**
     * Keystrokes that arrived while a foreground command owned the terminal and
     * nothing was reading stdin. A tty buffers type-ahead and hands it to the
     * shell when the job exits; dropping it loses whatever the user typed, and
     * when a dispatch never settles it leaves that connection with no feedback
     * whatsoever. Held as whole chunks so a multi-byte escape sequence replays
     * as one keystroke rather than three.
     */
    typeAhead: string[];
    constructor(terminal: ITerminal, vfs: VFS, registry: CommandRegistry, env: Record<string, string>, processRegistry: ProcessRegistry, commandIdentity?: ShellCommandIdentity);
    private registerBuiltins;
    getJobTable(): JobTable;
    getProcessRegistry(): ProcessRegistry;
    getCwd(): string;
    setCwd(cwd: string): void;
    getEnv(): Record<string, string>;
    getVfs(): VFS;
    getRegistry(): CommandRegistry;
    /**
     * Programmatic command execution with captured stdout/stderr.
     * Used by Sandbox.commands.run() for headless mode.
     */
    private _executeDepth;
    execute(cmd: string, options?: ExecuteOptions): Promise<{
        stdout: string;
        stderr: string;
        exitCode: number;
    }>;
    private resolveCommandIdentity;
    start(): void;
    private sourceRcFiles;
    printPrompt(): void;
    handleInput(data: string): void;
    private handleTab;
    private handleStdinInput;
    private applyCompletion;
    private getPromptWidth;
    redrawLine(): void;
    /**
     * Replay buffered type-ahead through the line editor. Stops the moment a
     * replayed keystroke starts a command: the rest stays queued and is
     * delivered when that one settles, so a queued line is never fed into a
     * shell that is busy again.
     */
    drainTypeAhead(): void;
    drainPasteQueue(): void;
    private moveCursorLeft;
    private moveCursorRight;
    private moveCursorHome;
    private moveCursorEnd;
    private historyUp;
    private historyDown;
    executeLine(line: string): Promise<void>;
    private builtinCd;
    private builtinPwd;
    private builtinEcho;
    private builtinClear;
    private builtinExport;
    private builtinSet;
    private builtinShift;
    private builtinTrap;
    private builtinHash;
    private printShellOptions;
    private setShellOptionByName;
    private setShellOptionByFlag;
    private setPositionals;
    private currentPositionals;
    private builtinReadonly;
    private builtinRead;
    private builtinWait;
    private resolveWaitTarget;
    private builtinUnset;
    private assignEnv;
    private snapshotShellState;
    private restoreShellState;
    private builtinExit;
    private builtinJobs;
    private builtinFg;
    private builtinBg;
    private builtinHistory;
    sourceFile(path: string): Promise<void>;
    private builtinSource;
    private builtinAlias;
    private builtinUnalias;
    private writeToTerminal;
}
//# sourceMappingURL=Shell.d.ts.map