/**
 * A program start (Kinu ask 66): what a mount's exec delegate, the session's
 * argv exec and node's child_process share. A program is started by its
 * argv, as execvp(3) starts one, never by shell text; it ends as waitpid(2)
 * reports, with an exit code or the signal that ended it.
 */
import type { ExecChunk } from './exec-stream.js';
/** What execve(2) is handed, and fd 0. */
export interface Program {
    /** execvp(3)'s: argv[0] is looked up on PATH unless it names a path. */
    readonly argv: readonly string[];
    /** execve(2)'s envp. */
    readonly env: Readonly<Record<string, string>>;
    /** A delegate's, in its mount's own terms. */
    readonly cwd: string;
    /** fd 0's bytes, in order, to their end (the program's EOF); null when fd 0 is closed. */
    readonly stdin: ReadableStream<Uint8Array> | null;
}
/** waitpid(2)'s answer: an exit code, or the signal (`SIGTERM`) that ended the program. */
export type ExitStatus = {
    readonly code: number;
    readonly signal: null;
} | {
    readonly code: null;
    readonly signal: string;
};
export interface StartedProgram {
    readonly output: ReadableStream<ExecChunk>;
    readonly exit: Promise<ExitStatus>;
    /** `signal` (`SIGINT`, `SIGTERM`, `SIGKILL`, …) sent to the program. */
    kill(signal: string): void;
}
/**
 * Where programs whose cwd is under a mount run (MountOptions.exec): the
 * machine the mount's files live on.
 * - `start` resolves once the program is running there, and only then. It
 *   rejects with an Error whose `code` is an errno name when the program
 *   could not start; nothing ran.
 * - `cancel` aborted while `start` is pending either rejects it ECANCELED,
 *   nothing having run, or resolves it with the program sent SIGKILL. After
 *   `start` resolves, signals go through `kill`.
 * - `locate` answers the path execvp would run for `name` (PATH in `env`,
 *   relative to `cwd`), or null: external programs only, never a builtin or
 *   a function of a shell on the machine.
 */
export interface ExecDelegate {
    start(program: Program, cancel: AbortSignal): Promise<StartedProgram>;
    locate(name: string, cwd: string, env: Readonly<Record<string, string>>): Promise<string | null>;
}
/**
 * Where a program starting with its cwd at a name runs: here, on the
 * machine of the mount the cwd is in (`cwd` in the mount's terms), or
 * nowhere while that mount is absent (its reason).
 */
export type ProgramPlacement = {
    readonly kind: 'local';
} | {
    readonly kind: 'delegated';
    readonly delegate: ExecDelegate;
    readonly cwd: string;
} | {
    readonly kind: 'absent';
    readonly reason: string;
};
export declare const LOCAL_PLACEMENT: ProgramPlacement;
//# sourceMappingURL=program-start.d.ts.map