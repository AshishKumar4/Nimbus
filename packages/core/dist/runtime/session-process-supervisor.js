/**
 * SessionProcessSupervisor — the session's single process owner.
 *
 * Deep-module facade over the three process storage primitives:
 *
 *   - ProcessTable      — PID authority and lifecycle state.
 *   - ProcessInputStore — controlling-terminal input channel: stdin
 *     packets, resize (coalesced), signals, terminal size.
 *   - ProcessLogStore   — bounded output rings, exit records, and the
 *     SQL-backed hibernation persistence (W9).
 *
 * Every session-side caller — session routes, the programmatic SDK RPC
 * surface, agent tools, shell commands, npm-bin launches, the
 * child-process broker, and runtime runners — goes through this facade.
 * No caller touches the underlying stores directly.
 *
 * Stage 2 of the OS kernel plan (docs/architecture/nimbus-os-runtime-spec.md,
 * "Process And PTY Completion") extends this module with process groups,
 * raw/cooked terminal mode, and foreground-process-group signal policy.
 * `ProcessTerminalDescriptor` is the seam those land on.
 */
import { ProcessTable } from './process-table.js';
import { ProcessInputStore } from './process-input.js';
import { ProcessLogStore, } from './process-logs.js';
export class SessionProcessSupervisor {
    table = new ProcessTable();
    input = new ProcessInputStore();
    logs = new ProcessLogStore();
    /** Terminators for processes whose work is a promise this session owns. */
    terminators = new Map();
    /** Fires after every appendOutput/markExit once log persistence is wired. */
    logActivity = null;
    /** Fires once per pid on its first terminal transition; see setOnTerminal. */
    onTerminalCb = null;
    // ── Lifecycle / PID authority ─────────────────────────────────────────
    /** Allocate a PID and register a new process. */
    spawn(command, argv, cwd, opts = {}) {
        const entry = this.table.spawn(command, argv, cwd, opts);
        if (opts.longRunning)
            this.table.setLongRunning(entry.pid);
        if (opts.attachedTty)
            this.table.setAttachedTty(entry.pid);
        return entry;
    }
    /** Mark an existing entry as long-running. Idempotent. */
    setLongRunning(pid) {
        this.table.setLongRunning(pid);
    }
    /** Mark an existing entry as an attached terminal process. Idempotent. */
    setAttachedTty(pid) {
        this.table.setAttachedTty(pid);
    }
    get(pid) {
        return this.table.get(pid);
    }
    getRunning() {
        return this.table.getRunning();
    }
    getAll() {
        return this.table.getAll();
    }
    /** Every process spawned under `pid`, transitively, oldest first. */
    descendantsOf(pid) {
        return this.table.descendantsOf(pid);
    }
    /**
     * Register how to stop the work behind `pid`. Background jobs started
     * through the programmatic API run as a promise held by this session, so
     * `kill` has to abort them rather than only marking the table entry.
     * Cleared once the process reaches a terminal state.
     */
    setTerminator(pid, terminate) {
        this.terminators.set(pid, terminate);
    }
    terminate(pid) {
        const terminator = this.terminators.get(pid);
        if (!terminator)
            return;
        this.terminators.delete(pid);
        try {
            terminator();
        }
        catch { /* the process is going away regardless */ }
    }
    cred(pid) {
        return this.table.credOf(pid);
    }
    setUmask(pid, umask) {
        return this.table.setUmask(pid, umask);
    }
    /**
     * Observe every pid's FIRST transition out of `running`, whichever door it
     * leaves by — exit(), kill(), a facet's self-reported exit, a timeout abort:
     * all of them end here, which is what makes this one callback a complete
     * seam for per-pid durable state (the resident-launch journal) that must be
     * released exactly when the process ends and never before.
     *
     * One slot, owned by the FacetManager. A second subscriber would mean two
     * owners of process-end policy; grow this into a list only when a second
     * genuine owner exists.
     */
    setOnTerminal(cb) {
        this.onTerminalCb = cb;
    }
    fireTerminal(pid, wasRunning) {
        if (!wasRunning || !this.onTerminalCb)
            return;
        if (this.table.get(pid)?.state === 'running')
            return;
        try {
            this.onTerminalCb(pid);
        }
        catch { /* the process is gone regardless */ }
    }
    /** Mark a process as exited. First terminal state wins. */
    exit(pid, exitCode) {
        const wasRunning = this.table.get(pid)?.state === 'running';
        this.table.exit(pid, exitCode);
        this.terminators.delete(pid);
        this.fireTerminal(pid, wasRunning);
    }
    /**
     * Mark a process as killed and tear down its input channel so queued
     * stdin can't outlive the process.
     */
    kill(pid) {
        const wasRunning = this.table.get(pid)?.state === 'running';
        const killed = this.table.kill(pid);
        this.terminate(pid);
        this.input.close(pid);
        this.fireTerminal(pid, wasRunning);
        return killed;
    }
    /** Clean up exited processes older than maxAge ms. */
    reap(maxAge) {
        return this.table.reap(maxAge);
    }
    get stats() {
        return this.table.stats;
    }
    /** See ProcessTable.setPidBase — generation-unique pid allocation. */
    setPidBase(base) {
        this.table.setPidBase(base);
    }
    /** The current generation's pid floor: pids <= base are prior-generation. */
    get pidBase() {
        return this.table.pidBase;
    }
    // ── Controlling terminal / stdin ──────────────────────────────────────
    /** Open the process's input channel. Until opened, input writes fail. */
    openInput(pid) {
        this.input.open(pid);
    }
    hasInput(pid) {
        return this.input.has(pid);
    }
    writeInput(pid, data) {
        return this.input.write(pid, data);
    }
    /** Signal stdin EOF. Queued packets still drain; further writes fail. */
    endInput(pid) {
        this.input.end(pid);
    }
    /** End and drop the input channel entirely. */
    closeInput(pid) {
        this.input.close(pid);
    }
    readInput(pid, waitMs) {
        return this.input.read(pid, waitMs);
    }
    resize(pid, columns, rows) {
        return this.input.resize(pid, columns, rows);
    }
    signal(pid, signal) {
        return this.input.signal(pid, signal);
    }
    /** Controlling-terminal descriptor; null when no input channel is open. */
    terminal(pid) {
        const size = this.input.terminalSize(pid);
        if (!size)
            return null;
        return {
            pid,
            attached: this.table.get(pid)?.attachedTty === true,
            columns: size.columns,
            rows: size.rows,
        };
    }
    // ── Output / exit records ─────────────────────────────────────────────
    appendOutput(pid, stream, data) {
        this.logs.append(pid, stream, data);
        this.logActivity?.();
    }
    /** Record exit in the log store. Idempotent: the first record wins. */
    markExit(pid, code, reason) {
        this.logs.markExit(pid, code, reason);
        this.logActivity?.();
    }
    getExit(pid) {
        return this.logs.getExit(pid);
    }
    hasLogs(pid) {
        return this.logs.has(pid);
    }
    logSize(pid) {
        return this.logs.size(pid);
    }
    readLogs(pid, opts) {
        return this.logs.read(pid, opts);
    }
    tailLogs(pid, opts) {
        return this.logs.tail(pid, opts);
    }
    allLogs(pid) {
        return this.logs.all(pid);
    }
    /** See ProcessLogStore.buffered — a read that never hydrates from SQL. */
    bufferedLogs(pid) {
        return this.logs.buffered(pid);
    }
    logSnapshot(pid) {
        return this.logs.snapshot(pid);
    }
    subscribeLogs(pid, cb) {
        return this.logs.subscribe(pid, cb);
    }
    subscribeExit(pid, cb) {
        return this.logs.subscribeExit(pid, cb);
    }
    get logStats() {
        return this.logs.stats;
    }
    // ── Log persistence / hibernation (W9) ────────────────────────────────
    /**
     * Install the SQL-backed persistence adapter. `onActivity` fires after
     * every appendOutput/markExit so the host can schedule debounced
     * flushes without the store knowing about timers.
     */
    setLogPersist(adapter, onActivity) {
        this.logs.setPersist(adapter);
        this.logActivity = onActivity;
    }
    /**
     * Install the instance-level chunk/exit broadcast (the hibernation-safe
     * process-terminal WS fan-out — see ProcessLogStore.setBroadcast).
     */
    setLogBroadcast(onChunk, onExit) {
        this.logs.setBroadcast(onChunk, onExit);
    }
    flushLogs() {
        this.logs.flush();
    }
    dropLogsOlderThan(ageMs, isOrphan) {
        return this.logs.dropOlderThan(ageMs, isOrphan);
    }
    logHibStats() {
        return this.logs.hibStats();
    }
    /**
     * Replace the in-memory log store with a fresh, unwired one. Test-only
     * hibernation simulation (`/api/_test/hib/simulate`): the caller must
     * re-wire persistence afterwards, mirroring a post-wake isolate.
     */
    resetLogStore() {
        this.logs = new ProcessLogStore();
        this.logActivity = null;
    }
}
