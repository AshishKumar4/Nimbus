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
 * program runs after it, so the program cannot observe it. The abort's reason
 * reaches the caller whole and carries the stop record: the output the
 * session has not acknowledged, and a tape of what the run drew from outside
 * itself — its random seed, clock readings and random bytes, how much each
 * synchronous read of stdin took, and a hash of everything it observed (each
 * file read, stat, listing and response body), in the order it asked. The
 * supervisor waits for the input (FacetManager.exec), then launches the same
 * program on the same pid from fresh module state with the stdin the stopped
 * run took, the new input after it, and the tape. That run replays the tape
 * up to the read the stopped run stopped at (the boundary): the same draws,
 * the same reads, the same observations, the same output on both streams,
 * which the session already showed and which is checked and dropped. At the
 * boundary both streams must have printed exactly what the stopped run had;
 * from there the program goes on with its input. A replay that observes,
 * prints or does anything else before the boundary is ended loudly
 * (`diverged`); nothing it did differently reaches anyone.
 *
 * A run can be replayed only while it has done nothing outside itself: a
 * second run would do it again. The guest counts every call that could (the
 * SUPERVISOR binding by default-deny, fetch, sockets, http clients), and a
 * read that finds its input missing in a run that made one fails with
 * ERR_NIMBUS_SYNC_STDIN naming it. A program that never reads stdin
 * synchronously, or finds its input there when it does, runs once and is
 * never held: no static guess about the code is made.
 *
 * The guest half is private to the runner module (`const __nimbusStopReplay`,
 * never on globalThis), and a stop record counts only when it carries the
 * run's nonce, which the session mints per run and only that module holds:
 * a program cannot stop itself, or forge a stop by throwing.
 */
/** What an abort's reason starts with when it is a stop record, before the run's nonce. */
export declare const STOP_RECORD_PREFIX = "NIMBUS_STOP ";
/** How many times one process may stop before its read fails instead. */
export declare const STOP_LIMIT = 64;
/**
 * The most output per stream a run may have printed and still be replayed:
 * the next run is checked against all of it, so the session keeps it.
 */
export declare const REPLAY_PREFIX_MAX_BYTES: number;
/** The most clock readings, observations and random bytes a replayable run may draw. */
export declare const REPLAY_TAPE_MAX_READINGS = 65536;
export declare const REPLAY_TAPE_MAX_RANDOM_BYTES: number;
/**
 * SUPERVISOR calls that change nothing outside the process: reads, its own
 * output, what it learned for its next launch. Every other call counts as one
 * a second run would repeat, including any name added to SupervisorRPC later.
 * `fsOpen` counts only when it opens for writing (STOP_REPLAY_SOURCE). The
 * umask a program sets is the process's own and is put back before a second
 * run (FacetManager.exec).
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
    /** How many bytes each completed synchronous read of stdin returned. */
    reads: number[];
    /** A hash of each observation (file read, stat, listing, response body), by the order it was asked for. */
    obs: (number | null)[];
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
    v: 2;
    /** `stdin`: a read needs input not there yet. `diverged`: a replay did not retrace the run before it. */
    kind: 'stdin' | 'diverged';
    /** The run that stopped (1 for the first). */
    run: number;
    out: StoppedOutput[];
    /** `stdin`: what the read waits for, the end of stdin or any of it. */
    until?: 'end' | 'data';
    /** `stdin`: how many synchronous reads of stdin completed before the one that stopped. */
    stopAt?: number;
    tape?: ReplayTape;
    /** A run whose output is captured, not streamed: what it had printed, base64. */
    captured?: {
        stdout: string;
        stderr: string;
    };
    /** `diverged`: how. */
    why?: string;
}
/** What a run after a stop is handed (the runner's `args.replay`). */
export interface ReplayLaunch {
    run: number;
    tape: ReplayTape;
    /** The synchronous read the run before stopped at: where the replay must have printed all of `prefix`. */
    stopAt: number;
    /** What the session showed of each stream, base64: the replay prints it again first. Null when output is captured. */
    prefix: {
        stdout: string;
        stderr: string;
    } | null;
}
export declare function decodeBase64(text: string | undefined): Uint8Array;
export declare function encodeBase64(bytes: Uint8Array): string;
/**
 * The stop record `error` carries for run `run` of a launch whose nonce is
 * `nonce`, or null when it carries none: any other error, a record of another
 * run or launch, or one that does not hold to the record's shape and bounds.
 * Nothing in a record is used before all of it is checked.
 */
export declare function stopRecordOf(error: unknown, nonce: string, run: number): StopRecord | null;
/**
 * The session's side of a process's output across its runs: each chunk a run
 * prints arrives tagged with the run and its offset, so a chunk the session
 * already has (it also rode a stop) is delivered once, and a stopped run's
 * late chunk is dropped (it rode the stop, or its successor prints it). It
 * keeps what it delivered, up to REPLAY_PREFIX_MAX_BYTES a stream: the prefix
 * the next run is checked against is what the session showed, not what a run
 * says it showed.
 */
export declare class ReplayOutputGate {
    run: number;
    private received;
    private shown;
    /** More than REPLAY_PREFIX_MAX_BYTES was shown on a stream: no run after a stop can be checked. */
    over: boolean;
    /** The part of a chunk not yet delivered. */
    take(stream: 'stdout' | 'stderr', data: Uint8Array, at: number, run: number): Uint8Array;
    /**
     * Run `record.run` stopped: what its record carries that is not yet
     * delivered, in order, and the prefix its successor must print first (null
     * when more was shown than a run can be checked against). Its successor's
     * output starts past the prefix.
     */
    stopped(record: StopRecord): {
        fresh: {
            stream: 'stdout' | 'stderr';
            bytes: Uint8Array;
        }[];
        prefix: Record<'stdout' | 'stderr', Uint8Array> | null;
    };
}
/**
 * Bytes held as owned pieces of a fixed size, however small the writes that
 * brought them: a writer's one-byte writes cost a piece per 64 KiB, not an
 * array and a packet each.
 */
export declare class OwnedPieces {
    static readonly SIZE: number;
    private readonly pieces;
    private used;
    bytes: number;
    add(data: Uint8Array): void;
    /** The pieces, the last cut to what it holds; call once. */
    finish(): Uint8Array[];
}
/**
 * What a run took from its stdin channel, as the session handed it over
 * (cpReadStdin): what goes back in front of the channel for the next run,
 * whatever the run says it took. Only the current run of the process may read
 * its channel: a stopped run's read still in flight takes nothing, so it
 * cannot swallow the input its successor waits for.
 */
export declare class StdinTaken {
    private readonly hold;
    private readonly limit;
    private writerId;
    private pieces;
    private over;
    constructor(hold: {
        take(max: number): number;
        give(n?: number): void;
    }, limit: number);
    /** A run with this writer identity starts: it alone reads the channel. */
    start(writerId: string): void;
    /** The run stopped: no run reads the channel until the next starts. */
    retire(): void;
    /** Whether a read by this writer identity may take from the channel. */
    admits(writerId: string | undefined): boolean;
    /** The current run was handed these bytes. */
    note(data: Uint8Array): void;
    /**
     * What the stopped run took, in order, and its size, still held against the
     * budget (the caller gives it back once it hands it on); null when it took
     * more than the limit. The next run's account starts empty.
     */
    take(): {
        chunks: Uint8Array[];
        bytes: number;
    } | null;
    /** Give back what is held: the process ended. */
    release(): void;
}
/**
 * The guest half, spliced at module level into a facet runner before the
 * node shims: `const __nimbusStopReplay`, private to the runner module.
 *
 *   ledger(supervisor)   the SUPERVISOR binding, counting calls that do
 *                        something outside the process (default-deny).
 *   begin(launch)        per run: { replay, abort, captured, capturedText, nonce }.
 *   arm(canStop, whyNot) before the entry: records what the run draws when it
 *                        can stop, replays what the stopped run drew.
 *   write / acked        each streamed chunk of output on its way out.
 *   readSome / readAll   how many bytes a synchronous read of stdin returns.
 *   block(until, syscall)  a read cannot complete: stops the run, or says why it cannot.
 *   observe / observeLater / observeStream  what the program saw of a file,
 *                        a listing or a response.
 *   effect(what) / unreplayable(why)  why a stop could not be replayed.
 *   finish() / booted()  at exit, or when a resident is up: a replay that
 *                        never reached the read it stopped at.
 */
export declare const STOP_REPLAY_SOURCE: string;
//# sourceMappingURL=stop-replay.d.ts.map