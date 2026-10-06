/**
 * facet-process.ts — supervisor-side broker for child_process.spawn.
 *
 * W8 Phase 1: facet-mapped pseudo-process. Each child_process.spawn call from
 * a parent facet routes through here:
 *
 *   parent facet  ── SUPERVISOR.cpSpawn(req) ─→  FacetProcessManager.spawn
 *                                                      │
 *                                                      ▼
 *                                  one of two execution kinds:
 *
 *   pure-builtin   — run inline in supervisor isolate via the command
 *                    registry (echo, cat, true, false, ls, env, sleep,
 *                    exit-code, …). No facet hop. Fast.
 *
 *   facet-direct   — mint a child facet that runs the command directly
 *                    via FacetManager.execStream(). The facet IS the
 *                    command's runtime — no nested cpRunBuiltinCommand
 *                    recursion (that was the BLOCKER-2 deadlock vector
 *                    in the initial plan; see W8-plan.md §8.5).
 *
 * stdin uses the shared process input channel; stdout/stderr use bounded
 * per-child pipes. cpReadOutput long-polls for incremental delivery
 * to the parent; cpDrainOutput is a one-shot full-flush invoked from the
 * parent's exit path so unawaited children don't lose output. A child's
 * stdin is a pipe: what runs it here reads the queue as a stream, as the
 * parent writes it (`_stdinOf`), and a runtime's facet reads the same channel
 * through cpReadStdin.
 *
 * Children run concurrently, as Node's do: each is dispatched on its own,
 * and nothing here waits for one child before starting the next. What a
 * child spends of the session's shared budgets it spends where it is spent
 * (a facet program's Dynamic Worker is admitted by the fabric's ledger).
 *
 * Lifecycle invariants:
 *   - exitCode is stamped exactly once (first writer wins). kill() and
 *     reportExit() race-free.
 *   - kill() runs the session's kill of the pid (its launch's terminator,
 *     and the release of what it held) before it stamps the exit, which
 *     wakes every pending waiter, so cpWait/cpReadOutput don't hang and
 *     nothing the child held outlives it.
 */
import type { SessionProcessSupervisor } from '@nimbus-sh/core/runtime/session-process-supervisor.js';
import type { ProcessView } from '@nimbus-sh/core/runtime/process-files.js';
import type { CommandInputStream } from '@nimbus-sh/core/substrate/lifo/commands/types.js';
/**
 * Result of running a pure-builtin or facet-direct command. Mirrors
 * FacetExecResult but with the streaming hooks already invoked, so this
 * value is just the final exit code.
 */
export interface ExecStreamResult {
    exitCode: number;
}
/**
 * Output chunk in a child's per-fd ring. Sequence numbers let parents
 * read incrementally with cpReadOutput(sinceSeq). The data is bytes: a
 * child's stdio is not text, and a string here would lose any byte sequence
 * that is not valid UTF-8.
 */
interface OutputChunk {
    seq: number;
    data: Uint8Array;
    /** Its number among the parent's news (FacetProcessManagerDeps.issueNews); 0 for none. */
    news: number;
}
/**
 * Per-child mutable state. Created on spawn, torn down only when the
 * parent reaps via cpReap or after a configurable idle timeout (we leave
 * the entry around for late drain/wait calls).
 */
interface ChildEntry {
    pid: number;
    /** The process that spawned it: whom its output, start and exit are news for. */
    parentPid: number;
    /** The descriptors its parent reads: output to an ignored one reaches nobody. */
    stdio: Array<'pipe' | 'ignore' | 'inherit'>;
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    startedAt: number;
    endedAt: number | null;
    outputs: {
        1: OutputChunk[];
        2: OutputChunk[];
    };
    outputSeq: {
        1: number;
        2: number;
    };
    outputBytes: {
        1: number;
        2: number;
    };
    outputDrained: Array<() => void>;
    outputWrites: {
        1: Promise<void>;
        2: Promise<void>;
    };
    parentClosed: (() => void) | null;
    outputWaiters: Array<{
        fd: 1 | 2;
        sinceSeq: number;
        resolve: (r: ReadOutputResult) => void;
        expiresAt: number;
    }>;
    exitCode: number | null;
    signal: string | null;
    killed: boolean;
    /** The errno code of a spawn that failed: the child never ran (EAGAIN: no room to start it). */
    spawnError: string | null;
    /**
     * The child has started: its runner admitted it (a facet program, once
     * its launch is let in on the Dynamic Worker ledger) or began it (a
     * builtin, a shell line). Until then it is pending, and may yet be
     * refused (spawnError). A parent's ChildProcess emits 'spawn' on this.
     */
    started: boolean;
    /** Woken when the child starts, or ends, whichever is first. */
    startWaiters: Array<() => void>;
    exitWaiters: Array<(r: ChildExitStatus) => void>;
    startNews: number;
    exitNews: number;
    closedNews: {
        1: number;
        2: number;
    };
}
/**
 * How a child ended, as Node's ChildProcess reports it: an exit status and
 * no signal, or the signal that ended it and no status. A spawn that failed
 * has `spawnError` (its errno code) and the negative errno as its status.
 */
export interface ChildExitStatus {
    done: boolean;
    exitCode: number | null;
    signal: string | null;
    spawnError?: string;
    /** Not done, but started: what a wait that asked to hear of the start answers. */
    started?: boolean;
    /** The parent's news this answer delivers (FacetProcessManagerDeps.issueNews). */
    news?: number[];
}
export interface SpawnReq {
    command: string;
    args: string[];
    env: Record<string, string>;
    cwd: string;
    stdio: ('pipe' | 'ignore' | 'inherit')[];
    detached?: boolean;
    shell?: boolean | string;
    stdin?: string;
    /** Supervisor-assigned invoking process PID. */
    parentPid: number;
}
export interface ReadOutputResult {
    chunks: {
        seq: number;
        data: Uint8Array;
    }[];
    closed: boolean;
    maxSeq: number;
    /** The parent's news this answer delivers (FacetProcessManagerDeps.issueNews). */
    news?: number[];
}
export interface DrainResult {
    stdout: Uint8Array;
    stderr: Uint8Array;
    stdoutClosed: boolean;
    stderrClosed: boolean;
}
/**
 * Hooks invoked by a child's runner (builtin, shell line or facet program)
 * to push output into the per-child ring. Kept as a small structural type
 * so tests can supply mocks. They carry bytes; a text producer encodes at
 * its own edge (see `textBytes`).
 */
export interface OutputHooks {
    onStdout: (data: Uint8Array) => void | Promise<void>;
    onStderr: (data: Uint8Array) => void | Promise<void>;
    /** The runner has started the program: a facet program's launch was let in (ChildEntry.started). */
    onStarted?: () => void;
}
/** A text producer's edge onto the byte hooks. */
export declare function textBytes(text: string): Uint8Array;
/**
 * Command resolution. The shell registry returns whatever shape it likes;
 * we adapt to a normalized 3-state result.
 */
export type CommandKind = 'pure-builtin' | 'facet-direct' | 'shell-direct' | 'unknown';
/**
 * The minimum shape we need from the FacetManager. Production passes
 * the real FacetManager; tests pass a mock with execStream.
 */
export interface FacetManagerLike {
    /** `opts.stdin` is the command's stdin, a pipe it reads as it arrives. */
    execStream(code: string, opts: {
        facetName?: string;
        cwd?: string;
        env?: Record<string, string>;
        argv?: string[];
        stdin?: CommandInputStream;
    }, hooks: OutputHooks): Promise<number>;
    /**
     * The session's kill of `pid` by `signal` (a name without SIG): the work
     * behind it ends (its launch's terminator), and what it held is released
     * and its exit reported (ports, RPC resources, relayed sockets). False when
     * it is not running.
     */
    kill(pid: number, signal: string): boolean;
}
/** Where a child runs from: its pid (whose credential it has), directory and environment. */
export interface ChildOrigin {
    readonly pid: number;
    readonly cwd: string;
    readonly env: Record<string, string>;
}
/**
 * The minimum shape we need from the command registry.
 */
export interface CommandRegistryLike {
    /** How `name` runs as the child `from` describes; null while nothing can run it. */
    resolve(name: string, from: ChildOrigin): Promise<{
        kind: CommandKind;
    } | null>;
    runPureBuiltin(pid: number, name: string, args: string[], env: Record<string, string>, cwd: string, stdin: CommandInputStream, hooks: OutputHooks): Promise<number>;
}
export interface ShellExecutorLike {
    execute(pid: number, commandLine: string, env: Record<string, string>, cwd: string, stdin: CommandInputStream, hooks: OutputHooks): Promise<number>;
}
/**
 * Constructor deps bundle. Keeping it as a single object simplifies
 * tests AND makes the production wiring in nimbus-session.ts read
 * declaratively.
 */
export interface FacetProcessManagerDeps {
    facetMgr: FacetManagerLike;
    processes: SessionProcessSupervisor;
    /** The process's own view of the namespace: where `sh <script>` reads the script, as the process. */
    vfsForProcess: (pid: number) => Pick<ProcessView, 'exists' | 'readFileString' | 'isDirectory'>;
    commandRegistry: CommandRegistryLike;
    shellExecutor?: ShellExecutorLike;
    /**
     * Number a piece of news of a child as it is produced, for its parent
     * `parentPid`: output the parent reads, the child's start, the end of a
     * stream, its exit (fabric issueProcessNews). The reply that delivers it
     * carries the number, and the parent's report that it is blocked counts
     * only once it has applied every number issued. 0: not numbered.
     */
    issueNews?: (parentPid: number) => number;
}
/** Cap recursion depth to defend against runaway spawn loops. */
export declare const CHILD_PROCESS_MAX_DEPTH = 8;
/** A pipe holds its writer here until its reader acknowledges consumed chunks. */
export declare const CHILD_STDIO_QUEUE_MAX_BYTES: number;
export declare class FacetProcessManager {
    private children;
    private deps;
    constructor(deps: FacetProcessManagerDeps);
    /**
     * Allocate a child PID, classify the command, dispatch it to its runner.
     * Returns immediately with the child PID; the actual command executes
     * asynchronously, beside any other child, and pushes output via the
     * per-child hooks.
     */
    spawn(req: SpawnReq): Promise<{
        childPid: number;
    }>;
    /**
     * Run the child to its end and stamp its exit. A facet program or a shell
     * line reads live stdin (NIMBUS_CP_CHILD_PID, cpReadStdin), as a Node
     * child_process pipe does; a pure builtin reads that same live byte channel.
     * Output goes straight to the child's bounded pipes while it runs,
     * so a prompt reaches the parent before the child waits for an answer.
     *
     * Runs in this isolate, on its own: a child that never exits holds nothing
     * a later child needs. (It used to be relayed through a single-slot Worker
     * Loader pool whose call stayed open for the child's life, so every later
     * spawn queued behind it, a kill included.)
     */
    private _dispatch;
    /**
     * The child's stdin as a stream over its queue: each read takes what the
     * parent has written, waiting for it, and ends when the parent ends stdin
     * or the child exits. Nothing is read ahead of the command's own reads.
     */
    private _stdinOf;
    private _shellPlanFor;
    private _dispatchShell;
    /** The shell's program: its `-c` text, its script, or (`sh` alone) its stdin, which it then has none left of. */
    private _shellCommandLineForPlan;
    private _runShellLine;
    stdinWrite(childPid: number, data: Uint8Array): Promise<{
        ok: boolean;
    }>;
    stdinEnd(childPid: number): Promise<void>;
    /**
     * Put stdin the child took back in front of its queue, as it was, past the
     * queue's cap and after its end too: a run of the child that stopped
     * before using it, run again (runtime/stop-replay.ts).
     */
    unreadStdin(childPid: number, chunks: readonly Uint8Array[]): void;
    /**
     * Long-poll: child facet asks the supervisor for its next stdin chunk.
     * Returns immediately if data is already queued OR if stdin is closed.
     */
    cpReadStdin(childPid: number, waitMs: number, maxBytes?: number): Promise<{
        data: Uint8Array;
        ended: boolean;
    }>;
    /** A broker-side text message onto the child's byte ring. */
    private _appendText;
    /** Whether this pid's descriptors belong to a child managed by this broker. */
    isChild(pid: number): boolean;
    /** Whether this pid is a child of this broker that has not ended. */
    isRunning(pid: number): boolean;
    /** Runtime stdout/stderr for a broker-owned pid goes to its parent, not the shell. */
    routeOutput(pid: number, fd: 1 | 2, bytes: Uint8Array): Promise<void> | null;
    /** Internal: push a chunk to fd 1 or 2, fire log-store + waiters. */
    private _appendOutput;
    private _pushOutput;
    /**
     * A read's answer: the chunks past `sinceSeq`, whether the stream has
     * ended, and the parent's news it delivers: each chunk's, the child's
     * start (its output says it started), and the stream's end.
     */
    private _readResult;
    /**
     * Long-poll read for fd 1 or 2.  Returns immediately if there are
     * chunks > sinceSeq OR if the child has already exited.
     */
    readOutput(childPid: number, fd: 1 | 2, sinceSeq: number, waitMs?: number): Promise<ReadOutputResult>;
    /**
     * One-shot final flush. Used by the parent's exit-time drain (BLOCKER-1
     * fix in W8-plan §8.5). Returns ALL pending output for both fds plus
     * the closed state. Does NOT wait — caller is the parent shutting down.
     */
    drainOutput(childPid: number): Promise<DrainResult>;
    /**
     * Synchronous kill. First-writer-wins on exit slot. The work behind the
     * pid ends first, through the session's own kill (FacetManagerLike.kill):
     * the terminator its launch registered aborts a facet program's run, so
     * the Dynamic Worker it held goes back to the ledger now rather than when
     * the program would have ended on its own, and its ports, RPC resources
     * and relayed sockets go with it. (`exit()`, which the stamp below calls,
     * drops that terminator without running it.) Then the stamp wakes every
     * waiter.
     */
    kill(childPid: number, signal?: string | number): boolean;
    /**
     * Stamp the exit slot. Idempotent — first call wins.
     * Wakes all waiters (exit, output, stdin) so callers don't hang.
     */
    private _stampExit;
    /** A stamped child's end, as Node reports it (ChildExitStatus), with the news it delivers. */
    private _exitStatus;
    /**
     * Late-arriving reportExit from the facet. Idempotent; if kill() or
     * an earlier reportExit already stamped, this is a no-op.
     */
    reportExit(childPid: number, exitCode: number, signal: string | null): void;
    /**
     * Long-poll wait. Returns immediately if already exited; otherwise
     * registers a waiter that resolves on the next exit-slot stamp.
     */
    wait(childPid: number, waitMs?: number, knownStarted?: boolean): Promise<ChildExitStatus>;
    /** The child has started (ChildEntry.started): wake whoever waits to hear of it. */
    private _markStarted;
    /** A piece of news of `child` for its parent, numbered (FacetProcessManagerDeps.issueNews). */
    private _news;
    /** Reap entries older than maxAgeMs whose exit slot is stamped. */
    reap(maxAgeMs?: number): number;
    get stats(): {
        total: number;
        running: number;
        exited: number;
        killed: number;
    };
    /** Test/diagnostic introspection. */
    _getChildEntry(pid: number): ChildEntry | undefined;
}
export {};
//# sourceMappingURL=process.d.ts.map