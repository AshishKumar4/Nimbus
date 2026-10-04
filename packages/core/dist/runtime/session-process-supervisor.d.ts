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
import { ProcessTable, type ProcessEntry } from './process-table.js';
import { type ProcessInputPacket } from './process-input.js';
import { ProcessLogStore, type LogChunk, type LogStream, type PersistAdapter, type ProcessExitInfo, type ProcessLogReadOptions, type SequencedLogChunk } from './process-logs.js';
import type { ProcessSignalName } from './process-io-protocol.js';
import type { VfsCred } from './os-contracts.js';
export interface ProcessSpawnOptions {
    /** Long-lived process (dev server, watcher, attached CLI). Surfaces a process tab. */
    longRunning?: boolean;
    /** Output and stdin are owned by an attached process terminal, not the parent shell. */
    attachedTty?: boolean;
    /** Inherit the parent process credential, including its current umask, and its exec id. */
    parentPid?: number;
    /** Explicit credential for a deliberate identity transition such as sudo. */
    cred?: VfsCred;
    /** The exec id of a process that does not take its parent's (`ProcessEntry.execId`). */
    execId?: string;
}
/**
 * Controlling-terminal descriptor for a process with an open input
 * channel. Folds the `attachedTty` classification and the input
 * channel's terminal size into one typed view. Stage 2 adds raw/cooked
 * mode state and the foreground process group here.
 */
export interface ProcessTerminalDescriptor {
    pid: number;
    /** True when the process runs as an attached TTY-shaped process tab. */
    attached: boolean;
    columns: number;
    rows: number;
}
export declare class SessionProcessSupervisor {
    private readonly table;
    private readonly input;
    private logs;
    /**
     * The log ring holds text lines; a process's output arrives as bytes. One
     * streaming decoder per (pid, stream) is this text consumer's edge, so a
     * character split across two chunks survives. Dropped at markExit.
     */
    private readonly outputDecoders;
    /** Terminators for processes whose work is a promise this session owns. */
    private terminators;
    /** Fires after every appendOutput/markExit once log persistence is wired. */
    private logActivity;
    /** Fires when a log retention deadline may have appeared; see setLogPersist. */
    private logRetention;
    /** The orphan rule's "process is gone": this table no longer holds it. */
    private readonly isLogOrphan;
    /** Fires once per pid on its first terminal transition; see setOnTerminal. */
    private onTerminalCb;
    /** Releases an ended process's filesystem binding; see setRelease. */
    private release;
    /** Ends a process by a signal's default action; see setDefaultSignalAction. */
    private defaultSignalAction;
    /** Allocate a PID and register a new process. */
    spawn(command: string, argv: string[], cwd: string, opts?: ProcessSpawnOptions): ProcessEntry;
    /** Mark an existing entry as long-running. Idempotent. */
    setLongRunning(pid: number): void;
    /** Mark an existing entry as an attached terminal process. Idempotent. */
    setAttachedTty(pid: number): void;
    setForeground(pid: number, foreground: boolean): void;
    get(pid: number): ProcessEntry | undefined;
    getRunning(): ProcessEntry[];
    getAll(): ProcessEntry[];
    /** Every process spawned under `pid`, transitively, oldest first. */
    descendantsOf(pid: number): ProcessEntry[];
    /** `pid`'s running children, oldest first. */
    childrenOf(pid: number): number[];
    /** `pid` → its units of in-flight work. */
    private readonly works;
    /** `pid` → the children it awaits, with how many awaits on each. */
    private readonly awaiting;
    /** Fires when what a process waits on may have changed; see setOnWaitChange. */
    private onWaitChange;
    /** Told when what a process waits on may have changed (a work or an await ended, a process ended). */
    setOnWaitChange(cb: (() => void) | null): void;
    /** `pid` has a unit of in-flight work of its own until the returned function is called. */
    beginWork(pid: number): () => void;
    /**
     * `pid` awaits its child `child`'s end, as one unit of its work, until
     * the returned function is called or either process ends.
     */
    beginAwait(pid: number, child: number): () => void;
    /**
     * The children `pid` awaits, when awaiting them is every unit of its own
     * in-flight work; null when it has other work, or none.
     */
    awaitsOnly(pid: number): number[] | null;
    /** An ended process awaits nothing, and nothing awaits it any more. */
    private forgetWaits;
    /**
     * Register how to stop the work behind `pid`. Background jobs started
     * through the programmatic API run as a promise held by this session, so
     * `kill` has to abort them rather than only marking the table entry.
     * Cleared once the process reaches a terminal state.
     */
    setTerminator(pid: number, terminate: () => void): void;
    private terminate;
    cred(pid: number): VfsCred;
    setUmask(pid: number, umask: number): number;
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
    setOnTerminal(cb: (pid: number) => void): void;
    private fireTerminal;
    /** Mark a process as exited. First terminal state wins. */
    exit(pid: number, exitCode: number): void;
    /**
     * Mark a process as killed and tear down its input channel so queued
     * stdin can't outlive the process. `exitCode` is the ending signal's
     * status; SIGKILL's 137 when absent.
     */
    kill(pid: number, exitCode?: number): boolean;
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
    reap(maxAge?: number): Promise<number>;
    /**
     * How an ended process lets go of what it bound in the filesystem (its
     * descriptor scope, its watches): the `releaseProcess` of the filesystem
     * this table's processes bind to. One slot, set by the workspace composed
     * over this table, which owns that filesystem; {@link reapTree} calls it
     * for each entry before forgetting it.
     */
    setRelease(release: (pid: number) => Promise<void>): void;
    /**
     * Remove `pid` and every process under it that has ended, now, as a parent
     * that waited for its children does: what a caller ran to completion has
     * nothing left to report. Each is released first (see {@link setRelease}),
     * so what it bound goes with its entry rather than outliving it; with no
     * release set this refuses. One still running is kept. Logs are
     * orphaned as by {@link reap}.
     */
    reapTree(pid: number): Promise<number>;
    /**
     * Release and forget each entry. A release that fails stops nothing:
     * releaseProcess revokes everything before it reports what it could not
     * do, so the entry is forgotten either way and the failure is returned.
     */
    private releaseAndForget;
    get stats(): ProcessTable['stats'];
    /** See ProcessTable.residentRunning — running long-running process count. */
    get residentRunning(): number;
    /** See ProcessTable.setPidBase — generation-unique pid allocation. */
    setPidBase(base: number): void;
    /** The current generation's pid floor: pids <= base are prior-generation. */
    get pidBase(): number;
    /** Open the process's input channel. Until opened, input writes fail. */
    openInput(pid: number): void;
    hasInput(pid: number): boolean;
    writeInput(pid: number, data: string): {
        ok: boolean;
    };
    /** Queue input bytes exactly as given (a pipe or redirect). */
    writeInputBytes(pid: number, data: Uint8Array): {
        ok: boolean;
    };
    /** Resolves when a write refused for a full queue may succeed; false once the channel is ended or gone. */
    whenInputWritable(pid: number): Promise<boolean>;
    /** Signal stdin EOF. Queued packets still drain; further writes fail. */
    endInput(pid: number): void;
    /** End and drop the input channel entirely. */
    closeInput(pid: number): void;
    readInput(pid: number, waitMs?: number): Promise<ProcessInputPacket>;
    resize(pid: number, columns: number, rows: number): {
        ok: boolean;
    };
    /**
     * Deliver a signal through the process's input channel. A process that has
     * not yet read that channel has not run far enough to install a handler,
     * so a terminating signal takes its default action now instead of waiting
     * in the queue for however long the program takes to start.
     */
    signal(pid: number, signal: ProcessSignalName): {
        ok: boolean;
    };
    /**
     * How a signal's default action ends a process whose work lives outside
     * this table (a facet being built or booted). One slot, owned by the
     * FacetManager, like setOnTerminal.
     */
    setDefaultSignalAction(cb: (pid: number, code: number, signal: ProcessSignalName) => void): void;
    /** Controlling-terminal descriptor; null when no input channel is open. */
    terminal(pid: number): ProcessTerminalDescriptor | null;
    appendOutput(pid: number, stream: LogStream, data: string): void;
    /** A process's own output: bytes on the relay, decoded at this edge. */
    appendOutputBytes(pid: number, stream: LogStream, data: Uint8Array): void;
    /** Record exit in the log store. Idempotent: the first record wins. */
    markExit(pid: number, code: number, reason?: string): void;
    getExit(pid: number): ProcessExitInfo | null;
    hasLogs(pid: number): boolean;
    logSize(pid: number): number;
    readLogs(pid: number, opts?: ProcessLogReadOptions): {
        chunks: SequencedLogChunk[];
        cursor: number;
        truncated: boolean;
    };
    tailLogs(pid: number, opts?: Pick<ProcessLogReadOptions, 'lines' | 'bytes'>): LogChunk[];
    allLogs(pid: number): LogChunk[];
    /** See ProcessLogStore.buffered — a read that never hydrates from SQL. */
    bufferedLogs(pid: number): LogChunk[];
    logSnapshot(pid: number): {
        bytes: number;
        chunks: number;
        exit: ProcessExitInfo | null;
    } | null;
    subscribeLogs(pid: number, cb: (chunk: LogChunk) => void): () => void;
    subscribeExit(pid: number, cb: (exit: ProcessExitInfo) => void): () => void;
    get logStats(): ProcessLogStore['stats'];
    /**
     * Install the SQL-backed persistence adapter. `onActivity` fires after
     * every appendOutput/markExit so the host can schedule debounced
     * flushes without the store knowing about timers. `onRetention` fires
     * only when a retention deadline may have appeared — a pid's logs
     * begin, its exit is recorded, a reader leaves, or the table reaps — so
     * the host re-reads `nextLogExpiry` there and never per chunk.
     */
    setLogPersist(adapter: PersistAdapter, onActivity: () => void, onRetention?: () => void): void;
    /**
     * Install the instance-level chunk/exit broadcast (the hibernation-safe
     * process-terminal WS fan-out — see ProcessLogStore.setBroadcast).
     */
    setLogBroadcast(onChunk: (pid: number, chunk: LogChunk) => void, onExit: (pid: number, exit: ProcessExitInfo) => void): void;
    flushLogs(): void;
    /** Drop the logs that are due; a pid this table no longer holds counts as an orphan. */
    dropLogsOlderThan(ageMs?: number): number;
    /** When dropLogsOlderThan next has work, by the same orphan rule, or null. */
    nextLogExpiry(): number | null;
    logHibStats(): ReturnType<ProcessLogStore['hibStats']>;
    /**
     * Replace the in-memory log store with a fresh, unwired one. Test-only
     * hibernation simulation (`/api/_test/hib/simulate`): the caller must
     * re-wire persistence afterwards, mirroring a post-wake isolate.
     */
    resetLogStore(): void;
}
//# sourceMappingURL=session-process-supervisor.d.ts.map