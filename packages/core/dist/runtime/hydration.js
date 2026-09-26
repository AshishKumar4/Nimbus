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
import { HYDRATION_DEADLINE_MS } from '@nimbus-sh/platform/limits.js';
function hydrationError(message, path) {
    return Object.assign(new Error(`EIO: ${message}`), { code: 'EIO', path });
}
export class Hydrator {
    store;
    options;
    queue = [];
    waiters = [];
    gates = [];
    batch;
    deadlineMs;
    readDeadlineMs;
    maxAttempts;
    backoffMs;
    maxBackoffMs;
    now;
    setTimer;
    running = null;
    /** Hashes a fetch has failed for, and how often. */
    attempts = new Map();
    /** Hashes that failed for good, with the cause. */
    failed = new Map();
    constructor(store, options) {
        this.store = store;
        this.options = options;
        this.batch = Math.max(1, options.batch ?? 64);
        this.deadlineMs = options.deadlineMs ?? HYDRATION_DEADLINE_MS;
        this.readDeadlineMs = options.readDeadlineMs ?? this.deadlineMs;
        this.maxAttempts = Math.max(1, options.maxAttempts ?? 8);
        this.backoffMs = options.backoffMs ?? 250;
        this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
        this.now = options.now ?? Date.now;
        this.setTimer = options.setTimer ?? ((fire, ms) => setTimeout(fire, ms));
    }
    /** What a lazy import left pending, in the order it named them. */
    enqueue(hashes) {
        const queued = new Set(this.queue);
        for (const hash of hashes)
            if (!queued.has(hash)) {
                this.queue.push(hash);
                queued.add(hash);
            }
    }
    /** The hashes still to hydrate, front first. */
    queued() {
        return this.queue;
    }
    /** The hashes that failed for good, with their causes. */
    failures() {
        return this.failed;
    }
    /** Queue the hashes that failed for good again, each with a fresh set of tries. */
    retryFailed() {
        const hashes = [...this.failed.keys()];
        this.failed.clear();
        for (const hash of hashes)
            this.attempts.delete(hash);
        this.enqueue(this.store.pendingOf(hashes));
        void this.run();
    }
    /** Whether `path` has every chunk local. */
    isLocal(path) {
        return this.store.pendingChunksOf(path).length === 0;
    }
    /** Why `path` cannot be hydrated: a chunk behind it failed for good. Null when none has. */
    failureOf(path) {
        if (this.failed.size === 0)
            return null;
        for (const hash of this.store.pendingChunksOf(path)) {
            const cause = this.failed.get(hash);
            if (cause !== undefined)
                return hydrationError(`${path}: import of chunk ${hash} failed: ${cause}`, path);
        }
        return null;
    }
    /**
     * One step of the job: fetch the ready hashes at the front, store what came
     * back right, then hand waiting readers whose path is now local their turn
     * and settle the gates. A hash the fetch failed for stays queued, for
     * later, and after MAX_ATTEMPTS has failed for good. False when nothing was
     * ready to fetch.
     */
    async step() {
        const now = this.now();
        const front = [];
        for (const hash of this.queue) {
            if (front.length >= this.batch)
                break;
            const tried = this.attempts.get(hash);
            if (tried === undefined || tried.notBefore <= now)
                front.push(hash);
        }
        if (front.length === 0)
            return false;
        const taken = this.store.pendingOf([...new Set(front)]);
        const failures = new Map();
        if (taken.length > 0) {
            let chunks = [];
            try {
                chunks = await this.options.fetch(taken);
            }
            catch (error) {
                const cause = error instanceof Error ? error.message : String(error);
                for (const hash of taken)
                    failures.set(hash, `the fetch failed: ${cause}`);
            }
            if (failures.size === 0) {
                const given = [...chunks].filter((chunk) => taken.includes(chunk.hash));
                const { invalid } = this.store.hydrateChunks(given);
                for (const hash of invalid)
                    failures.set(hash, 'the bytes fetched do not hash to it');
                const returned = new Set(given.map((chunk) => chunk.hash));
                for (const hash of taken)
                    if (!returned.has(hash))
                        failures.set(hash, 'the fetch did not return it');
            }
        }
        // The entries taken leave the queue by entry, not by position: a read
        // may have reordered it during the fetch. A hash queued twice is a no-op
        // the second time. A hash that failed goes to the back, to wait its turn.
        for (const hash of front) {
            const at = this.queue.indexOf(hash);
            if (at !== -1)
                this.queue.splice(at, 1);
        }
        for (const [hash, cause] of failures)
            this.fail(hash, cause);
        this.resume();
        this.settle();
        return true;
    }
    /** Run steps in the background until the queue is empty. Never rejects. */
    run() {
        if (this.options.schedule === 'manual')
            return Promise.resolve();
        if (this.running === null) {
            this.running = (async () => {
                try {
                    for (;;) {
                        if (await this.step())
                            continue;
                        const wait = this.nextRetryIn();
                        if (wait === null)
                            break;
                        await new Promise((resolve) => { this.setTimer(resolve, wait); });
                    }
                }
                catch (error) {
                    // A store failure (the database, not the fetch): readers get it, not the host.
                    const cause = error instanceof Error ? error.message : String(error);
                    for (const hash of this.queue.splice(0))
                        this.failed.set(hash, cause);
                    this.resume();
                    this.settle();
                }
                finally {
                    this.running = null;
                }
            })();
        }
        return this.running;
    }
    /**
     * An asynchronous read of `path`: resolves once its bytes are local;
     * rejects with EIO naming the path if a chunk behind it failed for good,
     * or at the deadline.
     */
    whenLocal(path) {
        const need = this.store.pendingChunksOf(path);
        if (need.length === 0)
            return Promise.resolve();
        const failure = this.failureOf(path);
        if (failure !== null)
            return Promise.reject(failure);
        this.prioritize(need);
        const opened = this.now();
        const waiting = new Promise((resolve, reject) => { this.waiters.push({ path, opened, resolve, reject }); });
        if (Number.isFinite(this.readDeadlineMs))
            this.setTimer(() => this.resume(), this.readDeadlineMs);
        void this.run();
        return waiting;
    }
    /** A synchronous read of `path` met its pending chunks: they go first. */
    missed(path) {
        const need = this.store.pendingChunksOf(path);
        if (need.length === 0)
            return;
        this.prioritize(need);
        void this.run();
    }
    /**
     * A launch that reads `named` synchronously. Resolves once every one is
     * local; rejects with EIO naming the first that is not, at the deadline, or
     * at once when a chunk behind one failed for good.
     */
    gate(named) {
        this.prioritize(named.flatMap((path) => this.store.pendingChunksOf(path)));
        const gate = { named, opened: this.now(), state: 'waiting', error: null, settle: [] };
        this.gates.push(gate);
        const decided = new Promise((resolve, reject) => {
            gate.settle.push(() => {
                if (gate.state === 'ok')
                    resolve();
                else if (gate.error !== null)
                    reject(gate.error);
            });
        });
        this.settle();
        if (gate.state === 'waiting') {
            this.setTimer(() => this.settle(), this.deadlineMs);
            void this.run();
        }
        return decided;
    }
    /** Every gate so far, in order: for diagnostics. */
    gateStates() {
        return this.gates.map((gate) => gate.state);
    }
    /** Settle every pending gate: open when all its paths are local, failed once one cannot be or its deadline passed. */
    settle() {
        const now = this.now();
        for (const gate of this.gates) {
            if (gate.state !== 'waiting')
                continue;
            const missing = gate.named.find((path) => !this.isLocal(path));
            const failure = missing === undefined ? null : this.failureOf(missing);
            if (missing === undefined)
                gate.state = 'ok';
            else if (failure !== null) {
                gate.state = { error: 'EIO', path: missing };
                gate.error = failure;
            }
            else if (gate.opened + this.deadlineMs <= now) {
                gate.state = { error: 'EIO', path: missing };
                gate.error = hydrationError(`hydration of ${missing} did not complete in ${Math.round(this.deadlineMs / 1000)}s`, missing);
            }
            else
                continue;
            for (const settle of gate.settle)
                settle();
        }
    }
    fail(hash, cause) {
        const tried = this.attempts.get(hash);
        const count = (tried?.count ?? 0) + 1;
        if (count >= this.maxAttempts) {
            this.attempts.delete(hash);
            this.failed.set(hash, cause);
            return;
        }
        const delay = Math.min(this.maxBackoffMs, this.backoffMs * 2 ** (count - 1));
        this.attempts.set(hash, { count, cause, notBefore: this.now() + delay });
        this.queue.push(hash);
    }
    /** How long until a queued hash may be tried again; null when none is queued. */
    nextRetryIn() {
        if (this.queue.length === 0)
            return null;
        const now = this.now();
        let soonest = Infinity;
        for (const hash of this.queue) {
            const tried = this.attempts.get(hash);
            soonest = Math.min(soonest, tried === undefined ? now : tried.notBefore);
        }
        return Math.max(0, soonest - now);
    }
    resume() {
        const now = this.now();
        for (let i = 0; i < this.waiters.length;) {
            const waiter = this.waiters[i];
            const failure = this.isLocal(waiter.path) ? null : this.failureOf(waiter.path);
            if (this.isLocal(waiter.path)) {
                this.waiters.splice(i, 1);
                waiter.resolve();
            }
            else if (failure !== null) {
                this.waiters.splice(i, 1);
                waiter.reject(failure);
            }
            else if (waiter.opened + this.readDeadlineMs <= now) {
                this.waiters.splice(i, 1);
                waiter.reject(hydrationError(`hydration of ${waiter.path} did not complete in ${Math.round(this.readDeadlineMs / 1000)}s`, waiter.path));
            }
            else
                i++;
        }
    }
    /** Move `hashes` (still queued) to the front, in their order, duplicates kept. */
    prioritize(hashes) {
        const queued = new Set(this.queue);
        const front = hashes.filter((hash) => queued.has(hash));
        if (front.length === 0)
            return;
        const moved = new Set(front);
        this.queue = [...front, ...this.queue.filter((hash) => !moved.has(hash))];
    }
}
