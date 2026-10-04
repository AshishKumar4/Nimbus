/**
 * Stop and replay: a synchronous read of stdin that has to wait.
 *
 * Node's `fs.readFileSync(0)` blocks the whole program until its writer ends
 * stdin, and `fs.readSync(0, …)` until some of it arrives. A Nimbus process
 * is JavaScript in a workerd isolate, which has no way to block: workerd turns
 * Atomics.wait off (jsg/setup.c++, SetAllowAtomicsWait(false)), every I/O
 * call returns a promise, and JSPI suspends wasm frames only ("trying to
 * suspend JS frames"). A read that finds its input not there yet cannot wait
 * for it in place.
 *
 * So the run stops there and the program runs again once the input is there.
 * The stop is `ctx.abort()`, which terminates the isolate's JavaScript at
 * once (V8 TerminateExecution): no catch, finally, microtask or timer of the
 * program runs after it, so the program cannot observe it. The abort's
 * reason reaches the caller whole, and carries the stop record: the output
 * the session has not acknowledged, and what the stopped run drew from the
 * outside — its random seed, the clock readings, the random bytes, the stdin
 * bytes and how much each read took. The supervisor waits for the input
 * (FacetManager.exec), then launches the same program on the same pid from
 * fresh module state. That run replays the record: the same draws in the same
 * order, the same reads, so the program takes the same path to the read,
 * printing the same bytes, which are checked against and dropped; then the
 * read finds its input and the program goes on. Output the replay prints
 * differently fails the process loudly rather than reaching anyone.
 *
 * A run can be replayed only while it has changed nothing outside itself: a
 * second run would change it again. The guest counts every call that could
 * (STOP_REPLAY_SOURCE's ledger, at the SUPERVISOR binding and at fetch), and
 * a read that finds its input missing in a run that made one fails with
 * ERR_NIMBUS_SYNC_STDIN naming it. A program that never reads stdin
 * synchronously, or finds its input there when it does, runs once and is
 * never held: no static guess about the code is made.
 */
/** What an abort's reason starts with when it is a stop record. */
export declare const STOP_RECORD_PREFIX = "NIMBUS_STOP ";
/** How many times one process may stop before its read fails instead. */
export declare const STOP_LIMIT = 64;
/**
 * The most output per stream a run may have printed and still be replayed:
 * the next run is checked against all of it, so the stop carries it.
 */
export declare const REPLAY_PREFIX_MAX_BYTES: number;
/** The most clock readings, and random bytes, a replayable run may draw. */
export declare const REPLAY_TAPE_MAX_READINGS = 65536;
export declare const REPLAY_TAPE_MAX_RANDOM_BYTES: number;
/**
 * SUPERVISOR calls that change nothing outside the process: reads, its own
 * output, what it learned for its next launch, and its own per-process state
 * (umask, a descriptor's position). Every other call counts as a change a
 * second run would repeat, including any name added to SupervisorRPC later.
 * `fsOpen` counts only when it opens for writing (STOP_REPLAY_SOURCE).
 */
export declare const SUPERVISOR_CALLS_WITHOUT_EFFECTS: readonly string[];
/** What a stopped run drew from the outside, to be drawn again in the same order. */
export interface ReplayTape {
    /** Math.random's seed (four uint32 words). */
    seed: number[];
    /** Date's clock readings, run-length encoded: [value, times]. */
    now: [number, number][];
    /** performance.now's readings, run-length encoded. */
    perf: [number, number][];
    /** Bytes crypto.getRandomValues handed out, base64. */
    random: string;
    /** How many bytes each synchronous read of stdin returned. */
    reads: number[];
}
/** A chunk of output the session had not acknowledged when the run stopped. */
export interface StoppedOutput {
    s: 'stdout' | 'stderr';
    /** Its offset in what the run printed to that stream. */
    at: number;
    /** base64. */
    b: string;
}
export interface StopRecord {
    v: 1;
    /** `stdin`: a read needs input not there yet. `diverged`: a replay printed differently. */
    kind: 'stdin' | 'diverged';
    /** The run that stopped (1 for the first). */
    run: number;
    /** What the read waits for: the end of stdin, or any of it. */
    until?: 'end' | 'data';
    syscall?: string;
    /** The stdin bytes the run took from its channel before it started, base64. */
    taken?: string;
    out?: StoppedOutput[];
    /** Everything the run printed, per stream, base64: what the next run must print first. */
    prefix?: {
        stdout: string;
        stderr: string;
    } | null;
    tape?: ReplayTape;
    /** `diverged`: which stream, and the first byte that differed. */
    stream?: 'stdout' | 'stderr';
    at?: number;
}
/** What a relaunch is handed (the runner's `args.replay`). */
export interface ReplayLaunch {
    run: number;
    tape: ReplayTape;
    prefix: {
        stdout: string;
        stderr: string;
    } | null;
}
/** The stop record an error carries, or null for any other error. */
export declare function stopRecordOf(error: unknown): StopRecord | null;
export declare function decodeBase64(text: string | undefined): Uint8Array;
/**
 * The session's side of a process's output across its runs: each chunk a run
 * prints arrives tagged with the run and its offset, so a chunk the session
 * already has (it also rode a stop) is delivered once, and a stopped run's
 * late chunk is dropped (it rode the stop, or its run's successor prints it).
 */
export declare class ReplayOutputGate {
    run: number;
    private received;
    /** The part of a chunk not yet delivered. */
    take(stream: 'stdout' | 'stderr', data: Uint8Array, at: number, run: number): Uint8Array;
    /**
     * Run `record.run` stopped: what its record carries that is not yet
     * delivered, in order. Its successor's output starts past the prefix, which
     * the session then holds whole.
     */
    stopped(record: StopRecord): {
        stream: 'stdout' | 'stderr';
        bytes: Uint8Array;
    }[];
}
/**
 * The guest half, spliced at module level into a facet runner before the
 * node shims: `globalThis.__nimbusStopReplay`.
 *
 *   ledger(supervisor)  the SUPERVISOR binding, counting calls that change
 *                       something outside the process.
 *   begin(replay, abort, captured)  per run: the replay it was handed, how to
 *                       stop it (ctx.abort), and whether its output is
 *                       captured rather than streamed.
 *   arm(canStop, whyNot)  before the entry: records what the run draws when
 *                       it can stop, replays what the stopped run drew.
 *   write / acked       each chunk of output on its way to the supervisor.
 *   read(n)             how many bytes a synchronous read of stdin returns.
 *   effect(what) / unreplayable(why)  why a stop could not be replayed.
 *   stop(until, syscall, taken)  stops the run; returns the reason it cannot.
 *   finish()            at exit: a replay that printed less than its prefix.
 */
export declare const STOP_REPLAY_SOURCE: string;
//# sourceMappingURL=stop-replay.d.ts.map