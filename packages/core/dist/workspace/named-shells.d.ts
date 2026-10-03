/**
 * named-shells.ts — a workspace's named shells.
 *
 * A named shell is a cwd and an environment that outlive the call that set
 * them, the way a terminal tab's do. Each name is a row of the workspace's
 * `vfs_shells` table, so it outlives the workspace object and its host's
 * restarts. Calls on one name run one at a time, in the order they were
 * made: two at once would read one state and race to write it back, and the
 * loser's `cd` would vanish. Calls on different names run at once.
 *
 * A call's functions, aliases, options, umask and descriptors are its
 * process's and end with it; only cwd and environment persist. The shell a
 * call runs in is built by the workspace for the call's own process
 * (`NimbusWorkspace.shellFor`), from the state this module keeps.
 */
import type { Shell } from '../substrate/lifo/shell/Shell.js';
import type { SqlDatabase } from '../runtime/os-contracts.js';
/** Where a shell is: its working directory and its environment. */
export interface ShellState {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
}
/** A named shell, held by one call: see {@link NamedShells.hold}. */
export interface NamedShell {
    /** Its working directory, where the process the call runs as starts. */
    readonly cwd: string;
    /** The shell, built for `pid`, the process the call runs as. */
    open(pid: number): Shell;
}
export interface NamedShellOptions {
    /**
     * Where a name with no saved state starts: absent, in the directory the
     * workspace started in (`fs.cwd`), with nothing beyond the workspace shell's
     * environment.
     */
    readonly start?: {
        readonly cwd: string;
        readonly env?: Readonly<Record<string, string>>;
    };
    /**
     * Save what the shell holds when the call settles; the default. False for a
     * call whose shell outlives it, such as a background job: what it would
     * save is a moment nobody asked about. A new name is saved where it started
     * either way.
     */
    readonly persist?: boolean;
}
/** A saved shell state, or an error naming what is wrong with it. */
export declare function parseShellState(value: unknown): ShellState;
/** Where named shells are saved, one row each; made by the first call that names one. */
export declare const SHELLS_TABLE = "vfs_shells";
export declare class NamedShells {
    private readonly sql;
    /** Where a name with no saved state and no `start` begins. */
    private readonly home;
    /** The shell for one call's process, in `state`. */
    private readonly shellFor;
    /** One queue per name: the last call made on it, settled when that call is. */
    private readonly queues;
    constructor(sql: SqlDatabase, 
    /** Where a name with no saved state and no `start` begins. */
    home: string, 
    /** The shell for one call's process, in `state`. */
    shellFor: (pid: number, state: ShellState) => Shell);
    /**
     * Run `body` in the named shell `id`: in the cwd and environment the last
     * call on that name left it with, else `options.start`, and save what the
     * shell holds when `body` settles. A name's first call saves where it
     * started even when it saves nothing else (`persist: false`), so the name
     * exists from then on, rooted there.
     */
    hold<T>(id: string, options: NamedShellOptions, body: (shell: NamedShell) => Promise<T>): Promise<T>;
    private save;
}
//# sourceMappingURL=named-shells.d.ts.map