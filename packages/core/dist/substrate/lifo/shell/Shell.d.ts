import type { ITerminal } from '../terminal/ITerminal.js';
import { ProcessView } from '../../../runtime/process-files.js';
import type { CommandRegistry } from '../commands/registry.js';
import type { CommandInputStream } from '../commands/types.js';
import type { ChildExit, CommandRunAsHost } from '../commands/types.js';
import { type NimbusFilesystemAuthority, type VfsCred } from '../../../runtime/os-contracts.js';
import type { TerminalInputStream } from '../commands/types.js';
import { type ProgramSpec, type TerminalFdState } from './interpreter.js';
import { type ShellOptions } from './state.js';
import { JobTable } from './jobs.js';
import { ProcessRegistry } from './ProcessRegistry.js';
import type { HostProcessSignals } from '../commands/system/kill.js';
import { ShellInputSubmission, type ShellQueuedInput } from '../../../shell/input-submission.js';
import type { ProcessExitNotice, ProcessExitNoticeSource } from '../../../runtime/process-exit-notices.js';
export declare function formatShellPrompt(env: Record<string, string>, cwd: string): string;
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
    /**
     * A line this shell runs on process `pid`'s descriptors, until the
     * returned function is called: `stop` ends it (SessionProcessSupervisor
     * holdWork). What the pid bound is released after the line has closed
     * what it opened, however the process ends.
     */
    holdWork?(pid: number, stop: () => void): () => void;
}
export declare class Shell {
    readonly filesystem: NimbusFilesystemAuthority;
    private terminal;
    private get vfs();
    private registry;
    /** The shell's own state (state.ts): what its builtins act on, and its child shells copy. */
    private readonly state;
    lineBuffer: string;
    cursorPos: number;
    screenCursorRow: number;
    /** Where Up/Down stands in the history: -1 is the line being typed. */
    historyIndex: number;
    private savedLine;
    running: boolean;
    private abortController;
    private terminalStdin;
    private stdinLineBuffer;
    private stdinCursorPos;
    private interpreter;
    private historyManager;
    private processRegistry;
    /** The host's own processes, which `kill` reaches by pid (see setHostProcessSignals). */
    private hostProcessSignals;
    private builtins;
    private commandIdentity;
    private tabCount;
    pasteQueue: ShellQueuedInput[];
    private lineSubmission;
    private activeInput;
    private lineInputs;
    private promptMode;
    private readonly exitNotices;
    private exitNoticeSource;
    private renderExitNotice;
    /**
     * Accepted lines that do not form a complete command yet: an unclosed
     * quote or a trailing `\` keeps the shell reading under PS2, as bash
     * does, instead of executing a truncated command.
     */
    private pendingLine;
    /**
     * Keystrokes that arrived while a foreground command owned the terminal and
     * nothing was reading stdin. A tty buffers type-ahead and hands it to the
     * shell when the job exits; dropping it loses whatever the user typed, and
     * when a dispatch never settles it leaves that connection with no feedback
     * whatsoever. Held as whole chunks so a multi-byte escape sequence replays
     * as one keystroke rather than three.
     */
    typeAhead: ShellQueuedInput[];
    constructor(terminal: ITerminal, filesystem: NimbusFilesystemAuthority, registry: CommandRegistry, env: Record<string, string>, processRegistry: ProcessRegistry, commandIdentity?: ShellCommandIdentity);
    /**
     * The command history, oldest first: the one store (HistoryManager, kept
     * in ~/.bash_history) that Up/Down, reverse search, Alt+. and the history
     * builtin all read, each line as it ran (after `!` expansion).
     */
    get history(): readonly string[];
    /** The names this shell runs itself, as help and completion list them. */
    builtinNames(): string[];
    getJobTable(): JobTable;
    /**
     * Let `kill` signal the host's processes: a numeric pid this shell's own
     * registry does not hold is handed to `host`. Child-shell views read the
     * shell they were forked from.
     */
    setHostProcessSignals(host: HostProcessSignals): void;
    /** The host processes `kill` reaches, for a shell built alongside this one. */
    getHostProcessSignals(): HostProcessSignals | undefined;
    getProcessRegistry(): ProcessRegistry;
    getCwd(): string;
    setCwd(cwd: string): void;
    getEnv(): Record<string, string>;
    getVfs(): ProcessView;
    /** Transfer terminal I/O without replacing shell state or sourcing login files. */
    bindTerminal(terminal: ITerminal): void;
    takeQueuedInput(): string[];
    queuePasteInput(data: string, submission?: ShellInputSubmission): void;
    rejectQueuedInput(): void;
    private bindTerminalInput;
    /**
     * The `runAs` host this shell re-credentials through. A caller building a
     * second Shell over the same kernel needs it, or its commands lose the
     * identity-transition path `sudo` and `su` are dispatched on.
     */
    getRunAsHost(): CommandRunAsHost | undefined;
    getRegistry(): CommandRegistry;
    /** execvp(3) of `argv` as a process of this shell's kernel (Interpreter.runProgram). */
    runProgram(argv: readonly string[], spec: ProgramSpec): Promise<ChildExit>;
    /**
     * End a shell that is done: the descriptors an `exec` left open close, as a
     * process's do when it exits. A shell built for one call ends with it.
     */
    closeDescriptors(): Promise<void>;
    /**
     * Programmatic command execution. Each stream goes to its sink when one is
     * given, and is otherwise captured into the result; never both, so a
     * streaming caller's output is not also held for the length of the command.
     */
    private _executeDepth;
    execute(cmd: string, options?: ExecuteOptions): Promise<{
        stdout: string;
        stderr: string;
        exitCode: number;
    }>;
    private resolveCommandIdentity;
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
    start(): Promise<void>;
    private sourceRcFiles;
    printPrompt(): void;
    /** A newly attached client learns current readiness, never a replayed completion. */
    announcePrompt(): void;
    printContinuationPrompt(): void;
    queueProcessExitNotice(notice: ProcessExitNotice, source: ProcessExitNoticeSource, render: (notice: ProcessExitNotice, source: ProcessExitNoticeSource) => string): boolean;
    handleInput(data: string, submission?: ShellInputSubmission): Promise<void>;
    private handleTab;
    private handleStdinInput;
    private applyCompletion;
    private getPromptWidth;
    /**
     * An asynchronous notice. While a command runs it is ordinary output; at an
     * idle prompt it goes above the prompt, which is redrawn with the line being
     * edited, so the prompt stays the last thing on screen.
     */
    writeNotice(text: string): void;
    redrawLine(): void;
    /**
     * Replay buffered type-ahead through the line editor. Stops the moment a
     * replayed keystroke starts a command: the rest stays queued and is
     * delivered when that one settles, so a queued line is never fed into a
     * shell that is busy again.
     */
    drainTypeAhead(): Promise<void>;
    drainPasteQueue(): Promise<void>;
    private moveCursorLeft;
    private moveCursorRight;
    private moveCursorHome;
    private moveCursorEnd;
    private historyUp;
    private historyDown;
    /**
     * A line the user finished with Enter. If it leaves a quote open or ends
     * in a line continuation it is not a command yet: bash buffers it, shows
     * PS2 and keeps reading, and so does this shell. A `\<newline>` join drops
     * both characters; a quoted join keeps the newline in the string.
     */
    private acceptLine;
    executeLine(line: string, submission?: ShellInputSubmission | undefined): Promise<void>;
    private consumeQueuedStdin;
    sourceFile(path: string): Promise<void>;
    private writeToTerminal;
}
//# sourceMappingURL=Shell.d.ts.map