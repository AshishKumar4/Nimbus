/**
 * Two-tier fan-out primitive for work that must execute in Worker Loader
 * facets without tripping workerd's per-DO dynamic-worker ceiling.
 *
 * A single Durable Object method can drive at most four concurrent
 * Worker Loader fetches before extra dispatches serialize or fail. Small
 * batches therefore run in the coordinator DO through IsolatePool.
 * Wider batches are sharded across sibling NimbusSession DOs, each of
 * which owns its own four-loader budget.
 *
 * Routing is deterministic: each task has a stable key, and the key maps
 * to a sibling DO shard. There is no silent fallback to width-1 execution;
 * missing LOADER or NIMBUS_SESSION bindings fail loudly so install and
 * runtime operations do not appear successful after partial dispatch.
 */
import { serializeFunction } from './vendor/serialize.js';
import { BindingError } from './vendor/errors.js';
import { IsolatePool } from './isolate-pool.js';
import { disposeRpcResource } from '@nimbus-sh/platform/rpc-dispose.js';
import { describeError, isDoOverloaded, isTransientDoReset } from '@nimbus-sh/platform/oom-classify.js';
/**
 * Threshold at which routing switches from coordinator-local loaders to
 * sibling Durable Objects.
 *
 * Set to **5** so the in-DO path stays below the V8 4-loaders-per-method
 * cap by construction. width < 5 stays local; width >= 5 uses sibling DOs.
 */
export const IN_DO_THRESHOLD = 5;
/**
 * Hard cap on concurrent peer DOs per single submitMany call. Throughput stays
 * flat through this width while keeping per-request scheduler pressure bounded.
 */
export const MAX_PEER_FANOUT = 32;
/**
 * Bounded retries for a peer-DO shard dispatch that rejects with a
 * transient platform reset (code roll-over, storage cold-start hiccup).
 * Sibling DOs are addressed by stable name, so the retry re-dispatches
 * the SAME shard to the re-provisioning object; the fanned-out work
 * (packument resolution, tarball materialisation) is idempotent, so
 * re-running a shard is safe. Budget mirrors the resolve-facet's own
 * per-fetch retry policy so a single flaky cold start no longer fails a
 * whole install. The same budget covers an overloaded peer, on the longer
 * schedule below. Non-transient rejections (OOM, count mismatch, genuine
 * task throw) are NOT retried — they propagate on the first hit.
 */
export const PEER_TRANSIENT_RESET_RETRIES = 3;
export const PEER_RETRY_BACKOFF_MS = [250, 750, 1500];
/**
 * Backoff for a shard whose peer DO was shed as overloaded. The object is
 * alive and the shard never ran; what it needs is time for the input-gate
 * queue to drain, so the schedule is an order of magnitude longer than the
 * reset schedule. A whole-batch abort here used to fail an entire install.
 */
export const PEER_OVERLOAD_BACKOFF_MS = [1000, 3000, 6000];
/**
 * Peer shards dispatched per phase. Each phase is a barrier that costs its
 * slowest member, so a wide fan-out pays ⌈shards / FANOUT_PHASE_SIZE⌉ serial
 * round-trips; the size trades that serialization against simultaneous cold
 * sibling DO starts.
 *
 * The six-barrier profile once measured on a 123-package install (21 shards of
 * ~6 packages, 10.6/6.8/21.8/7.9/34.6/4.8 s) came from the shard count, not
 * from this width. Capping install shards at INSTALL_PEER_CAP fixed it at the
 * source and that install now clears in two phases. Widening to 8 on top of
 * that bought one further barrier and doubled the simultaneous cold sibling-DO
 * starts, which is the account-level pressure the phasing exists for: twelve
 * concurrent Markflow installs went from 48 simultaneous peer starts to 96 and
 * began timing out. Phasing does not change how many peers start, only how
 * many start at once, so this width is set by the burst the scheduler
 * tolerates rather than by the barrier count.
 */
export const FANOUT_PHASE_SIZE = 4;
function isFanoutPeerStub(value) {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
        return false;
    }
    const execute = Reflect.get(value, '_rpcFanoutExecute');
    return typeof execute === 'function';
}
function fanoutPeerStub(value) {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
        throw new BindingError('Fanout: NIMBUS_SESSION.get() did not return a peer stub.');
    }
    if (!isFanoutPeerStub(value)) {
        throw new BindingError('Fanout: peer stub does not expose _rpcFanoutExecute().');
    }
    return value;
}
/**
 * Two-tier fan-out pool. Constructed by the supervisor DO; routes
 * each `submitMany` call automatically based on width.
 *
 * Lifetime: cheap to construct (no async init). Multiple submitMany
 * calls share NO state — each is dispatched fresh. The class
 * exists primarily as a clean API surface; per-call dispatch state
 * lives only inside submitMany's promise.
 */
export class Fanout {
    env;
    ctx;
    opts;
    coordDoId;
    coordDoIdShort;
    constructor(rawEnv, ctx, opts) {
        // A host hands its whole env over; the bindings are claimed here and the
        // LOADER claim is checked immediately. Hard-fail on a missing LOADER —
        // IsolatePool also enforces this, but checking up front points the
        // diagnostic at the fanout construction site rather than the
        // deferred isolate-pool one.
        const env = rawEnv ?? {};
        if (!env.LOADER || typeof env.LOADER.get !== 'function') {
            throw new BindingError('Fanout: env.LOADER binding missing or invalid. ' +
                'Add a [[worker_loaders]] entry to wrangler.jsonc.');
        }
        this.env = env;
        this.ctx = ctx;
        this.opts = opts;
        this.coordDoId = ctx.id.toString();
        this.coordDoIdShort = this.coordDoId.slice(0, 12);
    }
    /**
     * Dispatch `tasks` across the appropriate topology and return
     * results in input order.
     *
     * Routing:
     *   tasks.length < 5   -> coordinator-local IsolatePool
     *   tasks.length >= 5  -> sibling NimbusSession DOs
     *
     * Backpressure: if `tasks.length > MAX_PEER_FANOUT (32)`, tasks
     * are sharded modulo `MAX_PEER_FANOUT` and each shard's bucket
     * runs serially inside its assigned peer DO via the in-peer
     * IsolatePool's concurrency (capped at 4 there too). A
     * single submitMany call returns when ALL tasks complete (or any
     * throws).
     *
     * `fn` is the user function executed per task. It runs INSIDE a
     * Worker Loader isolate (in the in-DO path) or inside a peer DO's
     * Worker Loader isolate (in the peer-DO path); same trust posture
     * as IsolatePool.submit. The function is serialized via
     * the vendored serializeFunction (same as IsolatePool#prepare).
     */
    async submitMany(tasks, fn) {
        if (tasks.length === 0)
            return [];
        if (tasks.length < IN_DO_THRESHOLD) {
            return this._dispatchInDo(tasks, fn);
        }
        return this._dispatchPeerDo(tasks, fn);
    }
    /** Report which topology a task count uses without dispatching. */
    topologyFor(taskCount) {
        if (taskCount === 0)
            return 'empty';
        return taskCount < IN_DO_THRESHOLD ? 'in-do' : 'peer-do';
    }
    /**
     * Compute the deterministic peer-DO id for a task key and peer count.
     *
     * Shape: `nbf:${tag}:${coordDoIdShort}:${shard}` where
     * `shard = hash(key) mod peerCount`. Peer count is
     * `min(tasks.length, MAX_PEER_FANOUT)`.
     */
    peerSiblingId(key, peerCount) {
        const shard = hashKeyToShard(key, peerCount);
        return `nbf:${this.opts.tag}:${this.coordDoIdShort}:${shard}`;
    }
    // ── Private: in-DO dispatch (in-DO fanout) ──────────────────────────────
    async _dispatchInDo(tasks, fn) {
        // Use the existing IsolatePool. Concurrency = task count
        // (capped at 4 by constructor — tasks.length is already < 5
        // here, so the cap won't bite). Each task = one pool.submit;
        // pool.map runs them with stable-slot reuse.
        const concurrency = Math.min(tasks.length, IN_DO_THRESHOLD - 1);
        const pool = new IsolatePool(this.env, this.ctx, {
            concurrency,
            timeoutMs: this.opts.timeoutMs,
            tag: this.opts.tag,
            preamble: this.opts.preamble,
            wasmModules: this.opts.wasmModules,
            extraBindings: this.opts.extraBindings,
            omitSupervisor: this.opts.omitSupervisor,
            supervisorPid: this.opts.supervisorPid,
        });
        try {
            // pool.map runs the function over `items` with concurrency-bounded
            // slot reuse. Each slot is one warm loader isolate; we get exactly
            // `concurrency` loader isolates total — well under the 4-cap.
            const items = tasks.map((t) => t.args);
            const results = await pool.map(fn, items);
            // pool.map returns Array<R | null> (null on per-item failure with
            // onError='null'/'skip'). Default onError='throw' rejects on
            // first failure, so successful settle here implies all R values.
            return results;
        }
        finally {
            try {
                pool.dispose();
            }
            catch { /* best-effort */ }
        }
    }
    // ── Private: peer-DO dispatch (peer-DO fanout) ────────────────────────────
    async _dispatchPeerDo(tasks, fn) {
        const ns = this.env?.NIMBUS_SESSION;
        if (!ns || typeof ns.idFromName !== 'function' || typeof ns.get !== 'function') {
            throw new BindingError('Fanout: env.NIMBUS_SESSION binding missing or invalid. ' +
                'The peer-DO topology requires it. ' +
                'Add the binding via durable_objects.bindings in wrangler.jsonc.');
        }
        // Serialize the user function ONCE here on the supervisor side.
        // Each peer DO receives the same fnSource string; warm peer
        // loader isolates (keyed on fnHash) reuse across calls with
        // identical fns.
        const fnSource = serializeFunction(fn);
        // Cap peer count at MAX_PEER_FANOUT. Tasks beyond N=32 are
        // bucketed into existing shards — each shard's peer DO then
        // runs its bucket through its in-DO IsolatePool.map
        // (concurrency capped at 4 there).
        const peerCount = Math.min(tasks.length, this.opts.maxPeers ?? MAX_PEER_FANOUT);
        // Group tasks by deterministic shard. Same key → same shard, so
        // tests can predict which peer handles which task.
        const shards = new Map();
        for (const t of tasks) {
            const shard = hashKeyToShard(t.key, peerCount);
            let bucket = shards.get(shard);
            if (!bucket) {
                bucket = [];
                shards.set(shard, bucket);
            }
            bucket.push(t);
        }
        // Dispatch each shard to its peer DO. Build a map from
        // task → its place in the original tasks array so we can
        // reassemble results in input order.
        const taskIndex = new Map();
        tasks.forEach((t, i) => {
            taskIndex.set(t, i);
        });
        const results = new Array(tasks.length);
        // Build one async dispatcher per shard (closure capturing siblingName,
        // bucket). NOT eagerly-started — wrapped in a thunk so we can stagger
        // dispatch via Promise chains without forcing all shards to start
        // simultaneously.
        const dispatchers = [];
        for (const [shard, bucket] of shards) {
            const siblingName = `nbf:${this.opts.tag}:${this.coordDoIdShort}:${shard}`;
            const id = ns.idFromName(siblingName);
            const peerArgs = bucket.map((t) => t.args);
            dispatchers.push(async () => {
                for (let attempt = 0;; attempt++) {
                    // Fresh stub per attempt: after a transient reset the previous
                    // stub points at a torn-down object, so a retry re-resolves the
                    // sibling by its stable id.
                    const peerStub = ns.get(id);
                    const stub = fanoutPeerStub(peerStub);
                    try {
                        // Each peer DO RPC call uses ONE LOADER worker on its side.
                        // Supervisor → peer DO is a stub.fetch / RPC method call,
                        // NOT an env.LOADER.get(); that's the cap-sidestep that
                        // makes peer-DO fanout work.
                        const rpcResp = await stub._rpcFanoutExecute(fnSource, peerArgs, {
                            tag: this.opts.tag,
                            timeoutMs: this.opts.timeoutMs,
                            preamble: this.opts.preamble,
                            wasmModules: this.opts.wasmModules,
                            extraBindings: this.opts.extraBindings,
                            omitSupervisor: this.opts.omitSupervisor,
                            // INSTALL-HONESTY: forward the COORDINATOR's full doId so
                            // the peer's IsolatePool can mint a SUPERVISOR
                            // binding that routes back HERE (the user's session DO),
                            // not to the peer DO itself. Without this, peer DOs'
                            // env.SUPERVISOR.writeBatch / writeBatchStream / stdout /
                            // ... write into the peer's own VFS — invisible to the
                            // user. See INSTALL-HONESTY-retro.md.
                            coordinatorDoId: this.coordDoId,
                            // Credential source for peer-side writeBatchStream — the
                            // invoking process pid, so package writes are authorized
                            // as the user (not rejected as pid:0).
                            supervisorPid: this.opts.supervisorPid,
                        });
                        try {
                            const peerResults = rpcResp.results ?? [];
                            if (peerResults.length !== bucket.length) {
                                throw new Error(`peer DO returned ${peerResults.length} results for ${bucket.length} tasks ` +
                                    `(siblingName=${siblingName})`);
                            }
                            // Place each result back into its original input slot.
                            for (let i = 0; i < bucket.length; i++) {
                                const origIdx = taskIndex.get(bucket[i]);
                                if (origIdx === undefined) {
                                    throw new Error(`peer DO result had no original task index (siblingName=${siblingName})`);
                                }
                                results[origIdx] = peerResults[i];
                            }
                        }
                        finally {
                            disposeRpcResource(rpcResp);
                        }
                        return;
                    }
                    catch (err) {
                        const schedule = isTransientDoReset(err) ? PEER_RETRY_BACKOFF_MS
                            : isDoOverloaded(err) ? PEER_OVERLOAD_BACKOFF_MS
                                : null;
                        if (schedule && attempt < PEER_TRANSIENT_RESET_RETRIES) {
                            const backoff = schedule[Math.min(attempt, schedule.length - 1)];
                            await new Promise((r) => setTimeout(r, backoff));
                            continue;
                        }
                        // Re-throwing bare loses everything only this frame knows: which
                        // sibling ran the shard, how wide it was, and how many attempts
                        // it already cost. Callers report the message, so a rejection the
                        // platform words as `internal error` arrived at the user with no
                        // way to tell a one-off peer from a shard that had exhausted its
                        // retries. `cause` keeps the original for anything that inspects
                        // errors rather than reads them.
                        throw new Error(`peer shard ${siblingName} (${bucket.length} task${bucket.length === 1 ? '' : 's'}) `
                            + `failed after ${attempt + 1} attempt${attempt === 0 ? '' : 's'}: ${describeError(err)}`, { cause: err });
                    }
                    finally {
                        disposeRpcResource(peerStub);
                    }
                }
            });
        }
        // Dispatch peer shards in bounded phases. A single Promise.all across all
        // shards can create too many simultaneous cold sibling DO starts under
        // concurrent installs. Promise-chain phasing limits scheduler pressure
        // without sleeps, timers, or idle gaps between phases.
        //
        // A phase is a hard barrier: no shard in phase N+1 starts until every
        // shard in phase N returns, so `width@ms` per phase is what separates
        // "the shards are slow" from "there are too many barriers".
        for (let i = 0; i < dispatchers.length; i += FANOUT_PHASE_SIZE) {
            const phase = dispatchers.slice(i, i + FANOUT_PHASE_SIZE);
            const phaseStartedAt = Date.now();
            await Promise.all(phase.map((d) => d()));
            this.opts.onDispatchPhase?.(phase.length, Date.now() - phaseStartedAt);
        }
        return results;
    }
}
/**
 * Stable hash → shard. Uses a fresh djb2 over the key (NOT
 * hashSource) and modulos by peerCount.
 *
 * Why not reuse hashSource: hashSource returns a base-36 string,
 * NOT hex — its alphabet is `[0-9a-z]`. parseInt(str, 16) on a
 * base-36 string aborts at the first non-hex char (any of g-z),
 * which produces extremely poor distribution: keys with the same
 * leading-hex-prefix collide regardless of their suffix. (Seen in
 * the wild: `task-0 .. task-7` all collided onto shard 4.)
 *
 * Deterministic: same key + same peerCount → same shard, every run.
 * Tests use this to predict placement.
 */
export function hashKeyToShard(key, peerCount) {
    if (peerCount <= 1)
        return 0;
    // djb2, returning an unsigned 32-bit integer — full 2^32 range,
    // no string-format conversion gotchas. peerCount <= MAX_PEER_FANOUT
    // (32) << 2^32, so the modulo distributes uniformly for any input.
    let h = 5381;
    for (let i = 0; i < key.length; i++) {
        h = ((h << 5) + h + key.charCodeAt(i)) | 0;
    }
    return (h >>> 0) % peerCount;
}
