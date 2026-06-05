/**
 * ProcessTable — maps PIDs to facet names, tracks lifecycle.
 *
 * Each `node script.js` invocation gets a PID, which maps to a
 * facet name like "node-proc-1". The supervisor uses this to
 * route signals (kill) and track running processes.
 */
export type ProcessState = 'running' | 'exited' | 'killed';
export interface ProcessEntry {
    pid: number;
    facetName: string;
    command: string;
    argv: string[];
    cwd: string;
    state: ProcessState;
    exitCode: number | null;
    startTime: number;
    endTime: number | null;
    /** child-process isolation: explicit long-running flag set by FacetManager.spawn
     *  when a script is forked to a long-lived Worker Loader (vite,
     *  http.listen, --watch, …). Distinct from the regex heuristic in
     *  process-logs-api.ts:LONG_RUNNING_CMD_RE — when set, the API
     *  returns this directly. */
    longRunning?: boolean;
}
export declare class ProcessTable {
    private nextPid;
    private processes;
    private facetToPid;
    /** Allocate a PID and register a new process. */
    spawn(command: string, argv: string[], cwd: string): ProcessEntry;
    /**
     * Mark a process as exited.
     *
     * STABILITY-AUDIT.md M-S1: state-idempotent. Once a process reaches
     * a terminal state (`killed` or `exited`), subsequent exit() calls
     * are no-ops — the first terminal state wins.
     *
     * Without this guard, a `kill <pid>` (which sets state='killed',
     * exitCode=137) followed by the facet's own crash-catch in
     * facet-manager.ts:842-864 (which calls processTable.exit(pid, 1))
     * clobbers the kill signal with an exited/1 reading. `ps` then
     * disagrees with the ring-buffer footer that still says
     * "[process killed: killed]".
     */
    /** child-process isolation: mark an existing entry as long-running. Idempotent. */
    setLongRunning(pid: number): void;
    exit(pid: number, exitCode: number): void;
    /** Mark a process as killed. */
    kill(pid: number): boolean;
    get(pid: number): ProcessEntry | undefined;
    getByFacet(facetName: string): ProcessEntry | undefined;
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