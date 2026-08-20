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
import { type FacetTaskFn } from './isolate-pool.js';
import type { WorkerLoader } from './vendor/types.js';
/**
 * The sibling-session namespace the peer-DO topology routes through. Ids are
 * derived from a name so a task key always lands on the same peer.
 */
interface PeerSessionNamespace {
    idFromName(name: string): DurableObjectId;
    get(id: DurableObjectId): unknown;
}
/** The bindings a fan-out needs off the coordinator DO's env. */
export interface FanoutEnv {
    LOADER?: WorkerLoader;
    NIMBUS_SESSION?: PeerSessionNamespace;
}
/**
 * Threshold at which routing switches from coordinator-local loaders to
 * sibling Durable Objects.
 *
 * Set to **5** so the in-DO path stays below the V8 4-loaders-per-method
 * cap by construction. width < 5 stays local; width >= 5 uses sibling DOs.
 */
export declare const IN_DO_THRESHOLD = 5;
/**
 * Hard cap on concurrent peer DOs per single submitMany call. Throughput stays
 * flat through this width while keeping per-request scheduler pressure bounded.
 */
export declare const MAX_PEER_FANOUT = 32;
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
export declare const PEER_TRANSIENT_RESET_RETRIES = 3;
export declare const PEER_RETRY_BACKOFF_MS: number[];
/**
 * Backoff for a shard whose peer DO was shed as overloaded. The object is
 * alive and the shard never ran; what it needs is time for the input-gate
 * queue to drain, so the schedule is an order of magnitude longer than the
 * reset schedule. A whole-batch abort here used to fail an entire install.
 */
export declare const PEER_OVERLOAD_BACKOFF_MS: number[];
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
export declare const FANOUT_PHASE_SIZE = 4;
/** Argument shape for `submitMany`. */
export interface FanoutTask<A> {
    /**
     * Routing key for the stable-id router. Same key → same peer DO
     * (when on the peer-DO path). Tests use this to predict placement.
     */
    key: string;
    /** Argument passed to the user fn. */
    args: A;
}
/** Options handed to Fanout's constructor. */
export interface FanoutOptions {
    /**
     * Tag prepended to peer-DO ids and in-DO loader ids for debugging
     * (e.g. "npm-install-batch"). Affects neither isolate identity (in-DO
     * path uses the existing IsolatePool's tag-fold) nor peer-DO
     * deterministic placement (peer ids fold tag + key).
     */
    tag: string;
    /**
     * Per-task timeout in ms. Default 60_000. Forwarded to the in-DO
     * IsolatePool's submit calls and to the peer-DO RPC's own
     * IsolatePool.
     */
    timeoutMs?: number;
    /**
     * Preamble bundled into every facet (in-DO and inside each peer
     * DO). Same semantics as IsolatePool's preamble option.
     */
    preamble?: string;
    /**
     * Wasm modules forwarded to every facet. Same semantics as
     * IsolatePool's wasmModules option.
     */
    wasmModules?: Record<string, ArrayBuffer>;
    /**
     * Extra bindings forwarded to every facet. Same semantics as
     * IsolatePool's extraBindings option.
     */
    extraBindings?: Record<string, unknown>;
    /**
     * If set, skip the supervisor-RPC binding injection (mirrors
     * IsolatePool's omitSupervisor flag).
     */
    omitSupervisor?: boolean;
    /**
     * Invoking process pid, baked into each facet's SUPERVISOR binding so
     * filesystem RPCs (writeBatchStream) are authorized under the caller's
     * credential (mirrors IsolatePool's supervisorPid). Threaded to both
     * the in-DO loader pool and, via `_rpcFanoutExecute`, the peer-DO pools.
     * npm install passes the shell command's `ctx.pid`; resolve leaves it 0.
     */
    supervisorPid?: number;
    /**
     * Called once per completed peer-DO dispatch phase with that phase's shard
     * count and elapsed ms. Phases are barriers, so this is what tells a caller
     * whether its fan-out is bounded by shard work or by the number of barriers.
     * Not called on the in-DO path, which has no phases.
     */
    onDispatchPhase?: (width: number, elapsedMs: number) => void;
    /**
     * Cap on peer DOs this pool will spread one submitMany across. Defaults to
     * MAX_PEER_FANOUT. Tasks beyond the cap bucket into the peers that exist and
     * run through their in-peer pool, so lowering it trades peers for barriers
     * without lowering total concurrency: each peer runs its bucket at
     * concurrency 4, so N peers still resolve 4N tasks at once.
     *
     * A caller sets this when its per-task work is small enough that a peer per
     * task buys nothing but round-trips — one task per peer costs ⌈tasks/
     * FANOUT_PHASE_SIZE⌉ barriers, and each barrier costs a cold sibling start.
     */
    maxPeers?: number;
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
export declare class Fanout {
    private readonly env;
    private readonly ctx;
    private readonly opts;
    private readonly coordDoId;
    private readonly coordDoIdShort;
    constructor(rawEnv: unknown, ctx: DurableObjectState, opts: FanoutOptions);
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
    submitMany<A, R>(tasks: FanoutTask<A>[], fn: FacetTaskFn<A, R>): Promise<R[]>;
    /** Report which topology a task count uses without dispatching. */
    topologyFor(taskCount: number): 'in-do' | 'peer-do' | 'empty';
    /**
     * Compute the deterministic peer-DO id for a task key and peer count.
     *
     * Shape: `nbf:${tag}:${coordDoIdShort}:${shard}` where
     * `shard = hash(key) mod peerCount`. Peer count is
     * `min(tasks.length, MAX_PEER_FANOUT)`.
     */
    peerSiblingId(key: string, peerCount: number): string;
    private _dispatchInDo;
    private _dispatchPeerDo;
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
export declare function hashKeyToShard(key: string, peerCount: number): number;
export {};
//# sourceMappingURL=fanout.d.ts.map