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
import { parseProcessSignalName } from './process-io-protocol.js';
import { exitCodeForSignal, parseSignalName, signalDisposition } from '../substrate/lifo/shell/signals.js';
import { DELEGATION_RECALL_TIMEOUT_MS } from './delegations.js';
/**
 * How long work still held for an ended process (holdWork) has to stop: the
 * session's bound on a holder that does not let go when asked, the one a
 * delegation's recall has (delegations.ts). Past it the work is stopped
 * again and the process released all the same; work that ignored its stop
 * meets a closed scope.
 */
const HELD_WORK_STOP_MS = DELEGATION_RECALL_TIMEOUT_MS;
const ONCE = { once: true };
const NOTHING_REAPED = Promise.resolve(0);
/** Whether `a` and `b` are one identity: uid, gid and supplementary groups (as a set); a umask is not one. */
function sameIdentity(a, b) {
    if (a === b)
        return true;
    if (a.uid !== b.uid || a.gid !== b.gid)
        return false;
    const groups = new Set(a.groups);
    return b.groups.every((gid) => groups.has(gid)) && new Set(b.groups).size === groups.size;
}
export class SessionProcessSupervisor {
    table = new ProcessTable();
    /** Why no process is admitted any more (closeAdmission); null while they are. */
    refusal = null;
    /** What every spawn as another identity asks first; see governIdentityChanges. */
    identityPolicy = null;
    input = new ProcessInputStore();
    logs = new ProcessLogStore();
    /** Terminators for processes whose work is a promise this session owns. */
    terminators = new Map();
    /**
     * The processes whose programs take their own signals (takeSignals): the
     * signals sent to each that it has not taken, and its one wait for the next.
     */
    signalBoxes = new Map();
    /** The work this session runs on each pid's own descriptors (holdWork): how to stop each piece, and whether it was. */
    held = new Map();
    observeWork = null;
    /** Fires after every appendOutput/markExit once log persistence is wired. */
    logActivity = null;
    /** Fires when a log retention deadline may have appeared; see setLogPersist. */
    logRetention = null;
    /** The orphan rule's "process is gone": this table no longer holds it. */
    isLogOrphan = (pid) => !this.table.get(pid);
    /** Fires once per pid on its first terminal transition; see setOnTerminal. */
    onTerminalCb = null;
    /** Per pid, what its first terminal transition tells; see subscribeTerminal. */
    terminalSubscribers = new Map();
    /** Releases an ended process's filesystem binding; see setRelease. */
    release = null;
    /** Tells that filesystem the process has ended, at its end; see setRelease. */
    ended = null;
    /** Each ended pid's release, begun at its end: what a prune reports and waits for before it forgets the entry. */
    releases = new Map();
    /** Who waits for a pid's release to run (released), until it begins. */
    releaseWaiters = new Map();
    /** Each ended pid whose held work is still stopping: the bound on it (HELD_WORK_STOP_MS). */
    stopBounds = new Map();
    /** Ends a process by a signal's default action; see setDefaultSignalAction. */
    defaultSignalAction = null;
    /** Holds a process's output until its writes are published; see setOutputGate. */
    outputGate = null;
    /** Each pid's latest output still held: what its next output goes after. */
    heldOutput = new Map();
    /** The pids whose output is being delivered now: their own output made meanwhile goes with it. */
    releasing = new Set();
    /**
     * The pids whose end is decided but not yet published: observers are told
     * they run. A pid's own slot, kept until its end is published, whatever
     * becomes of its table entry.
     */
    unpublishedEnds = new Set();
    // ── Lifecycle / PID authority ─────────────────────────────────────────
    /**
     * Allocate a PID and register a new process. One with a parent and a
     * credential other than the parent's is made only if the identity policy
     * allows the change: refused, it is EPERM and no process.
     */
    spawn(command, argv, cwd, opts = {}) {
        if (this.refusal !== null)
            throw this.refusal;
        if (opts.parentPid !== undefined && opts.cred !== undefined && this.identityPolicy !== null) {
            const from = this.table.credOf(opts.parentPid);
            if (!sameIdentity(from, opts.cred) && !this.identityPolicy(from, opts.cred, command)) {
                throw Object.assign(new Error(`EPERM: operation not permitted, uid ${from.uid} may not become uid ${opts.cred.uid} (${command})`), { code: 'EPERM', errno: -1 });
            }
        }
        const entry = this.table.spawn(command, argv, cwd, opts);
        if (opts.longRunning)
            this.table.setLongRunning(entry.pid);
        if (opts.attachedTty)
            this.table.setAttachedTty(entry.pid);
        return entry;
    }
    /**
     * Ask `policy` before each spawn as another identity (spawn). One policy
     * per supervisor: a second, other one is refused, so two workspaces over
     * one process table cannot disagree on it.
     */
    governIdentityChanges(policy) {
        if (this.identityPolicy !== null && this.identityPolicy !== policy)
            throw new Error('SessionProcessSupervisor: an identity policy is already installed');
        this.identityPolicy = policy;
    }
    /**
     * Admit no process from now on: each spawn throws `reason`. A destroy's,
     * before it takes the processes it stops, so none starts behind it.
     */
    closeAdmission(reason) {
        this.refusal = reason;
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
    /** `pid`'s lifecycle: ended as soon as its end is decided, which is what releases what it held. */
    get(pid) {
        return this.table.get(pid);
    }
    /**
     * `pid`'s status as observers are told it (ps, process listings, a parent
     * waiting on it): its end once published, after the output before it
     * (releaseOutput); running until then.
     */
    published(pid) {
        const entry = this.table.get(pid);
        return entry && this.asPublished(entry);
    }
    /** Every process, as observers are told it (see {@link published}). */
    publishedAll() {
        return this.table.getAll().map((entry) => this.asPublished(entry));
    }
    asPublished(entry) {
        return this.unpublishedEnds.has(entry.pid) ? { ...entry, state: 'running', exitCode: null, endTime: null } : entry;
    }
    /** Whether `pid`'s end is decided and still held from its observers (see {@link published}). */
    endHeld(pid) {
        return this.unpublishedEnds.has(pid);
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
    /** `pid`'s running children, oldest first. */
    childrenOf(pid) {
        return this.table.getRunning()
            .filter((entry) => entry.parentPid === pid)
            .sort((a, b) => a.startTime - b.startTime)
            .map((entry) => entry.pid);
    }
    // ── What a process waits on ───────────────────────────────────────────
    //
    // A process running in the session (a shell line) holds no worker and
    // reports nothing of itself; what it waits on is told here. Each unit of
    // its own in-flight work (a command executing) is counted (beginWork), and
    // so is each child it awaits (beginAwait, by whoever runs the child for
    // it). When every unit of its work is such an await, it is doing nothing
    // but wait on those children (awaitsOnly), and the Dynamic Worker ledger
    // can tell whether that wait can ever end.
    /** `pid` → its units of in-flight work. */
    works = new Map();
    /** `pid` → the children it awaits, with how many awaits on each. */
    awaiting = new Map();
    /** Fires when what a process waits on may have changed; see setOnWaitChange. */
    onWaitChange = null;
    /** Told when what a process waits on may have changed (a work or an await ended, a process ended). */
    setOnWaitChange(cb) {
        this.onWaitChange = cb;
    }
    /** `pid` has a unit of in-flight work of its own until the returned function is called. */
    beginWork(pid) {
        this.works.set(pid, (this.works.get(pid) ?? 0) + 1);
        let ended = false;
        return () => {
            if (ended)
                return;
            ended = true;
            const left = (this.works.get(pid) ?? 1) - 1;
            if (left > 0)
                this.works.set(pid, left);
            else
                this.works.delete(pid);
            this.onWaitChange?.();
        };
    }
    /**
     * `pid` awaits its child `child`'s end, as one unit of its work, until
     * the returned function is called or either process ends. Told as a
     * change at once: the await may be what leaves `pid` doing nothing but
     * wait (a shell's `wait` on a job that is already running).
     */
    beginAwait(pid, child) {
        let children = this.awaiting.get(pid);
        if (!children)
            this.awaiting.set(pid, children = new Map());
        children.set(child, (children.get(child) ?? 0) + 1);
        this.onWaitChange?.();
        let ended = false;
        return () => {
            if (ended)
                return;
            ended = true;
            const now = this.awaiting.get(pid);
            const left = (now?.get(child) ?? 1) - 1;
            if (now && left > 0)
                now.set(child, left);
            else if (now) {
                now.delete(child);
                if (now.size === 0)
                    this.awaiting.delete(pid);
            }
            this.onWaitChange?.();
        };
    }
    /**
     * This table as the Dynamic Worker ledger reads it (fabric
     * ProcessWaitGraph, bindProcessWaitGraph): a process's running children,
     * and what a process holding no worker awaits. Paired with
     * setOnWaitChange(processWaitGraphChanged). One binding for the session
     * and for the ledger's protocol model, so the model reads the accounting
     * the session keeps.
     */
    waitGraph() {
        return {
            children: (pid) => this.childrenOf(pid),
            awaits: (pid) => this.awaitsOnly(pid),
        };
    }
    /**
     * The children `pid` awaits, when awaiting them is every unit of its own
     * in-flight work; null when it has other work, or none.
     */
    awaitsOnly(pid) {
        const works = this.works.get(pid) ?? 0;
        const children = this.awaiting.get(pid);
        if (works === 0 || !children)
            return null;
        let awaits = 0;
        for (const count of children.values())
            awaits += count;
        return awaits === works ? [...children.keys()] : null;
    }
    /**
     * An ended process awaits nothing, and nothing awaits it any more; and it
     * is no longer among its parent's running children. Told as a change even
     * when it awaited nothing: the children are part of what the ledger reads.
     */
    forgetWaits(pid) {
        this.works.delete(pid);
        this.awaiting.delete(pid);
        for (const [parent, children] of this.awaiting) {
            if (children.delete(pid) && children.size === 0)
                this.awaiting.delete(parent);
        }
        this.onWaitChange?.();
    }
    /**
     * Register how to stop the work behind `pid`: a program run elsewhere (a
     * facet) whose run this session holds as a promise, so `kill` has to abort
     * it rather than only marking the table entry. What such a process bound
     * in the filesystem is its program's, and is released at its end. Cleared
     * once the process reaches a terminal state.
     */
    setTerminator(pid, terminate) {
        this.terminators.set(pid, terminate);
    }
    /** Runtime composition adopts work already in flight, never cancelled work. */
    setWorkObservation(observe) {
        this.observeWork = observe;
        for (const [pid, pieces] of this.held)
            for (const work of pieces) {
                work.observation?.release();
                work.observation = !work.stopped && !work.signal?.aborted ? observe(pid) : undefined;
            }
    }
    /**
     * This session runs work on `pid`'s own descriptors (a shell job, a
     * command run in the session): `stop` ends it, given the kill's reason
     * when it has one (SESSION_DESTROYED for a destroy's), and the function
     * returned says it has stopped, its own cleanup done. A kill stops it
     * rather than only marking the table entry.
     *
     * The work owns those descriptors while it runs and closes them itself, so
     * the process's release (setRelease) comes after: once its end is marked
     * and every piece of work held for it has stopped, whichever is last. A
     * process with nothing held for it (a program run elsewhere, or one whose
     * host was lost: nothing of it here is left to unwind) is released at its
     * end.
     */
    holdWork(pid, stop, signal) {
        const owner = new AbortController();
        const ownSignal = owner.signal;
        // Each of the two ways the work is stopped ends what observes it: no listener of its own for that.
        const stopObserving = () => work.observation?.release();
        const abort = () => { owner.abort(signal?.reason); stopObserving(); };
        signal?.addEventListener('abort', abort, ONCE);
        if (signal?.aborted)
            owner.abort(signal.reason);
        const work = {
            stop: (reason) => { owner.abort(reason); stopObserving(); stop?.(reason); },
            stopped: false, signal: ownSignal,
            observation: ownSignal.aborted ? undefined : this.observeWork?.(pid),
        };
        let pieces = this.held.get(pid);
        if (!pieces)
            this.held.set(pid, pieces = new Set());
        pieces.add(work);
        let done = false;
        const release = () => {
            if (done)
                return;
            done = true;
            signal?.removeEventListener('abort', abort);
            stopObserving();
            const now = this.held.get(pid);
            now?.delete(work);
            if (now?.size === 0)
                this.held.delete(pid);
            this.releaseEnded(pid);
        };
        return Object.assign(release, { signal: ownSignal });
    }
    /** Whether `pid` runs, on work this session holds for it (holdWork, setTerminator): what a kill of it stops. */
    runsWork(pid) {
        return this.table.get(pid)?.state === 'running' && (this.held.has(pid) || this.terminators.has(pid));
    }
    /** Stop the work behind `pid`: its terminator, and every piece held for it, once each, for `reason`. */
    terminate(pid, reason) {
        const terminator = this.terminators.get(pid);
        this.terminators.delete(pid);
        try {
            terminator?.();
        }
        catch { /* the process is going away regardless */ }
        for (const work of this.held.get(pid) ?? []) {
            if (work.stopped)
                continue;
            work.stopped = true;
            work.observation?.release();
            try {
                work.stop(reason);
            }
            catch { /* the process is going away regardless */ }
        }
    }
    cred(pid) {
        return this.table.credOf(pid);
    }
    /**
     * Whether `caller` may signal `pid`, by Linux's rule (kill(2)): root may
     * signal any process, any other caller only a process of its own uid. The
     * one rule every kill path a process or user takes asks.
     */
    maySignal(caller, pid) {
        if (caller.uid === 0)
            return true;
        if (this.table.get(pid) === undefined)
            return false;
        return this.table.credOf(pid).uid === caller.uid;
    }
    /** {@link kill}, as `caller`: refused with EPERM where {@link maySignal} refuses it (isKillRefusal). */
    killAs(caller, pid, exitCode, reason) {
        if (!this.maySignal(caller, pid))
            throw Object.assign(new Error(`EPERM: operation not permitted, kill ${pid}`), { code: 'EPERM', errno: -1 });
        return this.kill(pid, exitCode, reason);
    }
    /** `pid`'s controlling terminal (ProcessEntry.terminal), or undefined when it has none or is not in the table. */
    terminalOf(pid) {
        return this.table.get(pid)?.terminal;
    }
    /** A shell made before its terminal takes it as its controlling terminal (ProcessTable.setTerminal). */
    setControllingTerminal(pid, terminal) {
        this.table.setTerminal(pid, terminal);
    }
    /** The running processes whose controlling terminal is `terminal`: what closing it hangs up. */
    onTerminal(terminal) {
        return this.table.onTerminal(terminal);
    }
    /** `pid` and the processes above it, nearest first, as the table has them now. */
    lineage(pid) {
        const chain = [];
        for (let entry = this.table.get(pid); entry !== undefined && !chain.includes(entry.pid); entry = entry.parentPid === undefined ? undefined : this.table.get(entry.parentPid)) {
            chain.push(entry.pid);
        }
        return chain;
    }
    liveCred(pid) {
        return this.table.liveCred(pid);
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
    /** Observe the authoritative end, even when that runtime has no log consumer. */
    subscribeTerminal(pid, listener) {
        let subscribers = this.terminalSubscribers.get(pid);
        if (!subscribers)
            this.terminalSubscribers.set(pid, subscribers = new Set());
        subscribers.add(listener);
        return () => {
            subscribers.delete(listener);
            if (subscribers.size === 0)
                this.terminalSubscribers.delete(pid);
        };
    }
    /**
     * `pid`'s exit status once it leaves `running`, however it leaves: what a
     * caller whose program ran on as a resident (FacetManager._promote) waits
     * on for that program's exit.
     */
    whenEnded(pid) {
        const entry = this.table.get(pid);
        if (entry?.state !== 'running')
            return Promise.resolve(entry?.exitCode ?? 0);
        return new Promise((resolve) => {
            this.subscribeTerminal(pid, () => resolve(this.table.get(pid)?.exitCode ?? 0));
        });
    }
    /** A decided end is told to observers (published) once the output before it is. */
    publishEnd(pid, wasRunning) {
        if (!wasRunning || this.table.get(pid)?.state === 'running')
            return;
        this.unpublishedEnds.add(pid);
        void this.releaseOutput(pid, () => { this.unpublishedEnds.delete(pid); });
    }
    fireTerminal(pid, wasRunning) {
        if (!wasRunning || this.table.get(pid)?.state === 'running')
            return;
        this.forgetWaits(pid);
        const subscribers = this.terminalSubscribers.get(pid);
        this.terminalSubscribers.delete(pid);
        for (const listener of subscribers ?? []) {
            try {
                listener();
            }
            catch { /* the process is gone regardless */ }
        }
        if (!this.onTerminalCb)
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
        if (wasRunning)
            this.ended?.(pid);
        this.releaseEnded(pid);
        this.publishEnd(pid, wasRunning);
        this.terminators.delete(pid);
        this.fireTerminal(pid, wasRunning);
    }
    /**
     * Mark a process as killed and tear down its input channel so queued
     * stdin can't outlive the process. `exitCode` is the ending signal's
     * status; SIGKILL's 137 when absent. `reason` is what its held work is
     * stopped with (holdWork).
     */
    kill(pid, exitCode, reason) {
        // A program that takes its own signals is sent the signal, and decides.
        const sent = reason === undefined ? null : parseProcessSignalName(`SIG${reason.signal}`);
        if (sent !== null && this.deliverSignal(pid, sent))
            return true;
        const wasRunning = this.table.get(pid)?.state === 'running';
        const killed = this.table.kill(pid, exitCode);
        if (wasRunning)
            this.ended?.(pid);
        this.releaseEnded(pid);
        this.publishEnd(pid, wasRunning);
        this.terminate(pid, reason);
        this.input.close(pid);
        this.fireTerminal(pid, wasRunning);
        return killed;
    }
    /**
     * Clean up exited processes older than maxAge ms: each one's release (see
     * {@link setRelease}) is waited for, then its entry forgotten, as
     * {@link reapTree} does. A session prunes its table this way rather than
     * at each call's return. With no release set nothing is reaped. A reaped
     * pid whose logs hold no exit (a process killed around its log) is an
     * orphan from here, which gives its logs a deadline.
     *
     * A prune serves whoever runs next, not the processes it removes, so a
     * release that failed goes to that process's own stderr log, where its
     * output is read; every expired entry is still forgotten. One whose end is
     * still held from its observers has not ended to them, and waits for a
     * prune after it is published; one whose work is still stopping (holdWork)
     * waits for a prune after it has.
     */
    reap(maxAge) {
        if (!this.release)
            return NOTHING_REAPED;
        const expired = this.table.expired(maxAge).filter((entry) => !this.unpublishedEnds.has(entry.pid) && !this.held.has(entry.pid));
        // Each launch prunes: one with nothing to prune costs it a settled promise, not an async call.
        return expired.length === 0 ? NOTHING_REAPED : this.reapExpired(expired);
    }
    async reapExpired(expired) {
        const { reaped, failures } = await this.forgetReleased(expired);
        for (const { pid, error } of failures)
            this.appendOutput(pid, 'stderr', `${error instanceof Error ? error.message : String(error)}\n`);
        return reaped;
    }
    /**
     * How an ended process lets go of what it bound in the filesystem (its
     * descriptor scope, its delegations, its watches): the `releaseProcess` of
     * the filesystem this table's processes bind to. One slot, set by the
     * workspace composed over this table, which owns that filesystem. It is
     * called once per process, at its end, however it ends (exit, kill, a lost
     * host: every end marks this table), so nothing it held outlives it to be
     * found by the next caller, a destroy among them. A prune reports how it
     * went (a descriptor's buffered bytes it lost) and forgets the entry.
     * `ended` is told at the end itself, before any held work has stopped:
     * what the process can no longer use (its read lease) goes then.
     */
    setRelease(release, ended) {
        this.release = release;
        this.ended = ended ?? null;
    }
    /**
     * Remove `pid` and every process under it that has ended, now, as a parent
     * that waited for its children does: what a caller ran to completion has
     * nothing left to report. Each one's release is waited for (see
     * {@link setRelease}) before its entry goes; with no release set this
     * refuses. One still running, whose end is still held from its observers,
     * or whose work is still stopping, is kept. Logs are orphaned as by
     * {@link reap}.
     */
    async reapTree(pid) {
        if (!this.release)
            throw new Error('reapTree: this process table has no filesystem release; compose a workspace over it');
        const ended = [this.table.get(pid), ...this.table.descendantsOf(pid)]
            .filter((entry) => entry !== undefined && entry.state !== 'running'
            && !this.unpublishedEnds.has(entry.pid) && !this.held.has(entry.pid));
        const { reaped, failures } = await this.forgetReleased(ended);
        // The caller waited for this tree: it hears every failure, once all of it is gone.
        if (failures.length === 1)
            throw failures[0].error;
        if (failures.length > 1)
            throw new AggregateError(failures.map((f) => f.error), `releasing ${failures.length} ended processes failed`);
        return reaped;
    }
    /**
     * `pid` has ended and no work held for it is still stopping: its release
     * begins now, in the turn that settled the last of them. One that ended
     * before a release was set is released when it is pruned.
     */
    releaseEnded(pid) {
        const entry = this.table.get(pid);
        if (entry === undefined || entry.state === 'running')
            return;
        if (!this.held.has(pid)) {
            void this.releaseOf(pid);
            return;
        }
        if (this.stopBounds.has(pid))
            return;
        this.stopBounds.set(pid, setTimeout(() => {
            this.stopBounds.delete(pid);
            if (!this.held.has(pid))
                return;
            this.terminate(pid);
            this.held.delete(pid);
            void this.releaseOf(pid);
        }, HELD_WORK_STOP_MS));
    }
    /**
     * Settles once `pid`'s release has run, however it went; at once when
     * nothing of it is still to be released (it has, or there is no release
     * to wait for). What a caller that ended a process waits for before it
     * relies on what the process held being gone (a destroy), bounded by
     * HELD_WORK_STOP_MS for work that ignores its stop.
     */
    released(pid) {
        const begun = this.releases.get(pid);
        if (begun !== undefined)
            return begun.then(() => { });
        const entry = this.table.get(pid);
        if (this.release === null || entry === undefined || entry.state === 'running' || !this.held.has(pid))
            return Promise.resolve();
        return new Promise((resolve) => {
            const waiting = this.releaseWaiters.get(pid);
            if (waiting)
                waiting.push(resolve);
            else
                this.releaseWaiters.set(pid, [resolve]);
        });
    }
    /**
     * The program behind `pid`, run elsewhere, says it has ended, ahead of
     * the table hearing of it (its exit is told once its output is let out):
     * what it bound is released now, so what its last closes flush goes with
     * that output, unless work the session runs on the pid still holds it.
     */
    programEnded(pid) {
        if (this.table.get(pid) === undefined || this.held.has(pid))
            return;
        void this.releaseOf(pid);
    }
    /** `pid`'s release, begun once: how it went, a failure included. */
    releaseOf(pid) {
        let released = this.releases.get(pid);
        if (released !== undefined)
            return released;
        const release = this.release;
        if (release === null)
            return Promise.resolve(null);
        try {
            released = release(pid).then(() => null, (error) => ({ error }));
        }
        catch (error) {
            released = Promise.resolve({ error });
        }
        this.releases.set(pid, released);
        const bound = this.stopBounds.get(pid);
        if (bound !== undefined)
            clearTimeout(bound);
        this.stopBounds.delete(pid);
        const waiting = this.releaseWaiters.get(pid);
        this.releaseWaiters.delete(pid);
        for (const resolve of waiting ?? [])
            void released.then(resolve);
        return released;
    }
    /**
     * Forget each entry once its release is done. A release that failed stops
     * nothing: releaseProcess revokes everything before it reports what it
     * could not do, so the entry is forgotten either way and the failure is
     * returned.
     */
    async forgetReleased(entries) {
        const failures = [];
        // Each release began at its process's end: they are waited for together.
        const released = await Promise.all(entries.map((entry) => this.releaseOf(entry.pid)));
        entries.forEach((entry, i) => {
            const failed = released[i];
            if (failed !== null)
                failures.push({ pid: entry.pid, error: failed.error });
            this.releases.delete(entry.pid);
            this.table.forget(entry.pid);
        });
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
    onPidStride(listener) {
        this.table.onPidStride(listener);
    }
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
    inheritInput(pid, parentPid) { this.input.inherit(pid, parentPid); }
    pumpInput(pid, source) { return this.input.pump(pid, source); }
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
    /**
     * A pipe write to `pid`'s input, waiting for room. When `writer`, the
     * process writing, takes its own signals (takeSignals), a signal sent to
     * it while it waits answers instead, as a write is interrupted, and the
     * write is withdrawn, taking nothing.
     */
    async writeInputBytesWait(pid, data, writer) {
        const box = writer === undefined ? undefined : this.signalBoxes.get(writer);
        // One there is room for does not wait, and nothing interrupts it.
        if (writer === undefined || box === undefined || this.input.hasRoom(pid, data.byteLength))
            return this.input.writeBytesWait(pid, data);
        const withdraw = new AbortController();
        const writing = this.input.writeBytesWait(pid, data, withdraw.signal);
        // Its waits for a signal end at their bound, or when its program lets go of its signals: the write is then waited for alone.
        while (this.signalBoxes.get(writer) === box) {
            const wait = this.waitSignal(box, 5000);
            const first = await Promise.race([writing.then((result) => ({ result })), wait.signal.then((signal) => ({ signal }))]);
            if ('result' in first) {
                // A signal it took as the write was made is the next wait's.
                wait.cancel();
                const late = await wait.signal;
                if (late !== null)
                    box.queued.unshift(late);
                return first.result;
            }
            if (first.signal === null)
                continue;
            withdraw.abort();
            const result = await writing;
            // Made before it could be withdrawn: the signal is the next wait's.
            if (result.ok) {
                box.queued.unshift(first.signal);
                return result;
            }
            return { ok: false, signal: first.signal };
        }
        return writing;
    }
    endInputAfterWrites(pid) { return this.input.endAfterWrites(pid); }
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
    /**
     * `pid`'s next input, waiting up to `waitMs` for it. For a program that
     * takes its own signals (takeSignals), a signal sent to it while it waits
     * answers instead, as a read is interrupted, and the read takes nothing.
     */
    async readInput(pid, waitMs, maxBytes) {
        const box = this.signalBoxes.get(pid);
        if (box === undefined)
            return this.input.read(pid, waitMs, maxBytes);
        const queued = box.queued.shift();
        if (queued !== undefined)
            return { data: '', ended: false, signal: queued };
        const withdraw = new AbortController();
        const reading = this.input.read(pid, waitMs, maxBytes, withdraw.signal);
        const wait = this.waitSignal(box, waitMs ?? 1000);
        const first = await Promise.race([reading.then((packet) => ({ packet })), wait.signal.then((signal) => ({ signal }))]);
        if ('packet' in first) {
            // A signal that came with it is the next wait's.
            wait.cancel();
            const late = await wait.signal;
            if (late !== null)
                box.queued.unshift(late);
            return first.packet;
        }
        withdraw.abort();
        if (first.signal === null)
            return reading;
        // Input that came with it goes back for the next read.
        const packet = await reading;
        if (packet.ended || packet.data.length > 0 || packet.resize || packet.signal)
            this.input.unread(pid, [packet]);
        return { data: '', ended: false, signal: first.signal };
    }
    /**
     * Until `pid` ends or the returned release is called (its program's run
     * ended: the process may run another), its program takes the signals it
     * `catches`: one sent to it (a kill, the terminal's keys, a client's
     * frame) is queued for it to take (nextSignal), and what it does is the
     * program's, as a process's own handlers decide. Any other, SIGKILL among
     * them, still ends it. Its runner says so when its image takes what its
     * host delivers (GIT_RUNNER_CONTRACTS).
     */
    takeSignals(pid, catches) {
        if (this.table.get(pid)?.state !== 'running' || this.signalBoxes.has(pid))
            return () => { };
        const box = { catches: new Set(catches.filter((signal) => signal !== 'SIGKILL')), queued: [], taker: null };
        this.signalBoxes.set(pid, box);
        // What was sent and not taken goes with its program.
        const release = () => {
            if (this.signalBoxes.get(pid) !== box)
                return;
            this.signalBoxes.delete(pid);
            box.taker?.(null);
        };
        const unsubscribe = this.subscribeTerminal(pid, release);
        return () => {
            unsubscribe();
            release();
        };
    }
    /**
     * The next signal sent to `pid`'s program (takeSignals), waiting up to
     * `waitMs` for one: null if none came, the process ended, or a later wait
     * took its place (one waits at a time).
     */
    nextSignal(pid, waitMs) {
        const box = this.signalBoxes.get(pid);
        return box === undefined ? Promise.resolve(null) : this.waitSignal(box, waitMs).signal;
    }
    /** {@link nextSignal}'s wait on `box`, and its cancel, which answers it null if it is still the one waiting. */
    waitSignal(box, waitMs) {
        const queued = box.queued.shift();
        if (queued !== undefined)
            return { signal: Promise.resolve(queued), cancel: () => { } };
        box.taker?.(null);
        let take = () => { };
        const signal = new Promise((resolve) => {
            const timer = setTimeout(() => take(null), Math.max(0, Math.min(waitMs, 5000)));
            take = (sent) => {
                clearTimeout(timer);
                if (box.taker === take)
                    box.taker = null;
                resolve(sent);
            };
            box.taker = take;
        });
        return { signal, cancel: () => { if (box.taker === take)
                take(null); } };
    }
    /**
     * `signal` queued for `pid`'s program if it takes its own and catches it
     * (takeSignals): whether it does. A kill path that ends a process past
     * this table (its host's resources first) asks this before it does.
     */
    deliverSignal(pid, signal) {
        const box = this.signalBoxes.get(pid);
        if (!box || !box.catches.has(signal))
            return false;
        if (box.taker)
            box.taker(signal);
        else
            box.queued.push(signal);
        return true;
    }
    /**
     * `reason`'s signal to `pid` and every process below it, as a terminal's
     * key signals its foreground job's process group: each takes it as
     * {@link kill} gives it, its program's own where it takes its signals, its
     * end where not.
     */
    signalGroup(pid, reason) {
        const group = this.getAll()
            .filter((entry) => entry.state === 'running' && this.lineage(entry.pid).includes(pid))
            .map((entry) => entry.pid);
        for (const member of group)
            this.kill(member, exitCodeForSignal(reason.signal), reason);
    }
    /** See ProcessInputStore.unread: input taken back to the front of the queue. */
    unreadInput(pid, packets) {
        this.input.unread(pid, packets);
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
        // A program that takes its own signals is sent it, whatever it would do by default.
        if (this.deliverSignal(pid, signal))
            return { ok: true };
        // Whether its default action ends a process, and the status it ends with:
        // the shell's table (signals.ts), Linux's dispositions and numbers.
        const name = parseSignalName(signal);
        const terminates = name !== null && signalDisposition(name) === 'terminate';
        const entry = this.table.get(pid);
        // Only an attached program reads its signals from this channel; a job
        // that never reads it is not "not yet started". SIGKILL cannot be caught,
        // blocked or ignored: it ends any running process at once, whether or not
        // the process reads this channel — a launch stuck before its first read
        // (a top-level await that never settles) or a background job that never
        // opens one was otherwise unkillable.
        const uncatchable = signal === 'SIGKILL';
        if (terminates && entry?.state === 'running'
            && (uncatchable || (entry.attachedTty === true && this.input.has(pid) && !this.input.hasReader(pid)))) {
            const code = exitCodeForSignal(name);
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
    /**
     * Hold each process's output (its log and live sinks, a pipe to another
     * process, the terminal, its exit) until `gate` lets it through. One slot.
     */
    setOutputGate(gate) {
        this.outputGate = gate;
    }
    /** `pid`'s output leaves, from now on, by a way no gate sees (a socket an answer of its hands over): its gate is told. */
    escapeOutput(pid) {
        this.outputGate?.escaped?.(pid);
    }
    /**
     * `deliver` once `pid`'s output may reach its observers: now, when the
     * gate holds nothing of pid's, else after the gate and after pid's output
     * before it, in the order the process made it. Every observer of a
     * process's output and its exit is reached through here.
     */
    releaseOutput(pid, deliver) {
        if ((this.outputGate === null && this.heldOutput.size === 0) || this.releasing.has(pid))
            return deliver();
        const prior = this.heldOutput.get(pid);
        const gated = this.outputGate?.before(pid) ?? null;
        const turn = prior === undefined ? gated : gated === null ? prior : Promise.all([prior, gated]);
        if (turn === null)
            return this.deliverOutput(pid, deliver);
        let delivery;
        const admitted = turn.then(() => { delivery = this.deliverOutput(pid, deliver); });
        // What comes after waits for this to be let through, not for its readers.
        const held = admitted.then(() => { }, () => { });
        this.heldOutput.set(pid, held);
        void held.then(() => { if (this.heldOutput.get(pid) === held)
            this.heldOutput.delete(pid); });
        return (async () => {
            await admitted;
            return await delivery;
        })();
    }
    deliverOutput(pid, deliver) {
        this.releasing.add(pid);
        try {
            return deliver();
        }
        finally {
            this.releasing.delete(pid);
        }
    }
    appendOutput(pid, stream, data) {
        void this.releaseOutput(pid, () => {
            this.logs.append(pid, stream, data);
            this.logActivity?.();
        });
    }
    /** Store bytes once, and await the live byte sink's pipe backpressure. */
    appendOutputBytes(pid, stream, data) {
        return this.releaseOutput(pid, () => {
            const delivery = this.logs.appendBytes(pid, stream, data);
            this.logActivity?.();
            return delivery;
        });
    }
    /** Record exit in the log store, after the output before it. Idempotent: the first record wins. */
    markExit(pid, code, reason) {
        void this.releaseOutput(pid, () => {
            this.logs.markExit(pid, code, reason);
            this.logActivity?.();
        });
    }
    getExit(pid) {
        return this.logs.getExit(pid);
    }
    hasLogs(pid) {
        return this.logs.has(pid);
    }
    retainsLogs(pid) { return this.logs.retains(pid); }
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
    subscribeOutputBytes(pid, cb) { return this.logs.subscribeBytes(pid, cb); }
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
/** Whether `error` is {@link SessionProcessSupervisor.killAs}'s refusal: kill(2)'s rule does not let the caller signal the process. */
export function isKillRefusal(error) {
    return error instanceof Error && Reflect.get(error, 'code') === 'EPERM';
}
