/**
 * N17: lazy hydration in an import window (model Nimbus.Vfs.Hydration,
 * N17-001; CUTOVER.md v3 §3).
 *
 * A lazy import (SqliteVFS.importPage with `lazy`) commits its rows at once
 * and leaves the chunks it did not carry pending. This job brings their bytes
 * from the embedder's `fetch(hashes)`, front of the queue first, one step at
 * a time, and decides who waits for what:
 * - an asynchronous read of a path with pending chunks moves them to the front
 *   and waits until the path is local (then it reads the bytes), at most the
 *   deadline;
 * - a synchronous read of one answers EIO naming the path (the engine's
 *   pendingChunkError) and moves its chunks to the front;
 * - a launch that reads synchronously (WASI) names the paths it needs; their
 *   chunks move to the front, in that order, and its gate opens when every
 *   one is local, or fails with EIO naming the first that is not once the
 *   deadline passes. A launch naming nothing pending opens at once.
 * Hydration is monotone: a local chunk never becomes pending again.
 *
 * A fetch can fail: reject, return wrong bytes, or leave hashes out. Each
 * such hash is tried again later (capped exponential backoff), and the job
 * goes on with the rest. After MAX_ATTEMPTS a hash has failed for good: a
 * reader of a path it backs is told so at once (EIO naming the path, the
 * chunk and the cause), and so is anyone waiting on it. `retryFailed()`
 * queues failed hashes again.
 */
import type { VfsExportChunk } from '../vfs/sqlite-vfs.js';
/** What the job needs of the engine. */
export interface HydrationStore {
    pendingChunksOf(path: string): string[];
    /** Which of `hashes` are still pending. */
    pendingOf(hashes: readonly string[]): string[];
    hydrateChunks(chunks: Iterable<VfsExportChunk>): {
        stored: string[];
        invalid: string[];
    };
}
export interface HydratorOptions {
    /** The embedder's fetch: the bytes of `hashes`, each re-hashed on store. */
    fetch: (hashes: string[]) => Promise<Iterable<VfsExportChunk>>;
    /** Hashes one step asks for. The model's step is one. */
    batch?: number;
    /** How long a launch's gate waits; default HYDRATION_DEADLINE_MS. */
    deadlineMs?: number;
    /** How long an asynchronous reader waits; default the gate's deadline. */
    readDeadlineMs?: number;
    now?: () => number;
    setTimer?: (fire: () => void, ms: number) => unknown;
    /**
     * 'background' (the default) runs steps whenever there is work; 'manual'
     * leaves every step to the caller (the model's schedule is the
     * environment's).
     */
    schedule?: 'background' | 'manual';
    /** Tries before a hash has failed for good; default 8. */
    maxAttempts?: number;
    /** First retry delay, doubled per try up to maxBackoffMs; default 250 ms and 30 s. */
    backoffMs?: number;
    maxBackoffMs?: number;
}
export type GateState = 'waiting' | 'ok' | {
    error: 'EIO';
    path: string;
};
type HydrationError = Error & {
    code: 'EIO';
    path: string;
};
export declare class Hydrator {
    private readonly store;
    private readonly options;
    private queue;
    private readonly waiters;
    private readonly gates;
    private readonly batch;
    private readonly deadlineMs;
    private readonly readDeadlineMs;
    private readonly maxAttempts;
    private readonly backoffMs;
    private readonly maxBackoffMs;
    private readonly now;
    private readonly setTimer;
    private running;
    /** Hashes a fetch has failed for, and how often. */
    private readonly attempts;
    /** Hashes that failed for good, with the cause. */
    private readonly failed;
    constructor(store: HydrationStore, options: HydratorOptions);
    /** What a lazy import left pending, in the order it named them. */
    enqueue(hashes: Iterable<string>): void;
    /** The hashes still to hydrate, front first. */
    queued(): readonly string[];
    /** The hashes that failed for good, with their causes. */
    failures(): ReadonlyMap<string, string>;
    /** Queue the hashes that failed for good again, each with a fresh set of tries. */
    retryFailed(): void;
    /** Whether `path` has every chunk local. */
    isLocal(path: string): boolean;
    /** Why `path` cannot be hydrated: a chunk behind it failed for good. Null when none has. */
    failureOf(path: string): HydrationError | null;
    /**
     * One step of the job: fetch the ready hashes at the front, store what came
     * back right, then hand waiting readers whose path is now local their turn
     * and settle the gates. A hash the fetch failed for stays queued, for
     * later, and after MAX_ATTEMPTS has failed for good. False when nothing was
     * ready to fetch.
     */
    step(): Promise<boolean>;
    /** Run steps in the background until the queue is empty. Never rejects. */
    run(): Promise<void>;
    /**
     * An asynchronous read of `path`: resolves once its bytes are local;
     * rejects with EIO naming the path if a chunk behind it failed for good,
     * or at the deadline.
     */
    whenLocal(path: string): Promise<void>;
    /** A synchronous read of `path` met its pending chunks: they go first. */
    missed(path: string): void;
    /**
     * A launch that reads `named` synchronously. Resolves once every one is
     * local; rejects with EIO naming the first that is not, at the deadline, or
     * at once when a chunk behind one failed for good.
     */
    gate(named: string[]): Promise<void>;
    /** Every gate so far, in order: for diagnostics. */
    gateStates(): GateState[];
    /** Settle every pending gate: open when all its paths are local, failed once one cannot be or its deadline passed. */
    settle(): void;
    private fail;
    /** How long until a queued hash may be tried again; null when none is queued. */
    private nextRetryIn;
    private resume;
    /** Move `hashes` (still queued) to the front, in their order, duplicates kept. */
    private prioritize;
}
export {};
//# sourceMappingURL=hydration.d.ts.map