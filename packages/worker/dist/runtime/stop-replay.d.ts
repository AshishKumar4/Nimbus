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
 * The stop is `ctx.abort(string)`, which terminates the isolate's JavaScript
 * at once (V8 TerminateExecution): no catch, finally, microtask or timer of
 * the program runs after it. Its reason is a primitive string the guest
 * builds with functions it captured before the program ran (no Error object,
 * no JSON or base64 the program could have replaced), and reaches the caller
 * whole: the output the session has not acknowledged, and a tape of the
 * draws the run made inside its isolate (its random seed, clock readings,
 * random bytes, how much each synchronous read of stdin took). The
 * supervisor waits for the input (FacetManager.exec), then launches the same
 * program on the same pid from fresh module state with the stdin the stopped
 * run took, the input after it, and the tape.
 *
 * Everything else the run saw crossed from the session, and is checked there,
 * where the program cannot reach (ReplayJournal): every answer a supervisor
 * call got is journaled as a digest of what it carried, in the order the run
 * was answered, and a run after a stop must ask for the same things and be
 * answered the same, in that order, up to the read the run before stopped at
 * (the boundary). A request still unanswered at the stop is not answered
 * before the boundary. Its network goes through the session too (the
 * supervisor binding is also its outbound, SupervisorRPC.fetch/connect): a
 * response is recorded with its bytes and served again, and a connection is
 * something done outside the process. Output is checked at both ends: the
 * session keeps what it showed (ReplayOutputGate), and the guest drops what
 * it prints again only where it matches. Anything a run after a stop does
 * differently before the boundary ends it loudly (`diverged`), and nothing it
 * did differently reaches anyone.
 *
 * A run can be replayed only while it has done nothing outside itself: a
 * second run would do it again. The session counts every call that could
 * (any supervisor call not known to be a read or the process's own output,
 * any request but a read, any connection), and so does the guest, to fail
 * the read where the program can catch it: ERR_NIMBUS_SYNC_STDIN, naming the
 * first. A program that never reads stdin synchronously, or finds its input
 * there when it does, runs once and is never held: no static guess about the
 * code is made.
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
/** The most clock readings, stdin reads and random bytes a replayable run may draw. */
export declare const REPLAY_TAPE_MAX_READINGS = 65536;
export declare const REPLAY_TAPE_MAX_RANDOM_BYTES: number;
/** The most answers the session journals for one run; past it the run cannot be replayed. */
export declare const REPLAY_JOURNAL_MAX_ENTRIES = 65536;
/** The most response bytes the session records for one process's runs; past it, unreplayable. */
export declare const REPLAY_FETCH_MAX_BYTES: number;
/**
 * How long a run after a stop may go without asking for the next thing the
 * run before it was answered, while something it asked for waits behind it,
 * before it is taken to have strayed.
 */
export declare const REPLAY_STALL_MS = 15000;
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
    v: 3;
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
    /** A run whose output is captured, not streamed: what it had printed. */
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
 * The guest stops with a string (`ctx.abort(reason)`), which reaches the
 * caller as an Error with that message. Nothing in a record is used before
 * all of it is checked.
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
    /** A run strayed: nothing more it prints is delivered. */
    close(): void;
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
 * Supervisor calls whose answers carry what the program sees of a path: the
 * session journals them for a process that can stop. Not journaled: the
 * coherence calls (fsAcquire and its kin) and the namespace listing (fsList),
 * which describe the whole filesystem, so that any change anywhere would end
 * every replay; and descriptor bookkeeping. They say where to look and when;
 * what is there is read by one of these.
 */
export declare const JOURNALED_CALLS: ReadonlySet<string>;
/** What an op does outside the process, or null when it does nothing a second run would repeat. */
export declare function supervisorCallEffect(op: string, args: readonly unknown[] | undefined): string | null;
/**
 * A digest of what a value carries, the same for the same contents however it
 * was built: bytes as bytes, strings by UTF-16 unit, objects by sorted key.
 * Two independent FNV-1a lanes, 64 bits: it is to notice a file that changed
 * while a process waited, not to resist a chosen collision.
 */
export declare function answerDigest(value: unknown): string;
/** A recorded response: served to a run after a stop instead of fetching again. */
export interface RecordedResponse {
    status: number;
    statusText: string;
    headers: [string, string][];
    body: Uint8Array;
}
export interface Expected {
    digest: string | undefined;
    /** Null: not answered when the run before stopped. */
    completion: number | null;
    response?: RecordedResponse;
}
/** What makes a run after a stop stray: ReplayJournal hands it to the process's owner. */
export type DivergeHandler = (why: string) => void;
/**
 * The session's journal of one process that can stop, across its runs: what
 * each run was answered, and for a run after a stop, what it must be answered
 * again and in which order, up to the boundary (see the header). One per
 * process, created when it launches and closed when it ends.
 */
export declare class ReplayJournal {
    private readonly onDiverge;
    private readonly stallMs;
    /** The run being answered (its writer identity); another run's calls take nothing. */
    private run;
    /** This run's answers, or null once it cannot be replayed (nothing more is recorded). */
    private entries;
    private occurrences;
    private completions;
    /** Why the current run cannot be replayed: the first thing it did outside itself, or a bound. */
    unreplayable: string | null;
    diverged: string | null;
    private expected;
    private expectedCompleted;
    /** How many of those the run after the stop has asked for again. */
    private expectedAsked;
    private boundaryPassed;
    private delivered;
    private waiting;
    private atBoundary;
    private stall;
    private recordedBytes;
    /** Paths the process's stdin is (a `< file`), as storage keys: reading them is reading input. */
    private readonly inputPaths;
    constructor(onDiverge: DivergeHandler, stallMs?: number);
    /** A run begins: the writer identity its calls carry. */
    start(run: string): void;
    /**
     * The process's stdin is the file at `path` (`< file`). Reading it is
     * reading input, as a pipe's packets are, not the world the run saw: a run
     * after a stop reads ahead what the run before stopped short of. A call
     * that names only that file is answered without being journaled.
     */
    input(path: string): void;
    /** Whether a call made by `run` belongs to the run being answered. */
    admits(run: string | undefined): boolean;
    /** Whether the run being answered may still be stopped and replayed. */
    get replayable(): boolean;
    /**
     * Whether what the run is answered is still journaled: it may yet stop, or
     * it is a run after a stop still short of its boundary.
     */
    get recording(): boolean;
    /**
     * The current run stopped: what it was answered becomes what the next run
     * must be answered again, and what it was still waiting for is answered to
     * the next only past the boundary. Nothing it asked for is answered now.
     */
    stopped(): void;
    /** The process ended: nothing more is answered or held. */
    close(): void;
    /** The current run did something outside itself (or `what` makes it unreplayable): see the class. */
    effect(what: string): Error | null;
    /** The current run cannot be replayed (D1: nothing more is recorded for it). */
    disqualify(why: string): void;
    /** A supervisor call from the process: answered through `dispatch`, journaled, ordered. */
    handle(op: string, args: readonly unknown[] | undefined, run: string | undefined, dispatch: () => Promise<unknown>): Promise<unknown>;
    /**
     * One journaled answer: `produce` yields it (and a recording to keep, for a
     * response); a run after a stop is answered as the run before it was, or it
     * strays. Resolves when the program may have it.
     */
    answer<T>(key: string, what: string, produce: (expected?: Expected) => Promise<T>, record?: (value: T) => RecordedResponse | undefined): Promise<T>;
    /**
     * The run after a stop reached the read the run before stopped at. It must
     * have asked again for everything the run before was answered by then; an
     * answer still on its way (the run got to the read sooner) is checked when
     * it comes, and given in the run before's order. The program reaches the
     * read synchronously, so it cannot wait here for it: getting to the read
     * before an answer is an order Node can give too.
     */
    boundary(run: string | undefined): void;
    /** Whether a run after a stop is still retracing the run before it. */
    get replaying(): boolean;
    private hold;
    /** The answer in turn was given: the next in the run before's order may go. */
    private advance;
    private watch;
    private diverge;
    private failHeld;
}
/** A call's identity across runs: its op and arguments, digested. */
export declare function callKey(op: string, args: readonly unknown[] | undefined): string;
/** A call, for a person: its op and the first path it names. */
export declare function describeCall(op: string, args: readonly unknown[] | undefined): string;
/**
 * The guest half, spliced at module level into a facet runner before the
 * node shims: `const __nimbusStopReplay`, private to the runner module.
 *
 *   ledger(supervisor)   the SUPERVISOR binding, counting calls that do
 *                        something outside the process (default-deny), so the
 *                        read fails where the program can catch it. The
 *                        session counts them too, and is what decides.
 *   begin(launch)        per run: { replay, abort, captured, capturedText,
 *                        nonce, boundary, outbound }.
 *   arm(canStop, whyNot) before the entry: records the run's draws when it can
 *                        stop, replays the stopped run's.
 *   write / acked        each streamed chunk of output on its way out.
 *   readSome / readAll   how many bytes a synchronous read of stdin returns.
 *   block(until, syscall)  a read cannot complete: stops the run, or says why it cannot.
 *   effect(what) / unreplayable(why)  why a stop could not be replayed.
 *   finish() / booted()  at exit, or when a resident is up: a replay that
 *                        never reached the read it stopped at.
 *
 * What it does with the run's nonce in hand uses only what it captured
 * before the program ran: the stop record is serialized here by hand (no
 * JSON, btoa, Error or prototype method the program could have replaced) and
 * handed to ctx.abort as a primitive string.
 */
export declare const STOP_REPLAY_SOURCE: string;
//# sourceMappingURL=stop-replay.d.ts.map