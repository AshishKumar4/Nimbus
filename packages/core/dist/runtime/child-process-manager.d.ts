import type { ExitStatus } from './program-start.js';
import type { SessionProcessSupervisor } from './session-process-supervisor.js';
import type { ProcessView } from './process-files.js';
import type { CommandInputStream } from '../substrate/lifo/commands/types.js';
/**
 * Output chunk in a child's per-fd ring. Sequence numbers let parents
 * read incrementally with cpReadOutput(sinceSeq). The data is bytes: a
 * child's stdio is not text, and a string here would lose any byte sequence
 * that is not valid UTF-8.
 */
interface OutputChunk {
    seq: number;
    data: Uint8Array;
    /** Its number among the parent's news (ChildProcessManagerDeps.issueNews); 0 for none. */
    news: number;
}
/**
 * Per-child state retained for late drain/wait calls until explicitly reaped.
 */
interface ChildEntry {
    pid: number;
    /** The process that spawned it: whom its output, start and exit are news for. */
    parentPid: number;
    /**
     * Whose handle it is: the process that spawned it and every process above
     * that one, as they were at the spawn. A prune of their rows changes nothing.
     */
    holders: readonly number[];
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
    /** The parent closed its read end of fd 1 or 2 (closeOutput): the child's writes there fail, EPIPE. */
    outputClosed: {
        1: boolean;
        2: boolean;
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
    /** The parent's news this answer delivers (ChildProcessManagerDeps.issueNews). */
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
    /** The parent's news this answer delivers (ChildProcessManagerDeps.issueNews). */
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
/** Where a child runs from: its pid (whose credential it has), directory and environment. */
export interface ChildOrigin {
    readonly pid: number;
    readonly cwd: string;
    readonly env: Record<string, string>;
}
export interface ChildRunnerContext extends ChildOrigin {
    readonly parentPid: number;
    readonly command: string;
    readonly args: string[];
    readonly stdio: SpawnReq['stdio'];
    readonly stdin: CommandInputStream;
    readonly output: OutputHooks;
    /** Called by the runner only once the program actually starts. */
    readonly onStarted: () => void;
}
export interface SpawnRefusal {
    readonly code: string;
    readonly errno: number;
}
/** A run's end: an exit status, a start refused, or (a program another machine ran) waitpid's answer. */
export interface ChildRunner {
    run(context: ChildRunnerContext): Promise<number | SpawnRefusal | ExitStatus>;
}
export interface ChildProcessHost {
    resolve(request: SpawnReq, origin: ChildOrigin): Promise<ChildRunner | null>;
    /** End the host's work and clean its resources before the broker stamps the exit. */
    terminate(pid: number, signal: string): boolean;
    /**
     * Number a piece of news of a child as it is produced, for its parent
     * `parentPid`: output the parent reads, the child's start, the end of a
     * stream, its exit (fabric issueProcessNews). The reply that delivers it
     * carries the number, and the parent's report that it is blocked counts
     * only once it has applied every number issued. 0: not numbered.
     */
    issueNews?: (parentPid: number) => number;
}
export interface ChildProcessManagerDeps extends ChildProcessHost {
    processes: SessionProcessSupervisor;
}
/** Cap recursion depth to defend against runaway spawn loops. */
export declare const CHILD_PROCESS_MAX_DEPTH = 8;
/** A pipe holds its writer here until its reader acknowledges consumed chunks. */
export declare const CHILD_STDIO_QUEUE_MAX_BYTES: number;
export declare function normalizeChildCommand(command: string): string;
/** Shell spawns share parsing and script/stdin loading across local and remote hosts. */
export declare function shellChildRunner(request: SpawnReq, vfs: Pick<ProcessView, 'exists' | 'readFileString' | 'isDirectory'>, execute: (context: ChildRunnerContext, commandLine: string) => Promise<number>): ChildRunner | null;
export declare class ChildProcessManager {
    private children;
    private deps;
    constructor(deps: ChildProcessManagerDeps);
    /** Bind the platform's runner and cleanup to the workspace's existing broker. */
    bindHost(host: ChildProcessHost): void;
    /**
     * Allocate a child PID, classify the command, dispatch it to its runner.
     * Returns immediately with the child PID; the actual command executes
     * asynchronously, beside any other child, and pushes output via the
     * per-child hooks.
     */
    spawn(req: SpawnReq): Promise<{
        childPid: number;
    }>;
    private _dispatch;
    /**
     * A child the process table ended with a signal (its process group's, a
     * `kill <pid>`), not through this broker: it died of that signal, whatever
     * its run returned as it was stopped. Whether it was.
     */
    private _stampKilled;
    /**
     * The child's stdin as a stream over its queue: each read takes what the
     * parent has written, waiting for it, and ends when the parent ends stdin
     * or the child exits. Nothing is read ahead of the command's own reads.
     */
    private _stdinOf;
    /** `writer`, the process writing, is interrupted by a signal it takes (SessionProcessSupervisor.writeInputBytesWait). */
    stdinWrite(childPid: number, data: Uint8Array, writer?: number, withdraw?: AbortSignal): Promise<{
        ok: boolean;
        signal?: string;
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
    /** The signals `pid`'s program catches now (SessionProcessSupervisor.catchSignals). */
    catchSignals(pid: number, catches: readonly string[]): void;
    /** The next signal sent to `pid`, whose program takes its own (SessionProcessSupervisor.nextSignal). */
    nextSignal(pid: number, waitMs: number): Promise<string | null>;
    /** A broker-side text message onto the child's byte ring. */
    private _appendText;
    /** Whether this pid's descriptors belong to a child managed by this broker. */
    isChild(pid: number): boolean;
    /**
     * Whether child `pid`'s handle is `caller`'s: `caller` spawned it, or is
     * above the process that did, as the spawn found them. It holds as long as
     * the broker holds the child's output and exit, whatever rows the process
     * table has forgotten since. False for a pid this broker did not spawn.
     */
    isHeldBy(pid: number, caller: number): boolean;
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
     * The parent closed its read end of the child's fd 1 or 2 (a consumer
     * destroyed the stream): what is queued there goes, and the child's
     * writes there, those waiting for room and those to come, fail EPIPE, as a
     * write to a pipe whose reader has gone does.
     */
    closeOutput(childPid: number, fd: 1 | 2): void;
    /**
     * One-shot final flush. Used by the parent's exit-time drain (BLOCKER-1
     * fix in W8-plan §8.5). Returns ALL pending output for both fds plus
     * the closed state. Does NOT wait — caller is the parent shutting down.
     */
    drainOutput(childPid: number): Promise<DrainResult>;
    /**
     * End the host's work and clean its resources first: exit(), used by the
     * stamp, drops the terminator without running it. The first stamp wins.
     */
    kill(childPid: number, signal?: string | number): boolean;
    /**
     * Stamp the exit slot. Idempotent — first call wins. What the child held
     * is released now (the process table's lifecycle); its parent is told
     * once the end is published (_ended).
     */
    private _stampExit;
    /** Whether the child's end is published (SessionProcessSupervisor.endHeld): what wait and its streams report. */
    private _ended;
    /** The child's published end, to its waiters: wakes all of them (exit, output, stdin) so callers don't hang. */
    private _announceExit;
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
    /** A piece of news of `child` for its parent, numbered (ChildProcessManagerDeps.issueNews). */
    private _news;
    /** Forget child `pid` once its end is published: its holder has taken its output and exit. */
    release(childPid: number): void;
    /** Reap entries older than maxAgeMs whose end is published. */
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
/** A facet's child-process capability. Its parent identity and stdin cannot be borrowed from another pid. */
export declare function createChildProcessSupervisor(manager: ChildProcessManager, pid: number): {
    cpSpawn: (request: SpawnReq) => Promise<{
        childPid: number;
    }>;
    cpStdinWrite: (child: number, bytes: Uint8Array) => Promise<{
        ok: boolean;
        signal?: string;
    }>;
    cpStdinEnd: (child: number) => Promise<void>;
    cpReadOutput: (child: number, fd: 1 | 2, sinceSeq: number, waitMs?: number) => Promise<ReadOutputResult>;
    cpWait: (child: number, waitMs?: number, _acquire?: object, knownStarted?: boolean) => Promise<ChildExitStatus>;
    cpKill: (child: number, signal?: string | number) => boolean;
    cpReadStdin: (_child: number, waitMs: number, _acquire?: object, maxBytes?: number) => Promise<{
        data: Uint8Array;
        ended: boolean;
    }>;
    cpCloseOutput: (child: number, fd: 1 | 2) => void;
    cpDrainOutput: (child: number) => Promise<DrainResult>;
    cpNextSignal: (waitMs: number) => Promise<string | null>;
    cpCatchSignals: (catches: readonly string[]) => void;
};
export {};
//# sourceMappingURL=child-process-manager.d.ts.map