/**
 * facet-pool.ts — Nimbus-specific wrapper over cloudflare-parallel.
 *
 * Adds on top of the vendored WorkerPool:
 *   1. **Stable-slot isolate reuse**. Upstream's #counter++ gives every
 *      dispatch a fresh isolate — fine for one-off AI calls, terrible for
 *      running 67 npm tarball extractions (cold-start dominates). We pin
 *      each job to `slot = cursor % concurrency` and use stable loader
 *      IDs `nfp:${fnHash}:slot-${i}`, so a pool of concurrency=4 keeps at
 *      most 4 warm isolates rather than N fresh ones.
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
 * This wrapper does NOT re-export the upstream surface. Users import
 * NimbusLoaderPool via src/parallel/index.ts; the vendored directory is
 * an implementation detail.
 */

import { CF_COMPAT_DATE } from '../constants.js';
import { getCtxExports } from '../session/ctx-exports.js';
import { serializeFunction, hashSource } from './vendor/serialize.js';
import { recordFailure, setLastFacetId, getLastRpcFrame } from '../observability/oom-discriminator.js';
import { classifyError } from '../observability/oom-classify.js';
import {
  BindingError,
  ExecutionError,
  RetryExhaustedError,
  TimeoutError,
} from './vendor/errors.js';
import type { WorkerLoader } from './vendor/types.js';

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
   * Raw JavaScript source prepended to every generated worker module.
   * Lets callers inject helpers that cannot be captured via `context`
   * (which is JSON-only) — typically a bundled dependency like a tar
   * parser. The user function can reference top-level names declared in
   * the preamble as if they were in lexical scope.
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
   * Extra module-level constants injected into the generated worker source
   * BEFORE the user function is declared. JSON-serializable only.
   */
  context?: Record<string, unknown>;
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

interface ResolvedResilience {
  timeoutMs: number;
  retries: number;
}

/**
 * esbuild runtime helpers re-declared at the top of every generated facet
 * module. esbuild emits `__name(fn, "fn")` wrappers around every named
 * function or arrow-with-binding-name; `fn.toString()` yields a body that
 * references `__name` by bare identifier. The supervisor bundle declares
 * `__name` at its own top level, but the binding does NOT cross isolate
 * boundaries — the facet's worker.js must re-declare it.
 *
 * The shim is bytes-stable so it doesn't perturb the loader-cache key;
 * if esbuild ever emits a new helper we'll see a "<name> is not defined"
 * error in the facet, add it here, and every slot rebuilds.
 */
const ESBUILD_RUNTIME_SHIM = [
  'const __defProp = Object.defineProperty;',
  'const __name = (target, value) => __defProp(target, "name", { value, configurable: true });',
].join('\n');

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
export class NimbusLoaderPool {
  private readonly loader: WorkerLoader;
  private readonly concurrency: number;
  private readonly defaultTimeoutMs: number;
  private readonly defaultRetries: number;
  private readonly tag: string;
  private readonly bindings: Record<string, unknown> | undefined;

  private readonly preamble: string | undefined;
  private readonly preambleHash: string;
  /**
   * WASM modules to ship in the LOADER `modules` map. See
   * NimbusLoaderPoolOptions.wasmModules for the rationale. Stored in
   * insertion order so the per-import preamble we generate matches
   * across pool dispatches (cache-key stability).
   */
  private readonly wasmModules: Array<{
    /** Specifier path the worker imports from (e.g. 'esbuild.wasm'). */
    name: string;
    /** Identifier used inside the generated worker for both the static
     *  import binding and the globalThis exposure. Sanitised from `name`. */
    id: string;
    bytes: ArrayBuffer;
  }>;
  /** Hash of (name + byte length + first/last bytes) of every wasm
   *  module, folded into the loader cache key so changes invalidate
   *  warm slots. Hashing the FULL bytes would be O(20+ MiB) per dispatch
   *  and is unnecessary — wasm bytes are pinned at deploy time, the
   *  length+endpoints are a strong-enough fingerprint. */
  private readonly wasmHash: string;
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
  private readonly doIdShort: string;

  constructor(
    env: any,
    ctx: DurableObjectState,
    opts?: NimbusLoaderPoolOptions,
  ) {
    const loader = env?.LOADER as WorkerLoader | undefined;
    if (!loader || typeof loader.get !== 'function') {
      throw new BindingError(
        'NimbusLoaderPool: env.LOADER binding missing or invalid. ' +
          'Add a [[worker_loaders]] entry to wrangler.jsonc.',
      );
    }
    this.loader = loader;
    this.concurrency = Math.max(1, opts?.concurrency ?? 4);
    this.defaultTimeoutMs = opts?.timeoutMs ?? 60_000;
    this.defaultRetries = Math.max(0, opts?.retries ?? 0);
    this.tag = opts?.tag ?? 'facet';
    this.preamble = opts?.preamble;
    // Include preamble in the cache-bucket key so changes to bundled helpers
    // invalidate warm slots. Empty preamble → '0' suffix (stable).
    this.preambleHash = this.preamble ? hashSource(this.preamble) : '0';
    this.doIdShort = ctx.id.toString().slice(0, 12);

    // Materialise the wasm-modules table. Sanitise each name into a
    // valid JS identifier for the static import binding; key collisions
    // (e.g. 'esbuild.wasm' and 'esbuild_wasm' both sanitise to
    // 'esbuild_wasm') are rejected loudly because the generated worker
    // would otherwise have duplicate imports. Order is preserved.
    const wasmEntries: Array<{ name: string; id: string; bytes: ArrayBuffer }> = [];
    const seenIds = new Set<string>();
    if (opts?.wasmModules) {
      for (const [name, bytes] of Object.entries(opts.wasmModules)) {
        if (!(bytes instanceof ArrayBuffer)) {
          throw new BindingError(
            `NimbusLoaderPool: wasmModules['${name}'] must be ArrayBuffer ` +
            `(got ${(bytes as any)?.constructor?.name || typeof bytes}).`,
          );
        }
        const id = name.replace(/[^A-Za-z0-9_]/g, '_').replace(/^[^A-Za-z_]/, '_');
        if (seenIds.has(id)) {
          throw new BindingError(
            `NimbusLoaderPool: wasmModules key '${name}' collides with another after ` +
            `identifier-sanitisation (id='${id}'). Pick distinct module names.`,
          );
        }
        seenIds.add(id);
        wasmEntries.push({ name, id, bytes });
      }
    }
    this.wasmModules = wasmEntries;
    // Fingerprint: name + length + first/last byte of each module.
    // Hashing 20+ MiB of wasm per dispatch would be wasteful; this
    // fingerprint is bytes-stable for a given deployed bundle and only
    // changes when the wasm itself changes (deploy-time event).
    if (wasmEntries.length === 0) {
      this.wasmHash = '0';
    } else {
      const fp = wasmEntries
        .map((w) => {
          const u = new Uint8Array(w.bytes);
          const len = u.byteLength;
          const first = len > 0 ? u[0] : 0;
          const last  = len > 0 ? u[len - 1] : 0;
          return `${w.name}:${len}:${first}:${last}`;
        })
        .join('|');
      this.wasmHash = hashSource(fp);
    }

    const bindings: Record<string, unknown> = { ...(opts?.extraBindings ?? {}) };
    if (!opts?.omitSupervisor) {
      const ctxExports = getCtxExports();
      if (ctxExports?.SupervisorRPC) {
        bindings.SUPERVISOR = ctxExports.SupervisorRPC({
          props: { doId: ctx.id.toString(), pid: 0 },
        });
      } else {
        // SupervisorRPC unavailable — likely running without ctx.exports
        // (legacy LOADER.load path). We still construct the pool but the
        // facet will get env.SUPERVISOR === undefined. Callers that need
        // SUPERVISOR should check availability before dispatch.
        // (A facet that tries to call env.SUPERVISOR.writeBatch will
        // throw a plain TypeError; that's the clearest failure mode.)
      }
    }
    this.bindings = Object.keys(bindings).length > 0 ? bindings : undefined;
  }

  /** Effective concurrency used when no per-call override is supplied. */
  get defaultConcurrency(): number {
    return this.concurrency;
  }

  #resolve(opts?: NimbusLoaderCallOptions): ResolvedResilience {
    return {
      timeoutMs: Math.max(0, opts?.timeoutMs ?? this.defaultTimeoutMs),
      retries: Math.max(0, opts?.retries ?? this.defaultRetries),
    };
  }

  /**
   * Build the WorkerCode blob that the loader callback will return.
   * Same bytes every time for a given (fnHash, slot, context) → lets
   * workerd treat it as a cache hit and reuse the isolate.
   *
   * Always prepends the ESBUILD_RUNTIME_SHIM so stringified functions that
   * reference esbuild-emitted helpers (__name, __defProp, etc.) don't
   * crash the facet with "__name is not defined". User preambles are
   * appended below the shim.
   */
  #buildCode(fnSource: string, context?: Record<string, unknown>) {
    const workerOpts = {
      compatibilityDate: CF_COMPAT_DATE,
      compatibilityFlags: ['nodejs_compat'],
      // Inherit parent network so the facet can reach registry.npmjs.org.
      globalOutbound: undefined as any,
      env: this.bindings,
    };

    // Build module source manually (always — even without a user preamble
    // — because we always want the esbuild-helper shim). The vendored
    // buildWorkerCode is no longer used on this path; we keep the same
    // module shape (default-export WorkerEntrypoint with execute()).
    const lines: string[] = [
      'import { WorkerEntrypoint } from "cloudflare:workers";',
    ];

    // ── WASM module imports ───────────────────────────────────────────
    // Each entry in `wasmModules` is registered in the LOADER's modules
    // map (below) as `{ wasm: ArrayBuffer }`. workerd compiles each
    // during the worker's module-load phase (eval permitted there) and
    // the standard ESM import binding receives the resulting
    // WebAssembly.Module. We expose them on `globalThis.__NIMBUS_WASM`
    // so the user fn can read them at request time without having to
    // re-import (the user fn is serialized via fn.toString and
    // doesn't carry import statements).
    if (this.wasmModules.length > 0) {
      lines.push('');
      lines.push('// ── Pool-injected WebAssembly modules ─────────────────────');
      for (const w of this.wasmModules) {
        lines.push(`import __NIMBUS_WASM_${w.id} from './${w.name}';`);
      }
      lines.push('globalThis.__NIMBUS_WASM = globalThis.__NIMBUS_WASM || {};');
      for (const w of this.wasmModules) {
        // Bind by ORIGINAL name (the spec the caller used) so the user
        // fn looks up via the same key it passed to wasmModules.
        lines.push(
          `globalThis.__NIMBUS_WASM[${JSON.stringify(w.name)}] = __NIMBUS_WASM_${w.id};`,
        );
      }
      lines.push('// ── End pool-injected WebAssembly modules ─────────────────');
    }

    lines.push(
      '',
      '// ── esbuild runtime shim ──────────────────────────────────',
      '// When Nimbus is bundled by wrangler/esbuild, our facet function',
      '// is transformed into `__name(async function …, "…")` at emit',
      '// time. `fn.toString()` then yields the wrapped function body,',
      '// but `__name` and its helpers are module-local in the SUPERVISOR',
      '// bundle and do NOT cross into the facet isolate. Redeclare them',
      '// here so facet bodies survive the toString() round-trip.',
      ESBUILD_RUNTIME_SHIM,
      '// ── End esbuild runtime shim ──────────────────────────────',
      '',
    );
    if (this.preamble) {
      lines.push(
        '// ── Preamble (pool-level helpers) ─────────────────────────',
        this.preamble,
        '// ── End preamble ──────────────────────────────────────────',
        '',
      );
    }
    if (context) {
      for (const [key, value] of Object.entries(context)) {
        lines.push(`const ${key} = ${JSON.stringify(value)};`);
      }
      lines.push('');
    }
    lines.push(`const __fn__ = ${fnSource};`);
    lines.push('');
    const callExpr = this.bindings
      ? '__fn__(...args, this.env)'
      : '__fn__(...args)';
    lines.push(
      'export default class extends WorkerEntrypoint {',
      '  execute(...args) {',
      `    const result = ${callExpr};`,
      '    if (result instanceof Promise) return result;',
      '    return result;',
      '  }',
      '}',
    );
    const moduleSource = lines.join('\n');

    // Modules map: the entry worker.js source plus any wasm modules the
    // pool was constructed with. Workerd parses the modules map at
    // worker-load time and resolves the static `import` statements
    // we generated above against this map. The wasm-shape entry
    // (`{ wasm: ArrayBuffer }`) tells workerd to compile during the
    // module-load phase — the only phase where wasm code generation
    // is permitted in this deploy.
    const modules: Record<string, any> = { 'worker.js': moduleSource };
    for (const w of this.wasmModules) {
      modules[w.name] = { wasm: w.bytes };
    }

    return {
      compatibilityDate: workerOpts.compatibilityDate,
      compatibilityFlags: workerOpts.compatibilityFlags,
      mainModule: 'worker.js',
      modules,
      env: workerOpts.env,
      // globalOutbound: undefined = inherit parent network; omitting the key
      // from the returned object has the same effect (codegen treats
      // absence as inherit when the key is explicitly stated; here we keep
      // it absent to match the cloudflare-parallel semantics).
    } as const;
  }

  /**
   * Dispatch a single task to the slot isolate. `slotIndex` picks which
   * warm isolate services the call; callers round-robin slots themselves.
   */
  async #dispatchSlot(
    fnSource: string,
    fnHash: string,
    slotIndex: number,
    args: unknown[],
    context: Record<string, unknown> | undefined,
    resilience: ResolvedResilience,
  ): Promise<unknown> {
    // Cache key includes the short DO id so warm isolates are scoped to
    // ONE session. See the doIdShort field comment for why — without it,
    // a later session's pool reuses the warm worker from a previous
    // session (which still carries the old session's env.SUPERVISOR
    // binding), and writeBatch RPCs land in the wrong DO's VFS.
    const id = `nfp:${this.tag}:${this.doIdShort}:${fnHash}:${this.preambleHash}:${this.wasmHash}:slot-${slotIndex}`;
    const code = this.#buildCode(fnSource, context);

    // W5 Lever 5: record the dispatch so /api/_diag/memory shows the
    // last-facet-id even on a hang or silent kill. Bounded — single
    // slot updated on every dispatch.
    try { setLastFacetId(id, slotIndex); } catch { /* best-effort */ }

    const runOnce = async (): Promise<unknown> => {
      // loader.get() is synchronous from the caller's POV; the callback
      // is only invoked on cache miss. We wrap the callback tightly so a
      // retry doesn't rebuild workerCode — that's already stable here.
      //
      // The returned `stub` is the cached worker reference. We deliberately
      // do NOT dispose it: loader.get() is designed for warm-slot reuse
      // across dispatches (same `id` returns the same cached worker),
      // and disposing would invalidate that cache.
      //
      // We USED to also dispose the per-dispatch `entrypoint` stub in a
      // finally block here (added in 3c47b44 to prevent QueueState::ACTIVE
      // during cold-start install). Empirically that broke dispatch on
      // every slot after the first: once the finally ran
      // `entrypoint[Symbol.dispose]()`, subsequent dispatches on the
      // same cached slot hung — SupervisorRPC.writeBatch logged
      // 'canceled', the DO-side _rpcWriteBatch completed OK, but the
      // pool never saw the result and every task stalled to the 60s
      // per-task timeout at 0/13 packages. Removing the per-dispatch
      // dispose restored 13/13 in ~2.3s in dev.
      //
      // The pool-level dispose() method below (also from 3c47b44) is
      // fine and stays — it only tears down the long-lived SUPERVISOR
      // binding stub once the whole pool is done, which does NOT
      // invalidate any in-flight slot's entrypoint reference.
      const stub = this.loader.get(id, async () => code);
      const entrypoint = stub.getEntrypoint();
      try {
        const out = await entrypoint.execute(...args);
        return out;
      } catch (err) {
        if (err instanceof Error) {
          throw new ExecutionError(err.message, err.stack);
        }
        throw new ExecutionError(String(err));
      }
    };

    const maxAttempts = 1 + resilience.retries;
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        if (resilience.timeoutMs > 0) {
          // Race runOnce() against a settable timer. CRITICAL: clear
          // the timer in a finally so the timer's reject closure (which
          // transitively roots `args` — i.e. the per-task payload sent
          // to the slot, including 28 MiB pre-bundle slices) doesn't
          // hold its references for the full timeoutMs after the race
          // settles.
          //
          // Before this fix: a facet OOM at t=0 left the slice rooted
          // for the remaining timeoutMs (default 60s for pre-bundle).
          // With concurrency=2, two consecutive OOMs could pin
          // ~56 MiB of slice memory in the supervisor heap for a full
          // minute — alongside an in-flight cirrus-real boot, that's
          // enough to push a shared isolate over the 128 MiB cap.
          // See plan in close-plan-2026-04-28.
          let timerId: ReturnType<typeof setTimeout> | undefined;
          try {
            return await Promise.race([
              runOnce(),
              new Promise<never>((_, reject) => {
                timerId = setTimeout(
                  () => reject(new TimeoutError(resilience.timeoutMs)),
                  resilience.timeoutMs,
                );
              }),
            ]);
          } finally {
            if (timerId !== undefined) clearTimeout(timerId);
          }
        }
        return await runOnce();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // W5 Lever 5: classify + record. We push on EVERY failed
        // attempt (not just the final retry-exhausted throw) so the
        // ring captures transient SQLITE_NOMEM / clone-refused
        // patterns that still ultimately succeed. Ring is bounded
        // (50 entries) so noise is self-limiting.
        try {
          recordFailure({
            at: Date.now(),
            phase: 'rpc',
            cause: classifyError(lastError),
            rssEstimateBytes: 0, heapUsedBytes: 0,
            lruBytes: 0, inFlightBytes: 0,
            lastRpcFrame: getLastRpcFrame(),
            lastFacetId: { codeId: id, slotIndex, atMs: Date.now() },
            message: lastError.message,
          });
        } catch { /* fail-soft */ }
        if (attempt < maxAttempts - 1) {
          // 100 * 2^attempt, capped at 2s so retries don't compound waiting.
          const delay = Math.min(2000, 100 * Math.pow(2, attempt));
          await new Promise((r) => setTimeout(r, delay));
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

  /**
   * Run `fn` once with `arg` on a slot isolate. Returns the result or
   * throws TimeoutError / RetryExhaustedError / ExecutionError.
   */
  async submit<T, R>(
    fn: (arg: T, env: any) => R | Promise<R>,
    arg: T,
    opts?: NimbusLoaderCallOptions,
  ): Promise<Awaited<R>> {
    const { fnSource, fnHash } = this.#prepare(fn);
    const resilience = this.#resolve(opts);
    return (await this.#dispatchSlot(
      fnSource,
      fnHash,
      0,
      [arg],
      opts?.context,
      resilience,
    )) as Awaited<R>;
  }

  /**
   * Run `fn` on every item in `items`, at most `concurrency` at a time,
   * pinned to stable slots so warm isolates are reused.
   *
   * Results are returned in input order. Failure handling per `onError`.
   */
  async map<T, R>(
    fn: (item: T, env: any) => R | Promise<R>,
    items: T[],
    opts?: NimbusLoaderMapOptions,
  ): Promise<Array<Awaited<R> | null>> {
    if (items.length === 0) return [];

    const { fnSource, fnHash } = this.#prepare(fn);
    const resilience = this.#resolve(opts);
    const concurrency = Math.max(
      1,
      Math.min(opts?.concurrency ?? this.concurrency, items.length),
    );
    const onError: 'throw' | 'null' | 'skip' = opts?.onError ?? 'throw';

    type Settled =
      | { ok: true; value: Awaited<R> }
      | { ok: false; error: Error };
    const settled: Settled[] = new Array(items.length);
    let cursor = 0;

    const runSlot = async (slotIndex: number): Promise<void> => {
      while (true) {
        const idx = cursor++;
        if (idx >= items.length) return;
        try {
          const value = (await this.#dispatchSlot(
            fnSource,
            fnHash,
            slotIndex,
            [items[idx]],
            opts?.context,
            resilience,
          )) as Awaited<R>;
          settled[idx] = { ok: true, value };
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          if (onError === 'throw') throw error;
          settled[idx] = { ok: false, error };
        }
      }
    };

    await Promise.all(
      Array.from({ length: concurrency }, (_, slotIndex) => runSlot(slotIndex)),
    );

    if (onError === 'null') {
      return settled.map((s) => (s.ok ? s.value : null));
    }
    if (onError === 'skip') {
      return settled
        .filter((s): s is { ok: true; value: Awaited<R> } => s.ok)
        .map((s) => s.value);
    }
    // onError === 'throw' — all slots succeeded.
    return settled.map((s) => (s as { ok: true; value: Awaited<R> }).value);
  }

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
  dispose(): void {
    if (!this.bindings) return;
    const disposerKey = (Symbol as any).dispose;
    if (!disposerKey) return;
    for (const key of Object.keys(this.bindings)) {
      const stub = (this.bindings as any)[key];
      const disposer = stub?.[disposerKey];
      if (typeof disposer === 'function') {
        try { disposer.call(stub); } catch { /* best-effort */ }
      }
    }
    // Prevent double-dispose from re-running the loop.
    (this as any).bindings = undefined;
  }
}

/** Re-export the subset of error types callers need to catch. */
export {
  BindingError,
  ExecutionError,
  RetryExhaustedError,
  TimeoutError,
} from './vendor/errors.js';
