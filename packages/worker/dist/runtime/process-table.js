/**
 * ProcessTable — maps PIDs to facet names, tracks lifecycle.
 *
 * Each `node script.js` invocation gets a PID, which maps to a
 * facet name like "node-proc-1". The supervisor uses this to
 * route signals (kill) and track running processes.
 */
export class ProcessTable {
    nextPid = 1;
    processes = new Map();
    facetToPid = new Map();
    /** Allocate a PID and register a new process. */
    spawn(command, argv, cwd) {
        const pid = this.nextPid++;
        const facetName = `node-proc-${pid}`;
        const entry = {
            pid,
            facetName,
            command,
            argv,
            cwd,
            state: 'running',
            exitCode: null,
            startTime: Date.now(),
            endTime: null,
        };
        this.processes.set(pid, entry);
        this.facetToPid.set(facetName, pid);
        return entry;
    }
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
    getByFacet(facetName) {
        const pid = this.facetToPid.get(facetName);
        return pid !== undefined ? this.processes.get(pid) : undefined;
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
                this.facetToPid.delete(entry.facetName);
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
