/**
 * loader-pool.ts — Nimbus loader-isolate pool based on cloudflare-parallel.
 *
 * Adds Nimbus-specific behavior to the upstream pool design:
 *   1. **Stable-slot isolate reuse**. Upstream's #counter++ gives every
 *      dispatch a fresh isolate — fine for one-off AI calls, terrible for
 *      running 67 npm tarball extractions (cold-start dominates). We pin
 *      each job to `slot = cursor % concurrency` and use stable loader
 *      IDs `nfp:${fnHash}:slot-${i}:g${generation}`, so a pool of
 *      concurrency=4 keeps at most 4 warm isolates rather than N fresh ones.
 *   2. **Nimbus defaults**: compatibilityDate = CF_COMPAT_DATE (matches
 *      the supervisor worker), compatibilityFlags = ['nodejs_compat'],
 *      globalOutbound = undefined (inherit parent network so the facet can
 *      reach https://registry.npmjs.org without a proxy binding).
 *   3. **SupervisorRPC autoinjection**. The pool grabs a SupervisorRPC
 *      stub from `getCtxExports()` and forwards it as `env.SUPERVISOR` to
 *      every facet, same pattern as git-network-facet.ts. Callers can add
 *      more bindings via `extraBindings`.
 *   4. **Fail-loud defaults**: timeout 60s, retries 0, onError 'throw'.
 *      Caller opts in to leniency.
 *
 * The vendored directory contains only the upstream serialization, error,
 * and binding types used by this implementation.
 */
/** Options handed to NimbusLoaderPool's constructor. */
export interface NimbusLoaderPoolOptions {
    /** Maximum concurrent in-flight facets. Default 4. */
    concurrency?: number;
    /** Per-task timeout in ms. Default 60_000. */
    timeoutMs?: number;
    /**
     * Per-task retry attempts AFTER the initial failure. Default 0.
     * Set to a small number only if transient RPC errors are common.
     */
    retries?: number;
    /**
     * Additional bindings forwarded to each facet. These merge on top of the
     * default `{ SUPERVISOR: SupervisorRPC({ doId, pid:0 }) }`. Use this to
     * give facets access to KV, R2, AI, or additional supervisor-level APIs.
     */
    extraBindings?: Record<string, unknown>;
    /**
     * Optional tag used in loader IDs for debugging (e.g. "npm-install").
     * Does NOT affect isolate identity — same fn + same tag = same slot.
     */
    tag?: string;
    /**
     * If true, omit the default SupervisorRPC binding. Use this for pools
     * that don't need DO callbacks (e.g. a pure CPU compute pool).
     */
    omitSupervisor?: boolean;
    /**
     * Loader cache scope. Defaults to `session`, which bakes the owning DO id
     * into the loader key so stateful facets cannot leak bindings or globals
     * across sessions. Use `global` only for stateless compute modules that do
     * not receive a Supervisor binding and do not retain user state.
     */
    cacheScope?: 'session' | 'global';
    /**
     * Override the `doId` baked into the auto-injected SUPERVISOR binding.
     * Default: `ctx.id.toString()` (the DO that constructs the pool).
     *
     * Used by NimbusFanoutPool's peer-DO branch (peer-DO fanout): peer DOs
     * construct their per-task NimbusLoaderPool from inside
     * `_rpcFanoutExecute`, where `ctx` is the PEER DO's ctx. Without this
     * override the peer's auto-injected SUPERVISOR routes back to the
     * peer DO itself — so writes (e.g. install-batch-facet's
     * writeBatchStream) land in the peer's VFS instead of the
     * COORDINATOR's. The user's terminal session is on the coordinator;
     * writes-to-peer are invisible. See INSTALL-HONESTY-retro.md.
     *
     * When set, the auto-injected SupervisorRPC uses this string as the
     * `props.doId`, routing all SUPERVISOR.* calls back to the
     * coordinator. Effective only when `omitSupervisor !== true`.
     */
    supervisorDoIdOverride?: string;
    /**
     * Process pid baked into the auto-injected SUPERVISOR binding's props.
     * The supervisor derives the write credential from this pid
     * (`SupervisorRPC._pid()` → `processes.cred(pid)`), so any facet that
     * calls a filesystem RPC (`writeBatchStream`, `writeFile`, …) must be
     * dispatched with the invoking process's real pid — otherwise the RPC
     * throws "missing or invalid process pid in props". npm install threads
     * the shell command's `ctx.pid` here so package files land as the user.
     * Left 0 (default) for pools whose facets touch only cache/registry RPCs
     * (npm resolve, pre-bundle), which never call `_pid()`.
     */
    supervisorPid?: number;
    /**
     * Raw JavaScript source prepended to every generated worker module.
     * Lets callers inject bundled helpers, such as a tar parser. The user
     * function can reference top-level names declared in the preamble as if
     * they were in lexical scope.
     *
     * Example: `preamble: 'export const parse = ...; const helper = ...;'`
     * — the preamble runs at module-load time; any side effects happen
     * inside the facet isolate.
     *
     * Preamble text is bytes-stable for a given pool — it's part of the
     * loader-cache key (fnHash), so changing the preamble invalidates all
     * warm slots.
     */
    preamble?: string;
    /**
     * WebAssembly modules to ship into the facet via the LOADER's
     * `modules` map. Map keys are module specifier paths (e.g.
     * `'esbuild.wasm'`); values are the raw bytes.
     *
     * Workerd registers each entry as `{ wasm: ArrayBuffer }` in the
     * worker's modules map. The pool prepends a static
     * `import __NIMBUS_WASM_<id> from './<key>';` to the generated
     * worker.js so workerd compiles each at module-load (startup phase,
     * where wasm code generation is permitted). The compiled Modules
     * are exposed via `globalThis.__NIMBUS_WASM[<key>]` for the user
     * function to read at request time.
     *
     * Why this works when other paths don't:
     *   - request-time `WebAssembly.compile()` — disallowed by workerd
     *     in this deploy.
     *   - request-time RPC of a pre-compiled Module — workerd
     *     structured-clone refuses ("Unable to deserialize cloned data").
     *   - inlining bytes in the preamble — 16 MiB string per dispatch
     *     OOMs the supervisor at module-source allocation time.
     *   - LOADER modules-map (this) — bytes ride INSIDE the worker code
     *     blob; workerd compiles wasm during its own startup pipeline,
     *     never crossing structured-clone, never executing JS eval.
     *
     * The bytes ARE part of the loader-cache key (workerd hashes the
     * whole WorkerCode), so changing the wasm bytes invalidates warm
     * slots — desirable when the bundled wasm version changes.
     */
    wasmModules?: Record<string, ArrayBuffer>;
}
/** Per-call override (merged with pool defaults). */
export interface NimbusLoaderCallOptions {
    timeoutMs?: number;
    retries?: number;
    /**
     * Per-call WebAssembly modules. Merged with the pool's
     * constructor-time `wasmModules` at dispatch time and shipped via
     * the LOADER's modules map (same `{ wasm: ArrayBuffer }` shape).
     *
     * Shipping path validated empirically against prod (see
     * `WebAssembly.instantiate(bytes)` is blocked at request-time but
     * the LOADER-modules path compiles bytes during the inner
     * worker's module-load phase, where wasm code generation IS
     * permitted. The bytes ride INSIDE the worker code blob; workerd
     * never crosses structured-clone, never executes user-eval.
     *
     * Cache key impact: per-call bytes are fingerprinted (length +
     * first/last byte per module) and folded into the loader cache
     * key. Identical bytes on the same slot → warm reuse; different
     * bytes → fresh isolate. The pool's existing `wasmHash` field
     * captures CONSTRUCTOR-time bytes only; per-call bytes get an
     * independent fingerprint mixed into the slot id at dispatch.
     *
     * Naming collision rule: a per-call key MUST NOT collide with a
     * constructor-time key (after identifier sanitisation). The
     * dispatch path throws BindingError if it does — silently
     * shadowing the constructor's wasm would break the cache-key
     * invariant downstream callers rely on.
     *
     * Used by the `wasm-runner` shell command in src/runtime/
     * wasm-runner.ts to ship user-supplied .wasm bytes from VFS into
     * a fresh facet isolate per invocation.
     */
    wasmModules?: Record<string, ArrayBuffer>;
}
/** Per-map override. Adds onError strategy for partial failures. */
export interface NimbusLoaderMapOptions extends NimbusLoaderCallOptions {
    /** Concurrency override for this call. Defaults to pool's concurrency. */
    concurrency?: number;
    /**
     * What to do when an individual item fails:
     *   - 'throw' (default): reject whole map on first failure.
     *   - 'null': replace failed items with null in the result array.
     *   - 'skip': omit failed items from the result array.
     * We default to 'throw' — install-time failures are not silently ignored.
     */
    onError?: 'throw' | 'null' | 'skip';
}
export interface LoaderWorkerModuleSourceOptions {
    fnSource: string;
    preamble?: string;
    wasmEntries?: ReadonlyArray<{
        name: string;
        id: string;
    }>;
    hasBindings: boolean;
}
/** Assemble the exact JavaScript module parsed by a dynamic loader worker. */
export declare function assembleLoaderWorkerModuleSource(options: LoaderWorkerModuleSourceOptions): string;
/**
 * Nimbus-scoped parallel dispatch over `env.LOADER`. Tasks are pure
 * functions whose last argument is an `env` object containing the
 * forwarded bindings (default: `{ SUPERVISOR }`).
 *
 * Typical use:
 *
 *   const pool = new NimbusLoaderPool(env, ctx, {
 *     concurrency: 4,
 *     tag: 'npm-install',
 *   });
 *   const results = await pool.map(
 *     async (pkg, env) => env.SUPERVISOR.writeBatch(buildPayload(pkg)),
 *     toFetch,
 *   );
 */
export declare class NimbusLoaderPool {
    #private;
    private readonly loader;
    private readonly concurrency;
    private readonly defaultTimeoutMs;
    private readonly defaultRetries;
    private readonly tag;
    private readonly slotGenerations;
    private bindings;
    private readonly preamble;
    private readonly preambleHash;
    /**
     * WASM modules to ship in the LOADER `modules` map. See
     * NimbusLoaderPoolOptions.wasmModules for the rationale. Stored in
     * insertion order so the per-import preamble we generate matches
     * across pool dispatches (cache-key stability).
     */
    private readonly wasmModules;
    /** Hash of (name + byte length + first/last bytes) of every wasm
     *  module, folded into the loader cache key so changes invalidate
     *  warm slots. Hashing the FULL bytes would be O(20+ MiB) per dispatch
     *  and is unnecessary — wasm bytes are pinned at deploy time, the
     *  length+endpoints are a strong-enough fingerprint. */
    private readonly wasmHash;
    /**
     * Short prefix of the owning DO's id, baked into the loader.get()
     * cache key so warm isolates are scoped to ONE session. Without this,
     * session A's pool and session B's pool (same `tag` + `fnHash`) share
     * an isolate — which means B's writeBatch RPCs routed through A's
     * env.SUPERVISOR binding (minted with A's doId at construction
     * time). B's install reports success but the writes land in A's VFS,
     * leaving B with only the git-clone seed files (~119 instead of ~1491).
     * 12 chars is enough entropy for DO ids to collide-free per process.
     */
    private readonly doIdShort;
    constructor(env: any, ctx: DurableObjectState, opts?: NimbusLoaderPoolOptions);
    /** Effective concurrency used when no per-call override is supplied. */
    get defaultConcurrency(): number;
    /**
     * Run `fn` once with `arg` on a slot isolate. Returns the result or
     * throws TimeoutError / RetryExhaustedError / ExecutionError.
     */
    submit<T, R>(fn: (arg: T, env: any) => R | Promise<R>, arg: T, opts?: NimbusLoaderCallOptions): Promise<Awaited<R>>;
    /**
     * Run `fn` on every item in `items`, at most `concurrency` at a time,
     * pinned to stable slots so warm isolates are reused.
     *
     * Results are returned in input order. Failure handling per `onError`.
     */
    map<T, R>(fn: (item: T, env: any) => R | Promise<R>, items: T[], opts?: NimbusLoaderMapOptions): Promise<Array<Awaited<R> | null>>;
    /**
     * Same shape as `map`, but accepts a pre-serialized function source
     * string instead of a live function reference. Used by
     * `NimbusFanoutPool`'s peer-DO leg, where the function was already
     * serialized on the coordinator side and forwarded over RPC.
     *
     * The fnSource MUST be the output of `serializeFunction(fn)`
     * (typically forwarded directly from a coordinator RPC). Bytes-
     * stable invariants:
     *   - `fnHash = hashSource(fnSource)` must be deterministic so
     *     warm slots are correctly keyed.
     *   - `fnSource` must NOT reference `this` — same rule as
     *     `serializeFunction`.
     *
     * No fn-validation runs here (it already ran on the coordinator);
     * the peer trusts the caller to forward a valid serialization.
     */
    mapSource<T, R>(fnSource: string, items: T[], opts?: NimbusLoaderMapOptions): Promise<Array<Awaited<R> | null>>;
    /**
     * Release any RPC stubs held by the pool. Call this once the caller
     * is done with the pool (post-`map`/`submit`) so the underlying
     * stubs don't linger in workerd's deferred-destruction queue.
     *
     * Primary target: the SUPERVISOR binding stub we minted at
     * construction time (via `ctxExports.SupervisorRPC({props})`). It's
     * a cross-isolate RPC stub — without explicit disposal it stays
     * referenced until the parent isolate's event-handler context
     * finishes, which during npm install means "until the whole install
     * completes" — long enough to accumulate alongside other leaked
     * stubs and trip the QueueState::ACTIVE fatal.
     *
     * Safe to call more than once; idempotent.
     */
    dispose(): void;
}
//# sourceMappingURL=loader-pool.d.ts.map