/**
 * fanout-pool.ts — two-tier fan-out primitive.
 *
 * Background
 * ──────────
 * The supervisor DO sits behind a V8 invariant: at most **4 concurrent
 * env.LOADER.get(...).getEntrypoint().fetch(...)** calls per DO method
 * invocation (3 from a Worker handler context). Beyond that, additional
 * dispatches serialize against the cap and produce
 * `Too many concurrent dynamic workers` errors. See
 * `audit/sections/FANOUT-AUDIT.md` and
 * `docs/research/poc-multi-backend-findings.md` for the measurement
 * data.
 *
 * The existing `NimbusLoaderPool` (src/loaders/loader-pool.ts) defaults
 * `concurrency = 4` precisely because of this cap. Every wide fan-out
 * site in `src/npm/installer.ts` (resolver, install-batch, pre-bundle)
 * was forced into a `concurrency: 1` outer pool with an internal
 * limiter inside ONE facet — see the explicit comment at
 * installer.ts:654 ("collapses what was 4 concurrent dynamic workers
 * (pool.map slots) into 1").
 *
 * Two validated topologies (POC findings)
 * ───────────────────────────────────────
 *   POC C  in-DO fan-out          1 coordinator DO + N≤4 loaders   4.03× at N=4
 *   POC B  DO Pool + 1 Loader/DO  N peer DOs × 1 loader each       7.75× at N=8, flat to N=32
 *
 * `NimbusFanoutPool` exposes ONE `submitMany` API that routes
 * automatically:
 *   width <  IN_DO_THRESHOLD   →  POC C (uses existing NimbusLoaderPool)
 *   width >= IN_DO_THRESHOLD   →  POC B (peer NimbusSession DOs)
 *
 * IN_DO_THRESHOLD is 5 — exactly above the V8 cap so we never use the
 * in-DO path beyond the safe ceiling, and the peer-DO path takes over
 * cleanly for the wider workloads.
 *
 * Stable-id router
 * ────────────────
 * Each task carries a `key` (string). The router maps
 * `key → siblingId = peerNamespace(coordDoIdShort, hash(key) mod N)`.
 * Same key → same peer DO across runs. Tests can predict which peer
 * handles which task, and warm peer isolates are reusable across
 * back-to-back fan-outs that share keys.
 *
 * Hard-fail policy
 * ────────────────
 * Anti-requirement: NO fallback. If `env.LOADER` is missing, throw
 * (existing NimbusLoaderPool already does). If
 * `env.NIMBUS_SESSION` is missing AND a peer-DO route is needed,
 * throw. Callers MUST get a deterministic error rather than silently
 * collapsing back to width-1. The supervisor error handler logs and
 * the install fails loudly — same posture every other facet binding
 * has.
 *
 * Backpressure
 * ────────────
 * Hard cap: `MAX_PEER_FANOUT = 32` (POC B's flat zone). If
 * `tasks.length > 32`, the surplus is queued and dispatched in
 * subsequent rounds after the first 32 settle. This keeps the
 * per-request peer-DO count bounded.
 */

import { serializeFunction } from './vendor/serialize.js';
import { BindingError } from './vendor/errors.js';
import { NimbusLoaderPool } from './loader-pool.js';

/**
 * Threshold at which we switch from in-DO POC C → peer-DO POC B.
 *
 * Set to **5** so the in-DO path stays below the V8 4-loaders-per-method
 * cap by construction. width < 5 → POC C; width >= 5 → POC B.
 */
export const IN_DO_THRESHOLD = 5;

/**
 * Hard cap on concurrent peer DOs per single submitMany call. POC B
 * measured flat throughput from N=8 to N=32; we use the ceiling so
 * pathological 500-pkg installs still parallelise as wide as the
 * topology supports.
 */
export const MAX_PEER_FANOUT = 32;

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

/** Options handed to NimbusFanoutPool's constructor. */
export interface NimbusFanoutPoolOptions {
  /**
   * Tag prepended to peer-DO ids and in-DO loader ids for debugging
   * (e.g. "npm-install-batch"). Affects neither isolate identity (in-DO
   * path uses the existing NimbusLoaderPool's tag-fold) nor peer-DO
   * deterministic placement (peer ids fold tag + key).
   */
  tag: string;
  /**
   * Per-task timeout in ms. Default 60_000. Forwarded to the in-DO
   * NimbusLoaderPool's submit calls and to the peer-DO RPC's own
   * NimbusLoaderPool.
   */
  timeoutMs?: number;
  /**
   * Preamble bundled into every facet (in-DO and inside each peer
   * DO). Same semantics as NimbusLoaderPool's preamble option.
   */
  preamble?: string;
  /**
   * Wasm modules forwarded to every facet. Same semantics as
   * NimbusLoaderPool's wasmModules option.
   */
  wasmModules?: Record<string, ArrayBuffer>;
  /**
   * Extra bindings forwarded to every facet. Same semantics as
   * NimbusLoaderPool's extraBindings option.
   */
  extraBindings?: Record<string, unknown>;
  /**
   * If set, skip the supervisor-RPC binding injection (mirrors
   * NimbusLoaderPool's omitSupervisor flag).
   */
  omitSupervisor?: boolean;
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
export class NimbusFanoutPool {
  private readonly env: any;
  private readonly ctx: DurableObjectState;
  private readonly opts: NimbusFanoutPoolOptions;
  private readonly coordDoIdShort: string;

  constructor(env: any, ctx: DurableObjectState, opts: NimbusFanoutPoolOptions) {
    // Hard-fail on missing LOADER. NimbusLoaderPool also enforces this,
    // but we check up front so the diagnostic points at the fanout-pool
    // construction site rather than the deferred loader-pool one.
    if (!env?.LOADER || typeof env.LOADER.get !== 'function') {
      throw new BindingError(
        'NimbusFanoutPool: env.LOADER binding missing or invalid. ' +
          'Add a [[worker_loaders]] entry to wrangler.jsonc.',
      );
    }
    this.env = env;
    this.ctx = ctx;
    this.opts = opts;
    this.coordDoIdShort = ctx.id.toString().slice(0, 12);
  }

  /**
   * Dispatch `tasks` across the appropriate topology and return
   * results in input order.
   *
   * Routing:
   *   tasks.length < 5   →  POC C in-DO via NimbusLoaderPool (concurrency = tasks.length, capped at 4)
   *   tasks.length >= 5  →  POC B peer-DO via env.NIMBUS_SESSION sibling DOs (deterministic stable-id router)
   *
   * Backpressure: if `tasks.length > MAX_PEER_FANOUT (32)`, tasks
   * are sharded modulo `MAX_PEER_FANOUT` and each shard's bucket
   * runs serially inside its assigned peer DO via the in-peer
   * NimbusLoaderPool's concurrency (capped at 4 there too). A
   * single submitMany call returns when ALL tasks complete (or any
   * throws).
   *
   * `fn` is the user function executed per task. It runs INSIDE a
   * Worker Loader isolate (in the in-DO path) or inside a peer DO's
   * Worker Loader isolate (in the peer-DO path); same trust posture
   * as NimbusLoaderPool.submit. The function is serialized via
   * the vendored serializeFunction (same as NimbusLoaderPool#prepare).
   */
  async submitMany<A, R>(
    tasks: FanoutTask<A>[],
    fn: (item: A, env: any) => R | Promise<R>,
  ): Promise<R[]> {
    if (tasks.length === 0) return [];

    if (tasks.length < IN_DO_THRESHOLD) {
      return this._dispatchInDo<A, R>(tasks, fn);
    }
    return this._dispatchPeerDo<A, R>(tasks, fn);
  }

  /**
   * Diagnostic: report which topology a given task count would use.
   * Used by tests to assert routing without exercising the full
   * dispatch path.
   */
  topologyFor(taskCount: number): 'in-do' | 'peer-do' | 'empty' {
    if (taskCount === 0) return 'empty';
    return taskCount < IN_DO_THRESHOLD ? 'in-do' : 'peer-do';
  }

  /**
   * Compute the deterministic peer-DO id for a given task key, given
   * the peer count. Exposed so tests can assert routing predictions
   * BEFORE running the dispatch.
   *
   * Shape: `nbf:${tag}:${coordDoIdShort}:${shard}` where
   * `shard = hash(key) mod peerCount`. The hash is hashSource()
   * (FNV-1a over a single-string input — adequate for routing; not
   * cryptographic). Peer count is `min(tasks.length, MAX_PEER_FANOUT)`.
   */
  peerSiblingId(key: string, peerCount: number): string {
    const shard = hashKeyToShard(key, peerCount);
    return `nbf:${this.opts.tag}:${this.coordDoIdShort}:${shard}`;
  }

  // ── Private: in-DO dispatch (POC C) ──────────────────────────────

  private async _dispatchInDo<A, R>(
    tasks: FanoutTask<A>[],
    fn: (item: A, env: any) => R | Promise<R>,
  ): Promise<R[]> {
    // Use the existing NimbusLoaderPool. Concurrency = task count
    // (capped at 4 by constructor — tasks.length is already < 5
    // here, so the cap won't bite). Each task = one pool.submit;
    // pool.map runs them with stable-slot reuse.
    const concurrency = Math.min(tasks.length, IN_DO_THRESHOLD - 1);
    const pool = new NimbusLoaderPool(this.env, this.ctx, {
      concurrency,
      timeoutMs: this.opts.timeoutMs,
      tag: this.opts.tag,
      preamble: this.opts.preamble,
      wasmModules: this.opts.wasmModules,
      extraBindings: this.opts.extraBindings,
      omitSupervisor: this.opts.omitSupervisor,
    });
    try {
      // pool.map runs the function over `items` with concurrency-bounded
      // slot reuse. Each slot is one warm loader isolate; we get exactly
      // `concurrency` loader isolates total — well under the 4-cap.
      const items = tasks.map((t) => t.args);
      const results = await pool.map<A, R>(fn, items);
      // pool.map returns Array<R | null> (null on per-item failure with
      // onError='null'/'skip'). Default onError='throw' rejects on
      // first failure, so successful settle here implies all R values.
      return results as R[];
    } finally {
      try { pool.dispose(); } catch { /* best-effort */ }
    }
  }

  // ── Private: peer-DO dispatch (POC B) ────────────────────────────

  private async _dispatchPeerDo<A, R>(
    tasks: FanoutTask<A>[],
    fn: (item: A, env: any) => R | Promise<R>,
  ): Promise<R[]> {
    const ns = this.env?.NIMBUS_SESSION;
    if (!ns || typeof ns.idFromName !== 'function' || typeof ns.get !== 'function') {
      throw new BindingError(
        'NimbusFanoutPool: env.NIMBUS_SESSION binding missing or invalid. ' +
          'The peer-DO topology requires it. ' +
          'Add the binding via durable_objects.bindings in wrangler.jsonc.',
      );
    }

    // Serialize the user function ONCE here on the supervisor side.
    // Each peer DO receives the same fnSource string; warm peer
    // loader isolates (keyed on fnHash) reuse across calls with
    // identical fns.
    const fnSource = serializeFunction(fn as any);

    // Cap peer count at MAX_PEER_FANOUT. Tasks beyond N=32 are
    // bucketed into existing shards — each shard's peer DO then
    // runs its bucket through its in-DO NimbusLoaderPool.map
    // (concurrency capped at 4 there).
    const peerCount = Math.min(tasks.length, MAX_PEER_FANOUT);
    // Group tasks by deterministic shard. Same key → same shard, so
    // tests can predict which peer handles which task.
    const shards = new Map<number, FanoutTask<A>[]>();
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
    const taskIndex = new Map<FanoutTask<A>, number>();
    tasks.forEach((t, i) => taskIndex.set(t, i));
    const results: R[] = new Array(tasks.length);

    const shardPromises: Promise<void>[] = [];
    for (const [shard, bucket] of shards) {
      const siblingName = `nbf:${this.opts.tag}:${this.coordDoIdShort}:${shard}`;
      const id = ns.idFromName(siblingName);
      const stub = ns.get(id);
      shardPromises.push(
        (async () => {
          // Each peer DO RPC call uses ONE LOADER worker on its side.
          // Supervisor → peer DO is a stub.fetch / RPC method call,
          // NOT an env.LOADER.get(); that's the cap-sidestep that
          // makes POC B work.
          const peerArgs = bucket.map((t) => t.args);
          const rpcResp = await (stub as any)._rpcFanoutExecute(
            fnSource,
            peerArgs,
            {
              tag: this.opts.tag,
              timeoutMs: this.opts.timeoutMs,
              preamble: this.opts.preamble,
              wasmModules: this.opts.wasmModules,
              extraBindings: this.opts.extraBindings,
              omitSupervisor: this.opts.omitSupervisor,
            },
          );
          const peerResults = (rpcResp?.results ?? []) as R[];
          if (peerResults.length !== bucket.length) {
            throw new Error(
              `peer DO returned ${peerResults.length} results for ${bucket.length} tasks ` +
              `(siblingName=${siblingName})`,
            );
          }
          // Place each result back into its original input slot.
          for (let i = 0; i < bucket.length; i++) {
            const origIdx = taskIndex.get(bucket[i])!;
            results[origIdx] = peerResults[i];
          }
        })(),
      );
    }

    await Promise.all(shardPromises);
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
export function hashKeyToShard(key: string, peerCount: number): number {
  if (peerCount <= 1) return 0;
  // djb2, returning an unsigned 32-bit integer — full 2^32 range,
  // no string-format conversion gotchas. peerCount <= MAX_PEER_FANOUT
  // (32) << 2^32, so the modulo distributes uniformly for any input.
  let h = 5381;
  for (let i = 0; i < key.length; i++) {
    h = ((h << 5) + h + key.charCodeAt(i)) | 0;
  }
  return (h >>> 0) % peerCount;
}
