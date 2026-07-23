/**
 * process-fabric.ts — the general heavy-process scheduler (peer-DO placement).
 *
 * The kernel already owns a ProcessTable, a fork/exec fabric, a SupervisorRPC
 * syscall channel, and a peer-DO fanout for short idempotent batch work
 * (fanout-pool.ts). This module adds the last step: scheduling LONG-LIVED,
 * MEMORY-HEAVY resident processes onto sibling NimbusSession DOs, because peer
 * Durable Objects have INDEPENDENT workerd process memory budgets — proven
 * live on the prod shape (placement:smart + D1), 8 peers × 150 MiB facets =
 * 1.2 GiB held concurrently, blast radius contained 12/12
 * (scratchpad/ARCHITECTURE-NEXTGEN.md §1).
 *
 * One policy point: runtime specs declare a process class
 * (`light` | `heavy`); `startResidentProcess` places `heavy` on a peer and
 * runs `light` in a local facet exactly as before. There is no per-runtime
 * special case here.
 *
 * NO DEFAULT HEAVY TENANT (2026-07-23). Every shipped runtime spec declares
 * `light`, so in production all processes flow the local path — behaviorally
 * identical to the pre-fabric spawn. The attach TUI was the intended first
 * heavy tenant, but its OOM (#35) was root-caused to a wasm FFI-ABI bug and
 * fixed in the runner itself; with that fix attach is stable as a local
 * facet, and peer placement would only add ~0.5 s of peer-DO cold-create
 * latency per spawn. The `heavy` path stays fully implemented, unit-tested,
 * and live-gate-proven (peer placement, syscall routing, OOM containment,
 * bounded respawn, deterministic kill) as the substrate for the
 * swap/durability layer (#18) and heavy multi-process workloads
 * (clang/wasm-ld batches, serve-as-tenant with a routed-HTTP peer leg).
 *
 * Peer topology
 * ─────────────
 * Peers are sibling NimbusSession DOs named `${coordinatorDoId}:proc:${slot}`
 * (same posture as the fanout's `nbf:` siblings — the existing DO namespace
 * binding, no new worker, no config change). A heavy spawn:
 *
 *   1. Probes the candidate peer for its module-scope isolate token
 *      (`_rpcHostProcessProbe`, one RPC, 2–11 ms warm). Two DOs reporting the
 *      same token share one isolate/process; on collision with the
 *      coordinator's own token or another in-use peer token, the scheduler
 *      moves to the next slot (probe-proven trick; co-location is rare —
 *      1 pair in 24 fresh peers). If every probed slot co-locates (e.g.
 *      single-process `wrangler dev`), the last candidate is used anyway:
 *      placement verification is an isolation OPTIMIZATION; lifecycle and
 *      routing semantics do not depend on it.
 *   2. Calls `_rpcHostProcess(stage, …)` on the peer and holds the RPC open
 *      for the process lifetime. The peer boots the process facet from ITS
 *      OWN env.LOADER — so the facet lands in the peer's workerd process —
 *      with the SUPERVISOR binding minted for the COORDINATOR's doId
 *      (`supervisor.doId` override, the same INSTALL-HONESTY routing the npm
 *      fanout ships). Every syscall (VFS read/write, stdout/stderr frames,
 *      stdin pump, port registry) lands on the coordinator: the disk and the
 *      terminal never move.
 *
 * Failure model
 * ─────────────
 * Peer OOM / silent facet reset severs the held-open RPC, which rejects on
 * the coordinator — identical surface to a local facet death. The scheduler
 * MAY respawn the process on a FRESH slot (a new machine lottery, impossible
 * when the facet is pinned to the session DO's process); respawn budget
 * defaults to 1 and is gated on the caller's `shouldRespawn` (a killed /
 * torn-down process never respawns).
 *
 * Lifecycle
 * ─────────
 * The coordinator holds `_rpcHostProcess` open; if the coordinator DO dies,
 * workerd cancels the inbound call on the peer, the peer's held-open
 * startProcess context collapses, and the facet dies with it — a
 * process-hosting peer cannot outlive its parent. Peers store nothing beyond
 * the NimbusSession constructor's isolate-gen counter (the `nbf:` fanout
 * siblings' accepted posture) and idle-evict when their process exits.
 */
import { getCtxExports } from '../session/ctx-exports.js';
import { disposeRpcResource } from '../_shared/rpc-dispose.js';
import { BindingError } from './vendor/errors.js';
import { isTransientDoReset } from '../observability/oom-classify.js';
import { PEER_TRANSIENT_RESET_RETRIES, PEER_RETRY_BACKOFF_MS } from './fanout-pool.js';
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
 * user's session DO, not the peer (the INSTALL-HONESTY posture).
 */
export async function createLoadedWorkerEntrypoint(ctxExports, code, supervisor, name = null, key = `nimbus-process:${supervisor.doId}:${supervisor.pid}`, stage) {
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
            ...(stage ? { stage } : {}),
        },
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
/**
 * Resource handle for one resident process. `done` settles when the process
 * lifecycle ends (clean exit resolves; facet/peer death rejects). The handle
 * is disposable so FacetManager's existing process-resource tracking kills
 * the process the same way it kills local facets: disposal severs the
 * held-open RPC chain (local: the loopback startProcess; peer: the
 * `_rpcHostProcess` call, plus an explicit cancel RPC so the peer tears its
 * facet down deterministically) and blocks any pending respawn.
 */
export class ResidentProcessHandle {
    done;
    processClass;
    /** Current placement; a heavy respawn moves it to the fresh peer. */
    placement;
    /** Peer respawns consumed (heavy only). */
    respawns = 0;
    #kill;
    #killed = false;
    constructor(processClass, placement, done, kill) {
        this.processClass = processClass;
        this.placement = placement;
        this.done = done;
        this.#kill = kill;
        // Symbol.dispose may be absent from older lib targets; wire defensively
        // so disposeRpcResource() (which probes for it) finds the disposer.
        const disposeSym = Symbol.dispose;
        if (disposeSym) {
            Object.defineProperty(this, disposeSym, { value: () => this.kill() });
        }
    }
    get killed() {
        return this.#killed;
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
export class ProcessFabric {
    ctx;
    ns;
    coordDoId;
    /** pid → isolate token of the peer currently hosting that process. */
    tokensInUse = new Map();
    /** Monotonic slot counter: respawns and new spawns land on fresh peers. */
    nextSlot = 0;
    constructor(ctx, ns) {
        this.ctx = ctx;
        this.ns = ns;
        this.coordDoId = ctx.id.toString();
    }
    /**
     * Boot a resident staged process and invoke its held-open startProcess.
     * Resolves once the lifecycle is RUNNING (the returned handle's `done`
     * carries the lifecycle promise); rejects on boot/placement failure.
     */
    async startResidentProcess(spawn) {
        if (spawn.processClass === 'light') {
            return this._startLocal(spawn);
        }
        return this._startPeer(spawn);
    }
    // ── light: local facet, exactly as before ─────────────────────────────
    async _startLocal(spawn) {
        const ctxExports = getNimbusCtxExports();
        const startStub = await createLoadedWorkerEntrypoint(ctxExports, undefined, { doId: this.coordDoId, pid: spawn.pid }, null, spawn.workerKey, spawn.stage);
        if (typeof startStub.startProcess !== 'function') {
            disposeRpcResource(startStub);
            throw new Error('Nimbus: resident process entrypoint has no startProcess method');
        }
        const done = startStub.startProcess().then(() => { disposeRpcResource(startStub); }, (e) => { disposeRpcResource(startStub); throw e; });
        return new ResidentProcessHandle('light', { kind: 'local' }, done, () => disposeRpcResource(startStub));
    }
    // ── heavy: peer-DO placement ──────────────────────────────────────────
    _requireNs() {
        if (!this.ns) {
            throw new BindingError('ProcessFabric: env.NIMBUS_SESSION binding missing or invalid. ' +
                'Heavy-class processes require the peer-DO namespace. ' +
                'Add the binding via durable_objects.bindings in wrangler.jsonc.');
        }
        return this.ns;
    }
    async _startPeer(spawn) {
        // First placement happens inline so a placement failure rejects the
        // spawn itself (matching the local path's boot-failure surface).
        const first = await this._placeDistinctPeer();
        const state = { current: first, handle: undefined };
        const done = this._runPeerLifecycle(spawn, state);
        const handle = new ResidentProcessHandle('heavy', { kind: 'peer', slot: first.slot, peerName: first.peerName, isolateToken: first.isolateToken }, done, () => this._cancelPeer(spawn.workerKey, state.current.peerName));
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
                await placement.stub._rpcHostProcess(spawn.stage, {
                    coordinatorDoId: this.coordDoId,
                    pid: spawn.pid,
                    workerKey: spawn.workerKey,
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
            // Respawn: fresh slot, re-verified placement, updated handle metadata.
            state.current = await this._placeDistinctPeer();
            if (state.handle) {
                state.handle.respawns++;
                state.handle.placement = {
                    kind: 'peer',
                    slot: state.current.slot,
                    peerName: state.current.peerName,
                    isolateToken: state.current.isolateToken,
                };
            }
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
     * `_rpcCancelHostProcess`, which disposes the peer's held-open startProcess
     * stub — the exact teardown FacetManager.kill applies to local facets. The
     * severed RPC then settles the coordinator-side lifecycle, whose respawn
     * gate sees `handle.killed` and stops.
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
