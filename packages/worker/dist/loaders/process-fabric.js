/**
 * process-fabric.ts — the resident-process scheduler (peer-DO placement).
 *
 * Every long-lived process Nimbus runs — node servers, python/ruby socket
 * servers, the opencode TUI and its headless server — is a Worker Loader
 * facet. This module owns WHICH workerd process that facet lands in, and it
 * is the only place in the kernel that knows the answer.
 *
 *   local  — the facet is minted from the coordinator session DO's own
 *            env.LOADER, so it shares the coordinator's workerd process
 *            memory envelope with the DO and every other local facet.
 *   peer   — the facet is minted from a sibling DO's loader
 *            (`${coordinatorDoId}:proc:${slot}`), so it gets an INDEPENDENT
 *            workerd memory budget. Proven live on the prod shape: 8 peers ×
 *            ~150 MiB held concurrently, blast radius contained 12/12
 *            (scratchpad/ARCHITECTURE-NEXTGEN.md §1).
 *
 * In BOTH cases the facet's SUPERVISOR binding is minted for the COORDINATOR's
 * doId, so every syscall — VFS read/write, stdout/stderr frames, stdin pump,
 * registerPort, loopback HTTP — lands on the user's session DO. The disk and
 * the terminal never move. Peer placement changes only which workerd process
 * runs the compute and holds the resident memory.
 *
 * Placement is INVISIBLE above this module. A `ResidentProcessHandle` exposes
 * the same lifecycle for either placement — `booted()` for the boot payload,
 * `done` for death, `kill()` for teardown — so the process table, stdio, the
 * shell and the SDK never learn where a process runs.
 *
 * Placement constraint: a peer cannot serve inbound HTTP
 * ─────────────────────────────────────────────────────
 * `routeTarget` is the ONE part of the handle that placement is not invisible
 * to. A dynamically-loaded facet cannot be re-entered to serve an inbound
 * request when it lives on a peer: the peer calling into its own facet's HTTP
 * handler throws `DataCloneError: Entrypoints to dynamically-loaded workers
 * cannot be transferred to other Workers` (raised in
 * `NimbusLoadedEntrypoint.handleHttpRequest`, `session/bindings.ts`). A clean
 * same-build A/B pins it to placement alone: the same server declared `light`
 * returns 200 byte-exact, declared `heavy` returns 502. Buffering the response
 * into peer-owned bytes, transferring native Request/Response, delivering the
 * request from inside the owning `_rpcHostProcess` invocation, and minting the
 * route stub together with the boot spec were each eliminated by experiment —
 * the underlying workerd mechanism is still unexplained.
 *
 * So: a process that serves inbound HTTP must be `light`. `routeThroughPeer`
 * below is the mechanism a fix would restore; until then no heavy-class
 * primitive may bind into PortRegistry.
 *
 * Policy
 * ──────
 * One field, one policy point. Each launch primitive DECLARES a
 * `processClass` where it is defined, and `startResidentProcess` is the only
 * consumer. There is no command-name or argv matching anywhere in this file.
 * A primitive is `heavy` when it is both RESIDENT (it accumulates memory over
 * its lifetime and is worth a whole workerd process) and NON-SERVING (nothing
 * routes inbound HTTP into it). Exactly one primitive qualifies today: the
 * opencode attach TUI, which talks to the user over the terminal RPC and the
 * stdin pump and binds no port. Everything else is `light` — node/vite/
 * wrangler/python/ruby servers and opencode `server` mode all bind ports, and
 * a one-shot command returns promptly and never reaches this module at all.
 *
 * Boot specs
 * ──────────
 * A resident process boots from one of two specs, both small enough to cross
 * the placement boundary:
 *
 *   staged — an OpencodeStageSpec. The ~23 MB artifact module map is
 *            assembled by the HOST inside a stateless NimbusLoadedEntrypoint
 *            isolate on the Worker-Loader cache-miss path, never in a session
 *            DO (which OOM-reset at the isolate cap when it did).
 *   code   — a generated module map (node / python / ruby runners). Module
 *            TEXT rides inline; wasm sidecars ride BY VFS PATH and are
 *            materialized by the HOST from the coordinator's disk. A ruby
 *            server's `ruby+stdlib.wasm` alone is 34.3 MiB — past workerd's
 *            32 MiB RPC argument limit — so shipping bytes was never an
 *            option, and resolving them host-side keeps them out of the
 *            coordinator's isolate entirely.
 *
 * Peer topology
 * ─────────────
 * Peers are sibling NimbusSession DOs named `${coordinatorDoId}:proc:${slot}`
 * (the same posture as the fanout's `nbf:` siblings — the existing DO
 * namespace binding, no new worker, no config change). A peer spawn:
 *
 *   1. Probes the candidate peer for its module-scope isolate token
 *      (`_rpcHostProcessProbe`, one RPC, 2–11 ms warm). Two DOs reporting the
 *      same token share one isolate/process; on collision with the
 *      coordinator's own token or another in-use peer token, the scheduler
 *      moves to the next slot (co-location is rare — 1 pair in 24 fresh
 *      peers). If every probed slot co-locates (e.g. single-process
 *      `wrangler dev`), the last candidate is used anyway: placement
 *      verification is an isolation OPTIMIZATION; lifecycle and routing
 *      semantics do not depend on it.
 *   2. Holds `_rpcHostProcess` open for the process lifetime. The peer boots
 *      the facet from ITS OWN env.LOADER and retains the facet's resources
 *      for as long as that call is open.
 *
 * Failure model
 * ─────────────
 * A peer OOM or silent facet reset severs the held-open RPC, which rejects on
 * the coordinator — the identical surface to a local facet death. The
 * scheduler MAY respawn the process on a FRESH slot (a new machine lottery,
 * impossible when the facet is pinned to the session DO's process); the
 * respawn budget defaults to 1, is gated on the caller's `shouldRespawn`, and
 * is always surfaced through `onRespawn` so a peer death is never silent.
 * A peer death is a PROCESS death, never a session death.
 *
 * Lifecycle
 * ─────────
 * The coordinator holds `_rpcHostProcess` open; if the coordinator DO dies,
 * workerd cancels the inbound call on the peer, the peer disposes the facet's
 * retained resources, and the facet dies with it — a process-hosting peer
 * cannot outlive its parent. Peers store nothing beyond the NimbusSession
 * constructor's isolate-gen counter (the `nbf:` fanout siblings' accepted
 * posture) and idle-evict when their process exits.
 */
import { z } from 'zod/v4';
import { OpencodeStageSpecSchema } from '../facets/opencode-staging.js';
import { getCtxExports } from '../session/ctx-exports.js';
import { disposeRpcResource, disposeRpcResources } from '../_shared/rpc-dispose.js';
import { BindingError } from './vendor/errors.js';
import { isTransientDoReset } from '../observability/oom-classify.js';
import { PEER_TRANSIENT_RESET_RETRIES, PEER_RETRY_BACKOFF_MS } from './fanout-pool.js';
/**
 * A generated module map in the form that crosses a placement boundary.
 * Module TEXT rides inline; wasm images are named by VFS path and read by the
 * NimbusLoadedEntrypoint that loads the facet — never by a session DO.
 */
export const ResidentCodeSpecSchema = z.object({
    compatibilityDate: z.string().min(1),
    compatibilityFlags: z.array(z.string()),
    mainModule: z.string().min(1),
    /**
     * Inline modules: generated source text, plus small wasm sidecars that come
     * from the worker's own ASSETS rather than the user's disk.
     */
    modules: z.record(z.string(), z.union([z.string(), z.object({ wasm: z.instanceof(ArrayBuffer) })])),
    /**
     * Module name → absolute VFS path of a wasm image to materialize at load.
     * This is how the big user-installed runtimes travel: ruby's
     * interpreter+stdlib image alone is 34.3 MiB, past workerd's 32 MiB RPC
     * argument limit, so its bytes can never ride inside a boot spec.
     */
    vfsWasmModules: z.record(z.string(), z.string()).optional(),
});
export const ResidentBootSpecSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('staged'), stage: OpencodeStageSpecSchema }),
    z.object({ kind: z.literal('code'), code: ResidentCodeSpecSchema }),
]);
/**
 * Distinct peer slots probed before accepting a co-located peer. Co-location
 * is rare (probe: 1 shared pair in 24 fresh peers), so 4 attempts make an
 * undetected-collision spawn vanishingly unlikely while keeping the
 * worst-case spawn overhead to a few warm RPCs.
 */
export const HEAVY_PLACEMENT_MAX_ATTEMPTS = 4;
/** Default respawn budget for a heavy process whose peer dies under it. */
export const HEAVY_RESPAWN_BUDGET = 1;
// ── Module-scope isolate identity ───────────────────────────────────────────
let _isolateToken = null;
/**
 * Lazy module-scope isolate token. Two Durable Objects that report the same
 * token share one isolate — and, since all NimbusSession DOs run the same
 * script, one workerd process. The scheduler compares peer tokens against its
 * own and those already in use to verify a heavy process landed in a distinct
 * process (the probe-proven placement check).
 */
export function isolateToken() {
    if (!_isolateToken)
        _isolateToken = crypto.randomUUID();
    return _isolateToken;
}
export function getNimbusCtxExports() {
    const ctxExports = getCtxExports();
    if (!ctxExports || typeof ctxExports !== 'object') {
        throw new Error('Nimbus: ctx.exports unavailable');
    }
    return ctxExports;
}
/**
 * Mint a NimbusLoadedEntrypoint stub for a keyed dynamic worker. The
 * `supervisor` identity controls where the facet's SUPERVISOR binding routes:
 * a peer host passes the COORDINATOR's doId so every syscall lands on the
 * user's session DO, not the peer.
 */
export async function createLoadedWorkerEntrypoint(ctxExports, code, supervisor, name = null, key = `nimbus-process:${supervisor.doId}:${supervisor.pid}`, boot) {
    if (!ctxExports.NimbusLoadedEntrypoint) {
        throw new Error('Nimbus: ctx.exports.NimbusLoadedEntrypoint unavailable');
    }
    return await ctxExports.NimbusLoadedEntrypoint({
        props: {
            key,
            name,
            depth: 0,
            code,
            supervisor,
            ...(boot?.kind === 'staged' ? { stage: boot.stage } : {}),
            ...(boot?.kind === 'code' ? { residentCode: boot.code } : {}),
        },
    });
}
/**
 * Boot a resident process's facet on THIS host. Identical code runs on the
 * coordinator (local placement) and on a peer DO (peer placement); the only
 * difference is whose `ctx.exports` — and therefore whose workerd process —
 * is handed in.
 *
 * Both spec kinds take the SAME route: the module map is completed inside the
 * stateless NimbusLoadedEntrypoint that loads it, never in a session DO. That
 * is a workerd requirement as much as a memory one — a dynamic worker loaded
 * directly from a Durable Object cannot be re-entered from a later request
 * ("the system does not know how to reload this Worker from scratch; have the
 * parent Worker expose an entrypoint which constructs the dynamic worker"), so
 * a DO-loaded facet could never serve its registered port.
 */
export async function hostResidentProcess(host, boot) {
    const route = await createRouteTarget(host);
    const startStub = await createLoadedWorkerEntrypoint(host.ctxExports, undefined, host.supervisor, null, host.workerKey, boot);
    if (typeof startStub.startProcess !== 'function') {
        disposeRpcResources([startStub, route]);
        throw new Error('Nimbus: resident process entrypoint has no startProcess method');
    }
    return {
        start: (args) => startStub.startProcess(args),
        route,
        dispose: onceDisposed([startStub, route]),
    };
}
/** Disposal is idempotent: kill, host-call teardown and respawn can all fire. */
function onceDisposed(resources) {
    let done = false;
    return () => {
        if (done)
            return;
        done = true;
        disposeRpcResources(resources);
    };
}
/**
 * A CODE-FREE, re-resolvable route target for the facet, keyed on workerKey.
 * Inbound HTTP arrives in a LATER request context than the boot, so the target
 * must re-resolve the already-loaded worker in the caller's context — and fail
 * loud if it was evicted, rather than silently booting a fresh isolate whose
 * server never called listen().
 */
async function createRouteTarget(host) {
    const stub = await createLoadedWorkerEntrypoint(host.ctxExports, undefined, host.supervisor, null, host.workerKey);
    if (typeof stub.handleHttpRequest !== 'function') {
        disposeRpcResource(stub);
        throw new Error('Nimbus: resident process entrypoint has no HTTP request handler');
    }
    return stub;
}
async function routeThroughPeer(stub, workerKey, request) {
    const headers = [];
    request.headers.forEach((value, key) => { headers.push([key, value]); });
    const result = await stub._rpcRouteHostedHttp(workerKey, {
        method: request.method,
        url: request.url,
        headers,
        body: request.method === 'GET' || request.method === 'HEAD' ? null : request.body,
    });
    const responseHeaders = new Headers();
    for (const [key, value] of result.headers)
        responseHeaders.append(key, value);
    return new Response(result.body, {
        status: result.status,
        statusText: result.statusText,
        headers: responseHeaders,
    });
}
function isPeerNamespace(value) {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null)
        return false;
    return typeof Reflect.get(value, 'idFromName') === 'function'
        && typeof Reflect.get(value, 'get') === 'function';
}
/** Extract the NIMBUS_SESSION peer namespace from a raw env, if present. */
export function peerNamespaceFromEnv(env) {
    const ns = ((typeof env === 'object' || typeof env === 'function') && env !== null)
        ? Reflect.get(env, 'NIMBUS_SESSION')
        : undefined;
    return isPeerNamespace(ns) ? ns : undefined;
}
function processPeerStub(value, peerName) {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
        throw new BindingError(`ProcessFabric: NIMBUS_SESSION.get() returned no stub for peer '${peerName}'.`);
    }
    if (typeof Reflect.get(value, '_rpcHostProcess') !== 'function'
        || typeof Reflect.get(value, '_rpcHostProcessProbe') !== 'function') {
        throw new BindingError(`ProcessFabric: peer '${peerName}' does not expose the host-process RPC surface.`);
    }
    return value;
}
function describePlacement(placement) {
    if (placement.kind === 'local')
        return 'local facet (coordinator process)';
    return `peer slot=${placement.slot} peer=${placement.peerName.slice(-12)} `
        + `token=${placement.isolateToken.slice(0, 8)}`;
}
/**
 * Resource handle for one resident process — the whole surface the kernel
 * above this module sees. Its lifecycle is placement-free: `booted`, `done`
 * and `kill` behave identically whether the facet runs in the coordinator's
 * workerd process or a sibling's. `routeTarget` is the exception — see the
 * placement constraint at the top of this file.
 *
 * `done` settles when the process's HOST context ends: for a `lifetime`
 * runner that is the process exiting (resolve) or dying (reject); for a
 * `boot` runner it is the facet dying under it, which locally is only
 * observable at kill time and on a peer is the severed host RPC.
 *
 * The handle is disposable so FacetManager's existing per-pid resource
 * tracking kills a hosted process exactly the way it kills a local facet.
 */
export class ResidentProcessHandle {
    done;
    processClass;
    /**
     * Inbound-HTTP target for PortRegistry; follows the process across respawns.
     * Usable only on a `light` handle — a peer-hosted facet cannot be re-entered
     * to serve an inbound request (placement constraint, top of this file), so
     * no heavy-class primitive may bind this into PortRegistry.
     */
    routeTarget;
    /** Peer respawns consumed (heavy only). */
    respawns = 0;
    #booted;
    #kill;
    #killed = false;
    #placement;
    constructor(init) {
        this.processClass = init.processClass;
        this.#placement = init.placement;
        this.done = init.done;
        this.#booted = init.booted;
        this.routeTarget = init.routeTarget;
        this.#kill = init.kill;
        // Symbol.dispose may be absent from older lib targets; wire defensively
        // so disposeRpcResource() (which probes for it) finds the disposer.
        const disposeSym = Symbol.dispose;
        if (disposeSym) {
            Object.defineProperty(this, disposeSym, { value: () => this.kill() });
        }
    }
    /**
     * The runner's startProcess payload. The runner is started as part of the
     * spawn, so this is a handle on that one boot — awaiting it twice is safe
     * and never re-starts anything. For a `lifetime` runner it settles at exit.
     */
    booted() {
        return this.#booted();
    }
    get killed() {
        return this.#killed;
    }
    /**
     * Human-readable placement, for the NIMBUS_DEBUG process-log line. Callers
     * log the string; they never branch on it — placement stays in here.
     */
    describePlacement() {
        return describePlacement(this.#placement());
    }
    /** Idempotent: sever the process's RPC chain and block respawn. */
    kill() {
        if (this.#killed)
            return;
        this.#killed = true;
        try {
            this.#kill();
        }
        catch { /* best-effort teardown */ }
    }
}
/** A promise that settles only when the process is killed. */
function heldUntilKilled() {
    let release = () => { };
    const promise = new Promise((resolve) => { release = resolve; });
    return { promise, release };
}
export class ProcessFabric {
    ctx;
    ns;
    coordDoId;
    /** pid → isolate token of the peer currently hosting that process. */
    tokensInUse = new Map();
    /** Monotonic slot counter: respawns and new spawns land on fresh peers. */
    nextSlot = 0;
    constructor(ctx, env) {
        this.ctx = ctx;
        this.ns = peerNamespaceFromEnv(env);
        this.coordDoId = ctx.id.toString();
    }
    /**
     * Boot a resident process and return its placement-free handle. Resolves
     * once the facet is hosted and the runner has been started; rejects on
     * boot/placement failure, matching a local boot failure's surface.
     *
     * THE policy point: one field read, no matching of any kind.
     */
    async startResidentProcess(spawn) {
        return spawn.processClass === 'light'
            ? this._startLocal(spawn)
            : this._startPeer(spawn);
    }
    // ── light: the facet lands in the coordinator's own workerd process ───
    async _startLocal(spawn) {
        const hosted = await hostResidentProcess(this._localHost(spawn), spawn.boot);
        const started = hosted.start(spawn.startArgs);
        const held = heldUntilKilled();
        // `lifetime`: the runner's startProcess IS the process, so its settlement
        // is the lifecycle — exactly the pre-fabric boot. `boot`: the runner
        // returns once it is up and the facet stays pinned by `hosted`, so
        // residency ends only when the pin is released (kill) or the boot failed.
        const done = spawn.startContract === 'lifetime'
            ? started.then(() => undefined)
            : started.then(() => held.promise);
        return new ResidentProcessHandle({
            processClass: 'light',
            placement: () => ({ kind: 'local' }),
            done: done.finally(() => hosted.dispose()),
            booted: () => started,
            routeTarget: hosted.route,
            kill: () => { held.release(); hosted.dispose(); },
        });
    }
    _localHost(spawn) {
        return {
            ctxExports: getNimbusCtxExports(),
            supervisor: { doId: this.coordDoId, pid: spawn.pid },
            workerKey: spawn.workerKey,
        };
    }
    // ── heavy: the facet lands in a sibling DO's workerd process ──────────
    _requireNs() {
        if (!this.ns) {
            throw new BindingError('ProcessFabric: env.NIMBUS_SESSION binding missing or invalid. '
                + 'Heavy-class processes require the peer-DO namespace. '
                + 'Add the binding via durable_objects.bindings in wrangler.jsonc.');
        }
        return this.ns;
    }
    async _startPeer(spawn) {
        // First placement happens inline so a placement failure rejects the
        // spawn itself (matching the local path's boot-failure surface).
        const first = await this._placeDistinctPeer();
        const state = { current: first, handle: undefined };
        // The route target follows the process across respawns by reading the
        // live placement on every request — PortRegistry keeps one binding.
        const routeTarget = {
            handleHttpRequest: (request) => routeThroughPeer(state.current.stub, spawn.workerKey, request),
        };
        const done = this._runPeerLifecycle(spawn, state);
        const handle = new ResidentProcessHandle({
            processClass: 'heavy',
            placement: () => ({
                kind: 'peer',
                slot: state.current.slot,
                peerName: state.current.peerName,
                isolateToken: state.current.isolateToken,
            }),
            done,
            // The peer starts the runner as part of hosting it; this reads back the
            // one boot payload (and rejects with a boot failure) without re-running
            // anything, so `booted()` means the same thing at either placement.
            booted: () => state.current.stub
                ._rpcAwaitHostedBoot(spawn.workerKey)
                .then((r) => r.payload),
            routeTarget,
            kill: () => this._cancelPeer(spawn.workerKey, state.current.peerName),
        });
        state.handle = handle;
        return handle;
    }
    /**
     * Drive the process on its peer; on peer death, respawn on a FRESH slot
     * (new machine lottery) within the bounded budget. The first placement is
     * pre-verified by _startPeer.
     */
    async _runPeerLifecycle(spawn, state) {
        let respawnsLeft = HEAVY_RESPAWN_BUDGET;
        for (;;) {
            const placement = state.current;
            this.tokensInUse.set(spawn.pid, placement.isolateToken);
            try {
                await placement.stub._rpcHostProcess(spawn.boot, {
                    coordinatorDoId: this.coordDoId,
                    pid: spawn.pid,
                    workerKey: spawn.workerKey,
                    startContract: spawn.startContract,
                    startArgs: spawn.startArgs,
                });
                return; // clean lifecycle end — the facet reported its own exit
            }
            catch (e) {
                const killed = state.handle?.killed === true;
                const wanted = spawn.shouldRespawn ? spawn.shouldRespawn() : true;
                if (killed || !wanted || respawnsLeft <= 0)
                    throw e;
                respawnsLeft--;
                try {
                    spawn.onRespawn?.(e);
                }
                catch { /* observability must not break the lifecycle */ }
            }
            finally {
                this.tokensInUse.delete(spawn.pid);
                disposeRpcResource(placement.stub);
            }
            // Respawn: fresh slot, re-verified placement. The handle's route target
            // and start() read `state.current`, so both re-point automatically.
            state.current = await this._placeDistinctPeer();
            if (state.handle)
                state.handle.respawns++;
        }
    }
    /**
     * Probe successive slots until one reports an isolate token distinct from
     * the coordinator's own and every token already hosting a process. Falls
     * back to the last probed candidate when every attempt co-locates (dev
     * single-process topologies) — see the module header.
     */
    async _placeDistinctPeer() {
        const ns = this._requireNs();
        const denied = new Set([isolateToken(), ...this.tokensInUse.values()]);
        let colocated = null;
        for (let attempt = 0; attempt < HEAVY_PLACEMENT_MAX_ATTEMPTS; attempt++) {
            const slot = this.nextSlot++;
            const peerName = `${this.coordDoId}:proc:${slot}`;
            const stub = processPeerStub(ns.get(ns.idFromName(peerName)), peerName);
            const probe = await this._probePeer(stub, peerName);
            const candidate = { stub, slot, peerName, isolateToken: probe.isolateToken };
            if (!denied.has(probe.isolateToken)) {
                if (colocated)
                    disposeRpcResource(colocated.stub);
                return candidate;
            }
            if (colocated)
                disposeRpcResource(colocated.stub);
            colocated = candidate;
        }
        return colocated;
    }
    /**
     * First contact with a possibly-cold sibling DO: retry transient platform
     * resets with the same bounded policy the fanout peers ship
     * (fanout-pool.ts PEER_TRANSIENT_RESET_RETRIES). Non-transient failures
     * propagate on the first hit.
     */
    async _probePeer(stub, peerName) {
        for (let attempt = 0;; attempt++) {
            try {
                const probe = await stub._rpcHostProcessProbe();
                if (!probe || typeof probe.isolateToken !== 'string' || probe.isolateToken.length === 0) {
                    throw new Error(`ProcessFabric: peer '${peerName}' returned no isolate token`);
                }
                return probe;
            }
            catch (err) {
                if (attempt < PEER_TRANSIENT_RESET_RETRIES && isTransientDoReset(err)) {
                    const backoff = PEER_RETRY_BACKOFF_MS[Math.min(attempt, PEER_RETRY_BACKOFF_MS.length - 1)];
                    await new Promise((r) => setTimeout(r, backoff));
                    continue;
                }
                throw err;
            }
        }
    }
    /**
     * Deterministic peer kill: a fresh stub to the hosting peer fires
     * `_rpcCancelHostProcess`, which disposes the peer's retained facet
     * resources — the exact teardown a local facet gets. The severed RPC then
     * settles the coordinator-side lifecycle, whose respawn gate sees
     * `handle.killed` and stops.
     */
    _cancelPeer(workerKey, peerName) {
        const ns = this.ns;
        if (!ns)
            return;
        try {
            const stub = processPeerStub(ns.get(ns.idFromName(peerName)), peerName);
            this.ctx.waitUntil(Promise.resolve(stub._rpcCancelHostProcess(workerKey))
                .catch(() => { })
                .finally(() => disposeRpcResource(stub)));
        }
        catch { /* best-effort */ }
    }
}
