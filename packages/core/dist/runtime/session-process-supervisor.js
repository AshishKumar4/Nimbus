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
import { StreamTextDecoders } from '../_shared/bytes.js';
/** Signals whose default action terminates the process, by number. */
const DEFAULT_TERMINATING_SIGNALS = {
    SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15,
};
export class SessionProcessSupervisor {
    table = new ProcessTable();
    input = new ProcessInputStore();
    logs = new ProcessLogStore();
    /**
     * The log ring holds text lines; a process's output arrives as bytes. One
     * streaming decoder per (pid, stream) is this text consumer's edge, so a
     * character split across two chunks survives. Dropped at markExit.
     */
    outputDecoders = new StreamTextDecoders();
    /** Terminators for processes whose work is a promise this session owns. */
    terminators = new Map();
    /** Fires after every appendOutput/markExit once log persistence is wired. */
    logActivity = null;
    /** Fires when a log retention deadline may have appeared; see setLogPersist. */
    logRetention = null;
    /** The orphan rule's "process is gone": this table no longer holds it. */
    isLogOrphan = (pid) => !this.table.get(pid);
    /** Fires once per pid on its first terminal transition; see setOnTerminal. */
    onTerminalCb = null;
    /** Releases an ended process's filesystem binding; see setRelease. */
    release = null;
    /** Ends a process by a signal's default action; see setDefaultSignalAction. */
    defaultSignalAction = null;
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
    setForeground(pid, foreground) {
        this.table.setForeground(pid, foreground);
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
     * stdin can't outlive the process. `exitCode` is the ending signal's
     * status; SIGKILL's 137 when absent.
     */
    kill(pid, exitCode) {
        const wasRunning = this.table.get(pid)?.state === 'running';
        const killed = this.table.kill(pid, exitCode);
        this.terminate(pid);
        this.input.close(pid);
        this.fireTerminal(pid, wasRunning);
        return killed;
    }
    /**
     * Clean up exited processes older than maxAge ms, each released first (see
     * {@link setRelease}), as {@link reapTree} does: a session prunes its table
     * this way rather than at each call's return, and an entry forgotten
     * unreleased left its binding behind. With no release set nothing is
     * reaped. A reaped pid whose logs hold no exit (a process killed around its
     * log) is an orphan from here, which gives its logs a deadline.
     *
     * A prune serves whoever runs next, not the processes it removes, so a
     * release that fails goes to that process's own stderr log, where its
     * output is read; every expired entry is still released and forgotten.
     */
    async reap(maxAge) {
        const release = this.release;
        if (!release)
            return 0;
        const { reaped, failures } = await this.releaseAndForget(release, this.table.expired(maxAge));
        for (const { pid, error } of failures)
            this.appendOutput(pid, 'stderr', `${error instanceof Error ? error.message : String(error)}\n`);
        return reaped;
    }
    /**
     * How an ended process lets go of what it bound in the filesystem (its
     * descriptor scope, its watches): the `releaseProcess` of the filesystem
     * this table's processes bind to. One slot, set by the workspace composed
     * over this table, which owns that filesystem; {@link reapTree} calls it
     * for each entry before forgetting it.
     */
    setRelease(release) {
        this.release = release;
    }
    /**
     * Remove `pid` and every process under it that has ended, now, as a parent
     * that waited for its children does: what a caller ran to completion has
     * nothing left to report. Each is released first (see {@link setRelease}),
     * so what it bound goes with its entry rather than outliving it; with no
     * release set this refuses. One still running is kept. Logs are
     * orphaned as by {@link reap}.
     */
    async reapTree(pid) {
        const release = this.release;
        if (!release)
            throw new Error('reapTree: this process table has no filesystem release; compose a workspace over it');
        const ended = [this.table.get(pid), ...this.table.descendantsOf(pid)]
            .filter((entry) => entry !== undefined && entry.state !== 'running');
        const { reaped, failures } = await this.releaseAndForget(release, ended);
        // The caller waited for this tree: it hears every failure, once all of it is gone.
        if (failures.length === 1)
            throw failures[0].error;
        if (failures.length > 1)
            throw new AggregateError(failures.map((f) => f.error), `releasing ${failures.length} ended processes failed`);
        return reaped;
    }
    /**
     * Release and forget each entry. A release that fails stops nothing:
     * releaseProcess revokes everything before it reports what it could not
     * do, so the entry is forgotten either way and the failure is returned.
     */
    async releaseAndForget(release, entries) {
        const failures = [];
        for (const entry of entries) {
            try {
                await release(entry.pid);
            }
            catch (error) {
                failures.push({ pid: entry.pid, error });
            }
            finally {
                this.table.forget(entry.pid);
            }
        }
        if (entries.length > 0)
            this.logRetention?.();
        return { reaped: entries.length, failures };
    }
    get stats() {
        return this.table.stats;
    }
    /** See ProcessTable.residentRunning — running long-running process count. */
    get residentRunning() {
        return this.table.residentRunning;
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
    /** Queue input bytes exactly as given (a pipe or redirect). */
    writeInputBytes(pid, data) {
        return this.input.writeBytes(pid, data);
    }
    /** Resolves when a write refused for a full queue may succeed; false once the channel is ended or gone. */
    whenInputWritable(pid) {
        return this.input.whenWritable(pid);
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
    /**
     * Deliver a signal through the process's input channel. A process that has
     * not yet read that channel has not run far enough to install a handler,
     * so a terminating signal takes its default action now instead of waiting
     * in the queue for however long the program takes to start.
     */
    signal(pid, signal) {
        const signo = DEFAULT_TERMINATING_SIGNALS[signal];
        const entry = this.table.get(pid);
        // Only an attached program reads its signals from this channel; a job
        // that never reads it is not "not yet started". SIGKILL cannot be caught,
        // blocked or ignored: it ends any running process at once, whether or not
        // the process reads this channel — a launch stuck before its first read
        // (a top-level await that never settles) or a background job that never
        // opens one was otherwise unkillable.
        const uncatchable = signal === 'SIGKILL';
        if (signo !== undefined && entry?.state === 'running'
            && (uncatchable || (entry.attachedTty === true && this.input.has(pid) && !this.input.hasReader(pid)))) {
            const code = 128 + signo;
            // Stop the work first: exit() drops the terminator without running it.
            this.terminate(pid);
            if (this.defaultSignalAction) {
                this.defaultSignalAction(pid, code, signal);
            }
            else {
                this.exit(pid, code);
                this.markExit(pid, code, signal);
                this.input.close(pid);
            }
            return { ok: true };
        }
        return this.input.signal(pid, signal);
    }
    /**
     * How a signal's default action ends a process whose work lives outside
     * this table (a facet being built or booted). One slot, owned by the
     * FacetManager, like setOnTerminal.
     */
    setDefaultSignalAction(cb) {
        this.defaultSignalAction = cb;
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
    /** A process's own output: bytes on the relay, decoded at this edge. */
    appendOutputBytes(pid, stream, data) {
        const text = this.outputDecoders.decode(`${pid}:${stream}`, data);
        if (text.length > 0)
            this.appendOutput(pid, stream, text);
    }
    /** Record exit in the log store. Idempotent: the first record wins. */
    markExit(pid, code, reason) {
        for (const stream of ['stdout', 'stderr']) {
            const tail = this.outputDecoders.drop(`${pid}:${stream}`);
            if (tail.length > 0)
                this.logs.append(pid, stream, tail);
        }
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
     * flushes without the store knowing about timers. `onRetention` fires
     * only when a retention deadline may have appeared — a pid's logs
     * begin, its exit is recorded, a reader leaves, or the table reaps — so
     * the host re-reads `nextLogExpiry` there and never per chunk.
     */
    setLogPersist(adapter, onActivity, onRetention) {
        this.logs.setPersist(adapter);
        this.logActivity = onActivity;
        this.logRetention = onRetention ?? null;
        this.logs.setRetentionHook(() => this.logRetention?.());
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
    /** Drop the logs that are due; a pid this table no longer holds counts as an orphan. */
    dropLogsOlderThan(ageMs) {
        return this.logs.dropOlderThan(ageMs, this.isLogOrphan);
    }
    /** When dropLogsOlderThan next has work, by the same orphan rule, or null. */
    nextLogExpiry() {
        return this.logs.nextExpiry(undefined, this.isLogOrphan);
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
        this.logRetention = null;
    }
}
