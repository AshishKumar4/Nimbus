import { type StopRecord } from './stop-replay-contracts.js';
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
//# sourceMappingURL=stop-replay-host.d.ts.map