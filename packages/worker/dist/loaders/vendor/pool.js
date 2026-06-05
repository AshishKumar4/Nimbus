import { buildWorkerCode } from './codegen.js';
import { serializeFunction, hashSource } from './serialize.js';
import { ExecutionError, BindingError, TimeoutError, RetryExhaustedError, } from './errors.js';
export class WorkerPool {
    #loader;
    #workerOpts;
    #bindings;
    #poolContext;
    #defaultTimeout;
    #defaultRetries;
    #defaultRetryDelay;
    #counter = 0;
    constructor(loader, opts) {
        if (!loader || typeof loader.get !== 'function') {
            throw new BindingError('WorkerPool requires a Worker Loader binding. ' +
                'Add `[[worker_loaders]]` to your wrangler.toml and pass `env.LOADER`.');
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
        }
        else {
            this.#workerOpts = opts?.workerOptions;
        }
    }
    #mergeContext(perCall) {
        if (!this.#poolContext && !perCall)
            return undefined;
        if (!this.#poolContext)
            return perCall;
        if (!perCall)
            return this.#poolContext;
        return { ...this.#poolContext, ...perCall };
    }
    #sourceOpts(perCallContext) {
        const context = this.#mergeContext(perCallContext);
        const passEnv = !!this.#bindings;
        if (!context && !passEnv)
            return undefined;
        return { context, passEnv };
    }
    #resolveResilience(perCall) {
        return {
            timeout: perCall?.timeout ?? this.#defaultTimeout,
            retries: perCall?.retries ?? this.#defaultRetries,
            retryDelay: perCall?.retryDelay ?? this.#defaultRetryDelay,
        };
    }
    // Core dispatch
    async #dispatch(fnSource, fnHash, args, perCallContext) {
        const id = `cfp:${fnHash}:${this.#counter++}`;
        const workerCode = buildWorkerCode(fnSource, this.#workerOpts, this.#sourceOpts(perCallContext));
        const stub = this.#loader.get(id, async () => workerCode);
        const entrypoint = stub.getEntrypoint();
        try {
            return await entrypoint.execute(...args);
        }
        catch (err) {
            if (err instanceof Error) {
                throw new ExecutionError(err.message, err.stack);
            }
            throw new ExecutionError(String(err));
        }
    }
    async #dispatchWithResilience(fnSource, fnHash, args, resilience, perCallContext) {
        const { timeout, retries, retryDelay } = this.#resolveResilience(resilience);
        const maxAttempts = 1 + (retries ?? 0);
        let lastError;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
                const taskPromise = this.#dispatch(fnSource, fnHash, args, perCallContext);
                if (timeout !== undefined && timeout > 0) {
                    const result = await Promise.race([
                        taskPromise,
                        new Promise((_, reject) => setTimeout(() => reject(new TimeoutError(timeout)), timeout)),
                    ]);
                    return result;
                }
                return await taskPromise;
            }
            catch (err) {
                lastError = err instanceof Error ? err : new Error(String(err));
                if (attempt < maxAttempts - 1) {
                    const delay = (retryDelay ?? 100) * Math.pow(2, attempt);
                    await new Promise((resolve) => setTimeout(resolve, delay));
                }
            }
        }
        if (maxAttempts > 1) {
            throw new RetryExhaustedError(maxAttempts, lastError);
        }
        throw lastError;
    }
    #prepare(fn) {
        const fnSource = serializeFunction(fn);
        const fnHash = hashSource(fnSource);
        return { fnSource, fnHash };
    }
    // Public API
    async submit(fn, ...rest) {
        // Last element of `rest` may be a SubmitOptions object.
        let args;
        let opts;
        const last = rest[rest.length - 1];
        if (rest.length > 0 && isSubmitOptions(last)) {
            opts = last;
            args = rest.slice(0, -1);
        }
        else {
            args = rest;
        }
        const { fnSource, fnHash } = this.#prepare(fn);
        return this.#dispatchWithResilience(fnSource, fnHash, args, opts ?? {}, opts?.context);
    }
    async map(fn, items, opts) {
        if (items.length === 0)
            return [];
        const { fnSource, fnHash } = this.#prepare(fn);
        const concurrency = opts?.concurrency ?? items.length;
        const onError = opts?.onError ?? 'throw';
        const resilience = {
            timeout: opts?.timeout,
            retries: opts?.retries,
            retryDelay: opts?.retryDelay,
        };
        if (onError === 'throw' && concurrency >= items.length) {
            return Promise.all(items.map((item) => this.#dispatchWithResilience(fnSource, fnHash, [item], resilience, opts?.context)));
        }
        // Bounded concurrency and/or partial failure handling.
        const settled = new Array(items.length);
        let cursor = 0;
        const runNext = async () => {
            while (cursor < items.length) {
                const idx = cursor++;
                try {
                    const value = await this.#dispatchWithResilience(fnSource, fnHash, [items[idx]], resilience, opts?.context);
                    settled[idx] = { ok: true, value };
                }
                catch (err) {
                    if (onError === 'throw')
                        throw err;
                    settled[idx] = {
                        ok: false,
                        error: err instanceof Error ? err : new Error(String(err)),
                    };
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => runNext()));
        if (onError === 'null') {
            return settled.map((s) => (s.ok ? s.value : null));
        }
        return settled.filter((s) => s.ok).map((s) => s.value);
    }
    /** Tree-parallel reduce: O(log n) depth instead of O(n). */
    async reduce(fn, items, initial) {
        if (items.length === 0)
            return initial;
        const { fnSource, fnHash } = this.#prepare(fn);
        let current = [initial, ...items];
        while (current.length > 1) {
            const tasks = [];
            const carryForward = [];
            for (let i = 0; i < current.length; i += 2) {
                if (i + 1 < current.length) {
                    tasks.push(this.#dispatch(fnSource, fnHash, [current[i], current[i + 1]]));
                }
                else {
                    carryForward.push({ index: tasks.length, value: current[i] });
                    tasks.push(Promise.resolve(current[i]));
                }
            }
            const round = await Promise.all(tasks);
            current = round;
        }
        return current[0];
    }
    /**
     * Chunked parallel map. Returns a curried function that splits input
     * into chunks and maps each chunk on a separate isolate.
     */
    pmap(fn) {
        const { fnSource, fnHash } = this.#prepare(fn);
        return async (items, opts) => {
            if (items.length === 0)
                return [];
            const numChunks = opts?.chunks ?? items.length;
            const chunkSize = Math.ceil(items.length / numChunks);
            const chunks = [];
            for (let i = 0; i < items.length; i += chunkSize) {
                chunks.push(items.slice(i, i + chunkSize));
            }
            const chunkResults = await Promise.all(chunks.map((chunk) => this.#dispatch(fnSource, fnHash, [chunk])));
            return chunkResults.flat();
        };
    }
    pipe(...fns) {
        const stages = fns.map((fn) => this.#prepare(fn));
        return async (input) => {
            let value = input;
            for (const { fnSource, fnHash } of stages) {
                value = await this.#dispatch(fnSource, fnHash, [value]);
            }
            return value;
        };
    }
    async scatter(fn, items, chunks, opts) {
        if (items.length === 0)
            return [];
        const { fnSource, fnHash } = this.#prepare(fn);
        const chunkSize = Math.ceil(items.length / chunks);
        const batches = [];
        for (let i = 0; i < items.length; i += chunkSize) {
            batches.push(items.slice(i, i + chunkSize));
        }
        const onError = opts?.onError ?? 'throw';
        const resilience = {
            timeout: opts?.timeout,
            retries: opts?.retries,
            retryDelay: opts?.retryDelay,
        };
        if (onError === 'throw') {
            return Promise.all(batches.map((batch) => this.#dispatchWithResilience(fnSource, fnHash, [batch], resilience, opts?.context)));
        }
        const results = await Promise.all(batches.map(async (batch) => {
            try {
                const value = await this.#dispatchWithResilience(fnSource, fnHash, [batch], resilience, opts?.context);
                return { ok: true, value };
            }
            catch (err) {
                return {
                    ok: false,
                    error: err instanceof Error ? err : new Error(String(err)),
                };
            }
        }));
        if (onError === 'null') {
            return results.map((r) => (r.ok ? r.value : null));
        }
        return results.filter((r) => r.ok).map((r) => r.value);
    }
    async gather(promises) {
        return Promise.all(promises);
    }
    // Streaming iterators
    async *mapStream(fn, items, opts) {
        if (items.length === 0)
            return;
        const { fnSource, fnHash } = this.#prepare(fn);
        const concurrency = opts?.concurrency ?? items.length;
        const resilience = {
            timeout: opts?.timeout,
            retries: opts?.retries,
            retryDelay: opts?.retryDelay,
        };
        // Channel: pre-allocate a promise per item. Producers resolve them
        // in completion order; the consumer awaits them sequentially.
        const queue = [];
        for (let i = 0; i < items.length; i++) {
            let resolve;
            let reject;
            const promise = new Promise((res, rej) => {
                resolve = res;
                reject = rej;
            });
            queue.push({ resolve, reject, promise });
        }
        let completionSlot = 0;
        let cursor = 0;
        const dispatchNext = async () => {
            while (cursor < items.length) {
                const itemIdx = cursor++;
                const slot = completionSlot++;
                try {
                    const value = await this.#dispatchWithResilience(fnSource, fnHash, [items[itemIdx]], resilience, opts?.context);
                    queue[slot].resolve({ index: itemIdx, value });
                }
                catch (err) {
                    queue[slot].reject(err instanceof Error ? err : new Error(String(err)));
                }
            }
        };
        const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => dispatchNext());
        for (let i = 0; i < items.length; i++) {
            yield await queue[i].promise;
        }
        await Promise.all(workers);
    }
    /**
     * Ordered streaming map: yields values in original input order,
     * buffering out-of-order completions internally.
     */
    async *mapOrdered(fn, items, opts) {
        if (items.length === 0)
            return;
        const { fnSource, fnHash } = this.#prepare(fn);
        const concurrency = opts?.concurrency ?? items.length;
        const resilience = {
            timeout: opts?.timeout,
            retries: opts?.retries,
            retryDelay: opts?.retryDelay,
        };
        // One promise per item, indexed by original position.
        // Lets us yield in order regardless of completion order.
        const slots = new Array(items.length);
        let cursor = 0;
        const dispatchNext = async () => {
            while (cursor < items.length) {
                const idx = cursor++;
                slots[idx] = this.#dispatchWithResilience(fnSource, fnHash, [items[idx]], resilience, opts?.context);
                await slots[idx].catch(() => { });
            }
        };
        const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => dispatchNext());
        for (let i = 0; i < items.length; i++) {
            // Spin-wait for slot assignment if a slow worker hasn't dispatched yet.
            while (slots[i] === undefined) {
                await new Promise((r) => setTimeout(r, 1));
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
function isSubmitOptions(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    if (value instanceof Date || value instanceof RegExp || value instanceof Map) {
        return false;
    }
    const keys = Object.keys(value);
    const optionKeys = new Set([
        'timeout', 'retries', 'retryDelay', 'context',
    ]);
    return keys.length > 0 && keys.some((k) => optionKeys.has(k));
}
