/**
 * git/wave-writer.ts — a producer's writes into the session, as W7 waves.
 *
 * Every git write a facet makes (a clone's files, fetch and pull's objects
 * and refs) is a record: a file, a link, a directory, or a removal. The
 * writer buffers records into a wave and publishes the wave through one
 * supervisor.writeBatchStream() call. A wave closes before it would pass
 * W7's owned-path bound (files, removals and the directories above them, up
 * to the root) or its byte budget; a file larger than the budget travels in
 * a wave of its own, and one streamed from a source is never held whole.
 *
 * Pipelining: one wave is in flight while the next one buffers. A wave
 * starts only once its predecessor has published, so a producer waits only
 * when it fills a second wave, and a failed wave is the last this writer
 * sends: the failure names its wave, and every later call rejects with it.
 *
 * Admitting a record costs its own new directories, never a recount of the
 * wave: the owned set grows as records arrive, and a directory chain walk
 * stops at the first directory already owned (whose chain is owned).
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
/** The supervisor surface a writer publishes through. */
export interface WaveSupervisor {
    writeBatchStream(stream: ReadableStream<Uint8Array>): Promise<unknown>;
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
    private readonly counters;
    constructor(options: WaveWriterOptions<Meta>);
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
    /** Every record accepted so far is durable; rejects with the first failed wave. */
    flush(): Promise<void>;
    /** The wave in flight has settled; nothing new is cut. */
    settled(): Promise<void>;
    assertHealthy(): void;
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
    /** The directories the buffered records publish, shallowest first. */
    private publishedDirectories;
    private bufferPin;
}
export declare function createWaveWriter<Meta = undefined>(options: WaveWriterOptions<Meta>): WaveWriter<Meta>;
//# sourceMappingURL=wave-writer.d.ts.map