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
    /** Fires after every appendOutput/markExit once log persistence is wired. */
    logActivity = null;
    // ── Lifecycle / PID authority ─────────────────────────────────────────
    /** Allocate a PID and register a new process. */
    spawn(command, argv, cwd, opts = {}) {
        const entry = this.table.spawn(command, argv, cwd);
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
    /** Mark a process as exited. First terminal state wins. */
    exit(pid, exitCode) {
        this.table.exit(pid, exitCode);
    }
    /**
     * Mark a process as killed and tear down its input channel so queued
     * stdin can't outlive the process.
     */
    kill(pid) {
        const killed = this.table.kill(pid);
        this.input.close(pid);
        return killed;
    }
    /** Clean up exited processes older than maxAge ms. */
    reap(maxAge) {
        return this.table.reap(maxAge);
    }
    get stats() {
        return this.table.stats;
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
