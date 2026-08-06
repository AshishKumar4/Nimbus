/**
 * process-host.ts — the two substrates a resident process can run on, and the
 * one value that picks between them.
 *
 * `loaders/process-fabric.ts` owns what a resident process IS. This module
 * owns only where it lives, behind `ProcessHost`:
 *
 *   facet — the process is a named child actor of the user's own session DO.
 *   peer  — the process is a named child actor of a SIBLING session DO, and
 *           the coordinator reaches it over one held-open RPC.
 *
 * Both call the same `openResidentFacet`. The peer leg is not a second process
 * implementation; it is the same call made on a different actor, which is why
 * the runner, the boot spec, the class name, the writer handshake, the start
 * contract and the lifecycle are shared code rather than parallel paths.
 *
 * Choosing between them
 * ─────────────────────
 * `NIMBUS_PROCESS_HOST`, one var for the whole deployment. No spawn site
 * chooses; no program name, mode or payload size reaches the choice. If a
 * decision about a particular process ever appears here, the heavy/light
 * classifier has grown back and should be deleted again.
 *
 *   |          | spawn      | memory      | CPU        | SQLite |
 *   |----------|------------|-------------|------------|--------|
 *   | facet    | 8-16 ms    | independent | SHARED     | own    |
 *   | peer     | 242-359 ms | independent | independent| own    |
 *
 * Facet CPU is shared because facets are separate isolates inside ONE actor
 * thread: awaiting I/O yields it completely (measured 0 ms of sibling impact),
 * but a non-yielding loop stalls every sibling for its full duration
 * (measured 6,852 ms). A peer pays ~20x the spawn cost to buy that back.
 *
 * What the peer leg has to do differently, and why none of it reaches the
 * process
 * ────────────────────────────────────────────────────────────────────────
 *   payloads — a whole structured-clone RPC value is capped at 32 MiB, and
 *              pi's node snapshot alone serializes to 44,252,709 bytes. Boot
 *              specs name their large members BY PATH, so what crosses is a
 *              path and the host reads the bytes off the coordinator's disk in
 *              4 MiB ranges through the supervisor. Nothing large is ever an
 *              RPC argument, so nothing has to be streamed or replayed.
 *   requests — workerd refuses to transfer an object owned by a
 *              dynamically-loaded worker across a sibling-DO hop, so a request
 *              travels to the peer as PARTS and the response comes back as
 *              parts, both with plain `ReadableStream` bodies that RPC carries
 *              with flow control. A live SSE body still streams; nothing is
 *              buffered.
 *   liveness — the host leg is held open for the process's whole life, which
 *              is also what keeps the hosting DO resident. A peer therefore
 *              never outlives its coordinator: the coordinator dying cancels
 *              the inbound call and the facet dies with it. Nothing in this
 *              fabric arms an alarm, on either substrate.
 *
 * WebSockets are NOT in that list, because a resident process never receives
 * one. `RouteableFacetTarget` is `handleHttpRequest(Request): Promise<Response>`
 * and nothing else; no runner returns a 101 with a `webSocket` member; every
 * inbound socket Nimbus serves — the shell terminal, `/api/logs/<pid>`, vite
 * HMR — terminates on the session DO and reaches the process, if at all, as
 * events on a supervisor poll. That is substrate-independent by construction.
 */
import { disposeRpcResource } from '../_shared/rpc-dispose.js';
import { isTransientDoReset } from '../observability/oom-classify.js';
import { PEER_RETRY_BACKOFF_MS, PEER_TRANSIENT_RESET_RETRIES } from './fanout-pool.js';
import { openResidentFacet, residentFacetName, } from './process-fabric.js';
import { BindingError } from './vendor/errors.js';
/**
 * The var that picks the substrate, and the only place its name appears.
 * Unset means `facet`; an unrecognized value is refused rather than defaulted,
 * because a typo that silently kept the old substrate would make an operator's
 * comparison a lie.
 */
export function processHostMode(env) {
    const raw = (typeof env === 'object' || typeof env === 'function') && env !== null
        ? Reflect.get(env, 'NIMBUS_PROCESS_HOST')
        : undefined;
    if (raw === undefined || raw === null || raw === '' || raw === 'facet')
        return 'facet';
    if (raw === 'peer')
        return 'peer';
    throw new Error(`Nimbus: NIMBUS_PROCESS_HOST must be 'facet' or 'peer' (got '${String(raw)}')`);
}
/**
 * The substrate for this deployment, resolved once. `disk` is the
 * coordinator's own filesystem reader; the peer host does not take it, because
 * a peer reads the same disk through the supervisor instead.
 */
export function processHostFor(ctx, env, disk) {
    return processHostMode(env) === 'peer'
        ? new PeerProcessHost(ctx, env)
        : new FacetProcessHost(ctx, env, disk);
}
// ── facet: the process is a child of the user's own session DO ──────────────
class FacetProcessHost {
    ctx;
    disk;
    env;
    coordDoId;
    constructor(ctx, env, disk) {
        this.ctx = ctx;
        this.disk = disk;
        this.env = (env ?? {});
        this.coordDoId = ctx.id.toString();
    }
    async open(params) {
        const supervisor = {
            doId: this.coordDoId,
            pid: params.pid,
            writerId: params.writerId,
        };
        const facet = openResidentFacet(this.ctx, this.env, this.disk, supervisor, params);
        return {
            ...facet,
            describe: () => `facet '${residentFacetName(params.pid)}' of session ${this.coordDoId.slice(-12)}`,
        };
    }
}
// ── peer: the process is a child of a sibling session DO ────────────────────
/**
 * How many sibling names to try before accepting one that co-located with a
 * process already running. Measured: 1 shared pair in 24 fresh peers.
 */
const PEER_PLACEMENT_MAX_ATTEMPTS = 4;
/**
 * This workerd process's identity. Module scope, so two Durable Objects
 * reporting the same token are in the same process — which is exactly the CPU
 * sharing a peer exists to avoid, and the only way to detect it.
 */
let _isolateToken = null;
export function isolateToken() {
    if (!_isolateToken)
        _isolateToken = crypto.randomUUID();
    return _isolateToken;
}
function peerNamespace(env) {
    const ns = (typeof env === 'object' || typeof env === 'function') && env !== null
        ? Reflect.get(env, 'NIMBUS_SESSION')
        : undefined;
    if ((typeof ns !== 'object' && typeof ns !== 'function') || ns === null
        || typeof Reflect.get(ns, 'idFromName') !== 'function'
        || typeof Reflect.get(ns, 'get') !== 'function') {
        throw new BindingError('ProcessFabric: env.NIMBUS_SESSION binding missing or invalid. '
            + "NIMBUS_PROCESS_HOST='peer' hosts every resident process on a sibling "
            + 'Durable Object; add the binding via durable_objects.bindings in wrangler.jsonc.');
    }
    return ns;
}
function processPeerStub(value, peerName) {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
        throw new BindingError(`ProcessFabric: NIMBUS_SESSION.get() returned no stub for peer '${peerName}'.`);
    }
    if (typeof Reflect.get(value, '_rpcHostProcess') !== 'function'
        || typeof Reflect.get(value, '_rpcProcessHostProbe') !== 'function') {
        throw new BindingError(`ProcessFabric: peer '${peerName}' does not expose the host-process RPC surface.`);
    }
    return value;
}
class PeerProcessHost {
    ctx;
    ns;
    coordDoId;
    /** pid → the isolate token of the peer currently hosting that process. */
    tokensInUse = new Map();
    constructor(ctx, env) {
        this.ctx = ctx;
        this.ns = peerNamespace(env);
        this.coordDoId = ctx.id.toString();
    }
    async open(params) {
        const placement = await this._place(params.pid);
        this.tokensInUse.set(params.pid, placement.isolateToken);
        // Held open for the process's whole life: it is the lifecycle, and it is
        // also what keeps the hosting DO resident. It settles when a `lifetime`
        // runner exits or when a `boot` runner's host is cancelled, and rejects if
        // the peer dies under either.
        const hostLeg = placement.stub._rpcHostProcess(params.boot, {
            coordinatorDoId: this.coordDoId,
            pid: params.pid,
            writerId: params.writerId,
            workerKey: params.workerKey,
            startArgs: params.startArgs,
        });
        hostLeg.catch(() => { });
        // The peer starts the runner as part of hosting it; this reads back that
        // one boot payload without re-running anything, so `started` means exactly
        // what it means on a facet. Racing the host leg is what turns a peer that
        // died before the boot landed into a rejection rather than a hang — the
        // peer that would have answered is the thing that is gone.
        const booted = placement.stub._rpcAwaitHostedBoot(params.workerKey).then((r) => r.payload);
        booted.catch(() => { });
        const started = Promise.race([booted, hostLeg.then(() => booted)]);
        started.catch(() => { });
        // Do not return a handle for a process that was never opened. Opening a
        // facet of one's own DO either throws or does not, before any handle
        // exists; this is that same moment, one hop away.
        try {
            await Promise.race([
                placement.stub._rpcAwaitHostedOpen(params.workerKey),
                hostLeg.then(() => ({ ok: true })),
            ]);
        }
        catch (error) {
            this.tokensInUse.delete(params.pid);
            this._cancel(params.workerKey, placement.peerName);
            disposeRpcResource(placement.stub);
            throw error;
        }
        let released = false;
        return {
            started,
            handleHttpRequest: (request) => routeThroughPeer(placement.stub, params.workerKey, request),
            release: async () => {
                if (released)
                    return;
                released = true;
                this.tokensInUse.delete(params.pid);
                try {
                    await this._cancel(params.workerKey, placement.peerName);
                }
                finally {
                    disposeRpcResource(placement.stub);
                }
            },
            describe: () => `peer '${placement.peerName}' (isolate ${placement.isolateToken.slice(0, 8)})`,
        };
    }
    /**
     * Probe successive sibling names until one reports an isolate token distinct
     * from this coordinator's and from every peer already hosting a process. A
     * peer that co-located bought nothing — it shares the CPU it was chosen to
     * escape — so placement verifies rather than assumes. When every attempt
     * co-locates (single-process dev topologies) the last candidate is used: a
     * co-located peer still runs the process correctly.
     */
    async _place(pid) {
        const denied = new Set([isolateToken(), ...this.tokensInUse.values()]);
        let colocated = null;
        for (let attempt = 0; attempt < PEER_PLACEMENT_MAX_ATTEMPTS; attempt++) {
            const peerName = `${this.coordDoId}:proc:${pid}:${attempt}`;
            let resource;
            try {
                resource = this.ns.get(this.ns.idFromName(peerName));
                const stub = processPeerStub(resource, peerName);
                const probe = await this._probe(stub, peerName);
                const candidate = { stub, peerName, isolateToken: probe.isolateToken };
                if (colocated)
                    disposeRpcResource(colocated.stub);
                if (!denied.has(probe.isolateToken))
                    return candidate;
                colocated = candidate;
            }
            catch (error) {
                disposeRpcResource(resource);
                if (colocated)
                    disposeRpcResource(colocated.stub);
                throw error;
            }
        }
        return colocated;
    }
    /**
     * First contact with a possibly-cold sibling DO: retry transient platform
     * resets with the same bounded policy the fanout peers ship. Non-transient
     * failures propagate on the first hit.
     */
    async _probe(stub, peerName) {
        for (let attempt = 0;; attempt++) {
            try {
                const probe = await stub._rpcProcessHostProbe();
                if (!probe || typeof probe.isolateToken !== 'string' || probe.isolateToken.length === 0) {
                    throw new Error(`ProcessFabric: peer '${peerName}' returned no isolate token`);
                }
                return probe;
            }
            catch (err) {
                if (attempt < PEER_TRANSIENT_RESET_RETRIES && isTransientDoReset(err)) {
                    await new Promise((r) => setTimeout(r, PEER_RETRY_BACKOFF_MS[Math.min(attempt, PEER_RETRY_BACKOFF_MS.length - 1)]));
                    continue;
                }
                throw err;
            }
        }
    }
    /**
     * A fresh stub to the hosting peer fires `_rpcCancelHostProcess`, which
     * releases the peer's facet — the exact teardown a local facet gets — and
     * only answers once it has. Awaiting it is what makes "released" mean the
     * same thing on both substrates, so the writer identity is retired at the
     * same point in the process's life either way. Also handed to `waitUntil`,
     * so a kill nobody awaited still completes.
     */
    _cancel(workerKey, peerName) {
        let stub;
        try {
            stub = processPeerStub(this.ns.get(this.ns.idFromName(peerName)), peerName);
        }
        catch {
            return Promise.resolve();
        }
        const cancelled = Promise.resolve(stub._rpcCancelHostProcess(workerKey))
            .then(() => undefined)
            .catch(() => { })
            .finally(() => disposeRpcResource(stub));
        this.ctx.waitUntil(cancelled);
        return cancelled;
    }
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
