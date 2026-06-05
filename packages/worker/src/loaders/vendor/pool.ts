import type { WorkerLoader, WorkerCode } from './types.js';
import type { WorkerCodeOptions, GenerateSourceOptions } from './codegen.js';
import { buildWorkerCode } from './codegen.js';
import { serializeFunction, hashSource } from './serialize.js';
import {
  ExecutionError,
  BindingError,
  TimeoutError,
  RetryExhaustedError,
} from './errors.js';

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

export class WorkerPool {
  readonly #loader: WorkerLoader;
  readonly #workerOpts: WorkerCodeOptions | undefined;
  readonly #bindings: Record<string, unknown> | undefined;
  readonly #poolContext: Record<string, unknown> | undefined;
  readonly #defaultTimeout: number | undefined;
  readonly #defaultRetries: number;
  readonly #defaultRetryDelay: number;

  #counter = 0;

  constructor(loader: WorkerLoader, opts?: PoolOptions) {
    if (!loader || typeof loader.get !== 'function') {
      throw new BindingError(
        'WorkerPool requires a Worker Loader binding. ' +
          'Add `[[worker_loaders]]` to your wrangler.toml and pass `env.LOADER`.',
      );
    }
    this.#loader = loader;
    this.#bindings = opts?.bindings;
    this.#poolContext = opts?.context;
    this.#defaultTimeout = opts?.timeout;
    this.#defaultRetries = opts?.retries ?? 0;
    this.#defaultRetryDelay = opts?.retryDelay ?? 100;

    // Merge bindings into workerOptions.env so the dynamic worker
    // receives them as `this.env` (the Worker Loader pattern).
    if (opts?.bindings) {
      const existingEnv = opts?.workerOptions?.env ?? {};
      this.#workerOpts = {
        ...opts?.workerOptions,
        env: { ...existingEnv, ...opts.bindings },
      };
    } else {
      this.#workerOpts = opts?.workerOptions;
    }
  }

  #mergeContext(
    perCall?: Record<string, unknown>,
  ): Record<string, unknown> | undefined {
    if (!this.#poolContext && !perCall) return undefined;
    if (!this.#poolContext) return perCall;
    if (!perCall) return this.#poolContext;
    return { ...this.#poolContext, ...perCall };
  }

  #sourceOpts(perCallContext?: Record<string, unknown>): GenerateSourceOptions | undefined {
    const context = this.#mergeContext(perCallContext);
    const passEnv = !!this.#bindings;
    if (!context && !passEnv) return undefined;
    return { context, passEnv };
  }

  #resolveResilience(perCall?: ResilienceOptions): {
    timeout: number | undefined;
    retries: number;
    retryDelay: number;
  } {
    return {
      timeout: perCall?.timeout ?? this.#defaultTimeout,
      retries: perCall?.retries ?? this.#defaultRetries,
      retryDelay: perCall?.retryDelay ?? this.#defaultRetryDelay,
    };
  }

  // Core dispatch

  async #dispatch(
    fnSource: string,
    fnHash: string,
    args: unknown[],
    perCallContext?: Record<string, unknown>,
  ): Promise<unknown> {
    const id = `cfp:${fnHash}:${this.#counter++}`;
    const workerCode = buildWorkerCode(
      fnSource,
      this.#workerOpts,
      this.#sourceOpts(perCallContext),
    );

    const stub = this.#loader.get(id, async () => workerCode);
    const entrypoint = stub.getEntrypoint();

    try {
      return await entrypoint.execute(...args);
    } catch (err: unknown) {
      if (err instanceof Error) {
        throw new ExecutionError(err.message, err.stack);
      }
      throw new ExecutionError(String(err));
    }
  }

  async #dispatchWithResilience(
    fnSource: string,
    fnHash: string,
    args: unknown[],
    resilience: ResilienceOptions,
    perCallContext?: Record<string, unknown>,
  ): Promise<unknown> {
    const { timeout, retries, retryDelay } = this.#resolveResilience(resilience);
    const maxAttempts = 1 + (retries ?? 0);
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const taskPromise = this.#dispatch(fnSource, fnHash, args, perCallContext);

        if (timeout !== undefined && timeout > 0) {
          const result = await Promise.race([
            taskPromise,
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new TimeoutError(timeout)), timeout),
            ),
          ]);
          return result;
        }

        return await taskPromise;
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));

        if (attempt < maxAttempts - 1) {
          const delay = (retryDelay ?? 100) * Math.pow(2, attempt);
          await new Promise<void>((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    if (maxAttempts > 1) {
      throw new RetryExhaustedError(maxAttempts, lastError!);
    }
    throw lastError!;
  }

  #prepare(fn: Function): { fnSource: string; fnHash: string } {
    const fnSource = serializeFunction(fn);
    const fnHash = hashSource(fnSource);
    return { fnSource, fnHash };
  }

  // Public API

  async submit<T>(
    fn: (...args: any[]) => T,
    ...rest: unknown[]
  ): Promise<Awaited<T>> {
    // Last element of `rest` may be a SubmitOptions object.
    let args: unknown[];
    let opts: SubmitOptions | undefined;

    const last = rest[rest.length - 1];
    if (rest.length > 0 && isSubmitOptions(last)) {
      opts = last as SubmitOptions;
      args = rest.slice(0, -1);
    } else {
      args = rest;
    }

    const { fnSource, fnHash } = this.#prepare(fn);
    return this.#dispatchWithResilience(
      fnSource,
      fnHash,
      args,
      opts ?? {},
      opts?.context,
    ) as Promise<Awaited<T>>;
  }

  async map<T, R>(
    fn: (item: T) => R,
    items: T[],
    opts?: MapOptions,
  ): Promise<Awaited<R>[]> {
    if (items.length === 0) return [];

    const { fnSource, fnHash } = this.#prepare(fn);
    const concurrency = opts?.concurrency ?? items.length;
    const onError = opts?.onError ?? 'throw';
    const resilience: ResilienceOptions = {
      timeout: opts?.timeout,
      retries: opts?.retries,
      retryDelay: opts?.retryDelay,
    };

    if (onError === 'throw' && concurrency >= items.length) {
      return Promise.all(
        items.map((item) =>
          this.#dispatchWithResilience(
            fnSource, fnHash, [item], resilience, opts?.context,
          ) as Promise<Awaited<R>>,
        ),
      );
    }

    // Bounded concurrency and/or partial failure handling.
    const settled: Array<{ ok: true; value: Awaited<R> } | { ok: false; error: Error }> =
      new Array(items.length);
    let cursor = 0;

    const runNext = async (): Promise<void> => {
      while (cursor < items.length) {
        const idx = cursor++;
        try {
          const value = await this.#dispatchWithResilience(
            fnSource, fnHash, [items[idx]], resilience, opts?.context,
          ) as Awaited<R>;
          settled[idx] = { ok: true, value };
        } catch (err: unknown) {
          if (onError === 'throw') throw err;
          settled[idx] = {
            ok: false,
            error: err instanceof Error ? err : new Error(String(err)),
          };
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, items.length) }, () => runNext()),
    );

    if (onError === 'null') {
      return settled.map((s) => (s.ok ? s.value : null)) as Awaited<R>[];
    }
    return settled.filter((s) => s.ok).map((s) => (s as { ok: true; value: Awaited<R> }).value);
  }

  /** Tree-parallel reduce: O(log n) depth instead of O(n). */
  async reduce<T>(
    fn: (a: T, b: T) => T,
    items: T[],
    initial: T,
  ): Promise<Awaited<T>> {
    if (items.length === 0) return initial as Awaited<T>;

    const { fnSource, fnHash } = this.#prepare(fn);
    let current: T[] = [initial, ...items];

    while (current.length > 1) {
      const tasks: Promise<unknown>[] = [];
      const carryForward: { index: number; value: T }[] = [];

      for (let i = 0; i < current.length; i += 2) {
        if (i + 1 < current.length) {
          tasks.push(this.#dispatch(fnSource, fnHash, [current[i], current[i + 1]]));
        } else {
          carryForward.push({ index: tasks.length, value: current[i] });
          tasks.push(Promise.resolve(current[i]));
        }
      }

      const round = await Promise.all(tasks);
      current = round as T[];
    }

    return current[0] as Awaited<T>;
  }

  /**
   * Chunked parallel map. Returns a curried function that splits input
   * into chunks and maps each chunk on a separate isolate.
   */
  pmap<T, R>(
    fn: (batch: T[]) => R[],
  ): (items: T[], opts?: PmapOptions) => Promise<Awaited<R>[]> {
    const { fnSource, fnHash } = this.#prepare(fn);

    return async (items: T[], opts?: PmapOptions): Promise<Awaited<R>[]> => {
      if (items.length === 0) return [];

      const numChunks = opts?.chunks ?? items.length;
      const chunkSize = Math.ceil(items.length / numChunks);
      const chunks: T[][] = [];

      for (let i = 0; i < items.length; i += chunkSize) {
        chunks.push(items.slice(i, i + chunkSize));
      }

      const chunkResults = await Promise.all(
        chunks.map((chunk) =>
          this.#dispatch(fnSource, fnHash, [chunk]),
        ),
      );

      return (chunkResults as Awaited<R>[][]).flat();
    };
  }

  /**
   * Sequential pipeline where each stage runs on its own isolate.
   * Output of one stage feeds into the next.
   */
  pipe<A, B>(f1: (a: A) => B): (input: A) => Promise<Awaited<B>>;
  pipe<A, B, C>(f1: (a: A) => B, f2: (b: Awaited<B>) => C): (input: A) => Promise<Awaited<C>>;
  pipe<A, B, C, D>(
    f1: (a: A) => B,
    f2: (b: Awaited<B>) => C,
    f3: (c: Awaited<C>) => D,
  ): (input: A) => Promise<Awaited<D>>;
  pipe<A, B, C, D, E>(
    f1: (a: A) => B,
    f2: (b: Awaited<B>) => C,
    f3: (c: Awaited<C>) => D,
    f4: (d: Awaited<D>) => E,
  ): (input: A) => Promise<Awaited<E>>;
  pipe<A, B, C, D, E, F>(
    f1: (a: A) => B,
    f2: (b: Awaited<B>) => C,
    f3: (c: Awaited<C>) => D,
    f4: (d: Awaited<D>) => E,
    f5: (e: Awaited<E>) => F,
  ): (input: A) => Promise<Awaited<F>>;
  pipe(...fns: ((...args: any[]) => any)[]): (input: any) => Promise<any>;
  pipe(...fns: ((...args: any[]) => any)[]): (input: any) => Promise<any> {
    const stages = fns.map((fn) => this.#prepare(fn));

    return async (input: unknown): Promise<unknown> => {
      let value = input;
      for (const { fnSource, fnHash } of stages) {
        value = await this.#dispatch(fnSource, fnHash, [value]);
      }
      return value;
    };
  }

  async scatter<T, R>(
    fn: (items: T[]) => R,
    items: T[],
    chunks: number,
    opts?: ScatterOptions,
  ): Promise<Awaited<R>[]> {
    if (items.length === 0) return [];

    const { fnSource, fnHash } = this.#prepare(fn);
    const chunkSize = Math.ceil(items.length / chunks);
    const batches: T[][] = [];

    for (let i = 0; i < items.length; i += chunkSize) {
      batches.push(items.slice(i, i + chunkSize));
    }

    const onError = opts?.onError ?? 'throw';
    const resilience: ResilienceOptions = {
      timeout: opts?.timeout,
      retries: opts?.retries,
      retryDelay: opts?.retryDelay,
    };

    if (onError === 'throw') {
      return Promise.all(
        batches.map((batch) =>
          this.#dispatchWithResilience(
            fnSource, fnHash, [batch], resilience, opts?.context,
          ) as Promise<Awaited<R>>,
        ),
      );
    }

    const results = await Promise.all(
      batches.map(async (batch) => {
        try {
          const value = await this.#dispatchWithResilience(
            fnSource, fnHash, [batch], resilience, opts?.context,
          ) as Awaited<R>;
          return { ok: true as const, value };
        } catch (err: unknown) {
          return {
            ok: false as const,
            error: err instanceof Error ? err : new Error(String(err)),
          };
        }
      }),
    );

    if (onError === 'null') {
      return results.map((r) => (r.ok ? r.value : null)) as Awaited<R>[];
    }
    return results.filter((r) => r.ok).map((r) => (r as { ok: true; value: Awaited<R> }).value);
  }

  async gather<T>(promises: Promise<T>[]): Promise<T[]> {
    return Promise.all(promises);
  }

  // Streaming iterators

  async *mapStream<T, R>(
    fn: (item: T) => R,
    items: T[],
    opts?: StreamOptions,
  ): AsyncIterable<StreamResult<Awaited<R>>> {
    if (items.length === 0) return;

    const { fnSource, fnHash } = this.#prepare(fn);
    const concurrency = opts?.concurrency ?? items.length;
    const resilience: ResilienceOptions = {
      timeout: opts?.timeout,
      retries: opts?.retries,
      retryDelay: opts?.retryDelay,
    };

    // Channel: pre-allocate a promise per item. Producers resolve them
    // in completion order; the consumer awaits them sequentially.
    const queue: Array<{
      resolve: (v: StreamResult<Awaited<R>>) => void;
      reject: (e: Error) => void;
      promise: Promise<StreamResult<Awaited<R>>>;
    }> = [];

    for (let i = 0; i < items.length; i++) {
      let resolve!: (v: StreamResult<Awaited<R>>) => void;
      let reject!: (e: Error) => void;
      const promise = new Promise<StreamResult<Awaited<R>>>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      queue.push({ resolve, reject, promise });
    }

    let completionSlot = 0;
    let cursor = 0;

    const dispatchNext = async (): Promise<void> => {
      while (cursor < items.length) {
        const itemIdx = cursor++;
        const slot = completionSlot++;
        try {
          const value = await this.#dispatchWithResilience(
            fnSource, fnHash, [items[itemIdx]], resilience, opts?.context,
          ) as Awaited<R>;
          queue[slot].resolve({ index: itemIdx, value });
        } catch (err: unknown) {
          queue[slot].reject(
            err instanceof Error ? err : new Error(String(err)),
          );
        }
      }
    };

    const workers = Array.from(
      { length: Math.min(concurrency, items.length) },
      () => dispatchNext(),
    );

    for (let i = 0; i < items.length; i++) {
      yield await queue[i].promise;
    }

    await Promise.all(workers);
  }

  /**
   * Ordered streaming map: yields values in original input order,
   * buffering out-of-order completions internally.
   */
  async *mapOrdered<T, R>(
    fn: (item: T) => R,
    items: T[],
    opts?: StreamOptions,
  ): AsyncIterable<Awaited<R>> {
    if (items.length === 0) return;

    const { fnSource, fnHash } = this.#prepare(fn);
    const concurrency = opts?.concurrency ?? items.length;
    const resilience: ResilienceOptions = {
      timeout: opts?.timeout,
      retries: opts?.retries,
      retryDelay: opts?.retryDelay,
    };

    // One promise per item, indexed by original position.
    // Lets us yield in order regardless of completion order.
    const slots: Array<Promise<Awaited<R>>> = new Array(items.length);

    let cursor = 0;

    const dispatchNext = async (): Promise<void> => {
      while (cursor < items.length) {
        const idx = cursor++;
        slots[idx] = this.#dispatchWithResilience(
          fnSource, fnHash, [items[idx]], resilience, opts?.context,
        ) as Promise<Awaited<R>>;
        await slots[idx].catch(() => {});
      }
    };

    const workers = Array.from(
      { length: Math.min(concurrency, items.length) },
      () => dispatchNext(),
    );

    for (let i = 0; i < items.length; i++) {
      // Spin-wait for slot assignment if a slow worker hasn't dispatched yet.
      while (slots[i] === undefined) {
        await new Promise<void>((r) => setTimeout(r, 1));
      }
      yield await slots[i];
    }

    await Promise.all(workers);
  }
}

/**
 * Heuristic: detect whether the last argument to submit() is a SubmitOptions
 * object rather than a regular argument. Checks for a plain object with at
 * least one recognized option key.
 */
function isSubmitOptions(value: unknown): value is SubmitOptions {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  if (value instanceof Date || value instanceof RegExp || value instanceof Map) {
    return false;
  }
  const keys = Object.keys(value as Record<string, unknown>);
  const optionKeys = new Set([
    'timeout', 'retries', 'retryDelay', 'context',
  ]);
  return keys.length > 0 && keys.some((k) => optionKeys.has(k));
}
