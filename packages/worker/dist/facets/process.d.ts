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
 * Lifecycle invariants:
 *   - exitCode is stamped exactly once (first writer wins). kill() and
 *     reportExit() race-free.
 *   - kill() resolves all pending waiters BEFORE invoking facets.abort,
 *     so cpWait/cpReadOutput don't hang on a torn-down facet.
 *   - facets.delete is deferred to a microtask after abort to give any
 *     in-flight reportExit RPC a chance to land (and be no-op'd by the
 *     idempotent guard).
 */
import type { ProcessTable } from '../runtime/process-table.js';
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
 * read incrementally with cpReadOutput(sinceSeq).
 */
interface OutputChunk {
    seq: number;
    data: string;
}
/**
 * Per-child mutable state. Created on spawn, torn down only when the
 * parent reaps via cpReap or after a configurable idle timeout (we leave
 * the entry around for late drain/wait calls).
 */
interface ChildEntry {
    pid: number;
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    facetName: string;
    startedAt: number;
    endedAt: number | null;
    stdinChunks: string[];
    stdinClosed: boolean;
    stdinTotalBytes: number;
    stdinWaiters: Array<(r: {
        data: string;
        ended: boolean;
    }) => void>;
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
    exitWaiters: Array<(r: {
        done: boolean;
        exitCode: number | null;
        signal: string | null;
    }) => void>;
    facetSlot: {
        abort?: () => void;
        killed?: boolean;
    } | null;
}
export interface SpawnReq {
    command: string;
    args: string[];
    env: Record<string, string>;
    cwd: string;
    stdio: ('pipe' | 'ignore' | 'inherit')[];
    detached?: boolean;
    shell?: boolean | string;
    /** Optional explicit parent PID for log routing. */
    parentPid?: number;
}
export interface ReadOutputResult {
    chunks: {
        seq: number;
        data: string;
    }[];
    closed: boolean;
    maxSeq: number;
}
export interface DrainResult {
    stdout: string;
    stderr: string;
    stdoutClosed: boolean;
    stderrClosed: boolean;
}
/**
 * Hooks invoked by the inline runner / facet-direct runner to push
 * output back into the per-child ring. Kept as a small structural type
 * so tests can supply mocks.
 */
export interface OutputHooks {
    onStdout: (data: string) => void;
    onStderr: (data: string) => void;
}
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
        facetName?: string;
        cwd?: string;
        env?: Record<string, string>;
        argv?: string[];
    }, hooks: OutputHooks): Promise<number>;
    abort?(facetName: string, signal?: string): boolean;
}
/**
 * The minimum shape we need from the command registry.
 */
export interface CommandRegistryLike {
    resolve(name: string): {
        kind: CommandKind;
    } | null;
    runPureBuiltin(name: string, args: string[], env: Record<string, string>, cwd: string, stdin: string, hooks: OutputHooks): Promise<number>;
}
export interface ShellExecutorLike {
    execute(commandLine: string, env: Record<string, string>, cwd: string, stdin: string, hooks: OutputHooks): Promise<number>;
}
/**
 * The minimum shape we need from the ProcessLogStore.
 */
export interface LogStoreLike {
    append(pid: number, stream: 'stdout' | 'stderr', data: string): void;
    markExit(pid: number, code: number): void;
    getExit(pid: number): number | undefined;
}
/**
 * Constructor deps bundle. Keeping it as a single object simplifies
 * tests AND makes the production wiring in nimbus-session.ts read
 * declaratively.
 */
export interface FacetProcessManagerDeps {
    facetMgr: FacetManagerLike;
    processTable: ProcessTable | {
        spawn: (cmd: string, argv: string[], cwd: string) => any;
        exit: (pid: number, code: number) => void;
        kill: (pid: number) => boolean;
        get: (pid: number) => any;
        reap: () => number;
    };
    processLogs: LogStoreLike;
    vfs: {
        exists(p: string): boolean;
        readFileString(p: string): string;
        isDirectory(p: string): boolean;
    };
    commandRegistry: CommandRegistryLike;
    shellExecutor?: ShellExecutorLike;
    /** Optional: ctx for facets.abort/delete in production. */
    ctx?: {
        facets?: {
            abort?: (name: string, e?: any) => void;
            delete?: (name: string) => void;
        };
    };
    /**
     * child-process isolation gap #1: optional ChildProcessSpawnPool. When supplied,
     * `_dispatch` routes each spawn through the pool (one-task
     * NimbusFanoutPool.submitMany call per spawn), giving each spawn a
     * fresh Worker Loader isolate. When omitted, falls back to the
     * legacy in-supervisor dispatch (unit-test path; production wiring
     * always supplies it).
     */
    spawnPool?: {
        runOne: (req: any, kind: CommandKind, hooks: {
            onStdout: (d: string) => void;
            onStderr: (d: string) => void;
        }, childId: number | string) => Promise<number>;
    };
}
/** Cap recursion depth to defend against runaway spawn loops. */
export declare const CHILD_PROCESS_MAX_DEPTH = 8;
export declare class FacetProcessManager {
    private children;
    private nextPid;
    private deps;
    constructor(deps: FacetProcessManagerDeps);
    /**
     * Allocate a child PID, classify the command, dispatch to inline runner
     * or facet-direct runner. Returns immediately with the child PID; the
     * actual command executes asynchronously and pushes output via the
     * per-child hooks.
     */
    spawn(req: SpawnReq): Promise<{
        childPid: number;
    }>;
    /** Dispatch by kind. */
    private _dispatch;
    /**
     * child-process isolation gap #1: inline dispatch — runs the existing
     * pure-builtin / facet-direct logic with string-collecting hooks
     * and returns the final {exitCode, stdout, stderr} envelope.
     *
     * Called by _rpcCpDispatchInline (src/session/rpc.ts) which is in
     * turn called by the spawn-facet running inside a fresh Worker
     * Loader isolate. The dispatch envelope is in a fresh isolate; the
     * actual command logic still uses the existing registry paths.
     *
     * Single-ownership: stdin/stdout/stderr returned as strings; no
     * shared buffers cross the RPC boundary.
     */
    dispatchInline(req: SpawnReq, kind: string): Promise<{
        exitCode: number;
        stdout: string;
        stderr: string;
    }>;
    /**
     * Synchronously drain the stdin queue for a pure-builtin. Waits up to
     * 50ms for stdinClosed if data is still flowing. Pure-builtins block
     * on full stdin so we have to commit upfront — the parent should have
     * called stdinEnd() before the wait ticks expire.
     */
    private _waitForStdinEvent;
    private _drainStdinForBuiltin;
    private _shellPlanFor;
    private _dispatchShell;
    private _drainStdinForShell;
    private _runShellLine;
    stdinWrite(childPid: number, data: string): {
        ok: boolean;
    };
    stdinEnd(childPid: number): void;
    /**
     * Long-poll: child facet asks the supervisor for its next stdin chunk.
     * Returns immediately if data is already queued OR if stdin is closed.
     */
    cpReadStdin(childPid: number, waitMs: number): Promise<{
        data: string;
        ended: boolean;
    }>;
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
     * Synchronous kill. First-writer-wins on exit slot. Resolves all
     * pending waiters BEFORE invoking facets.abort so cpWait/cpReadOutput
     * don't hang on a torn-down facet.
     */
    kill(childPid: number, signal?: string): boolean;
    /**
     * Stamp the exit slot. Idempotent — first call wins.
     * Wakes all waiters (exit, output, stdin) so callers don't hang.
     */
    private _stampExit;
    /**
     * Late-arriving reportExit from the facet. Idempotent; if kill() or
     * an earlier reportExit already stamped, this is a no-op.
     */
    reportExit(childPid: number, exitCode: number, signal: string | null): void;
    /**
     * Long-poll wait. Returns immediately if already exited; otherwise
     * registers a waiter that resolves on the next exit-slot stamp.
     */
    wait(childPid: number, waitMs?: number): Promise<{
        done: boolean;
        exitCode: number | null;
        signal: string | null;
    }>;
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