/**
 * ProcessTable — PID allocation and process lifecycle state.
 *
 * Each `node script.js` invocation gets a PID. The supervisor uses this
 * to route signals (kill) and track running processes. Owned by
 * SessionProcessSupervisor; callers go through that facade.
 */
/**
 * Pid-space stride per DO instance generation. Pids are allocated as
 * `generation * PID_GEN_STRIDE + seq`, so pid-keyed state that OUTLIVES an
 * instance reset — hibernatable process-terminal WebSocket attachments,
 * persisted w9_proc_logs rows, named Worker Loader isolate keys, and
 * still-running facets from the previous instance — can never collide with
 * (or bleed into) a pid allocated by the next instance. A pid at or below
 * the current base is by construction from a PREVIOUS generation.
 */
export const PID_GEN_STRIDE = 1_000_000;
export class ProcessTable {
    nextPid = 1;
    base = 0;
    processes = new Map();
    /**
     * Move the pid space onto this instance generation's range. Called once at
     * DO boot (before any event runs) with `isolateGen * PID_GEN_STRIDE`.
     * Monotonic and idempotent — never moves pids backwards.
     */
    setPidBase(base) {
        if (!Number.isFinite(base) || base <= this.base)
            return;
        this.base = base;
        this.nextPid = Math.max(this.nextPid, base + 1);
    }
    /** The current generation's pid floor: pids <= base are prior-generation. */
    get pidBase() {
        return this.base;
    }
    /** Allocate a PID and register a new process. */
    spawn(command, argv, cwd) {
        const pid = this.nextPid++;
        const entry = {
            pid,
            command,
            argv,
            cwd,
            state: 'running',
            exitCode: null,
            startTime: Date.now(),
            endTime: null,
        };
        this.processes.set(pid, entry);
        return entry;
    }
    /** child-process isolation: mark an existing entry as long-running. Idempotent. */
    setLongRunning(pid) {
        const entry = this.processes.get(pid);
        if (entry)
            entry.longRunning = true;
    }
    /** Mark an existing entry as an attached terminal process. Idempotent. */
    setAttachedTty(pid) {
        const entry = this.processes.get(pid);
        if (entry)
            entry.attachedTty = true;
    }
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
    exit(pid, exitCode) {
        const entry = this.processes.get(pid);
        if (!entry)
            return;
        if (entry.state !== 'running')
            return; // first terminal state wins
        entry.state = 'exited';
        entry.exitCode = exitCode;
        entry.endTime = Date.now();
    }
    /** Mark a process as killed. */
    kill(pid) {
        const entry = this.processes.get(pid);
        if (!entry || entry.state !== 'running')
            return false;
        entry.state = 'killed';
        entry.exitCode = 137; // SIGKILL
        entry.endTime = Date.now();
        return true;
    }
    get(pid) {
        return this.processes.get(pid);
    }
    getRunning() {
        return [...this.processes.values()].filter(p => p.state === 'running');
    }
    getAll() {
        return [...this.processes.values()];
    }
    /** Clean up exited processes older than maxAge ms. */
    reap(maxAge = 60_000) {
        const now = Date.now();
        let reaped = 0;
        for (const [pid, entry] of this.processes) {
            if (entry.state !== 'running' && entry.endTime && now - entry.endTime > maxAge) {
                this.processes.delete(pid);
                reaped++;
            }
        }
        return reaped;
    }
    get stats() {
        const all = [...this.processes.values()];
        return {
            total: all.length,
            running: all.filter(p => p.state === 'running').length,
            exited: all.filter(p => p.state === 'exited').length,
            killed: all.filter(p => p.state === 'killed').length,
            nextPid: this.nextPid,
        };
    }
}
