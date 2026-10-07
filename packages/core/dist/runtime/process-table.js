import { CRED_SESSION_USER } from './os-contracts.js';
/**
 * What an `execId` may be: 1 to 160 characters from `A-Z a-z 0-9 . _ : -`,
 * starting with a letter or digit, the rule a shell's name follows.
 */
const EXEC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
/** An exec id from a caller, or an error that names the rule it broke. */
export function parseExecId(value) {
    if (typeof value === 'string' && EXEC_ID.test(value))
        return value;
    throw new Error('execId must be 1 to 160 characters from A-Z a-z 0-9 . _ : - and start with a letter or digit, got '
        + (typeof value === 'string' ? `${value.length} characters` : typeof value));
}
/**
 * A process's exec id as a field of a record that reports it (a process, or
 * the pid listening on a port): absent when the process has none, so a
 * record about a process no exec named is what it was before exec ids.
 */
export function execIdField(entry) {
    return entry?.execId === undefined ? {} : { execId: entry.execId };
}
function immutableCred(cred) {
    return Object.freeze({
        uid: cred.uid,
        gid: cred.gid,
        groups: Object.freeze([...cred.groups]),
        umask: cred.umask,
    });
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
    spawn(command, argv, cwd, options = {}) {
        const inheritedCred = options.parentPid === undefined
            ? CRED_SESSION_USER
            : this.credOf(options.parentPid);
        const execId = options.execId
            ?? (options.parentPid === undefined ? undefined : this.processes.get(options.parentPid)?.execId);
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
            cred: immutableCred(options.cred ?? inheritedCred),
            parentPid: options.parentPid,
            ...(execId === undefined ? {} : { execId }),
            ...(options.restartedFrom === undefined ? {} : { restartedFrom: { ...options.restartedFrom } }),
        };
        this.processes.set(pid, entry);
        return entry;
    }
    credOf(pid) {
        const entry = this.processes.get(pid);
        if (!entry)
            throw new Error(`process pid ${pid} does not exist`);
        return immutableCred(entry.cred);
    }
    cred(pid) {
        return this.credOf(pid);
    }
    setUmask(pid, umask) {
        const entry = this.processes.get(pid);
        if (!entry)
            throw new Error(`process pid ${pid} does not exist`);
        if (!Number.isInteger(umask) || umask < 0 || umask > 0o777) {
            throw new Error(`invalid umask ${umask}`);
        }
        const previous = entry.cred.umask;
        entry.cred = immutableCred({ ...entry.cred, umask });
        return previous;
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
    setForeground(pid, foreground) {
        const entry = this.processes.get(pid);
        if (entry)
            entry.foreground = foreground;
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
    /** Mark a process as killed, by SIGKILL (137) unless the signal's status is given. */
    kill(pid, exitCode = 137) {
        const entry = this.processes.get(pid);
        if (!entry || entry.state !== 'running')
            return false;
        entry.state = 'killed';
        entry.exitCode = exitCode;
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
    /**
     * Every process spawned under `pid`, transitively, oldest first.
     *
     * Output attribution needs this: a command's console output can land in a
     * child's log ring (an npm bin, a facet-backed runtime) rather than on the
     * caller's streams, and a start-time window is not a safe substitute when
     * several commands run concurrently in one session.
     */
    descendantsOf(pid) {
        const found = [];
        const frontier = new Set([pid]);
        for (const entry of [...this.processes.values()].sort((a, b) => a.startTime - b.startTime)) {
            if (entry.parentPid !== undefined && frontier.has(entry.parentPid)) {
                frontier.add(entry.pid);
                found.push(entry);
            }
        }
        return found;
    }
    /** Remove `pid`'s entry, now: its owner has seen it end. */
    forget(pid) {
        this.processes.delete(pid);
    }
    /** The processes that ended more than maxAge ms ago, which a reap may forget. */
    expired(maxAge = 60_000) {
        const now = Date.now();
        return [...this.processes.values()].filter((entry) => entry.state !== 'running' && entry.endTime !== null && now - entry.endTime > maxAge);
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
    /**
     * How many RESIDENT processes are running: a long-running entry still in
     * `running` state. The keep-alive alarm's re-arm condition — a session
     * holds itself in memory for exactly as long as one of these lives, and
     * `stats.running` cannot answer it (a foreground `node -e` is running too,
     * and it finishes inside the turn that started it).
     */
    get residentRunning() {
        let count = 0;
        for (const entry of this.processes.values()) {
            if (entry.state === 'running' && entry.longRunning === true)
                count++;
        }
        return count;
    }
}
