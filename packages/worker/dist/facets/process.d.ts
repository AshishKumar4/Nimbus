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
 * stdin / stdout / stderr stream through per-child queues maintained on
 * this manager instance. cpReadOutput long-polls for incremental delivery
 * to the parent; cpDrainOutput is a one-shot full-flush invoked from the
 * parent's exit path so unawaited children don't lose output.
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
    stdinChunks: Uint8Array[];
    stdinClosed: boolean;
    stdinTotalBytes: number;
    /** Woken when stdin gains a chunk, closes, or the child exits; each takes from `stdinChunks` itself. */
    stdinWaiters: Array<() => void>;
    outputs: {
        1: OutputChunk[];
        2: OutputChunk[];
    };
    outputSeq: {
        1: number;
        2: number;
    };
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
    onStdout: (data: Uint8Array) => void;
    onStderr: (data: Uint8Array) => void;
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
    execStream(code: string, opts: {
        cwd?: string;
        env?: Record<string, string>;
        argv?: string[];
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
    runPureBuiltin(pid: number, name: string, args: string[], env: Record<string, string>, cwd: string, stdin: string, hooks: OutputHooks): Promise<number>;
}
export interface ShellExecutorLike {
    execute(pid: number, commandLine: string, env: Record<string, string>, cwd: string, stdin: string, hooks: OutputHooks): Promise<number>;
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
     * News of a child was produced for its parent `parentPid`: output the
     * parent reads, the child's start, its exit. The parent's report that it
     * is blocked on its children stops being current (fabric noteProcessNews).
     */
    onNews?: (parentPid: number) => void;
}
/** Cap recursion depth to defend against runaway spawn loops. */
export declare const CHILD_PROCESS_MAX_DEPTH = 8;
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
     * child_process pipe does; a pure builtin takes the stdin the parent queued
     * as one string. Output goes straight to the child's queues while it runs,
     * so a prompt reaches the parent before the child waits for an answer.
     *
     * Runs in this isolate, on its own: a child that never exits holds nothing
     * a later child needs. (It used to be relayed through a single-slot Worker
     * Loader pool whose call stayed open for the child's life, so every later
     * spawn queued behind it, a kill included.)
     */
    private _dispatch;
    /**
     * Synchronously drain the stdin queue for a pure-builtin. Waits up to
     * 50ms for stdinClosed if data is still flowing. Pure-builtins block
     * on full stdin so we have to commit upfront — the parent should have
     * called stdinEnd() before the wait ticks expire.
     */
    private _waitForStdinEvent;
    private _drainStdinForBuiltin;
    private _shellPlanFor;
    private _shellCommandLineForPlan;
    private _runShellLine;
    stdinWrite(childPid: number, data: Uint8Array): {
        ok: boolean;
    };
    stdinEnd(childPid: number): void;
    /** The child's next stdin packet: a queued chunk, else the end once stdin closed or the child exited; null while neither. */
    private _takeStdin;
    /**
     * Long-poll: child facet asks the supervisor for its next stdin chunk.
     * Returns immediately if data is already queued OR if stdin is closed.
     */
    cpReadStdin(childPid: number, waitMs: number): Promise<{
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
    routeOutput(pid: number, fd: 1 | 2, bytes: Uint8Array): boolean;
    /** Internal: push a chunk to fd 1 or 2, fire log-store + waiters. */
    private _appendOutput;
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
    /** A stamped child's end, as Node reports it (ChildExitStatus). */
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
    /** News of `child` for its parent (FacetProcessManagerDeps.onNews). */
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