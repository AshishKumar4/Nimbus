/**
 * wave-writer.ts — a producer's writes into the session, as W7 waves.
 *
 * The one W7 producer: git's network facet (a clone's files, fetch and
 * pull's objects and refs), npm's install facet (package files), and the
 * session's own bulk writes (npm bin shims, the clang sysroot). Each write
 * is a record: a file, a link, a directory, or a removal. The writer buffers
 * records into a wave and publishes the wave through one writeBatchStream()
 * call. A wave closes before it would pass W7's owned-path bounds (count and
 * bytes: files, removals and the directories above them, up to the root) or
 * its byte budget; a file larger than the budget travels in a wave of its
 * own, and one streamed from a source is never held whole.
 *
 * Pipelining: one wave is in flight while the next one buffers. A wave
 * starts only once its predecessor has published, so a producer waits only
 * when it fills a second wave, and a failed wave is the last this writer
 * sends: the failure names its wave, and every later call rejects with it.
 * Waves publish in order, so a record written after another is durable only
 * if that one is: a completion marker written last proves what came before.
 *
 * Lost transport (lost-call.ts, the one policy for it): a wave whose call
 * failed before the session answered (isLostFencedCall), or that nothing
 * read for LOST_STREAM_STALL_MS before its end, or that stayed unanswered
 * LOST_STREAM_ANSWER_MS after it, is sent again after a backoff, at most
 * LOST_CALL_RESEND_BACKOFF_MS.length times. The abandoned attempt's stream
 * is errored so it reads nothing more, and every attempt carries its fence
 * (writer, wave, attempt): the session refuses an attempt older than one it
 * has seen, so a late original never applies over its re-send.
 * Re-sending is safe: a wave is the same paths and bytes, replacing. A shed
 * wave never ran; the platform's advice is not to retry an overloaded
 * object, but these waves are few and backed off, and npm measured the
 * re-send recover a 119-package install that otherwise lost 31 packages to
 * one shed. A wave the session answered (ok: false) is its verdict and is
 * never retried, nor is a wave with a streamed source (its source is spent).
 *
 * Fault domains: with `failPerOwner`, a record's `meta` is its owner (an
 * npm package), and a failed wave whose records all have owners fails those
 * owners (their later records reject, their buffered ones are not sent)
 * while the writer goes on for the rest. Otherwise, and for a failed wave
 * carrying anything unowned (a directory or removal record, the pin, a
 * record without meta), the failed wave is the last one sent.
 *
 * Admitting a record costs its own new directories, never a recount of the
 * wave: the owned set grows as records arrive, and a directory chain walk
 * stops at the first directory already owned (whose chain is owned).
 * Records may be written concurrently (an install writes several packages
 * at once): each is admitted and buffered in call order.
 *
 * Several writers may publish into one session at once (a clone's parallel
 * producers); each is its own stream, and the session takes them
 * concurrently.
 */
/** Paths a wave holds back from W7's bound, for its pinned marker and the marker's directories. */
export declare const WAVE_PATHS: number;
export declare const WAVE_PATH_BYTES: number;
/** Buffered content bytes that close a wave. */
export declare const WAVE_BYTES: number;
/**
 * Which attempt of which wave under which writer epoch a stream is. The
 * session issued the epoch (openWaveWriter) and refuses, by default, an
 * attempt under an epoch it does not hold open, or older than one it has
 * admitted under it: an attempt the writer gave up on never applies after
 * its re-send, however late it arrives.
 */
export interface WaveFence {
    writer: string;
    wave: number;
    attempt: number;
}
/** The supervisor surface a writer publishes through. */
export interface WaveSupervisor {
    /** `fence` is absent when the supervisor issued no epoch: the session fences nothing. */
    writeBatchStream(stream: ReadableStream<Uint8Array>, fence?: WaveFence): Promise<unknown>;
    /**
     * A writer epoch from the session, the only identity it admits fenced
     * waves under, or null when it fences nothing. Absent on a supervisor
     * that is the session itself (nothing between them can lose a call).
     */
    openWaveWriter?(): Promise<string | null>;
}
/** A published file as the session will stat it: what a warm index entry needs. */
export interface WaveFileReceipt {
    path: string;
    ino: number;
    mode: number;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
    uid: number;
    gid: number;
    dev: number;
}
export interface WaveReport {
    wave: number;
    files: number;
    bytes: number;
    rpcWallMs: number;
    receipts: WaveFileReceipt[];
}
/** What one wave carried, for the caller's own view of the paths it published. */
export interface WaveCut<Meta> {
    wave: number;
    mtimeMs: number;
    /** Each file and link, with what its caller attached to the record. */
    files: {
        path: string;
        meta: Meta | undefined;
    }[];
    directories: string[];
}
export interface WaveWriterOptions<Meta = undefined> {
    supervisor: WaveSupervisor;
    /**
     * The directory a wave publishes up to, inclusive: a record's directories
     * above it are not the writer's. Null publishes every ancestor.
     */
    root: string | null;
    /** An existing worktree: only directories strictly below it are published. */
    worktreeRoot?: string | null;
    /** Record paths are relative to it (joined with '/'); omitted, they are VFS paths. */
    base?: string;
    /** Wall-clock time (ms) after which no new wave starts. */
    deadline?: number | null;
    /** Every inode's mtime; omitted, each wave stamps the time it was cut. */
    mtimeMs?: number;
    /** A directory's mode, as the caller knows it; omitted or undefined, 0o755. */
    directoryMode?: (path: string) => number | undefined;
    /** Called synchronously as a wave is cut, before it is sent. */
    onCut?: (cut: WaveCut<Meta>) => void;
    /** Called once per published wave, in order. */
    onWave?: (report: WaveReport) => void;
    /** A record's `meta` names its owner, and a failed wave fails only the owners it carried. */
    failPerOwner?: boolean;
    /** The lost-call policy's timings (lost-call.ts); tests shorten them. */
    retry?: {
        backoffMs: readonly number[];
        stallMs: number;
        answerDeadlineMs: number;
    };
    /** Called before each re-send of a lost wave, with its lost-call attributes (lost-call.ts). */
    onResend?: (lost: Record<string, string | number>) => void;
}
export interface WaveStats {
    waves: number;
    files: number;
    bytes: number;
    rpcWallMs: number;
    maxRpcWallMs: number;
    producerWaitMs: number;
    /** Paths probed by ownership accounting: linear in records, never wave × records. */
    ownershipVisits: number;
    maxWavePaths: number;
    maxWaveBytes: number;
    /** Waves sent again after their transport was lost. */
    retries: number;
}
export declare class WaveFailure extends Error {
    readonly wave: number;
    constructor(wave: number, cause: unknown);
}
export declare class WaveWriter<Meta = undefined> {
    private readonly options;
    private readonly records;
    private readonly directories;
    private readonly deletes;
    private bufferedBytes;
    private symlinks;
    /** Links in the wave in flight: sent, not yet published. */
    private inFlightSymlinks;
    /** Every path the buffered wave publishes; a superset once a buffered record is removed. */
    private readonly owned;
    /** The upward-closed part of `owned`: each one's chain, to the root, is owned too. */
    private readonly ownedDirectories;
    private ownedPathBytes;
    private pin;
    private inFlight;
    private cutQueue;
    private sequence;
    private failure;
    /** Owners (records' `meta`) whose records a failed wave carried. */
    private readonly failedOwners;
    private readonly counters;
    /** The session's epoch for this writer, and when it was opened (null: unfenced). */
    private epoch;
    /** Mutations run one at a time, in call order: concurrent writers interleave by record. */
    private mutations;
    constructor(options: WaveWriterOptions<Meta>);
    /** Run `mutate` once every mutation called before it has finished. */
    private exclusive;
    /**
     * A regular file. The writer takes `bytes`; a view sharing its buffer is
     * copied. `meta` rides with the record, back to the caller as it is cut.
     */
    file(path: string, mode: number, bytes: Uint8Array, meta?: Meta): Promise<void>;
    /** A symbolic link to `target`. */
    symlink(path: string, target: string, meta?: Meta): Promise<void>;
    /**
     * A regular file of `size` bytes read from `chunks` as its wave drains:
     * the buffered wave is sent first, then this file travels alone, and the
     * call resolves once its source is consumed.
     */
    fileChunks(path: string, mode: number, size: number, chunks: AsyncIterable<Uint8Array>, meta?: Meta): Promise<void>;
    /** A directory (an empty one, a gitlink): files' directories need no record. */
    directory(path: string): Promise<void>;
    /**
     * Remove what stands at `path`, its subtree included. A buffered record at
     * the path is dropped; with `directory`, a buffered mkdir of it too.
     */
    remove(path: string, directory?: boolean): Promise<void>;
    /**
     * A file every wave re-asserts until a wave carrying it publishes (a
     * clone's ownership marker): parent directories publish independently of
     * files, so each wave leaves the marker's proof in place. `durable` says
     * these bytes are already published.
     */
    setPin(path: string, text: string, durable?: boolean): void;
    clearPin(path: string): void;
    /** The bytes buffered at `path`, if a file or link is. */
    buffered(path: string): Uint8Array | undefined;
    /** The buffered file or link at `path`: its kind, size and the caller's `meta`. */
    bufferedRecord(path: string): {
        kind: 'file' | 'symlink';
        size: number;
        meta: Meta | undefined;
    } | undefined;
    isBufferedDirectory(path: string): boolean;
    isBufferedDelete(path: string): boolean;
    bufferedPaths(): {
        files: Iterable<string>;
        directories: Iterable<string>;
        deletes: Iterable<string>;
    };
    /** Whether a link is buffered or in flight: written, not yet published. */
    get hasUnpublishedSymlinks(): boolean;
    /** Every record written before this call is durable; rejects with the first failed wave. */
    flush(): Promise<void>;
    /** The wave in flight has settled; nothing new is cut. */
    settled(): Promise<void>;
    assertHealthy(): void;
    /** The failure of the wave that carried `owner`'s records, if one failed. */
    failureOf(owner: Meta): WaveFailure | undefined;
    private assertOwnerHealthy;
    get failed(): WaveFailure | null;
    stats(): WaveStats;
    private key;
    private tally;
    private hasBuffered;
    private ownPath;
    /** collectDirectoryPaths' chain from `path` upward, to the first directory already owned. */
    private walkChain;
    /** Cut waves until `path` (with its chain) and `bytes` fit beside what is buffered. */
    private admit;
    private buffer;
    private drop;
    private cutIfFull;
    /**
     * Send the buffered wave once the one in flight has published. Cuts are
     * serialised, so at most one wave is in flight and one buffers.
     */
    private cut;
    private cutNow;
    /**
     * Send one wave, again while its transport is lost (see the module's
     * comment), and answer with what the session answered.
     */
    private send;
    /**
     * The epoch this writer's waves are fenced under: opened before its first
     * wave, and again once half of WAVE_EPOCH_TTL_MS has passed, so a wave is
     * never sent under an epoch about to close.
     */
    private currentEpoch;
    /** The directories the buffered records publish, shallowest first. */
    private publishedDirectories;
    private bufferPin;
}
export declare function createWaveWriter<Meta = undefined>(options: WaveWriterOptions<Meta>): WaveWriter<Meta>;
//# sourceMappingURL=wave-writer.d.ts.map