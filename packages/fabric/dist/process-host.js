/**
 * process-host.ts — the two substrates a resident process can run on, and the
 * one value that picks between them.
 *
 * `process-fabric.ts` owns what a resident process IS. This module
 * owns only where it lives, behind `ProcessHost`:
 *
 *   facet — the process is a named child actor of the user's own session DO.
 *   peer  — the process is a named child actor of a SIBLING session DO, and
 *           the coordinator reaches it over one held-open RPC. Both ends of
 *           that RPC are here: `PeerProcessHost` calls it, `PeerHost` serves it.
 *
 * Both call the same `processes(ctx, env).spawn`. The peer leg is not a second process
 * implementation; it is the same call made on a different actor, which is why
 * the runner, the boot spec, the class name, the writer handshake, the start
 * contract and the lifecycle are shared code rather than parallel paths.
 *
 * Choosing between them
 * ─────────────────────
 * One value for the whole deployment, resolved by the embedder's config seam
 * (Nimbus reads `NIMBUS_PROCESS_HOST` in the worker's own selector) and
 * handed to `createProcessHost`. No spawn site chooses; no program name, mode
 * or payload size reaches the choice. If a decision about a particular
 * process ever appears here, the heavy/light classifier has grown back and
 * should be deleted again.
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
 * WebSockets are the one thing on that list the RPC path cannot carry at all.
 * A 101 Response owns a live socket, and RPC's Request/Response transport
 * reconstructs a value rather than handing the socket over, so an upgrade
 * stays on FETCH semantics for every hop: a facet is fetched directly, and a
 * peer is fetched as a service binding which then fetches its hosted facet.
 * Two headers carry what the RPC arguments would have — see
 * {@link HOSTED_WEBSOCKET_KEY_HEADER} — and a per-process capability makes
 * that pair unforgeable by anything that did not open the process.
 */
import { ISOLATE_NETWORK, networkRef, workspaceNetwork, } from '@nimbus-sh/core/_shared/workspace-network.js';
import { errorText } from '@nimbus-sh/core/_shared/error-text.js';
import { isWebSocketUpgradeRequest } from '@nimbus-sh/core/_shared/websocket-upgrade.js';
import { disposeRpcResource } from '@nimbus-sh/platform/rpc-dispose.js';
import { RESIDENT_KEEPALIVE_MS } from '@nimbus-sh/platform/limits.js';
import { peerRetryDelay } from './fanout.js';
import { hostNamespaceBinding, hostOpDispatch } from './host-dispatch.js';
import { z } from 'zod/v4';
import { isHostReset } from '@nimbus-sh/platform/oom-classify.js';
import { ProcessHostLost, } from './process-fabric.js';
import { DYNAMIC_WORKER_CODE_LIMIT_BYTES } from './budgets.js';
import { BindingError } from './vendor/errors.js';
import { processes, } from './workerd-facet-host.js';
import { bindingSupervisor, supervisorBindingProps } from './supervisor-props.js';
/**
 * The substrate for this deployment, resolved once. The mode arrives already
 * decided — the embedder owns the config var that picks it, and refuses an
 * unrecognized value there rather than defaulting, because a typo that
 * silently kept the old substrate would make an operator's comparison a lie.
 * `disk` is the coordinator's own filesystem reader; the peer host does not
 * take it, because a peer reads the same disk through the supervisor instead.
 */
export function createProcessHost(mode, ctx, env, disk, 
/** The workspace's network: every process's binding carries it, and with it its egress. */
network, supervise = bindingSupervisor) {
    return mode === 'peer'
        ? new PeerProcessHost(ctx, env, network, supervise)
        : new FacetProcessHost(ctx, env, disk, network, supervise);
}
// ── facet: the process is a child of the user's own session DO ──────────────
class FacetProcessHost {
    ctx;
    disk;
    network;
    supervise;
    /**
     * The process shares its session's Durable Object, so the session's own
     * store is reachable by copy-on-write — and its storage budget is the same
     * budget. Both halves of that follow from the one fact, and neither is
     * optional.
     */
    imageDelivery = {
        reflink: 'same-object',
        moduleCeilingBytes: DYNAMIC_WORKER_CODE_LIMIT_BYTES,
        storageSharedWithSession: true,
    };
    env;
    coordDoId;
    constructor(ctx, env, disk, network, supervise) {
        this.ctx = ctx;
        this.disk = disk;
        this.network = network;
        this.supervise = supervise;
        this.env = (env ?? {});
        this.coordDoId = ctx.id.toString();
    }
    runOnce(params, consume) {
        const supervisor = supervisorBindingProps(this.ctx, params.pid, { writerId: params.writerId, network: this.network() });
        return processes(this.ctx, this.env).run(supervisor, this.supervise, params, consume);
    }
    async open(params) {
        const supervisor = supervisorBindingProps(this.ctx, params.pid, { writerId: params.writerId, network: this.network() });
        const { name, ...facet } = processes(this.ctx, this.env).spawn(this.disk, supervisor, params);
        // The platform can kill or reset the process's own facet (its memory or
        // CPU limit, measured with astro dev on 2026-10-08) with the session left
        // standing; the next call to the facet is what shows it. Its boot is left
        // as the facet answers it: a run's own start and stop (a boot waiting on
        // stdin is replayed) are not the host's to judge.
        const loss = new HostLoss(facet.lost);
        return {
            ...facet,
            lost: loss.signal,
            handleHttpRequest: (request) => loss.route(() => facet.handleHttpRequest(request)),
            handleWebSocketRequest: (request) => loss.route(() => facet.handleWebSocketRequest(request)),
            release: () => {
                loss.release();
                return facet.release();
            },
            describe: () => `facet '${name}' (pid ${params.pid})`
                + ` of session ${this.coordDoId.slice(-12)}`
                + `; ${describeImageDelivery(this.imageDelivery)}`,
        };
    }
}
/**
 * The operator-facing half of the substrate difference, on the one line an
 * operator actually reads. A comment in this file would not have told anyone
 * who flipped the config that the image path changed under them.
 */
function describeImageDelivery(delivery) {
    return `fs image: reflink ${delivery.reflink}, module map ≤ ${delivery.moduleCeilingBytes}B, `
        + `storage ${delivery.storageSharedWithSession ? 'shared with the session' : 'its own'}`;
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
/**
 * Options the coordinator hands a hosting peer. Parsed on the peer, because a
 * sibling accepts them from whoever calls it.
 */
const HostProcessOptsSchema = z.object({
    /** Full doId of the coordinator session (SUPERVISOR routing target). */
    coordinatorDoId: z.string().min(1),
    /** The coordinator's route, minted into the process's SUPERVISOR binding. */
    route: z.object({
        supervisorEntrypoint: z.string().min(1),
        hostNamespace: z.string().min(1),
        hostDispatchMethod: z.string().min(1),
    }).optional(),
    /** Supervisor-assigned pid of the process entry on the coordinator. */
    pid: z.number().int().positive(),
    /** Trusted identity of this concrete resident-host incarnation. */
    writerId: z.string().uuid(),
    /** The coordinator instance's delivery incarnation, minted into the SUPERVISOR binding (ResidentSupervisorProps). */
    hostIncarnation: z.string().uuid().optional(),
    /** The coordinator workspace's egress (a stub, crossed by RPC) and its id: the process's network. */
    network: z.object({
        egress: z.custom((value) => value !== null && (typeof value === 'object' || typeof value === 'function')
            && 'fetch' in value && typeof value.fetch === 'function' && 'connect' in value && typeof value.connect === 'function'),
        id: z.string().min(1),
    }).optional(),
    /** Keyed dynamic-worker identity on the peer's loader. */
    workerKey: z.string().min(1),
    /** Unforgeable capability for the fetch-semantic WebSocket hop. */
    webSocketCapability: z.string().uuid(),
    /** Opaque arguments forwarded to the runner's startProcess. */
    startArgs: z.unknown().optional(),
});
/**
 * Which hosted process a fetched upgrade is for. An upgrade cannot travel as
 * RPC arguments, so the two values `_rpcRouteHostedHttp` would have taken ride
 * as headers on the peer fetch instead.
 *
 * The key alone is guessable from a pid, so it is not enough on its own; the
 * capability is minted per `open()` and known only to the coordinator that
 * opened the process and the peer that hosts it. The receiving session strips
 * both before the request reaches the process.
 */
export const HOSTED_WEBSOCKET_KEY_HEADER = 'x-nimbus-hosted-websocket';
export const HOSTED_WEBSOCKET_CAPABILITY_HEADER = 'x-nimbus-hosted-websocket-capability';
/**
 * Peer stubs forward one supervisorOp entrypoint: every method the host-
 * process surface needs is an envelope op, not a private _rpc* method.
 */
function peerNamespace(env) {
    try {
        return hostNamespaceBinding(env, 'ProcessFabric');
    }
    catch (e) {
        if (e instanceof BindingError) {
            throw new BindingError(e.message
                + " NIMBUS_PROCESS_HOST='peer' hosts every resident process on a sibling "
                + "Durable Object; name the host's own binding with composeFabric({ hostNamespace }).");
        }
        throw e;
    }
}
const PeerProbeResult = z.object({ isolateToken: z.string() });
const PeerOpenResult = z.object({ ok: z.boolean() });
const PeerBootResult = z.object({ payload: z.unknown() });
const PeerCancelResult = z.object({ cancelled: z.boolean() });
const PeerHttpResult = z.object({
    status: z.number().int(),
    statusText: z.string(),
    headers: z.array(z.tuple([z.string(), z.string()])),
    body: z.instanceof(ReadableStream).nullable(),
});
function processPeerStub(value, peerName) {
    const dispatch = hostOpDispatch(value, `ProcessFabric peer '${peerName}'`);
    const fetchFn = (typeof value === 'object' || typeof value === 'function') && value !== null
        ? Reflect.get(value, 'fetch')
        : undefined;
    if (typeof fetchFn !== 'function') {
        throw new BindingError(`ProcessFabric: peer '${peerName}' exposes no fetch() — the hosted-websocket `
            + 'upgrade leg still travels as a service-binding fetch.');
    }
    const adapter = {
        _rpcProcessHostProbe: async () => PeerProbeResult.parse(await dispatch({ op: 'processHostProbe', args: [] })),
        _rpcHostProcess: async (boot, opts) => PeerOpenResult.parse(await dispatch({ op: 'hostProcess', args: [boot, opts] })),
        _rpcAwaitHostedOpen: async (key) => PeerOpenResult.parse(await dispatch({ op: 'awaitHostedOpen', args: [key] })),
        _rpcAwaitHostedBoot: async (key) => {
            const result = PeerBootResult.parse(await dispatch({ op: 'awaitHostedBoot', args: [key] }));
            return { payload: result.payload };
        },
        _rpcRouteHostedHttp: async (key, request) => PeerHttpResult.parse(await dispatch({ op: 'routeHostedHttp', args: [key, request] })),
        _rpcCancelHostProcess: async (key) => PeerCancelResult.parse(await dispatch({ op: 'cancelHostProcess', args: [key] })),
        fetch: async (request) => {
            const response = await Reflect.apply(fetchFn, value, [request]);
            if (!(response instanceof Response))
                throw new BindingError(`ProcessFabric: peer '${peerName}' returned no Response`);
            return response;
        },
    };
    // The adapter wraps the raw stub; releasing the adapter must release it —
    // a held RPC stub pins the peer DO for the session's life.
    const disposerKey = Reflect.get(Symbol, 'dispose');
    if (typeof disposerKey === 'symbol') {
        Object.defineProperty(adapter, disposerKey, { value: () => disposeRpcResource(value) });
    }
    return adapter;
}
class PeerProcessHost {
    ctx;
    network;
    supervise;
    /**
     * A peer buys independent CPU and its own storage budget, and pays for both
     * with the image path: nothing crosses a Durable Object boundary by
     * reference, so the whole session filesystem has to travel as bytes.
     */
    imageDelivery = {
        reflink: 'impossible',
        moduleCeilingBytes: DYNAMIC_WORKER_CODE_LIMIT_BYTES,
        storageSharedWithSession: false,
    };
    ns;
    env;
    coordDoId;
    /** pid → the isolate token of the peer currently hosting that process. */
    tokensInUse = new Map();
    /** workerKey → how to end an open process whose host reports its reset (hostLost). */
    opens = new Map();
    constructor(ctx, env, network, supervise) {
        this.ctx = ctx;
        this.network = network;
        this.supervise = supervise;
        if (env === null || (typeof env !== 'object' && typeof env !== 'function')) {
            throw new BindingError('ProcessFabric: a peer host requires environment bindings');
        }
        this.ns = peerNamespace(env);
        this.env = (env ?? {});
        this.coordDoId = ctx.id.toString();
    }
    /**
     * Not placed on a sibling, and that is not a gap in this substrate.
     * `peer` exists to buy a resident process independent CPU; a program that
     * ends with the call it was started by has no residency to place, and its
     * map is fully inline — so a hop would meet the RPC ceiling that by-path
     * boot specs exist to avoid while buying nothing. It runs as a dynamic
     * worker of the coordinator here exactly as it does on `facet`.
     */
    runOnce(params, consume) {
        const supervisor = supervisorBindingProps(this.ctx, params.pid, { writerId: params.writerId, network: this.network() });
        return processes(this.ctx, this.env).run(supervisor, this.supervise, params, consume);
    }
    async open(params) {
        if (params.facet) {
            // A durable application's facet must be a child of the COORDINATOR's
            // Durable Object — its `app-slot-<n>` row and retained SQLite live in
            // that DO's storage. A sibling host would own storage the coordinator's
            // durable-slot book and removeDurableApp cannot reach.
            throw new Error('Nimbus: a durable spawn must be facet-hosted on its own coordinator; '
                + 'the peer substrate cannot serve one');
        }
        const placement = await this._place(params.pid);
        // Minted per open, held only by this coordinator and the peer that hosts
        // the process. The workerKey is derivable from a pid; this is not.
        const webSocketCapability = crypto.randomUUID();
        // Held open for the process's whole life: it is the lifecycle, and it is
        // also what keeps the hosting DO resident. It settles when a `lifetime`
        // runner exits or when a `boot` runner's host is cancelled, and rejects if
        // the peer dies under either.
        // The peer mints the process's binding from these, for THIS object: the
        // coordinator's doId, route and delivery instance.
        const supervisor = supervisorBindingProps(this.ctx, params.pid, { writerId: params.writerId, network: this.network() });
        const hostLeg = placement.stub._rpcHostProcess(params.boot, {
            coordinatorDoId: supervisor.doId,
            route: supervisor.route,
            pid: supervisor.pid,
            writerId: params.writerId,
            hostIncarnation: supervisor.hostIncarnation,
            // The workspace's egress crosses to the peer, which mints the process's binding with it.
            network: networkRef(this.network()),
            workerKey: params.workerKey,
            webSocketCapability,
            startArgs: params.startArgs,
        });
        hostLeg.catch(() => { });
        // The held leg failing is one way the peer's loss shows (a coordinator's
        // own release settles it cleanly); the peer's next incarnation reporting
        // it (hostLost) from its own alarm is another.
        const loss = new HostLoss(hostLeg);
        this.opens.set(params.workerKey, { capability: webSocketCapability, lose: (error) => loss.lose(error) });
        // The peer starts the runner as part of hosting it; this reads back that
        // one boot payload without re-running anything, so `started` means exactly
        // what it means on a facet. Racing the host leg is what turns a peer that
        // died before the boot landed into a rejection rather than a hang — the
        // peer that would have answered is the thing that is gone.
        const started = loss.route(() => placement.stub._rpcAwaitHostedBoot(params.workerKey).then((r) => r.payload));
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
            this.opens.delete(params.workerKey);
            // Awaited, not fired off: a spawn that rejects must mean nothing was
            // left running, which is what a throw from `processes().spawn` means on
            // the other substrate.
            try {
                await this._cancel(params.workerKey, placement.peerName);
            }
            finally {
                disposeRpcResource(placement.stub);
            }
            throw error;
        }
        let released = false;
        return {
            started,
            // The held leg IS the process's residency here, and it settles cleanly
            // when the coordinator releases. The host going away under a process
            // that was up rejects this, and the fabric ends the process on it.
            lost: loss.signal,
            handleHttpRequest: (request) => loss.route(() => routeThroughPeer(placement.stub, params.workerKey, request)),
            handleWebSocketRequest: (request) => loss.route(() => routeWebSocketThroughPeer(placement.stub, params.workerKey, webSocketCapability, request)),
            release: async () => {
                if (released)
                    return;
                released = true;
                loss.release();
                this.tokensInUse.delete(params.pid);
                this.opens.delete(params.workerKey);
                try {
                    await this._cancel(params.workerKey, placement.peerName);
                }
                finally {
                    disposeRpcResource(placement.stub);
                }
            },
            describe: () => `peer '${placement.peerName}' (isolate ${placement.isolateToken.slice(0, 8)})`
                + `; ${describeImageDelivery(this.imageDelivery)}`,
        };
    }
    hostLost(workerKey, capability) {
        const open = this.opens.get(workerKey);
        if (open === undefined || open.capability !== capability)
            return false;
        open.lose(new Error('the host restarted without it'));
        return true;
    }
    /**
     * Probe successive sibling names until one reports an isolate token distinct
     * from this coordinator's and from every peer already hosting a process. A
     * peer that co-located bought nothing — it shares the CPU it was chosen to
     * escape — so placement verifies rather than assumes.
     */
    async _place(pid) {
        const denied = new Set([isolateToken(), ...this.tokensInUse.values()]);
        for (let attempt = 0; attempt < PEER_PLACEMENT_MAX_ATTEMPTS - 1; attempt++) {
            const candidate = await this._probePlacement(pid, attempt);
            if (!denied.has(candidate.isolateToken))
                return candidate;
            disposeRpcResource(candidate.stub);
        }
        // Every attempt co-located, which happens in single-process topologies. Use
        // the last one anyway: it runs the process correctly, it just shares the
        // CPU it was chosen to escape, and the placement line names the isolate it
        // landed in so that is visible rather than assumed.
        return this._probePlacement(pid, PEER_PLACEMENT_MAX_ATTEMPTS - 1);
    }
    /** One sibling name, resolved and probed. Leaks nothing on failure. */
    async _probePlacement(pid, attempt) {
        const peerName = `${this.coordDoId}:proc:${pid}:${attempt}`;
        let resource = null;
        try {
            resource = this.ns.get(this.ns.idFromName(peerName));
            const stub = processPeerStub(resource, peerName);
            const probe = await this._probe(stub, peerName);
            return { stub, peerName, isolateToken: probe.isolateToken };
        }
        catch (error) {
            disposeRpcResource(resource);
            throw error;
        }
    }
    /**
     * First contact with a possibly-cold sibling DO: retry transient platform
     * resets on the fanout peers' schedule. An overloaded sibling fails the
     * probe at once, as does any other failure: the spawn then fails fast
     * rather than wait the overload schedule out.
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
                const backoff = peerRetryDelay(err, attempt, { retryOverloaded: false });
                if (backoff !== null) {
                    await new Promise((r) => setTimeout(r, backoff));
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
/**
 * How long a boot-payload or routed-HTTP leg waits for its process's host
 * record. Normally zero: the coordinator issues `hostProcess` first and it
 * registers before its first await. The wait exists so neither leg can lose a
 * race with RPC delivery order.
 */
const HOSTED_RECORD_WAIT_MS = 30_000;
/**
 * Live production DO storage keys: one row per process this host holds for a
 * coordinator, while it holds it. Never rename (a migration).
 */
const HOSTING_KEY_PREFIX = 'hosting:';
/**
 * How often a host holding a process looks for its own reset: the resident
 * keep-alive's cadence, so the session learns of it within one cadence.
 */
export const HOSTING_WATCH_MS = RESIDENT_KEEPALIVE_MS;
/**
 * Whole-file reads for a boot spec's by-path members, in ranges. This is the
 * one thing a peer does differently from a coordinator, and it is a PARAMETER
 * of `processes().spawn` rather than a branch inside it: the coordinator reads
 * its own disk synchronously, a peer reads the same disk over the supervisor.
 *
 * Ranged because these are the session's largest files — a ruby
 * interpreter+stdlib image is 34.3 MiB — and workerd's 32 MiB ceiling applies
 * to each returned VALUE, not to the call. UNCACHED for the same reason the
 * coordinator's own reader is: caching a 34 MiB blob in a 32 MiB LRU evicts
 * everything the session was using and holds the blob for the session's life.
 *
 * The credential is the PROCESS's, not the kernel's, because that is what a
 * supervisor RPC carries and no substrate should be able to read more than the
 * process it hosts. Boot-spec members are reachable under it by construction:
 * the image store is kernel-owned mode 0644 precisely so any process can read
 * it, and the installed runtime images are world-readable too.
 */
const RESIDENT_READ_RANGE_BYTES = 4 * 1024 * 1024;
function peerDiskReader(supervisor) {
    const fs = bindingSupervisor(supervisor);
    return { readFile: (path) => readSupervisorFile(fs, path) };
}
async function readSupervisorFile(fs, path) {
    const stat = await fs.stat(path);
    const size = Number(stat?.size);
    if (!Number.isSafeInteger(size) || size < 0) {
        throw new Error(`Nimbus: cannot size '${path}' for a resident process's module map`);
    }
    const out = new Uint8Array(size);
    for (let offset = 0; offset < size;) {
        const chunk = await fs.fsReadRangeUncached(path, offset, Math.min(RESIDENT_READ_RANGE_BYTES, size - offset));
        if (!chunk || chunk.byteLength === 0) {
            throw new Error(`Nimbus: '${path}' returned no bytes at offset ${offset}`);
        }
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}
/**
 * The processes this Durable Object hosts for its siblings, and every leg a
 * coordinator's {@link PeerProcessHost} calls on it. One per object: its
 * records are this instance's memory, and its hosting rows are the storage a
 * next incarnation reads to report what the platform reset under it.
 */
export class PeerHost {
    ctx;
    options;
    records = new Map();
    waiters = new Map();
    env;
    constructor(ctx, env, options) {
        this.ctx = ctx;
        this.options = options;
        this.env = (env ?? {});
    }
    /**
     * Placement probe: this peer's module-scope isolate token, so the
     * coordinator can verify the peer landed in a distinct workerd process — the
     * same token means a shared process, which is the CPU sharing a peer exists
     * to escape.
     */
    probe() {
        return { isolateToken: isolateToken() };
    }
    /**
     * Host a resident process. Held open by the coordinator for the process's
     * whole life, and it is that held call which keeps this object resident —
     * the hosting watch is armed to report a reset, never to wake a host back
     * up. Resolves when the coordinator releases the process; rejects if it
     * could not be opened at all.
     *
     * The runner's start CONTRACT never crosses. The coordinator's fabric decides
     * from it when the process is over and releases, which cancels this call — so
     * this leg holds uniformly and has no idea whether it is hosting a TUI or a
     * server.
     *
     * If the coordinator dies, workerd cancels this inbound call, the facet is
     * released in the `finally` below, and the process dies with it: a hosting
     * peer never outlives its parent session.
     */
    async host(boot, opts) {
        const hostOpts = HostProcessOptsSchema.parse(opts);
        const spec = this.options.bootSpec.parse(boot);
        const { workerKey } = hostOpts;
        const supervisor = {
            ...supervisorBindingProps(this.ctx, hostOpts.pid, {
                writerId: hostOpts.writerId, doId: hostOpts.coordinatorDoId, route: hostOpts.route,
                network: hostOpts.network === undefined ? ISOLATE_NETWORK : workspaceNetwork(hostOpts.network.egress, hostOpts.network.id),
            }),
            ...(hostOpts.hostIncarnation === undefined ? {} : { hostIncarnation: hostOpts.hostIncarnation }),
        };
        let cancel = () => { };
        const cancelled = new Promise((resolve) => { cancel = resolve; });
        let settleFacet = () => { };
        let failFacet = () => { };
        const facetPromise = new Promise((resolve, reject) => {
            settleFacet = resolve;
            failFacet = reject;
        });
        let settleStarted = () => { };
        let failStarted = () => { };
        const startedPromise = new Promise((resolve, reject) => {
            settleStarted = resolve;
            failStarted = reject;
        });
        // Nothing awaits these unless a leg asks for them; keep the runtime from
        // reporting them as unhandled while the process is healthy.
        facetPromise.catch(() => { });
        startedPromise.catch(() => { });
        this.register(workerKey, {
            facet: facetPromise,
            started: startedPromise,
            webSocketCapability: hostOpts.webSocketCapability,
            cancel,
        });
        // What this host's next incarnation needs to tell the session it lost the
        // process: kept while it hosts, with the alarm that will look
        // (watchFired). Both are in place before the process exists; a host that
        // cannot keep them does not host it.
        const hostingKey = `${HOSTING_KEY_PREFIX}${workerKey}`;
        const hosting = {
            coordinatorDoId: hostOpts.coordinatorDoId,
            ...(hostOpts.route === undefined ? {} : { route: hostOpts.route }),
            workerKey,
            capability: hostOpts.webSocketCapability,
        };
        let facet;
        try {
            await this.ctx.storage.put(hostingKey, hosting);
            await this.armWatch();
            facet = processes(this.ctx, this.env).spawn(() => peerDiskReader(supervisor), supervisor, {
                pid: hostOpts.pid,
                workerKey,
                boot: spec,
                writerId: hostOpts.writerId,
                startArgs: hostOpts.startArgs,
            });
            settleFacet(facet);
            facet.started.then(settleStarted, failStarted);
            // The facet lost here fails the held leg, which is how the session hears of it.
            await Promise.race([cancelled, facet.lost]);
            return { ok: true };
        }
        catch (e) {
            failFacet(e);
            failStarted(e);
            throw e;
        }
        finally {
            // The record OUTLIVES the process on purpose, and a peer hosts exactly one
            // (its name carries the pid), so this is one entry per host for the life of
            // the instance. Dropping it would make a request that arrives after a kill
            // wait out `HOSTED_RECORD_WAIT_MS` and then blame the wrong thing; keeping
            // it routes that request into the released facet, which is exactly what a
            // coordinator-hosted one does — it says the process is no longer running.
            await facet?.release();
            await this.ctx.storage.delete(hostingKey);
        }
    }
    /**
     * Settle once the process is OPEN on this peer, or reject with whatever
     * stopped it from opening.
     *
     * This exists so a host failure surfaces at the same place on both substrates.
     * Opening a facet of your own DO either throws or does not, before the fabric
     * has a handle; opening one on a peer is a message, and without this the
     * coordinator would return a handle for a process that never existed and only
     * discover it later, through `done`.
     */
    async awaitOpen(workerKey) {
        const record = await this.awaitRecord(workerKey);
        await record.facet;
        return { ok: true };
    }
    /**
     * Read back the runner's startProcess payload. `host` started it; this
     * never starts anything, so a coordinator asking twice gets the same answer
     * a local facet would have returned inline — and for a `lifetime` runner it
     * settles at exit, exactly as the local one does.
     */
    async awaitBoot(workerKey) {
        const record = await this.awaitRecord(workerKey);
        return { payload: await record.started };
    }
    /**
     * Inbound HTTP for a port owned by a process this peer hosts.
     *
     * A `Request`/`Response` cannot cross a sibling-DO hop by reference — workerd
     * rejects it with "Entrypoints to dynamically-loaded workers cannot be
     * transferred to other Workers", because the object belongs to the
     * dynamically-loaded facet on the other side. Their PARTS travel fine, and a
     * body is a plain ReadableStream, which RPC transfers with flow control. So
     * the leg carries the parts and rebuilds the object on each side: no
     * buffering, no size ceiling, and an SSE or chunked body still flows live.
     *
     * The response body is re-piped through an identity stream owned by THIS
     * isolate before it is returned, for the same reason the parts exist at all:
     * what leaves here must not be an object the loaded worker owns.
     */
    async routeHttp(workerKey, wire) {
        const record = await this.awaitRecord(workerKey);
        const facet = await record.facet;
        const headers = new Headers();
        for (const [k, v] of wire.headers)
            headers.append(k, v);
        const init = { method: wire.method, headers };
        if (wire.body) {
            init.body = wire.body;
            init.duplex = 'half';
        }
        const response = await facet.handleHttpRequest(new Request(wire.url, init));
        let body = null;
        if (response.body) {
            const { readable, writable } = new IdentityTransformStream();
            this.ctx.waitUntil(response.body.pipeTo(writable).catch(() => { }));
            body = readable;
        }
        return {
            status: response.status,
            statusText: response.statusText,
            headers: headerPairs(response.headers),
            body,
        };
    }
    /**
     * The peer end of the upgrade hop, or null for a request that is not one.
     * Reached by `fetch` rather than RPC, so the 101 and its live socket travel
     * back as themselves. This request is a sibling coordinator's, not a
     * browser's, so it is answered before any route of the object's own, and
     * both headers are stripped so the process never sees the transport that
     * carried it.
     *
     * The workerKey names a process and is derivable from a pid, so it does not
     * authorise on its own; the capability is minted by whoever opened the process
     * and never leaves the two objects that hold it. A mismatch is a 404 and not
     * a 403, so the route reveals nothing about what this peer is hosting.
     */
    routeWebSocket(request) {
        const workerKey = request.headers.get(HOSTED_WEBSOCKET_KEY_HEADER);
        if (!workerKey)
            return null;
        if (!isWebSocketUpgradeRequest(request.headers)) {
            return Promise.resolve(new Response('Expected WebSocket', { status: 426 }));
        }
        const capability = request.headers.get(HOSTED_WEBSOCKET_CAPABILITY_HEADER);
        if (!capability)
            return Promise.resolve(new Response('Not found', { status: 404 }));
        const headers = new Headers(request.headers);
        headers.delete(HOSTED_WEBSOCKET_KEY_HEADER);
        headers.delete(HOSTED_WEBSOCKET_CAPABILITY_HEADER);
        return this.awaitRecord(workerKey).then(async (record) => {
            if (record.webSocketCapability !== capability)
                return new Response('Not found', { status: 404 });
            const facet = await record.facet;
            return facet.handleWebSocketRequest(new Request(request.url, { method: request.method, headers }));
        });
    }
    /**
     * Deterministic kill of a hosted process — the same teardown a coordinator
     * applies to a facet of its own, and it does not answer until it has
     * happened. The facet is released HERE rather than left to the held call's
     * `finally`, because a caller that has to guess whether the process is really
     * gone cannot retire the writer identity behind it.
     */
    async cancel(workerKey) {
        const record = this.records.get(workerKey);
        if (!record)
            return { cancelled: false };
        const facet = await record.facet.catch(() => null);
        await facet?.release();
        try {
            record.cancel();
        }
        catch { /* best-effort */ }
        return { cancelled: true };
    }
    /**
     * The hosting alarm. A row whose process this incarnation does not hold is
     * one the platform reset this object under (a new incarnation remembers
     * nothing of the processes it held, and the held leg that would have said so
     * may stay open, measured 2026-10-07): the session is told at once, and the
     * row is dropped once the session has answered, whatever it answered. A row
     * the session did not hear about is kept, and so is the watch: the next
     * alarm tells it again. A failure to read or drop the rows is retried the
     * same way, since the dispatcher forgets a reason whose handler throws.
     * Answers when to look again, or null when nothing is left to watch.
     */
    async watchFired() {
        const again = Date.now() + HOSTING_WATCH_MS;
        try {
            const rows = await this.ctx.storage.list({ prefix: HOSTING_KEY_PREFIX });
            let watching = false;
            for (const [key, row] of rows) {
                if (this.records.has(row.workerKey)) {
                    watching = true;
                    continue;
                }
                try {
                    const ns = hostNamespaceBinding(this.env, 'ProcessFabric host', row.route);
                    await hostOpDispatch(ns.get(ns.idFromString(row.coordinatorDoId)), 'ProcessFabric host', row.route)({
                        op: 'hostLost',
                        args: [row.workerKey, row.capability],
                    });
                }
                catch (error) {
                    console.warn(`[process-host] could not tell session ${row.coordinatorDoId.slice(-12)} that its process ${row.workerKey} was lost; trying again:`, errorText(error));
                    watching = true;
                    continue;
                }
                await this.ctx.storage.delete(key);
            }
            return watching ? again : null;
        }
        catch (error) {
            console.warn('[process-host] the hosting watch could not read or drop its records; trying again:', errorText(error));
            return again;
        }
    }
    /** One that cannot be armed throws, and the host refuses the process rather than hold one nothing would report the loss of. */
    async armWatch() {
        try {
            await this.options.scheduleWatch(Date.now() + HOSTING_WATCH_MS);
        }
        catch (error) {
            throw new Error(`Nimbus: this host could not arm the alarm that reports its own reset, so it does not host the process: ${errorText(error)}`);
        }
    }
    register(workerKey, record) {
        this.records.set(workerKey, record);
        const pending = this.waiters.get(workerKey);
        if (!pending)
            return;
        this.waiters.delete(workerKey);
        for (const notify of pending)
            notify(record);
    }
    /**
     * The record for `workerKey`, waiting briefly if the host leg has not landed
     * yet — the coordinator issues it first and it registers before its first
     * await, so normally there is nothing to wait for, but RPC delivery order is
     * not a guarantee.
     *
     * A host runs exactly ONE process: its Durable Object name carries the pid
     * (`<doId>:proc:<pid>:<attempt>`) and pids never repeat, being strided by
     * generation. So a key this host is not hosting is a key it never will host,
     * and parking a waiter for it would let anyone holding a stub to this object
     * accumulate map entries and 30-second timers here by the thousand. Once
     * something is known, an unknown key is refused immediately instead.
     */
    awaitRecord(workerKey) {
        const existing = this.records.get(workerKey);
        if (existing)
            return Promise.resolve(existing);
        if (this.records.size > 0 || (this.waiters.size > 0 && !this.waiters.has(workerKey))) {
            return Promise.reject(new Error(`Nimbus: peer hosts no process for key '${workerKey}'`));
        }
        return new Promise((resolve, reject) => {
            const pending = this.waiters.get(workerKey) ?? new Set();
            const notify = (record) => { clearTimeout(timer); resolve(record); };
            const timer = setTimeout(() => {
                pending.delete(notify);
                if (pending.size === 0)
                    this.waiters.delete(workerKey);
                reject(new Error(`Nimbus: peer hosts no process for key '${workerKey}'`));
            }, HOSTED_RECORD_WAIT_MS);
            pending.add(notify);
            this.waiters.set(workerKey, pending);
        });
    }
}
/**
 * One open process's host loss: the platform reset or killed the actor it
 * runs in (its facet, or a peer), and the process is over. Fired once, by
 * whichever shows it first: `held` (a leg the host holds for the process's
 * life) failing, or a call to the host failing with a reset's own words
 * (isHostReset). From then on every leg answers with the one
 * ProcessHostLost: `signal` rejects with it, and a route fails at once.
 *
 * Measured on Cloudflare: a peer reset under a CPU-bound process left the
 * held leg open, and only the next call failed, after about 10 s, with
 * "Durable Object reset because its code was updated." (2026-10-07); a facet
 * killed by its memory limit answered the next call, after about 60 s, with
 * "Durable Object's isolate exceeded its memory limit and was reset."
 * (2026-10-08). A call in flight when the loss shows fails then, not when
 * the platform's own answer arrives.
 */
class HostLoss {
    gone = null;
    /** Nimbus released the process itself (a kill, a stop): what fails after that is no loss. */
    released = false;
    reject = () => { };
    signal = new Promise((_, reject) => { this.reject = reject; });
    constructor(held) {
        this.signal.catch(() => { });
        held?.then(() => undefined, (error) => { if (!this.released)
            this.lose(error); });
    }
    lose(error) {
        if (this.gone === null) {
            this.gone = new ProcessHostLost(error);
            this.reject(this.gone);
        }
        return this.gone;
    }
    /** The host is being released on purpose: the facet or peer ending now is that, not a loss. */
    release() {
        this.released = true;
    }
    /** A call to the host, which fails by the loss's name once the host is gone. */
    route(leg) {
        if (this.gone !== null)
            return Promise.reject(this.gone);
        const call = leg().catch((error) => {
            throw this.gone ?? (!this.released && isHostReset(error) ? this.lose(error) : error);
        });
        return Promise.race([call, this.signal]);
    }
}
async function routeThroughPeer(stub, workerKey, request) {
    const result = await stub._rpcRouteHostedHttp(workerKey, {
        method: request.method,
        url: request.url,
        headers: headerPairs(request.headers),
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
/**
 * The upgrade hop. `stub.fetch` is a service-binding fetch, so the peer's
 * `Response` — socket and all — is handed back rather than reconstructed,
 * which is the whole reason this is not an RPC.
 */
function routeWebSocketThroughPeer(stub, workerKey, capability, request) {
    const headers = new Headers(request.headers);
    headers.set(HOSTED_WEBSOCKET_KEY_HEADER, workerKey);
    headers.set(HOSTED_WEBSOCKET_CAPABILITY_HEADER, capability);
    return stub.fetch(new Request(request.url, { method: request.method, headers }));
}
/**
 * Headers as pairs, with every `Set-Cookie` kept separate.
 *
 * Iterating a `Headers` combines same-named fields into one comma-joined
 * value, and for `Set-Cookie` that is not reversible — `append` cannot split
 * `a=1; Path=/, b=2; Path=/` back into two cookies, and a browser reading the
 * merged form sets one malformed cookie instead of two. Every other field
 * combines by comma legally, so only this one needs the separate accessor.
 * A user's server setting two cookies must not depend on which substrate its
 * process happened to run on.
 */
export function headerPairs(headers) {
    const pairs = [];
    headers.forEach((value, key) => {
        if (key.toLowerCase() !== 'set-cookie')
            pairs.push([key, value]);
    });
    const getSetCookie = headers.getSetCookie;
    const cookies = typeof getSetCookie === 'function'
        ? getSetCookie.call(headers)
        : (headers.get('set-cookie') ? [headers.get('set-cookie')] : []);
    for (const cookie of cookies)
        pairs.push(['set-cookie', cookie]);
    return pairs;
}
