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
/** Filesystem changes a run that can be run again records, and the bytes they carry. */
export declare const REPLAY_TAPE_MAX_WRITES = 4096;
export declare const REPLAY_TAPE_MAX_WRITE_BYTES: number;
export declare const REPLAY_WRITE_ENTRY_MAX_CHARS = 8192;
/** The most answers the session journals for one run; past it the run cannot be replayed. */
export declare const REPLAY_JOURNAL_MAX_ENTRIES = 65536;
/** Joined reads keep their actual answers until the run ends, including lost-response resends. */
export declare const REPLAY_READ_RECEIPT_MAX_BYTES: number;
/** The most response bytes the session records for one process's runs; past it, unreplayable. */
export declare const REPLAY_FETCH_MAX_BYTES: number;
/**
 * How long a run after a stop may go without asking for the next thing the
 * run before it was answered, while something it asked for waits behind it,
 * before it is taken to have strayed.
 */
export declare const REPLAY_STALL_MS = 15000;
/** The longest stop record the session reads; a longer one is not a stop. */
export declare const STOP_RECORD_MAX_CHARS: number;
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
    /** Each change it made to the filesystem: its call, its path and a digest of all of it. */
    writes: string[];
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
    /**
     * `stdin`: a read needs input not there yet. `listen`: a one-shot's first
     * listen, to be run again as a resident. `diverged`: a replay did not
     * retrace the run before it.
     */
    kind: 'stdin' | 'listen' | 'diverged';
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
    stopAt?: number;
    /** The run before stopped at its first listen instead: the replay's boundary is there. */
    listen?: true;
    /** What the session showed of each stream, base64: the replay prints it again first. Null when output is captured. */
    prefix: {
        stdout: string;
        stderr: string;
    } | null;
    /** Completed supervisor/network observations the guest must receive again. */
    observations?: Record<string, number>;
}
/** A complete response, or the exact body failure after its headers. */
export interface RecordedResponse {
    status: number;
    statusText: string;
    headers: [string, string][];
    hasBody: boolean;
    body: Uint8Array;
    chunks?: number[];
    bodyError?: string;
    bodyFailure?: ReplayFailure;
}
export interface ReplayFailure {
    name: string;
    message: string;
    stack?: string;
    properties: Record<string, unknown>;
    cause?: ReplayFailure;
}
export type RecordedBody = {
    body: Uint8Array;
    digest: string;
    chunks: number[];
    error?: string;
    failure?: ReplayFailure;
} | {
    error: string;
    failure?: ReplayFailure;
} | {
    tooLarge: true;
};
//# sourceMappingURL=stop-replay-contracts.d.ts.map