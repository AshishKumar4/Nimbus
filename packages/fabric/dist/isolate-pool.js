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
 *      globalOutbound = the egress of the pool's `network` when it has
 *      one, else absent (`ISOLATE_NETWORK`: the parent's network, which
 *      reaches https://registry.npmjs.org without a proxy binding).
 *   3. **Supervisor autoinjection**. The pool grabs the embedder's
 *      registered supervisor entrypoint stub (see `supervisorEntrypoint` in
 *      composition.ts) and forwards it as `env.SUPERVISOR` to every facet,
 *      same pattern as git/network-facet.ts. Callers can add more bindings
 *      via `extraBindings`.
 *   4. **Fail-loud defaults**: timeout 60s, retries 0, a map rejects on its first failure, once all it started have settled.
 *      Caller opts in to leniency.
 *
 * The vendored directory contains only the upstream serialization, error,
 * and binding types used by this implementation.
 */
import { loaderOutbound, requireNetwork } from '@nimbus-sh/core/_shared/workspace-network.js';
import { CF_COMPAT_DATE, GUEST_COMPAT_FLAGS } from '@nimbus-sh/core/constants.js';
import { supervisorEntrypoint } from './composition.js';
import { infrastructureSupervisorProps, supervisorLoaderKey, mintProcessSupervisor } from './supervisor-props.js';
import { applyFacetLimits, facetCallDeadlineMs, facetLimits, facetLoaderKey } from './facet-limits.js';
import { unsettledEnd } from '@nimbus-sh/core/_shared/process-fs-client.js';
import { disposeRpcResource } from '@nimbus-sh/platform/rpc-dispose.js';
import { hashSource } from './vendor/serialize.js';
import { requireFacetTaskSource } from '@nimbus-sh/core/runtime/facet-task.js';
import { sha256Hex } from '@nimbus-sh/core/_shared/crypto.js';
import { beginLoaderFetch, readmitRefused, claimAdmission, suspendHeldAdmission, withDynamicWorkerCapNamed, } from './budgets.js';
import { assertModuleMapWithinCodeLimit } from './budgets.js';
import { recordFailure, setLastFacetId, getLastRpcFrame } from '@nimbus-sh/platform/oom-discriminator.js';
import { classifyError } from '@nimbus-sh/platform/oom-classify.js';
import { BindingError, ExecutionError, RetryExhaustedError, TimeoutError, } from './vendor/errors.js';
import { FACET_ERROR_KEY } from '@nimbus-sh/core/runtime/facet-host.js';
import { SupervisorLoadWaitError, acquireSupervisorLoad, reclaimableSupervisorAllocation, tryAcquireSupervisorLoad, } from '@nimbus-sh/platform/heavy-alloc-coord.js';
import { memberBuffer } from '@nimbus-sh/platform/worker-code.js';
import { hostWasmIdentity } from './host-wasm.js';
import { TASK_BODY_ERROR_SOURCE } from './task-body-error.js';
/** Result ownership shared by guest tasks that call the supervisor. */
const FACET_RPC_PREAMBLE = [
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
            lines.push(`import __NIMBUS_WASM_${entry.id} from ${JSON.stringify(`./${entry.name}`)};`);
        }
        lines.push('globalThis.__NIMBUS_WASM = globalThis.__NIMBUS_WASM || {};');
        for (const entry of wasmEntries) {
            lines.push(`globalThis.__NIMBUS_WASM[${JSON.stringify(entry.name)}] = __NIMBUS_WASM_${entry.id};`);
        }
        lines.push('// ── End pool-injected WebAssembly modules ─────────────────');
    }
    lines.push('', FACET_RPC_PREAMBLE, '');
    if (options.preamble) {
        lines.push('// ── Preamble (pool-level helpers) ─────────────────────────', options.preamble, '// ── End preamble ──────────────────────────────────────────', '');
    }
    lines.push(`const __fn__ = ${options.fnSource};`);
    lines.push('');
    const callExpr = options.callBindings
        ? '__fn__(args[0], { ...this.env, ...args[1] })'
        : options.hasBindings
            ? '__fn__(...args, this.env)'
            : '__fn__(...args)';
    const requestCallExpr = options.hasBindings
        ? '__fn__(request, this.env)'
        : '__fn__(request)';
    lines.push(TASK_BODY_ERROR_SOURCE, 'export default class extends WorkerEntrypoint {', '  execute(...args) {', `    return ${callExpr};`, '  }', '', '  // Request/Response transport: the ONE dispatch path whose abort is', '  // real. workerd cancels the inner execution context when the request', '  // signal aborts while the fn is suspended on I/O; RPC execute() above', '  // has no equivalent (measured: Symbol.dispose on a pending RPC does', '  // not cancel). The fn is request-shaped — it encodes and decodes its', '  // own payload; nothing generic is serialized here.', '  async fetch(request) {', '    try {', `      const result = await ${requestCallExpr};`, '      if (result instanceof Response) return result;', '      return Response.json(result ?? null);', '    } catch (err) {', '      // Fail loud inside the response so an abort of the transport is', '      // not conflated with a guest exception: the caller sees 500 only', '      // for a real fn failure, and aborts arrive as fetch rejections.', '      const failure = __nimbusTaskBodyError(err, request);', '      const message = failure instanceof Error && failure.message ? failure.message : String(failure);', `      return Response.json({ ${JSON.stringify(FACET_ERROR_KEY)}: message }, { status: 500 });`, '    }', '  }', '}');
    return lines.join('\n');
}
/**
 * `name`'s entry, its identifier being the name with every character an
 * identifier cannot hold replaced. Two names whose identifiers agree would
 * bind one import twice, so a name is refused when `bound` already holds
 * its identifier (keyed to who took it), and recorded there otherwise.
 */
function wasmEntry(name, wasm, bound, scope) {
    const id = name.replace(/[^A-Za-z0-9_]/g, '_').replace(/^[^A-Za-z_]/, '_');
    const holder = bound.get(id);
    if (holder !== undefined) {
        throw new BindingError(`IsolatePool: ${scope} key '${name}' and ${holder} both bind the identifier ${id}. Pick distinct module names.`);
    }
    bound.set(id, `${scope} key '${name}'`);
    return { name, id, wasm };
}
/**
 * The loader ids with images each Durable Object's pools have most recently
 * loaded, at most LOADED_IDS_KEPT: a dispatch to one takes no credit before
 * its worker, for the loader answers it warm and reads nothing. One
 * forgotten only takes credit it gives back unused.
 */
const loadedByCtx = new WeakMap();
const LOADED_IDS_KEPT = 256;
/** `id` as the most recently loaded: insertion order is recency, the oldest dropped past LOADED_IDS_KEPT. */
function noteLoaded(ids, id) {
    ids.delete(id);
    ids.add(id);
    for (const oldest of ids) {
        if (ids.size <= LOADED_IDS_KEPT)
            break;
        ids.delete(oldest);
    }
}
function loadedIds(ctx) {
    let ids = loadedByCtx.get(ctx);
    if (ids === undefined)
        loadedByCtx.set(ctx, ids = new Set());
    return ids;
}
const callsByCtx = new WeakMap();
const FACET_CALLS_KEPT = 16;
/** The last facet calls `ctx`'s pools made, oldest first: what a launch's phases cost (`/api/_diag/session`). */
export function recentFacetCalls(ctx) {
    const ring = callsByCtx.get(ctx);
    if (ring === undefined)
        return [];
    const first = (ring.next - ring.count + FACET_CALLS_KEPT) % FACET_CALLS_KEPT;
    const calls = [];
    for (let i = 0; i < ring.count; i++) {
        const slot = ring.slots[(first + i) % FACET_CALLS_KEPT];
        if (slot !== undefined)
            calls.push({ ...slot });
    }
    return calls;
}
function noteFacetCall(ctx, tag, loadMs, began) {
    let ring = callsByCtx.get(ctx);
    if (ring === undefined) {
        ring = { slots: Array.from({ length: FACET_CALLS_KEPT }, () => ({ tag: '', cold: false, loadMs: 0, callMs: 0, at: 0 })), next: 0, count: 0 };
        callsByCtx.set(ctx, ring);
    }
    const slot = ring.slots[ring.next];
    if (slot === undefined)
        return;
    slot.tag = tag;
    slot.cold = loadMs !== null;
    slot.loadMs = loadMs ?? 0;
    slot.callMs = Date.now() - began;
    slot.at = began;
    ring.next = (ring.next + 1) % FACET_CALLS_KEPT;
    ring.count = Math.min(FACET_CALLS_KEPT, ring.count + 1);
}
function loadCredit(lease) {
    let held = lease;
    const unregister = reclaimableSupervisorAllocation(() => {
        held = null;
        lease.release();
    });
    const take = () => {
        unregister();
        const taken = held;
        held = null;
        return taken;
    };
    return { take, release: () => take()?.release() };
}
/**
 * The images' part of a loader cache key: '0' for none, so a pool without
 * wasm keeps one stable key, else the SHA-256 of every image's name and
 * identity. An image's identity is equal only for equal bytes
 * (FacetImage.identity), never a guess from its size: a key two images share
 * runs one image's module for the other. clang's ./a and ./b were both 7572
 * bytes with equal first and last bytes, differing only at offset 651, and a
 * length+endpoints key ran ./a's module for ./b.
 */
async function wasmIdentity(parts) {
    if (parts.length === 0)
        return '0';
    return sha256Hex(parts.join('|'));
}
/** `entry` as its loader-key part: an image by its identity, a host-compiled module by the one its host described. */
function wasmKeyPart(entry) {
    if (!(entry.wasm instanceof WebAssembly.Module))
        return `${entry.name}:${entry.wasm.identity}`;
    const identity = hostWasmIdentity(entry.wasm);
    if (!identity) {
        throw new BindingError(`IsolatePool: wasmModules['${entry.name}'] is a WebAssembly.Module nobody described; ` +
            'pass it through describeHostWasm (@nimbus-sh/fabric/host-wasm.js) so warm slots ' +
            'can be keyed by it and the code limit can count it.');
    }
    return `${entry.name}:host:${identity.id}:${identity.bytes}`;
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
 *     network: workspace.network,
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
    facetKind;
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
    /** The bindings each call carries (IsolatePoolOptions.supervisorPerCall). */
    callBindings;
    preamble;
    preambleHash;
    /**
     * WASM modules to ship in the LOADER `modules` map. See
     * IsolatePoolOptions.wasmModules for the rationale. Stored in
     * insertion order so the per-import preamble we generate matches
     * across pool dispatches (cache-key stability).
     */
    wasmModules;
    /** The identifiers wasmModules bind, each to the key that took it: a per-call module takes none of them. */
    wasmIds = new Map();
    /** Every constructor-time wasm module, as the loader cache key names it
     *  (wasmIdentity), so a change invalidates warm slots: a compiled module
     *  by the identity its host described, an image by its own. */
    wasmKeyParts;
    /** wasmIdentity of wasmKeyParts, digested on the first dispatch. */
    #wasmHash = null;
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
    /** IsolatePoolOptions.network: each facet's outbound, and a loader-id segment. */
    network;
    /** The process the pool's facets write as, when they are bound to one (supervisorPid). */
    writerPid;
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
        this.claim = opts.claim;
        this.concurrency = Math.max(1, opts.concurrency ?? 1);
        this.facetKind = opts.facetKind ?? 'isolate';
        this.defaultTimeoutMs = opts.timeoutMs ?? facetCallDeadlineMs(this.facetKind) ?? 0;
        this.defaultRetries = Math.max(0, opts.retries ?? 0);
        this.tag = opts.tag ?? 'facet';
        this.writerPid = opts.omitSupervisor || opts.supervisorPid === undefined ? undefined : opts.supervisorPid;
        this.preamble = opts.preamble;
        // Include preamble in the cache-bucket key so changes to bundled helpers
        // invalidate warm slots. Empty preamble → '0' suffix (stable).
        this.preambleHash = this.preamble ? hashSource(this.preamble) : '0';
        this.doIdShort = opts.cacheScope === 'global'
            ? 'global'
            : ctx.id.toString().slice(0, 12);
        this.scope = opts.scope ?? '';
        // The network of the process the pool's facets act for (WorkspaceNetwork.forProcess), the one its binding carries.
        this.network = requireNetwork(opts.network, 'IsolatePool').forProcess(opts.processSupervisor?.pid ?? opts.supervisorPid ?? 0);
        // The wasm-modules table, in the order given.
        this.wasmModules = Object.entries(opts.wasmModules ?? {}).map(([name, wasm]) => wasmEntry(name, wasm, this.wasmIds, 'pool wasmModules'));
        this.wasmKeyParts = this.wasmModules.map(wasmKeyPart);
        const bindings = { ...(opts.extraBindings ?? {}) };
        this.supervisorKey = 's-none';
        if (!opts.omitSupervisor) {
            const supervisorRpc = supervisorEntrypoint();
            if (supervisorRpc) {
                // INSTALL-HONESTY: peer-DO branch supplies coordinator's doId
                // via supervisorDoIdOverride so SUPERVISOR.* RPCs route back
                // to the user's session DO, not the peer DO. Default to the
                // local ctx.id (single-DO callers and the in-DO in-DO fanout path).
                // A helper's binding acts as no run, on the pool's network
                // (IsolatePoolOptions.network): its SUPERVISOR calls that reach the
                // network for the workspace (an npm packument read) go out through
                // the same egress as the facet.
                const supervisor = opts?.processSupervisor ?? infrastructureSupervisorProps(ctx, opts?.supervisorPid ?? 0, {
                    doId: opts?.supervisorDoIdOverride,
                    route: opts?.supervisorRoute,
                    network: this.network,
                });
                const minted = opts?.processSupervisor
                    ? mintProcessSupervisor(supervisorRpc, opts.processSupervisor) : supervisorRpc({ props: supervisor });
                if (opts.supervisorPerCall)
                    this.callBindings = { SUPERVISOR: minted };
                else
                    bindings.SUPERVISOR = minted;
                // Whatever the minted worker's env carries must be in its loader
                // cache key — workerd's loader cache survives a DO hibernation
                // wake while generation-strided pids (1000001 → 2000001) do not:
                // a warm slot keyed without the supervisor identity returns in
                // the new generation still credentialed to the dead pid, and
                // every pid-authorized RPC from it fails "process pid … does
                // not exist". doIdShort alone cannot cover this — it changes
                // across sessions, not across wakes of the same session. So does
                // the instance a binding delivers mutations to, when it names one.
                const run = supervisor.bindingKind === 'process' ? `:${supervisor.writerId}` : '';
                this.supervisorKey = this.callBindings === undefined
                    ? supervisorLoaderKey(`s${supervisor.doId.slice(0, 12)}-${supervisor.pid}${run}`, supervisor)
                    : 's-call';
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
     * The call's own wasm images, as entries after the pool's: none may bind
     * an identifier the pool's modules bind.
     *
     * Returns [] when there are no per-call entries — that's the hot
     * path (every existing pool dispatch).
     */
    #materialisePerCallWasm(perCall) {
        if (!perCall)
            return [];
        const bound = new Map(this.wasmIds);
        return Object.entries(perCall).map(([name, image]) => wasmEntry(name, image, bound, 'per-call wasmModules'));
    }
    /**
     * The generated worker.js for `fnSource`: the same text every time for a
     * given function and module table, so workerd can reuse the isolate.
     *
     * Each entry in `wasmModules` (constructor-time + per-call) is imported
     * from the LOADER's modules map, which carries it as `{ wasm }`. workerd
     * compiles each during the worker's module-load phase (eval permitted
     * there) and the standard ESM import binding receives the resulting
     * WebAssembly.Module, exposed on `globalThis.__NIMBUS_WASM` so the user
     * fn can read it at request time. Per-call entries (wasm-runner's) follow
     * the pool's; a name colliding with the pool's was refused in
     * #materialisePerCallWasm.
     */
    #workerSource(fnSource, entries) {
        return assembleLoaderWorkerModuleSource({
            fnSource,
            preamble: this.preamble,
            wasmEntries: entries,
            hasBindings: this.bindings !== undefined,
            callBindings: this.callBindings !== undefined,
        });
    }
    /**
     * The WorkerCode the loader's cache-miss callback returns, built inside it:
     * the worker and every wasm module, its images read now (memberBuffer, the
     * read's own buffer) under an admission on the isolate's budget for their
     * size, both let go as the callback returns. A warm worker never calls
     * back, so it costs no read and no admission.
     */
    async #loadCode(source, entries) {
        const modules = { 'worker.js': source };
        for (const entry of entries) {
            modules[entry.name] = { wasm: entry.wasm instanceof WebAssembly.Module ? entry.wasm : memberBuffer(await entry.wasm.read()) };
        }
        return {
            compatibilityDate: CF_COMPAT_DATE,
            compatibilityFlags: [...GUEST_COMPAT_FLAGS],
            mainModule: 'worker.js',
            modules,
            env: this.bindings,
            // The workspace's egress when the pool works for one; else the key is
            // absent and the facet inherits the parent's network.
            ...loaderOutbound(this.network),
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
    async #dispatchSlot(fnSource, fnHash, slotIndex, invoke, resilience, perCallWasm, signal, 
    /** Collects this dispatch's tail: it settles once every execution the dispatch started has. */
    tails) {
        // A warm slot executes one dispatch at a time: queue behind the
        // previous owner, then record this dispatch as the new tail. The
        // tail outlives the caller's outcome: a timeout rejects the
        // Promise.race while runOnce's RPC is still live on the Worker, so
        // release waits for every execution the owned body started to
        // settle — never the caller's settle alone.
        const previous = this.slotTails.get(slotIndex) ?? Promise.resolve();
        let release;
        const tail = new Promise((resolve) => { release = resolve; });
        this.slotTails.set(slotIndex, tail);
        tails?.push(tail);
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
        // with different images hit different slots (no cache poisoning).
        // For the common case (no per-call wasm) the fingerprint is '0',
        // which is stable so warm reuse is unaffected.
        const perCallWasmEntries = this.#materialisePerCallWasm(perCallWasm);
        this.#wasmHash ??= wasmIdentity(this.wasmKeyParts);
        const [wasmHash, perCallWasmHash] = await Promise.all([
            this.#wasmHash,
            wasmIdentity(perCallWasmEntries.map(wasmKeyPart)),
        ]);
        // Cache key includes the short DO id so warm isolates are scoped to
        // ONE session (see the doIdShort field comment), and the supervisor
        // identity so a wake of that same session can never reuse a warm
        // worker whose SUPERVISOR binding still names the dead generation's
        // pid. See the supervisorKey field comment for the failure mode.
        const buildId = (generation) => `nfp:${facetLoaderKey(this.facetKind, this.tag)}:${this.doIdShort}:${fnHash}:${this.preambleHash}:${wasmHash}:${perCallWasmHash}:${this.supervisorKey}:slot-${slotIndex}:g${generation}${this.scope ? `:${this.scope}` : ''}${this.network?.id ? `:${this.network.id}` : ''}`;
        let id = buildId(this.slotGenerations.get(slotIndex) ?? 0);
        const entries = [...this.wasmModules, ...perCallWasmEntries];
        const source = this.#workerSource(fnSource, entries);
        // What the images will weigh once read, so a map over the platform's
        // ceiling, which can never load, is refused before anything is read or
        // waited for.
        const members = { 'worker.js': source };
        const unread = {};
        let imageBytes = 0;
        for (const entry of entries) {
            if (entry.wasm instanceof WebAssembly.Module) {
                members[entry.name] = { wasm: entry.wasm };
            }
            else {
                unread[entry.name] = entry.wasm.size;
                imageBytes += entry.wasm.peak;
            }
        }
        assertModuleMapWithinCodeLimit(members, unread);
        // W5 Lever 5: record the dispatch so /api/_diag/memory shows the
        // last-facet-id even on a hang or silent kill. Bounded — single
        // slot updated on every dispatch.
        try {
            setLastFacetId(id, slotIndex);
        }
        catch { /* best-effort */ }
        const loaded = loadedIds(this.ctx);
        /**
         * The credit a load this Durable Object's pools have not made needs, taken
         * before any worker hold (LoadCredit): an inherited launch admission's
         * worker is given back for the wait, and taken again once the credit is
         * held. One it has made is answered warm and reads nothing; should the
         * loader have dropped it, or running work reclaimed its credit, its
         * callback takes credit without waiting, or the call ends its hold and
         * comes back here for it.
         */
        const takeCredit = async () => {
            if (imageBytes === 0 || loaded.has(id))
                return null;
            const resume = this.claim ? undefined : suspendHeldAdmission(this.ctx);
            // Refused or aborted, it ends at once: the launch, its admission given back, holds no worker for it.
            const credit = loadCredit(await acquireSupervisorLoad(`facet '${this.tag}' images`, imageBytes, signal, { owner: `facet '${this.tag}' images`, pid: this.writerPid, session: this.ctx.id?.toString() }));
            try {
                await resume?.(signal);
            }
            catch (error) {
                credit.release();
                throw error;
            }
            return credit;
        };
        // The hold the latest attempt ran on: a refused one is readmitted on its terms.
        let held;
        /**
         * One attempt, on the hold and credit a refused call's readmission took
         * for it, or on its own: credit, then a worker. The credit is its own, for
         * attempts a timeout left running overlap.
         */
        const runOnce = async (readmitted) => {
            // loader.get() is synchronous from the caller's POV; the callback
            // is only invoked on cache miss, and builds the code then: a retry
            // that misses again reads its images again.
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
            // Lock order (acquireSupervisorLoad): credit, then a worker.
            const credit = readmitted ? readmitted.credit : await takeCredit();
            let lacking = false;
            try {
                // The hold comes first among what remains, so it ends whatever setup
                // throws: a readmitted one was taken when the ledger let it in.
                // Inside an admitted launch (a child's python, ruby or wasm runtime
                // dispatching here), the first dispatch is the launch's own worker.
                const endFetch = readmitted?.admitted ?? (this.claim ? undefined : claimAdmission(this.ctx)) ?? beginLoaderFetch(this.ctx, id, this.claim);
                held = endFetch;
                const began = Date.now();
                let loadMs = null;
                try {
                    const stub = this.loader.get(id, async () => {
                        const loading = Date.now();
                        const lease = imageBytes === 0 ? null : credit?.take() ?? tryAcquireSupervisorLoad(imageBytes, { owner: `facet '${this.tag}' images`, pid: this.writerPid, session: this.ctx.id?.toString() });
                        if (imageBytes > 0 && lease === null) {
                            lacking = true;
                            throw new Error(`IsolatePool(${this.tag}): its images' credit is not free while it holds a worker`);
                        }
                        try {
                            const code = applyFacetLimits(this.facetKind, await this.#loadCode(source, entries));
                            if (imageBytes > 0)
                                noteLoaded(loaded, id);
                            return code;
                        }
                        finally {
                            lease?.release();
                            loadMs = Date.now() - loading;
                        }
                    });
                    const entrypoint = stub.getEntrypoint(undefined, { limits: facetLimits(this.facetKind) });
                    // Direct property call, awaited by this frame — bracketed, never
                    // wrapped. See beginLoaderFetch for the measured DO-poisoning hazard.
                    const answer = await invoke(entrypoint, attempt);
                    noteFacetCall(this.ctx, this.tag, loadMs, began);
                    return answer;
                }
                catch (err) {
                    // The ledger learns a limit refusal from the hold it ends.
                    endFetch(err);
                    // A load the loader dropped, whose credit was not free: its hold ended, it waits for credit as a new load does.
                    if (lacking) {
                        loaded.delete(id);
                        return await runOnce(null);
                    }
                    if (err instanceof Error) {
                        throw new ExecutionError(err.message, err.stack);
                    }
                    throw new ExecutionError(String(err));
                }
                finally {
                    endFetch();
                }
            }
            finally {
                credit?.release();
            }
        };
        const maxAttempts = 1 + resilience.retries;
        let lastError;
        let retriedCloneRefusal = false;
        // When the platform first refused this call (readmitRefused).
        let firstRefusal;
        let attempt = 0;
        // What a refused call's readmission took for the next attempt.
        let readmitted = null;
        while (attempt < maxAttempts) {
            const taken = readmitted;
            readmitted = null;
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
                        const attemptPromise = runOnce(taken);
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
                const attemptPromise = runOnce(taken);
                inFlight.push(attemptPromise);
                return await attemptPromise;
            }
            catch (err) {
                if (err instanceof SupervisorLoadWaitError)
                    throw err;
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
                if (cause === 'dynamic_worker_cap' && held) {
                    // The platform refused to start this call: nothing ran, so it is
                    // sent again, without spending an attempt, once the ledger lets it in.
                    firstRefusal ??= Date.now();
                    // Credit before the worker the readmission holds.
                    const credit = await takeCredit();
                    let admitted;
                    try {
                        admitted = await readmitRefused(held, { since: firstRefusal, signal });
                    }
                    finally {
                        if (!admitted)
                            credit?.release();
                    }
                    if (admitted) {
                        readmitted = { admitted, credit };
                        continue;
                    }
                    // The caller aborted while waiting: surface its abort as above.
                    if (signal?.aborted)
                        throw lastError;
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
        const fnSource = requireFacetTaskSource(fn);
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
        try {
            return (await this.#dispatchSlot(fnSource, fnHash, 0, (entrypoint) => this.#execute(entrypoint, arg), resilience, opts?.wasmModules, opts?.signal));
        }
        catch (error) {
            throw this.#ended(error);
        }
    }
    /**
     * A run that failed (its facet died, was killed or timed out) of a process
     * that writes (bound to a pid) ended abnormally: its error says what may be
     * lost (unsettledEnd), every time; whether it acknowledged writes it never
     * sent, the session cannot know.
     */
    #ended(error) {
        // A load refused before it ran wrote nothing.
        return this.writerPid === undefined || error instanceof SupervisorLoadWaitError ? error : unsettledEnd(error);
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
        if (this.callBindings !== undefined) {
            throw new BindingError('IsolatePool.submitRequest: a per-call supervisor rides an RPC dispatch (submit or map), not a Request.');
        }
        const { fnSource, fnHash } = this.#prepare(fn);
        const resilience = this.#resolve(opts);
        // Every attempt fetches a clone: a Request's body is consumed once,
        // so the caller's original stays unspent and retries get a fresh
        // body that follows the same signal.
        try {
            return await this.#dispatchSlot(fnSource, fnHash, 0, (entrypoint) => entrypoint.fetch(request.clone()), resilience, opts?.wasmModules, opts?.signal ? AbortSignal.any([request.signal, opts.signal]) : request.signal);
        }
        catch (error) {
            throw this.#ended(error);
        }
    }
    /**
     * Run `fn` on every item in `items`, at most `concurrency` at a time,
     * pinned to stable slots so warm isolates are reused. Results are in input
     * order. After an item fails no item starts, and the map rejects with the
     * first failure once every execution it started has settled, a timed-out
     * one included: nothing it dispatched is still running when it returns.
     */
    async map(fn, items, opts) {
        if (items.length === 0)
            return [];
        const { fnSource, fnHash } = this.#prepare(fn);
        return valuesOf(await this.#mapInternal(fnSource, fnHash, items, opts, true));
    }
    /** `map`, where every item runs whatever the others do: each item's outcome. */
    async mapSettled(fn, items, opts) {
        if (items.length === 0)
            return [];
        const { fnSource, fnHash } = this.#prepare(fn);
        return this.#mapInternal(fnSource, fnHash, items, opts, false);
    }
    /**
     * The peer-DO transport of `map` (`stopOnFailure`) and `mapSettled`: the
     * coordinator forwards the task's already compiled expression, whose exact
     * bytes key the same warm slots. Each item's outcome.
     */
    async mapSource(fnSource, items, stopOnFailure, opts) {
        if (items.length === 0)
            return [];
        return this.#mapInternal(fnSource, hashSource(fnSource), items, opts, stopOnFailure);
    }
    async #mapInternal(fnSource, fnHash, items, opts, stopOnFailure) {
        const resilience = this.#resolve(opts);
        const concurrency = Math.max(1, Math.min(opts?.concurrency ?? this.concurrency, items.length));
        const settled = new Array(items.length);
        const tails = [];
        let cursor = 0;
        let failed = false;
        const runSlot = async (slotIndex) => {
            while (!(stopOnFailure && failed)) {
                const idx = cursor++;
                if (idx >= items.length)
                    return;
                try {
                    const value = (await this.#dispatchSlot(fnSource, fnHash, slotIndex, (entrypoint) => this.#execute(entrypoint, items[idx]), resilience, opts?.wasmModules, opts?.signal, tails));
                    settled[idx] = { ok: true, value };
                }
                catch (err) {
                    settled[idx] = { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
                    failed = true;
                }
            }
        };
        await Promise.all(Array.from({ length: concurrency }, (_, slotIndex) => runSlot(slotIndex)));
        // An item that timed out answered its caller, but its execution may
        // still be live on the Worker (#dispatchSlot's tail): the map returns
        // once every execution it started has settled, so none outlives it,
        // and waits for nothing else that shares its slots.
        await Promise.all(tails);
        for (let idx = 0; idx < items.length; idx++) {
            settled[idx] ??= { ok: false, error: new Error('not started: an earlier item failed') };
        }
        return settled;
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
        disposeRpcResource(this.callBindings?.SUPERVISOR);
        this.callBindings = undefined;
        if (!this.bindings)
            return;
        for (const key of Object.keys(this.bindings)) {
            disposeRpcResource(this.bindings[key]);
        }
        // Prevent double-dispose from re-running the loop.
        this.bindings = undefined;
    }
    /** One `execute` of an argument, with the call's bindings when the pool hands them per call. */
    #execute(entrypoint, arg) {
        return this.callBindings === undefined ? entrypoint.execute(arg) : entrypoint.execute(arg, this.callBindings);
    }
}
/** Every value of `settled`, or (once all have settled) the first failure. */
export function valuesOf(settled) {
    const failure = settled.find((outcome) => !outcome.ok);
    if (failure && !failure.ok)
        throw failure.error;
    return settled.flatMap((outcome) => (outcome.ok ? [outcome.value] : []));
}
