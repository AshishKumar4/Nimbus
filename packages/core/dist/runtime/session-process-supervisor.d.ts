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
    /** Inherit the parent process credential, including its current umask. */
    parentPid?: number;
    /** Explicit credential for a deliberate identity transition such as sudo. */
    cred?: VfsCred;
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
    /** Terminators for processes whose work is a promise this session owns. */
    private terminators;
    /** Fires after every appendOutput/markExit once log persistence is wired. */
    private logActivity;
    /** Fires once per pid on its first terminal transition; see setOnTerminal. */
    private onTerminalCb;
    /** Allocate a PID and register a new process. */
    spawn(command: string, argv: string[], cwd: string, opts?: ProcessSpawnOptions): ProcessEntry;
    /** Mark an existing entry as long-running. Idempotent. */
    setLongRunning(pid: number): void;
    /** Mark an existing entry as an attached terminal process. Idempotent. */
    setAttachedTty(pid: number): void;
    get(pid: number): ProcessEntry | undefined;
    getRunning(): ProcessEntry[];
    getAll(): ProcessEntry[];
    /** Every process spawned under `pid`, transitively, oldest first. */
    descendantsOf(pid: number): ProcessEntry[];
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
     * stdin can't outlive the process.
     */
    kill(pid: number): boolean;
    /** Clean up exited processes older than maxAge ms. */
    reap(maxAge?: number): number;
    get stats(): ProcessTable['stats'];
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
    /** Signal stdin EOF. Queued packets still drain; further writes fail. */
    endInput(pid: number): void;
    /** End and drop the input channel entirely. */
    closeInput(pid: number): void;
    readInput(pid: number, waitMs?: number): Promise<ProcessInputPacket>;
    resize(pid: number, columns: number, rows: number): {
        ok: boolean;
    };
    signal(pid: number, signal: ProcessSignalName): {
        ok: boolean;
    };
    /** Controlling-terminal descriptor; null when no input channel is open. */
    terminal(pid: number): ProcessTerminalDescriptor | null;
    appendOutput(pid: number, stream: LogStream, data: string): void;
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
     * flushes without the store knowing about timers.
     */
    setLogPersist(adapter: PersistAdapter, onActivity: () => void): void;
    /**
     * Install the instance-level chunk/exit broadcast (the hibernation-safe
     * process-terminal WS fan-out — see ProcessLogStore.setBroadcast).
     */
    setLogBroadcast(onChunk: (pid: number, chunk: LogChunk) => void, onExit: (pid: number, exit: ProcessExitInfo) => void): void;
    flushLogs(): void;
    dropLogsOlderThan(ageMs?: number, isOrphan?: (pid: number) => boolean): number;
    logHibStats(): ReturnType<ProcessLogStore['hibStats']>;
    /**
     * Replace the in-memory log store with a fresh, unwired one. Test-only
     * hibernation simulation (`/api/_test/hib/simulate`): the caller must
     * re-wire persistence afterwards, mirroring a post-wake isolate.
     */
    resetLogStore(): void;
}
//# sourceMappingURL=session-process-supervisor.d.ts.map