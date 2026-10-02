import { type VfsCred } from './os-contracts.js';
/**
 * ProcessTable — PID allocation and process lifecycle state.
 *
 * Each `node script.js` invocation gets a PID. The supervisor uses this
 * to route signals (kill) and track running processes. Owned by
 * SessionProcessSupervisor; callers go through that facade.
 */
export type ProcessState = 'running' | 'exited' | 'killed';
export interface ProcessEntry {
    pid: number;
    command: string;
    argv: string[];
    cwd: string;
    state: ProcessState;
    exitCode: number | null;
    startTime: number;
    endTime: number | null;
    cred: VfsCred;
    /** Spawning process, when the spawn declared one. Roots have none. */
    parentPid?: number;
    /**
     * The caller's name for the exec that started this process (`execId` on
     * exec, execStream and startProcess), taken at spawn from the parent, or,
     * for a process a runtime starts for a command, from the command's process
     * (`execIdOf`), so everything an exec starts carries it. Absent when no
     * exec named one.
     */
    execId?: string;
    /** Explicit long-running flag set when a command is handed to a
     *  long-lived Worker Loader or shell execution path. */
    longRunning?: boolean;
    /** Output is owned by a process-terminal attachment, not the parent shell. */
    attachedTty?: boolean;
    /** Output is owned by the command that launched it, until its launch returns. */
    foreground?: boolean;
}
export interface ProcessTableSpawnOptions {
    cred?: VfsCred;
    parentPid?: number;
    /**
     * The exec id of a process that does not take its parent's: an exec's own
     * job, a process a runtime starts for a command, or a resident re-driven
     * after a reset. Otherwise the parent's is inherited.
     */
    execId?: string;
}
/** An exec id from a caller, or an error that names the rule it broke. */
export declare function parseExecId(value: unknown): string;
/**
 * The exec id process `pid` carries, if `pid` names a process that has one:
 * what a process a runtime starts for a command takes from the command's
 * process, which is not its parent in the table.
 */
export declare function execIdOf(processes: {
    get(pid: number): ProcessEntry | undefined;
}, pid: number | undefined): string | undefined;
/**
 * A process's exec id as a field of a record that reports it (a process, or
 * the pid listening on a port): absent when the process has none, so a
 * record about a process no exec named is what it was before exec ids.
 */
export declare function execIdField(entry: ProcessEntry | undefined): {
    execId?: string;
};
/**
 * Pid-space stride per DO instance generation. Pids are allocated as
 * `generation * PID_GEN_STRIDE + seq`, so pid-keyed state that OUTLIVES an
 * instance reset — hibernatable process-terminal WebSocket attachments,
 * persisted w9_proc_logs rows, named Worker Loader isolate keys, and
 * still-running facets from the previous instance — can never collide with
 * (or bleed into) a pid allocated by the next instance. A pid at or below
 * the current base is by construction from a PREVIOUS generation.
 */
export declare const PID_GEN_STRIDE = 1000000;
export declare class ProcessTable {
    private nextPid;
    private base;
    private processes;
    /**
     * Move the pid space onto this instance generation's range. Called once at
     * DO boot (before any event runs) with `isolateGen * PID_GEN_STRIDE`.
     * Monotonic and idempotent — never moves pids backwards.
     */
    setPidBase(base: number): void;
    /** The current generation's pid floor: pids <= base are prior-generation. */
    get pidBase(): number;
    /** Allocate a PID and register a new process. */
    spawn(command: string, argv: string[], cwd: string, options?: ProcessTableSpawnOptions): ProcessEntry;
    credOf(pid: number): VfsCred;
    cred(pid: number): VfsCred;
    setUmask(pid: number, umask: number): number;
    /** child-process isolation: mark an existing entry as long-running. Idempotent. */
    setLongRunning(pid: number): void;
    /** Mark an existing entry as an attached terminal process. Idempotent. */
    setAttachedTty(pid: number): void;
    setForeground(pid: number, foreground: boolean): void;
    /**
     * Mark a process as exited.
     *
     * Once a process reaches a terminal state (`killed` or `exited`),
     * subsequent exit() calls
     * are no-ops — the first terminal state wins.
     *
     * Without this guard, a `kill <pid>` (which sets state='killed',
     * exitCode=137) followed by the facet's own crash-catch (which calls
     * exit(pid, 1)) clobbers the kill signal with an exited/1 reading.
     * `ps` then disagrees with the ring-buffer footer that still says
     * "[process killed: killed]".
     */
    exit(pid: number, exitCode: number): void;
    /** Mark a process as killed, by SIGKILL (137) unless the signal's status is given. */
    kill(pid: number, exitCode?: number): boolean;
    get(pid: number): ProcessEntry | undefined;
    getRunning(): ProcessEntry[];
    getAll(): ProcessEntry[];
    /**
     * Every process spawned under `pid`, transitively, oldest first.
     *
     * Output attribution needs this: a command's console output can land in a
     * child's log ring (an npm bin, a facet-backed runtime) rather than on the
     * caller's streams, and a start-time window is not a safe substitute when
     * several commands run concurrently in one session.
     */
    descendantsOf(pid: number): ProcessEntry[];
    /** Clean up exited processes older than maxAge ms. */
    reap(maxAge?: number): number;
    get stats(): {
        total: number;
        running: number;
        exited: number;
        killed: number;
        nextPid: number;
    };
    /**
     * How many RESIDENT processes are running: a long-running entry still in
     * `running` state. The keep-alive alarm's re-arm condition — a session
     * holds itself in memory for exactly as long as one of these lives, and
     * `stats.running` cannot answer it (a foreground `node -e` is running too,
     * and it finishes inside the turn that started it).
     */
    get residentRunning(): number;
}
//# sourceMappingURL=process-table.d.ts.map