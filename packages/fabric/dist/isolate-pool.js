/**
 * isolate-pool.ts — Nimbus loader-isolate pool based on cloudflare-parallel.
 *
 * Adds Nimbus-specific behavior to the upstream pool design:
 *   1. **Stable-slot isolate reuse**. Upstream's #counter++ gives every
 *      dispatch a fresh isolate — fine for one-off AI calls, terrible for
 *      running 67 npm tarball extractions (cold-start dominates). We pin
 *      each job to `slot = cursor % concurrency` and use stable loader
 *      IDs `nfp:${fnHash}:slot-${i}:g${generation}`, so a pool of
 *      concurrency=N keeps at most N warm isolates rather than one per job.
 *   2. **Nimbus defaults**: compatibilityDate = CF_COMPAT_DATE (matches
 *      the supervisor worker), compatibilityFlags = GUEST_COMPAT_FLAGS,
 *      globalOutbound = undefined (inherit parent network so the facet can
 *      reach https://registry.npmjs.org without a proxy binding).
 *   3. **Supervisor autoinjection**. The pool grabs the embedder's
 *      registered supervisor entrypoint stub (see `supervisorEntrypoint` in
 *      composition.ts) and forwards it as `env.SUPERVISOR` to every facet,
 *      same pattern as git/network-facet.ts. Callers can add more bindings
 *      via `extraBindings`.
 *   4. **Fail-loud defaults**: timeout 60s, retries 0, onError 'throw'.
 *      Caller opts in to leniency.
 *
 * The vendored directory contains only the upstream serialization, error,
 * and binding types used by this implementation.
 */
import { CF_COMPAT_DATE, GUEST_COMPAT_FLAGS } from '@nimbus-sh/core/constants.js';
import { supervisorEntrypoint } from './composition.js';
import { supervisorBindingProps, supervisorLoaderKey } from './supervisor-props.js';
import { disposeRpcResource } from '@nimbus-sh/platform/rpc-dispose.js';
import { serializeFunction, hashSource } from './vendor/serialize.js';
import { beginLoaderFetch, beginLoaderFetchWhenFree, claimAdmission, withDynamicWorkerCapNamed, } from './budgets.js';
import { assertModuleMapWithinCodeLimit } from './budgets.js';
import { recordFailure, setLastFacetId, getLastRpcFrame } from '@nimbus-sh/platform/oom-discriminator.js';
import { classifyError } from '@nimbus-sh/platform/oom-classify.js';
import { BindingError, ExecutionError, RetryExhaustedError, TimeoutError, } from './vendor/errors.js';
import { hostWasmIdentity } from './host-wasm.js';
/**
 * How long one call waits, in all, on the Dynamic Worker ledger after
 * "Dynamic worker concurrency limit exceeded" before the refusal surfaces
 * (beginLoaderFetchWhenFree: let in when a hold ends or the refusal's pause
 * passes). A deployed Durable Object admitted the refused batch after a 6 s
 * pause; 15 s bounds a call that would never be admitted.
 */
const CAP_REFUSAL_WAIT_MS = 15_000;
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
    'const __nimbusDisposeRpcResult = (value) => {',
    '  if ((typeof value !== "object" && typeof value !== "function") || value === null) return;',
    '  const dispose = value[Symbol.dispose];',
    '  if (typeof dispose === "function") { try { dispose.call(value); } catch {} }',
    '};',
    'const __nimbusUseRpcResult = async (promise, use) => {',
    '  const value = await promise;',
    '  try { return await use(value); }',
    '  finally { __nimbusDisposeRpcResult(value); }',
    '};',
].join('\n');
/** Assemble the exact JavaScript module parsed by a dynamic loader worker. */
export function assembleLoaderWorkerModuleSource(options) {
    const lines = [
        'import { WorkerEntrypoint } from "cloudflare:workers";',
    ];
    const wasmEntries = options.wasmEntries ?? [];
    if (wasmEntries.length > 0) {
        lines.push('');
        lines.push('// ── Pool-injected WebAssembly modules ─────────────────────');
        for (const entry of wasmEntries) {
            lines.push(`import __NIMBUS_WASM_${entry.id} from './${entry.name}';`);
        }
        lines.push('globalThis.__NIMBUS_WASM = globalThis.__NIMBUS_WASM || {};');
        for (const entry of wasmEntries) {
            lines.push(`globalThis.__NIMBUS_WASM[${JSON.stringify(entry.name)}] = __NIMBUS_WASM_${entry.id};`);
        }
        lines.push('// ── End pool-injected WebAssembly modules ─────────────────');
    }
    lines.push('', '// ── esbuild runtime shim ──────────────────────────────────', '// When Nimbus is bundled by wrangler/esbuild, our facet function', '// is transformed into `__name(async function …, "…")` at emit', '// time. `fn.toString()` then yields the wrapped function body,', '// but `__name` and its helpers are module-local in the SUPERVISOR', '// bundle and do NOT cross into the facet isolate. Redeclare them', '// here so facet bodies survive the toString() round-trip.', ESBUILD_RUNTIME_SHIM, '// ── End esbuild runtime shim ──────────────────────────────', '');
    if (options.preamble) {
        lines.push('// ── Preamble (pool-level helpers) ─────────────────────────', options.preamble, '// ── End preamble ──────────────────────────────────────────', '');
    }
    lines.push(`const __fn__ = ${options.fnSource};`);
    lines.push('');
    const callExpr = options.hasBindings
        ? '__fn__(...args, this.env)'
        : '__fn__(...args)';
    const requestCallExpr = options.hasBindings
        ? '__fn__(request, this.env)'
        : '__fn__(request)';
    lines.push('export default class extends WorkerEntrypoint {', '  execute(...args) {', `    const result = ${callExpr};`, '    if (result instanceof Promise) return result;', '    return result;', '  }', '', '  // Request/Response transport: the ONE dispatch path whose abort is', '  // real. workerd cancels the inner execution context when the request', '  // signal aborts while the fn is suspended on I/O; RPC execute() above', '  // has no equivalent (measured: Symbol.dispose on a pending RPC does', '  // not cancel). The fn is request-shaped — it encodes and decodes its', '  // own payload; nothing generic is serialized here.', '  async fetch(request) {', '    try {', `      const result = await ${requestCallExpr};`, '      if (result instanceof Response) return result;', '      return Response.json(result ?? null);', '    } catch (err) {', '      // Fail loud inside the response so an abort of the transport is', '      // not conflated with a guest exception: the caller sees 500 only', '      // for a real fn failure, and aborts arrive as fetch rejections.', '      const message = err instanceof Error && err.message ? err.message : String(err);', '      return Response.json({ __nimbusFacetError: message }, { status: 500 });', '    }', '  }', '}');
    return lines.join('\n');
}
/**
 * Nimbus-scoped parallel dispatch over `env.LOADER`. Tasks are pure
 * functions whose last argument is an `env` object containing the
 * forwarded bindings (default: `{ SUPERVISOR }`).
 *
 * Typical use:
 *
 *   const pool = new IsolatePool(env, ctx, {
 *     concurrency: 2,
 *     tag: 'npm-install',
 *   });
 *   const results = await pool.map(
 *     async (pkg, env) => env.SUPERVISOR.writeBatch(buildPayload(pkg)),
 *     toFetch,
 *   );
 */
export class IsolatePool {
    loader;
    /** The hosting actor, as the loader budget ledger's per-DO key. */
    ctx;
    /** The width this pool's dispatches are held inside (IsolatePoolOptions.claim). */
    claim;
    concurrency;
    defaultTimeoutMs;
    defaultRetries;
    tag;
    slotGenerations = new Map();
    /**
     * Per-slot execution ownership: the tail of each slot's in-flight
     * dispatch chain. Two dispatches on the same warm isolate at once
     * interleave on its QueueState — map() callers used to trust the
     * caller's slot round-robin, which could not prevent submit() (slot
     * 0) or a second map() landing on a slot a task still occupied. Every
     * dispatch now waits for the slot's previous execution to settle
     * before touching it.
     */
    slotTails = new Map();
    /** Set by dispose() — queued dispatches reject instead of running. */
    disposed = false;
    bindings;
    preamble;
    preambleHash;
    /**
     * WASM modules to ship in the LOADER `modules` map. See
     * IsolatePoolOptions.wasmModules for the rationale. Stored in
     * insertion order so the per-import preamble we generate matches
     * across pool dispatches (cache-key stability).
     */
    wasmModules;
    /** Hash of every constructor-time wasm module, folded into the loader
     *  cache key so changes invalidate warm slots: a compiled module by the
     *  identity its host described, bytes by name + length + first/last
     *  byte. Hashing the FULL bytes would be O(20+ MiB) per dispatch and is
     *  unnecessary — they are pinned at deploy time. */
    wasmHash;
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
    doIdShort;
    /**
     * The supervisor identity the minted worker's env.SUPERVISOR binding
     * bakes (doId short-form + pid), folded into the loader cache key. 's-none'
     * when no SUPERVISOR binding was minted, so a supervisor-less pool keeps
     * the old key shape and its warm slots stay shared.
     */
    supervisorKey;
    /** Extra loader-id segment from options.scope — see IsolatePoolOptions. */
    scope;
    constructor(env, ctx, opts) {
        // A host hands its whole env over; the binding is claimed here and the
        // claim is checked on the next line.
        const loader = env?.LOADER;
        if (!loader || typeof loader.get !== 'function') {
            throw new BindingError('IsolatePool: env.LOADER binding missing or invalid. ' +
                'Add a [[worker_loaders]] entry to wrangler.jsonc.');
        }
        this.loader = loader;
        this.ctx = ctx;
        this.claim = opts?.claim;
        this.concurrency = Math.max(1, opts?.concurrency ?? 1);
        this.defaultTimeoutMs = opts?.timeoutMs ?? 60_000;
        this.defaultRetries = Math.max(0, opts?.retries ?? 0);
        this.tag = opts?.tag ?? 'facet';
        this.preamble = opts?.preamble;
        // Include preamble in the cache-bucket key so changes to bundled helpers
        // invalidate warm slots. Empty preamble → '0' suffix (stable).
        this.preambleHash = this.preamble ? hashSource(this.preamble) : '0';
        this.doIdShort = opts?.cacheScope === 'global'
            ? 'global'
            : ctx.id.toString().slice(0, 12);
        this.scope = opts?.scope ?? '';
        // Materialise the wasm-modules table. Sanitise each name into a
        // valid JS identifier for the static import binding; key collisions
        // (e.g. 'esbuild.wasm' and 'esbuild_wasm' both sanitise to
        // 'esbuild_wasm') are rejected loudly because the generated worker
        // would otherwise have duplicate imports. Order is preserved.
        const wasmEntries = [];
        const fingerprints = [];
        const seenIds = new Set();
        if (opts?.wasmModules) {
            for (const [name, wasm] of Object.entries(opts.wasmModules)) {
                let fingerprint;
                if (wasm instanceof ArrayBuffer) {
                    // Name + length + first/last byte: hashing 20+ MiB of wasm per
                    // dispatch would be wasteful, and these bytes change only with
                    // the deployed bundle.
                    const u = new Uint8Array(wasm);
                    const len = u.byteLength;
                    fingerprint = `${name}:${len}:${len > 0 ? u[0] : 0}:${len > 0 ? u[len - 1] : 0}`;
                }
                else if (wasm instanceof WebAssembly.Module) {
                    const identity = hostWasmIdentity(wasm);
                    if (!identity) {
                        throw new BindingError(`IsolatePool: wasmModules['${name}'] is a WebAssembly.Module nobody described; ` +
                            'pass it through describeHostWasm (@nimbus-sh/fabric/host-wasm.js) so warm slots ' +
                            'can be keyed by it and the code limit can count it.');
                    }
                    fingerprint = `${name}:host:${identity.id}:${identity.bytes}`;
                }
                else {
                    // Reached only when a caller broke the declared option type, so the
                    // value is whatever it really was rather than the union here.
                    const got = wasm?.constructor?.name;
                    throw new BindingError(`IsolatePool: wasmModules['${name}'] must be an ArrayBuffer or a WebAssembly.Module ` +
                        `(got ${got || typeof wasm}).`);
                }
                const id = name.replace(/[^A-Za-z0-9_]/g, '_').replace(/^[^A-Za-z_]/, '_');
                if (seenIds.has(id)) {
                    throw new BindingError(`IsolatePool: wasmModules key '${name}' collides with another after ` +
                        `identifier-sanitisation (id='${id}'). Pick distinct module names.`);
                }
                seenIds.add(id);
                wasmEntries.push({ name, id, wasm });
                fingerprints.push(fingerprint);
            }
        }
        this.wasmModules = wasmEntries;
        this.wasmHash = fingerprints.length === 0 ? '0' : hashSource(fingerprints.join('|'));
        const bindings = { ...(opts?.extraBindings ?? {}) };
        this.supervisorKey = 's-none';
        if (!opts?.omitSupervisor) {
            const supervisorRpc = supervisorEntrypoint();
            if (supervisorRpc) {
                // INSTALL-HONESTY: peer-DO branch supplies coordinator's doId
                // via supervisorDoIdOverride so SUPERVISOR.* RPCs route back
                // to the user's session DO, not the peer DO. Default to the
                // local ctx.id (single-DO callers and the in-DO in-DO fanout path).
                const supervisor = supervisorBindingProps(ctx, opts?.supervisorPid ?? 0, {
                    doId: opts?.supervisorDoIdOverride,
                    route: opts?.supervisorRoute,
                });
                bindings.SUPERVISOR = supervisorRpc({ props: supervisor });
                // Whatever the minted worker's env carries must be in its loader
                // cache key — workerd's loader cache survives a DO hibernation
                // wake while generation-strided pids (1000001 → 2000001) do not:
                // a warm slot keyed without the supervisor identity returns in
                // the new generation still credentialed to the dead pid, and
                // every pid-authorized RPC from it fails "process pid … does
                // not exist". doIdShort alone cannot cover this — it changes
                // across sessions, not across wakes of the same session. So does
                // the instance a binding delivers mutations to, when it names one.
                this.supervisorKey = supervisorLoaderKey(`s${supervisor.doId.slice(0, 12)}-${supervisor.pid}`, supervisor);
            }
            else {
                // Supervisor entrypoint unavailable — running without ctx.exports
                // (e.g. unit-test harness, or LOADER.load contexts where the
                // bindings.SUPERVISOR auto-wire isn't set up). We still construct
                // the pool but the facet will get env.SUPERVISOR === undefined.
                // Callers that need SUPERVISOR should check availability before
                // dispatch. (A facet that tries to call env.SUPERVISOR.writeBatch
                // will throw a plain TypeError; that's the clearest failure mode.)
            }
        }
        this.bindings = Object.keys(bindings).length > 0 ? bindings : undefined;
    }
    /** Effective concurrency used when no per-call override is supplied. */
    get defaultConcurrency() {
        return this.concurrency;
    }
    #resolve(opts) {
        return {
            timeoutMs: Math.max(0, opts?.timeoutMs ?? this.defaultTimeoutMs),
            retries: Math.max(0, opts?.retries ?? this.defaultRetries),
        };
    }
    /**
     * Materialise per-call wasm bytes into the {name,id,bytes} shape
     * the import-build path expects. Mirrors the constructor's logic
     * (identifier sanitisation + collision check) but ALSO rejects
     * collisions with constructor-time entries.
     *
     * Returns [] when there are no per-call entries — that's the hot
     * path (every existing pool dispatch).
     */
    #materialisePerCallWasm(perCall) {
        if (!perCall)
            return [];
        const out = [];
        const ctorIds = new Set(this.wasmModules.map((w) => w.id));
        const seen = new Set();
        for (const [name, bytes] of Object.entries(perCall)) {
            if (!(bytes instanceof ArrayBuffer)) {
                const got = bytes?.constructor?.name;
                throw new BindingError(`IsolatePool: per-call wasmModules['${name}'] must be ` +
                    `ArrayBuffer (got ${got || typeof bytes}).`);
            }
            const id = name.replace(/[^A-Za-z0-9_]/g, '_').replace(/^[^A-Za-z_]/, '_');
            if (ctorIds.has(id)) {
                throw new BindingError(`IsolatePool: per-call wasmModules key '${name}' (sanitised ` +
                    `id='${id}') collides with a constructor-time wasm module. ` +
                    `Per-call modules cannot shadow pool-defaults. Pick a distinct name.`);
            }
            if (seen.has(id)) {
                throw new BindingError(`IsolatePool: per-call wasmModules key '${name}' (sanitised ` +
                    `id='${id}') collides with another per-call key. Pick distinct names.`);
            }
            seen.add(id);
            out.push({ name, id, wasm: bytes });
        }
        return out;
    }
    /**
     * Compute a stable fingerprint of a list of {name,bytes} entries.
     * Returns '0' for the empty list (cache-key bytes-stable for the
     * common no-per-call-wasm case). Same fingerprinting strategy as
     * the constructor's `wasmHash`: name + length + first/last byte
     * per module. Hashing all bytes would be O(20+ MiB) per dispatch
     * for nothing — the length+endpoints fingerprint is a strong-
     * enough discriminator and identical bytes produce identical
     * fingerprints (warm reuse).
     *
     * Per-call wasm fingerprinting MUST be content-sensitive: when a user
     * compiles two .c files (e.g. `clang a.c -o a` then `clang b.c -o b`)
     * the resulting .wasm binaries may differ by only a few bytes deep
     * inside the code section. The old fingerprint
     * `name + len + first + last` collided for such cases, returning the
     * same cache key and forcing a warm-isolate reuse that served the
     * FIRST binary's WebAssembly.Module on the second dispatch (verified
     * in prod: ./a and ./b were both 7572 bytes with identical first/last
     * bytes, differing only at offset 651 — clang-state-fix wave repro).
     *
     * Fix: hash the ACTUAL bytes via djb2 over the full content. Per-call
     * wasm is typically the user's compiled binary (KBs to a few MiB);
     * djb2 of a few MiB takes microseconds on the supervisor side and
     * runs once per dispatch (not per request — warm-reuse-on-match still
     * works for the legitimate "same bytes" case). The savings of NOT
     * hashing the wasm were marginal; the correctness cost was severe.
     */
    #fingerprintWasm(entries) {
        if (entries.length === 0)
            return '0';
        const parts = [];
        for (const w of entries) {
            const u = new Uint8Array(w.wasm);
            const len = u.byteLength;
            // djb2 over the bytes. Faster than crypto.subtle.digest at small
            // sizes, deterministic, and good enough for cache-key
            // disambiguation (NOT cryptographic — the loader cache doesn't
            // protect against malicious inputs).
            let h = 5381;
            for (let i = 0; i < len; i++) {
                h = ((h << 5) + h + u[i]) | 0;
            }
            parts.push(`${w.name}:${len}:${(h >>> 0).toString(36)}`);
        }
        return hashSource(parts.join('|'));
    }
    /**
     * Build the WorkerCode blob that the loader callback will return.
     * Same bytes every time for a given function and slot, allowing workerd
     * to reuse the isolate.
     *
     * Always prepends the ESBUILD_RUNTIME_SHIM so stringified functions that
     * reference esbuild-emitted helpers (__name, __defProp, etc.) don't
     * crash the facet with "__name is not defined". User preambles are
     * appended below the shim.
     */
    #buildCode(fnSource, perCallWasmEntries) {
        const workerOpts = {
            compatibilityDate: CF_COMPAT_DATE,
            compatibilityFlags: [...GUEST_COMPAT_FLAGS],
            // Inherit parent network so the facet can reach registry.npmjs.org.
            globalOutbound: undefined,
            env: this.bindings,
        };
        // ── WASM module imports ───────────────────────────────────────────
        // Each entry in `wasmModules` (constructor-time + per-call) is
        // registered in the LOADER's modules map (below) as
        // `{ wasm: ArrayBuffer }`. workerd compiles each during the
        // worker's module-load phase (eval permitted there) and the
        // standard ESM import binding receives the resulting
        // WebAssembly.Module. We expose them on `globalThis.__NIMBUS_WASM`
        // so the user fn can read them at request time without having to
        // re-import (the user fn is serialized via fn.toString and doesn't
        // carry import statements).
        //
        // Per-call entries (passed via IsolateCallOptions.wasmModules
        // — used by the wasm-runner shell command) are appended to the same
        // table. Naming collision with constructor entries is rejected
        // upstream in #materialisePerCallWasm so the import block here
        // doesn't have to deduplicate.
        const allWasmEntries = [
            ...this.wasmModules,
            ...(perCallWasmEntries ?? []),
        ];
        const moduleSource = assembleLoaderWorkerModuleSource({
            fnSource,
            preamble: this.preamble,
            wasmEntries: allWasmEntries,
            hasBindings: this.bindings !== undefined,
        });
        // Modules map: the entry worker.js source plus any wasm modules the
        // pool was constructed with. Workerd parses the modules map at
        // worker-load time and resolves the static `import` statements
        // we generated above against this map. The wasm-shape entry
        // (`{ wasm: ArrayBuffer }`) tells workerd to compile during the
        // module-load phase — the only phase where wasm code generation
        // is permitted in this deploy.
        //
        // Per-call entries are appended after constructor entries so the
        // map order matches the import order in the generated worker.js
        // (matters only for human-readable diffs; workerd doesn't care).
        const modules = { 'worker.js': moduleSource };
        for (const w of allWasmEntries) {
            modules[w.name] = { wasm: w.wasm };
        }
        assertModuleMapWithinCodeLimit(modules);
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
        };
    }
    /**
     * Dispatch a single task to the slot isolate. `slotIndex` picks which
     * warm isolate services the call; callers round-robin slots themselves.
     * Serialized per slot: this call waits for the slot's previous
     * execution to settle before touching the warm isolate.
     *
     * `invoke` is the single-attempt call against the slot's entrypoint
     * stub. `execute` dispatches call `entrypoint.execute(...args)`;
     * `fetch` dispatches call `entrypoint.fetch(<per-attempt Request>)` —
     * the attempt index lets a fetch invoke mint a fresh clone for retries,
     * since a Request's body is consumed once.
     */
    async #dispatchSlot(fnSource, fnHash, slotIndex, invoke, resilience, perCallWasm, signal) {
        // A warm slot executes one dispatch at a time: queue behind the
        // previous owner, then record this dispatch as the new tail. The
        // tail outlives the caller's outcome: a timeout rejects the
        // Promise.race while runOnce's RPC is still live on the Worker, so
        // release waits for every execution the owned body started to
        // settle — never the caller's settle alone.
        const previous = this.slotTails.get(slotIndex) ?? Promise.resolve();
        let release;
        this.slotTails.set(slotIndex, new Promise((resolve) => { release = resolve; }));
        await previous;
        if (this.disposed) {
            release();
            throw new BindingError(`IsolatePool(${this.tag}) is disposed`);
        }
        const inFlight = [];
        try {
            return await this.#dispatchSlotOwned(fnSource, fnHash, slotIndex, invoke, resilience, perCallWasm, inFlight, signal);
        }
        finally {
            // Do not delay the caller's own outcome — the tail releases when
            // the RPCs the body launched have actually settled.
            void Promise.allSettled(inFlight).then(() => release());
        }
    }
    async #dispatchSlotOwned(fnSource, fnHash, slotIndex, invoke, resilience, perCallWasm, inFlight, signal) {
        // Per-call wasm fingerprint. Mixed into the cache key so two calls
        // with different bytes hit different slots (no cache poisoning).
        // For the common case (no per-call wasm) the fingerprint is '0',
        // which is bytes-stable so warm reuse is unaffected.
        const perCallWasmEntries = this.#materialisePerCallWasm(perCallWasm);
        const perCallWasmHash = this.#fingerprintWasm(perCallWasmEntries);
        // Cache key includes the short DO id so warm isolates are scoped to
        // ONE session (see the doIdShort field comment), and the supervisor
        // identity so a wake of that same session can never reuse a warm
        // worker whose SUPERVISOR binding still names the dead generation's
        // pid. See the supervisorKey field comment for the failure mode.
        const buildId = (generation) => `nfp:${this.tag}:${this.doIdShort}:${fnHash}:${this.preambleHash}:${this.wasmHash}:${perCallWasmHash}:${this.supervisorKey}:slot-${slotIndex}:g${generation}${this.scope ? `:${this.scope}` : ''}`;
        let id = buildId(this.slotGenerations.get(slotIndex) ?? 0);
        const code = this.#buildCode(fnSource, perCallWasmEntries);
        // W5 Lever 5: record the dispatch so /api/_diag/memory shows the
        // last-facet-id even on a hang or silent kill. Bounded — single
        // slot updated on every dispatch.
        try {
            setLastFacetId(id, slotIndex);
        }
        catch { /* best-effort */ }
        // A hold the ledger already took for the next attempt, when a refused
        // call waited on it for room; otherwise the attempt begins its own.
        let admitted;
        const runOnce = async () => {
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
            //
            // The hold comes first, so it ends whatever setup throws: a retry's
            // was taken when the ledger let it in.
            // Inside an admitted launch (a child's python, ruby or wasm runtime
            // dispatching here), the first dispatch is the launch's own worker.
            const endFetch = admitted ?? (this.claim ? undefined : claimAdmission(this.ctx)) ?? beginLoaderFetch(this.ctx, id, this.claim);
            admitted = undefined;
            try {
                const stub = this.loader.get(id, async () => code);
                const entrypoint = stub.getEntrypoint();
                // Direct property call, awaited by this frame — bracketed, never
                // wrapped. See beginLoaderFetch for the measured DO-poisoning hazard.
                return await invoke(entrypoint, attempt);
            }
            catch (err) {
                // The ledger learns a limit refusal from the hold it ends.
                endFetch(err);
                if (err instanceof Error) {
                    throw new ExecutionError(err.message, err.stack);
                }
                throw new ExecutionError(String(err));
            }
            finally {
                endFetch();
            }
        };
        const maxAttempts = 1 + resilience.retries;
        let lastError;
        let retriedCloneRefusal = false;
        // When this call's waits for room after a limit refusal run out.
        let capDeadline;
        let attempt = 0;
        while (attempt < maxAttempts) {
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
                    let timerId;
                    try {
                        const attemptPromise = runOnce();
                        inFlight.push(attemptPromise);
                        return await Promise.race([
                            attemptPromise,
                            new Promise((_, reject) => {
                                timerId = setTimeout(() => reject(new TimeoutError(resilience.timeoutMs)), resilience.timeoutMs);
                            }),
                        ]);
                    }
                    finally {
                        if (timerId !== undefined)
                            clearTimeout(timerId);
                    }
                }
                const attemptPromise = runOnce();
                inFlight.push(attemptPromise);
                return await attemptPromise;
            }
            catch (err) {
                lastError = err instanceof Error ? err : new Error(String(err));
                const cause = classifyError(lastError);
                // W5 Lever 5: classify + record. We push on EVERY failed
                // attempt (not just the final retry-exhausted throw) so the
                // ring captures transient SQLITE_NOMEM / clone-refused
                // patterns that still ultimately succeed. Ring is bounded
                // (50 entries) so noise is self-limiting.
                try {
                    recordFailure({
                        at: Date.now(),
                        phase: 'rpc',
                        cause,
                        rssEstimateBytes: 0, heapUsedBytes: 0,
                        lruBytes: 0, inFlightBytes: 0,
                        lastRpcFrame: getLastRpcFrame(),
                        lastFacetId: { codeId: id, slotIndex, atMs: Date.now() },
                        message: lastError.message,
                    });
                }
                catch { /* fail-soft */ }
                if (signal?.aborted) {
                    // The caller aborted this dispatch's Request. workerd cancelled
                    // the isolate's execution context wherever it was suspended —
                    // mid-syscall, mid-stream — so the interpreter's heap may hold
                    // half-applied state. Bump the slot generation: the next
                    // dispatch lands on a FRESH worker under a new id rather than
                    // reusing the abandoned one. Retrying is wrong — the user
                    // interrupted; surface the abort.
                    const generation = (this.slotGenerations.get(slotIndex) ?? 0) + 1;
                    this.slotGenerations.set(slotIndex, generation);
                    throw lastError;
                }
                if (cause === 'clone_refused' && !retriedCloneRefusal) {
                    retriedCloneRefusal = true;
                    const generation = (this.slotGenerations.get(slotIndex) ?? 0) + 1;
                    this.slotGenerations.set(slotIndex, generation);
                    id = buildId(generation);
                    try {
                        setLastFacetId(id, slotIndex);
                    }
                    catch { /* best-effort */ }
                    // If the supervisor DO is stale, a newer loader still cannot
                    // deserialize back into it; only recycling that DO heals the
                    // reverse direction. This refresh targets the stale-loader case.
                    continue;
                }
                if (cause === 'dynamic_worker_cap') {
                    // The platform refused to start this call. Nothing ran, so the
                    // call waits, as the platform asks, and is sent again without
                    // spending an attempt: on the ledger, which lets it in when a
                    // hold ends, or when the pause this refusal started has passed
                    // (the platform still counts a worker the ledger has given back:
                    // a fan-out's workers stay counted for a moment after their
                    // calls return).
                    capDeadline ??= Date.now() + CAP_REFUSAL_WAIT_MS;
                    const remainingMs = capDeadline - Date.now();
                    if (remainingMs > 0) {
                        // The deadline's timer is cleared once the wait settles: a
                        // pending timer keeps the hosting object from hibernating.
                        const deadline = new AbortController();
                        const timer = setTimeout(() => deadline.abort(), remainingMs);
                        const waitFor = signal ? AbortSignal.any([deadline.signal, signal]) : deadline.signal;
                        admitted = await beginLoaderFetchWhenFree(this.ctx, id, { claim: this.claim, signal: waitFor })
                            .catch(() => undefined)
                            .finally(() => clearTimeout(timer));
                        if (admitted)
                            continue;
                        // The caller aborted while waiting: surface its abort as above.
                        if (signal?.aborted)
                            throw lastError;
                    }
                }
                if (attempt < maxAttempts - 1) {
                    // 100 * 2^attempt, capped at 2s so retries don't compound waiting.
                    const delay = Math.min(2000, 100 * Math.pow(2, attempt));
                    await new Promise((r) => setTimeout(r, delay));
                }
                attempt++;
            }
        }
        // On the way out only, so retries do not stack the annotation: a limit
        // hit carries the ledger — which workers were in flight — instead of the
        // platform's bare message.
        const named = withDynamicWorkerCapNamed(this.ctx, lastError);
        if (maxAttempts > 1) {
            throw new RetryExhaustedError(maxAttempts, named);
        }
        throw named;
    }
    #prepare(fn) {
        const fnSource = serializeFunction(fn);
        const fnHash = hashSource(fnSource);
        return { fnSource, fnHash };
    }
    /**
     * Run `fn` once with `arg` on a slot isolate. Returns the result or
     * throws TimeoutError / RetryExhaustedError / ExecutionError.
     */
    async submit(fn, arg, opts) {
        const { fnSource, fnHash } = this.#prepare(fn);
        const resilience = this.#resolve(opts);
        return (await this.#dispatchSlot(fnSource, fnHash, 0, (entrypoint) => entrypoint.execute(arg), resilience, opts?.wasmModules));
    }
    /**
     * Dispatch `fn` through the fetch transport — the pool's only
     * cancellable path: aborting `request.signal` cancels the inner
     * execution context at its next I/O suspension (a synchronous CPU
     * section cannot be preempted — the platform's honest limit), the
     * call rejects, and the slot generation bumps so the next dispatch
     * gets a fresh interpreter. `fn` is request-shaped: it encodes and
     * decodes its own payload.
     */
    async submitRequest(fn, request, opts) {
        if (request.bodyUsed) {
            throw new BindingError('IsolatePool.submitRequest: request body is already consumed — ' +
                'pass an unconsumed Request so retries can re-issue it.');
        }
        const { fnSource, fnHash } = this.#prepare(fn);
        const resilience = this.#resolve(opts);
        // Every attempt fetches a clone: a Request's body is consumed once,
        // so the caller's original stays unspent and retries get a fresh
        // body that follows the same signal.
        return this.#dispatchSlot(fnSource, fnHash, 0, (entrypoint) => entrypoint.fetch(request.clone()), resilience, opts?.wasmModules, request.signal);
    }
    /**
     * Run `fn` on every item in `items`, at most `concurrency` at a time,
     * pinned to stable slots so warm isolates are reused.
     *
     * Results are returned in input order. Failure handling per `onError`.
     */
    async map(fn, items, opts) {
        if (items.length === 0)
            return [];
        const { fnSource, fnHash } = this.#prepare(fn);
        return this.#mapInternal(fnSource, fnHash, items, opts);
    }
    /**
     * Same shape as `map`, but accepts a pre-serialized function source
     * string instead of a live function reference. Used by
     * `Fanout`'s peer-DO leg, where the function was already
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
    async mapSource(fnSource, items, opts) {
        if (items.length === 0)
            return [];
        const fnHash = hashSource(fnSource);
        return this.#mapInternal(fnSource, fnHash, items, opts);
    }
    async #mapInternal(fnSource, fnHash, items, opts) {
        const resilience = this.#resolve(opts);
        const concurrency = Math.max(1, Math.min(opts?.concurrency ?? this.concurrency, items.length));
        const onError = opts?.onError ?? 'throw';
        const settled = new Array(items.length);
        let cursor = 0;
        const runSlot = async (slotIndex) => {
            while (true) {
                const idx = cursor++;
                if (idx >= items.length)
                    return;
                try {
                    const value = (await this.#dispatchSlot(fnSource, fnHash, slotIndex, (entrypoint) => entrypoint.execute(items[idx]), resilience, opts?.wasmModules));
                    settled[idx] = { ok: true, value };
                }
                catch (err) {
                    const error = err instanceof Error ? err : new Error(String(err));
                    if (onError === 'throw')
                        throw error;
                    settled[idx] = { ok: false, error };
                }
            }
        };
        await Promise.all(Array.from({ length: concurrency }, (_, slotIndex) => runSlot(slotIndex)));
        if (onError === 'null') {
            return settled.map((s) => (s.ok ? s.value : null));
        }
        if (onError === 'skip') {
            return settled
                .filter((s) => s.ok)
                .map((s) => s.value);
        }
        // onError === 'throw' — all slots succeeded.
        return settled.map((s) => s.value);
    }
    /**
     * Release any RPC stubs held by the pool. Call this once the caller
     * is done with the pool (post-`map`/`submit`) so the underlying
     * stubs don't linger in workerd's deferred-destruction queue.
     *
     * Primary target: the SUPERVISOR binding stub we minted at
     * construction time (via the registered supervisor entrypoint). It's
     * a cross-isolate RPC stub — without explicit disposal it stays
     * referenced until the parent isolate's event-handler context
     * finishes, which during npm install means "until the whole install
     * completes" — long enough to accumulate alongside other leaked
     * stubs and trip the QueueState::ACTIVE fatal.
     *
     * Safe to call more than once; idempotent.
     */
    dispose() {
        this.disposed = true;
        if (!this.bindings)
            return;
        for (const key of Object.keys(this.bindings)) {
            disposeRpcResource(this.bindings[key]);
        }
        // Prevent double-dispose from re-running the loop.
        this.bindings = undefined;
    }
}
