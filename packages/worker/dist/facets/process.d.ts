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
 * parent's exit path so unawaited children don't lose output. A child's
 * stdin is a pipe: what runs it here reads the queue as a stream, as the
 * parent writes it (`_stdinOf`), and a runtime's facet reads the same queue
 * through cpReadStdin.
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
import type { SessionProcessSupervisor } from '@nimbus-sh/core/runtime/session-process-supervisor.js';
import type { ProcessView } from '@nimbus-sh/core/runtime/process-files.js';
import type { CommandInputStream } from '@nimbus-sh/core/substrate/lifo/commands/types.js';
import type { SqlDatabase } from '@nimbus-sh/core/runtime/os-contracts.js';
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
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    facetName: string;
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
    stdin?: string;
    /** Supervisor-assigned invoking process PID. */
    parentPid: number;
    /** Broker-assigned child PID for isolated inline dispatch. */
    processPid?: number;
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
 * Hooks invoked by the inline runner / facet-direct runner to push
 * output back into the per-child ring. Kept as a small structural type
 * so tests can supply mocks. They carry bytes; a text producer encodes at
 * its own edge (see `textBytes`).
 */
export interface OutputHooks {
    onStdout: (data: Uint8Array) => void;
    onStderr: (data: Uint8Array) => void;
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
    abort?(facetName: string, signal?: string): boolean;
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
    /** Optional: ctx for facets.abort/delete in production. */
    ctx?: {
        facets?: {
            abort?: (name: string, e?: any) => void;
            delete?: (name: string) => void;
        };
        storage?: {
            sql?: SqlDatabase;
        };
    };
    /** Optional Worker Loader pool for isolating child-process dispatch. */
    spawnPool?: {
        runOne: (req: any, kind: Exclude<CommandKind, 'unknown'>, hooks: OutputHooks) => Promise<number>;
    };
}
/** Cap recursion depth to defend against runaway spawn loops. */
export declare const CHILD_PROCESS_MAX_DEPTH = 8;
export declare class FacetProcessManager {
    private children;
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
     * A managed child streams to its existing output queue while it runs;
     * otherwise the inline caller receives captured text in the result.
     */
    dispatchInline(req: SpawnReq, kind: string): Promise<{
        exitCode: number;
        stdout: string;
        stderr: string;
    }>;
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
    stdinWrite(childPid: number, data: Uint8Array): {
        ok: boolean;
    };
    stdinEnd(childPid: number): void;
    /**
     * Put stdin the child took back in front of its queue, as it was, past the
     * queue's cap and after its end too: a run of the child that stopped
     * before using it, run again (runtime/stop-replay.ts).
     */
    unreadStdin(childPid: number, chunks: readonly Uint8Array[]): void;
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