/**
 * N17: lazy hydration in an import window (model Nimbus.Vfs.Hydration,
 * N17-001; CUTOVER.md v3 §3).
 *
 * A lazy import (SqliteVFS.importPage with `lazy`) commits its rows at once
 * and leaves the chunks it did not carry pending. This job brings their bytes
 * from the embedder's `fetch(hashes)`, front of the queue first, one step at
 * a time, and decides who waits for what:
 * - an asynchronous read of a path with pending chunks moves them to the front
 *   and waits until the path is local (then it reads the bytes);
 * - a synchronous read of one answers EIO naming the path (the engine's
 *   pendingChunkError) and moves its chunks to the front;
 * - a launch that reads synchronously (WASI) names the paths it needs; their
 *   chunks move to the front, in that order, and its gate opens when every
 *   one is local, or fails with EIO naming the first that is not once the
 *   deadline passes. A launch naming nothing pending opens at once.
 * Hydration is monotone: a local chunk never becomes pending again.
 */
import type { VfsExportChunk } from '../vfs/sqlite-vfs.js';
/** What the job needs of the engine. */
export interface HydrationStore {
    pendingChunksOf(path: string): string[];
    /** Which of `hashes` are still pending. */
    pendingOf(hashes: readonly string[]): string[];
    hydrateChunks(chunks: Iterable<VfsExportChunk>): string[];
}
export interface HydratorOptions {
    /** The embedder's fetch: the bytes of `hashes`, each re-hashed on store. */
    fetch: (hashes: string[]) => Promise<Iterable<VfsExportChunk>>;
    /** Hashes one step asks for. The model's step is one. */
    batch?: number;
    deadlineMs?: number;
    now?: () => number;
    setTimer?: (fire: () => void, ms: number) => unknown;
    /**
     * 'background' (the default) runs steps whenever there is work; 'manual'
     * leaves every step to the caller (the model's schedule is the
     * environment's).
     */
    schedule?: 'background' | 'manual';
}
export type GateState = 'waiting' | 'ok' | {
    error: 'EIO';
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
    private readonly now;
    private readonly setTimer;
    private running;
    constructor(store: HydrationStore, options: HydratorOptions);
    /** What a lazy import left pending, in the order it named them. */
    enqueue(hashes: Iterable<string>): void;
    /** The hashes still to hydrate, front first. */
    queued(): readonly string[];
    /** Whether `path` has every chunk local. */
    isLocal(path: string): boolean;
    /**
     * One step of the job: fetch the hashes at the front, store them, then
     * hand waiting readers whose path is now local their turn and settle the
     * gates. False when there is nothing to do.
     */
    step(): Promise<boolean>;
    /** Run steps in the background until the queue is empty. */
    run(): Promise<void>;
    /** An asynchronous read of `path`: resolves once its bytes are local. */
    whenLocal(path: string): Promise<void>;
    /** A synchronous read of `path` met its pending chunks: they go first. */
    missed(path: string): void;
    /**
     * A launch that reads `named` synchronously. Resolves once every one is
     * local; rejects with EIO naming the first that is not, at the deadline.
     */
    gate(named: string[]): Promise<void>;
    /** Every gate so far, in order: for diagnostics. */
    gateStates(): GateState[];
    /** Settle every pending gate: open when all its paths are local, failed once its deadline passed. */
    settle(): void;
    private resume;
    /** Move `hashes` (still queued) to the front, in their order, duplicates kept. */
    private prioritize;
}
//# sourceMappingURL=hydration.d.ts.map