/**
 * state.ts — a shell's own state: what its builtins read and change, and
 * what a child shell gets a copy of. The interactive shell (Shell.ts) holds
 * the first; each child shell (a subshell, pipeline element, `$( )` or
 * background job: interpreter.ts fork) its own; a builtin acts on the state
 * of the shell that runs it (BuiltinExecutionContext.shell).
 */
import type { JobTable } from './jobs.js';
export interface ShellOptions {
    errexit: boolean;
    nounset: boolean;
    pipefail: boolean;
    /** bash's POSIX mode (`sh`, `--posix`, `set -o posix`): a script ends at a special builtin's own failure. */
    posix: boolean;
}
export interface TrapTable {
    get(signal: string): string | undefined;
    set(signal: string, action: string): void;
    delete(signal: string): void;
    entries(): IterableIterator<[string, string]>;
}
export interface ShellState {
    readonly env: Record<string, string>;
    /**
     * Indexed arrays; `env` holds the scalars. A name lives in exactly one of
     * them, so `$arr` and `${arr[0]}` cannot disagree, and only `unset` moves a
     * name from one to the other.
     */
    readonly arrays: Map<string, (string | undefined)[]>;
    getCwd(): string;
    /** Move the shell, and PWD with it as an assignment would; false where PWD is readonly and kept its value. */
    setCwd(cwd: string): boolean;
    readonly options: ShellOptions;
    readonly traps: TrapTable;
    readonly readonlyNames: Set<string>;
    /** The variables with the export attribute: what came in the environment, and what `export` or `declare -x` marked. */
    readonly exportedNames: Set<string>;
    /** Variables declared with no value (`declare p`, `export p`): set or not, they exist until unset. */
    readonly declaredNames: Set<string>;
    readonly aliases: Map<string, string>;
    readonly jobTable: JobTable;
}
/** A shell's state at `cwd`, its variables `env` (PWD set), nothing else defined. */
export declare function createShellState(env: Record<string, string>, cwd: string, jobTable: JobTable): ShellState;
/**
 * A child shell's state, as fork(2) makes one: its own copy of every part of
 * `parent`, so nothing it changes reaches `parent`. Traps reset to the
 * default, except ignored ones; jobs are the child's own.
 */
export declare function forkShellState(parent: ShellState): ShellState;
/** A shell's state as it was, for restoreShellState: a copy of every part but its jobs. */
export interface ShellStateFrame {
    readonly cwd: string;
    readonly env: Record<string, string>;
    readonly arrays: Map<string, (string | undefined)[]>;
    readonly options: ShellOptions;
    readonly traps: Map<string, string>;
    readonly readonlyNames: Set<string>;
    readonly exportedNames: Set<string>;
    readonly declaredNames: Set<string>;
    readonly aliases: Map<string, string>;
}
export declare function snapshotShellState(state: ShellState): ShellStateFrame;
/** Put `state` back as `frame` holds it, in place: whatever holds its parts sees them restored. */
export declare function restoreShellState(state: ShellState, frame: ShellStateFrame): void;
//# sourceMappingURL=state.d.ts.map