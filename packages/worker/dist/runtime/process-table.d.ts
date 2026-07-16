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
    /** Explicit long-running flag set when a command is handed to a
     *  long-lived Worker Loader or shell execution path. */
    longRunning?: boolean;
    /** Output is owned by a process-terminal attachment, not the parent shell. */
    attachedTty?: boolean;
}
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
    spawn(command: string, argv: string[], cwd: string): ProcessEntry;
    /** child-process isolation: mark an existing entry as long-running. Idempotent. */
    setLongRunning(pid: number): void;
    /** Mark an existing entry as an attached terminal process. Idempotent. */
    setAttachedTty(pid: number): void;
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
    /** Mark a process as killed. */
    kill(pid: number): boolean;
    get(pid: number): ProcessEntry | undefined;
    getRunning(): ProcessEntry[];
    getAll(): ProcessEntry[];
    /** Clean up exited processes older than maxAge ms. */
    reap(maxAge?: number): number;
    get stats(): {
        total: number;
        running: number;
        exited: number;
        killed: number;
        nextPid: number;
    };
}
//# sourceMappingURL=process-table.d.ts.map