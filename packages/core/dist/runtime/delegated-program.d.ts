/**
 * A program placed on a mount's machine (ProgramPlacement 'delegated'), run
 * over a command's streams: what the shell, execvp's callers and a node
 * child's host share.
 */
import type { CommandInputStream } from '../substrate/lifo/commands/types.js';
import { type ExecDelegate, type ExitStatus, type StartedProgram } from './program-start.js';
import type { NimbusFilesystemAuthority, VfsCred } from './os-contracts.js';
/**
 * A start that did not run: the delegate refused it (execve's failure, by
 * its errno name: `ENOENT`, `EHOSTDOWN`), or the caller's stop came while it
 * was pending (`ECANCELED`, whichever way the delegate settled it).
 */
export declare class ProgramRefusal extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
/** Where the program's streams go and come from. Each write's wait is the program's. */
export interface DelegatedStreams {
    /** fd 0, read as the program reads it; null when it has none. */
    readonly stdin: CommandInputStream | null;
    stdout(bytes: Uint8Array): Promise<void>;
    stderr(bytes: Uint8Array): Promise<void>;
}
/**
 * `argv` started by `delegate` from `cwd` (its mount's terms) with `env`,
 * and run to its end: its exit as waitpid reports it.
 * - A start the delegate refuses throws ProgramRefusal; nothing ran.
 * - `cancel` is the caller's stop: before the start, the delegate's own
 *   cancellation, and ProgramRefusal ECANCELED however the delegate settles
 *   it; after it, the signal its reason names (`SIGINT` for Ctrl-C), sent
 *   to the program, which ends as it decides.
 * - A write its reader refuses (a closed pipe) is SIGPIPE to the program,
 *   as a write to a pipe with no reader is, and its output is not read on.
 *   Any other failed write ends the program (SIGKILL) before it is thrown:
 *   nothing runs on that its caller has given up.
 * - `onStarted` hears of the start, for a caller with its own signals to send.
 */
export declare function runDelegatedProgram(delegate: ExecDelegate, program: {
    readonly argv: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    readonly cwd: string;
}, streams: DelegatedStreams, cancel: AbortSignal, onStarted?: (started: StartedProgram) => void): Promise<ExitStatus>;
/**
 * Where a program `name` started from `cwd` by a process of `cred` would be
 * found, when the cwd's mount runs programs on its own machine: its path
 * there, or null (none there, or the mount absent). Undefined: it would
 * start here (CommandContext.locateProgram, hash).
 */
export declare function locatePlacedProgram(filesystem: NimbusFilesystemAuthority, cred: Readonly<VfsCred>, name: string, cwd: string, env: Readonly<Record<string, string>>): Promise<string | null | undefined>;
/** A program's end as the shell reports it: its exit code, or 128+n for the signal that ended it. */
export declare function shellStatusOf(exit: ExitStatus): number;
//# sourceMappingURL=delegated-program.d.ts.map