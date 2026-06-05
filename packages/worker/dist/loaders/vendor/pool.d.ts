import type { WorkerLoader } from './types.js';
import type { WorkerCodeOptions } from './codegen.js';
export interface ResilienceOptions {
    timeout?: number;
    /** Retry attempts after initial failure. 0 = no retries (default). */
    retries?: number;
    /** Base delay (ms) between retries. Doubles each attempt. Default: 100. */
    retryDelay?: number;
}
export interface PoolOptions {
    workerOptions?: WorkerCodeOptions;
    /**
     * Bindings forwarded to dynamic workers (KV, R2, AI, D1, etc.).
     * When set, each function receives an `env` object as its last argument.
     */
    bindings?: Record<string, unknown>;
    /**
     * Values injected as module-level constants into every generated worker.
     * Must be JSON-serializable.
     */
    context?: Record<string, unknown>;
    timeout?: number;
    retries?: number;
    retryDelay?: number;
}
export interface SubmitOptions extends ResilienceOptions {
    /** Per-call context. Merged with (and overrides) pool-level context. */
    context?: Record<string, unknown>;
}
export type OnErrorStrategy = 'throw' | 'skip' | 'null';
export interface MapOptions extends ResilienceOptions {
    concurrency?: number;
    context?: Record<string, unknown>;
    /**
     * Per-item failure handling:
     * - `'throw'` (default): reject on first failure.
     * - `'skip'`: omit failed items from results.
     * - `'null'`: replace failed items with `null`.
     */
    onError?: OnErrorStrategy;
}
export interface PmapOptions {
    chunks?: number;
}
export interface StreamOptions extends ResilienceOptions {
    concurrency?: number;
    context?: Record<string, unknown>;
}
export interface StreamResult<T> {
    index: number;
    value: T;
}
export interface ScatterOptions extends ResilienceOptions {
    context?: Record<string, unknown>;
    onError?: OnErrorStrategy;
}
export declare class WorkerPool {
    #private;
    constructor(loader: WorkerLoader, opts?: PoolOptions);
    submit<T>(fn: (...args: any[]) => T, ...rest: unknown[]): Promise<Awaited<T>>;
    map<T, R>(fn: (item: T) => R, items: T[], opts?: MapOptions): Promise<Awaited<R>[]>;
    /** Tree-parallel reduce: O(log n) depth instead of O(n). */
    reduce<T>(fn: (a: T, b: T) => T, items: T[], initial: T): Promise<Awaited<T>>;
    /**
     * Chunked parallel map. Returns a curried function that splits input
     * into chunks and maps each chunk on a separate isolate.
     */
    pmap<T, R>(fn: (batch: T[]) => R[]): (items: T[], opts?: PmapOptions) => Promise<Awaited<R>[]>;
    /**
     * Sequential pipeline where each stage runs on its own isolate.
     * Output of one stage feeds into the next.
     */
    pipe<A, B>(f1: (a: A) => B): (input: A) => Promise<Awaited<B>>;
    pipe<A, B, C>(f1: (a: A) => B, f2: (b: Awaited<B>) => C): (input: A) => Promise<Awaited<C>>;
    pipe<A, B, C, D>(f1: (a: A) => B, f2: (b: Awaited<B>) => C, f3: (c: Awaited<C>) => D): (input: A) => Promise<Awaited<D>>;
    pipe<A, B, C, D, E>(f1: (a: A) => B, f2: (b: Awaited<B>) => C, f3: (c: Awaited<C>) => D, f4: (d: Awaited<D>) => E): (input: A) => Promise<Awaited<E>>;
    pipe<A, B, C, D, E, F>(f1: (a: A) => B, f2: (b: Awaited<B>) => C, f3: (c: Awaited<C>) => D, f4: (d: Awaited<D>) => E, f5: (e: Awaited<E>) => F): (input: A) => Promise<Awaited<F>>;
    pipe(...fns: ((...args: any[]) => any)[]): (input: any) => Promise<any>;
    scatter<T, R>(fn: (items: T[]) => R, items: T[], chunks: number, opts?: ScatterOptions): Promise<Awaited<R>[]>;
    gather<T>(promises: Promise<T>[]): Promise<T[]>;
    mapStream<T, R>(fn: (item: T) => R, items: T[], opts?: StreamOptions): AsyncIterable<StreamResult<Awaited<R>>>;
    /**
     * Ordered streaming map: yields values in original input order,
     * buffering out-of-order completions internally.
     */
    mapOrdered<T, R>(fn: (item: T) => R, items: T[], opts?: StreamOptions): AsyncIterable<Awaited<R>>;
}
//# sourceMappingURL=pool.d.ts.map