/**
 * process-host.ts — the two substrates a resident process can run on, and the
 * one value that picks between them.
 *
 * `process-fabric.ts` owns what a resident process IS. This module
 * owns only where it lives, behind `ProcessHost`:
 *
 *   facet — the process is a named child actor of the user's own session DO.
 *   peer  — the process is a named child actor of a SIBLING session DO, and
 *           the coordinator reaches it over bounded RPC and native fetch, which
 *           `PeerProcessHost` here calls and `PeerHost` (peer-host.ts)
 *           serves.
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
 *   liveness — work owns a shared abortable observation. Idle has no watch;
 *              the next use validates incarnation before admission. The
 *              coordinator records peer ownership before starting it and
 *              reconciles that ownership on cold start and explicit close.
 *              Neither substrate arms a polling alarm.
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

import { networkRef, type WorkspaceNetwork } from '@nimbus-sh/core/_shared/workspace-network.js';
import { ProcessNotAdmitted, type ResponseScope } from '@nimbus-sh/core/runtime/os-contracts.js';
import { disposeRpcResource } from '@nimbus-sh/platform/rpc-dispose.js';
import { hostActivity, HOST_INCARNATION_HEADER, leafReceived, SentRequests, type HostRequest } from './host-activity.js';
import { onColdStart } from './generation.js';
import { peerRetryDelay } from './fanout.js';
import { hostNamespaceBinding, hostOpDispatch, type HostNamespaceBinding } from './host-dispatch.js';
import { z } from 'zod/v4';
import { isHostReset } from '@nimbus-sh/platform/oom-classify.js';
import {
  ProcessHostLost,
  type HostedProcess,
  type OneShotParams,
  type ProcessHost,
  type ProcessHostParams,
  type ProcessImageDelivery,
  type ResidentBootSpec,
  type ResidentDiskReader,
  type ResidentSupervisorProps,
  type RunnerCallParams,
  type Supervise,
} from './process-fabric.js';
import {
  HOSTED_WEBSOCKET_CAPABILITY_HEADER,
  HOSTED_WEBSOCKET_KEY_HEADER,
  HOSTED_WATCH_HEADER,
  HOSTED_RESIDENCY_HEADER,
  HOSTED_FAILURE_HEADER,
  HOSTED_NOT_ADMITTED_HEADER,
  headerPairs,
  isolateToken,
  type HostedHttpRequest,
  type HostedHttpResponse,
  type HostProcessOpts,
} from './peer-host.js';
import { DYNAMIC_WORKER_CODE_LIMIT_BYTES } from './budgets.js';
import { BindingError } from './vendor/errors.js';
import {
  processes,
  type ResidentFacetEnv,
} from './workerd-facet-host.js';
import { bindingSupervisor, supervisorBindingProps } from './supervisor-props.js';

/** The substrates this deployment can be configured for. */
export type ProcessHostMode = 'facet' | 'peer';

/**
 * The substrate for this deployment, resolved once. The mode arrives already
 * decided — the embedder owns the config var that picks it, and refuses an
 * unrecognized value there rather than defaulting, because a typo that
 * silently kept the old substrate would make an operator's comparison a lie.
 * `disk` is the coordinator's own filesystem reader; the peer host does not
 * take it, because a peer reads the same disk through the supervisor instead.
 */
export function createProcessHost(
  mode: ProcessHostMode,
  ctx: DurableObjectState,
  env: unknown,
  disk: (pid: number) => ResidentDiskReader,
  /** The workspace's network: every process's binding carries it, and with it its egress. */
  network: () => WorkspaceNetwork,
  supervise: Supervise = bindingSupervisor,
): ProcessHost {
  return mode === 'peer'
    ? new PeerProcessHost(ctx, env, network, supervise)
    : new FacetProcessHost(ctx, env, disk, network, supervise);
}

// ── facet: the process is a child of the user's own session DO ──────────────

class FacetProcessHost implements ProcessHost {
  assertDurableStorage(): void {}
  /**
   * The process shares its session's Durable Object, so the session's own
   * store is reachable by copy-on-write — and its storage budget is the same
   * budget. Both halves of that follow from the one fact, and neither is
   * optional.
   */
  readonly imageDelivery: ProcessImageDelivery = {
    reflink: 'same-object',
    moduleCeilingBytes: DYNAMIC_WORKER_CODE_LIMIT_BYTES,
    storageSharedWithSession: true,
  };

  private readonly env: ResidentFacetEnv;
  private readonly coordDoId: string;

  constructor(
    private readonly ctx: DurableObjectState,
    env: unknown,
    private readonly disk: (pid: number) => ResidentDiskReader,
    private readonly network: () => WorkspaceNetwork,
    private readonly supervise: Supervise,
  ) {
    this.env = (env ?? {}) as ResidentFacetEnv;
    this.coordDoId = ctx.id.toString();
  }

  runOnce<T>(params: OneShotParams, consume: (response: Response) => Promise<T>): Promise<T> {
    const supervisor = supervisorBindingProps(this.ctx, params.pid, { writerId: params.writerId, network: this.network() });
    return processes(this.ctx, this.env).run(supervisor, this.supervise, params, consume);
  }

  callRunner<I extends object, T>(params: RunnerCallParams<I>, consume: (answer: object) => T): Promise<T> {
    return processes(this.ctx, this.env).callRunner(() => supervisorBindingProps(this.ctx, params.pid, { writerId: params.writerId, network: this.network() }), params, consume);
  }

  async open(params: ProcessHostParams): Promise<HostedProcess> {
    const supervisor: ResidentSupervisorProps = supervisorBindingProps(this.ctx, params.pid, { writerId: params.writerId, network: this.network() });
    const { name, ...facet } = processes(this.ctx, this.env).spawn(this.disk, supervisor, params);
    // The platform can kill or reset the process's own facet (its memory or
    // CPU limit, measured with astro dev on 2026-10-08) with the session left
    // standing; the next call to the facet is what shows it. Its boot is left
    // as the facet answers it: a run's own start and stop (a boot waiting on
    // stdin is replayed) are not the host's to judge.
    const loss = new HostLoss(params.pid, facet.lost);
    const starting = hostActivity(this.ctx).acquire();
    return {
      ...facet,
      started: facet.started.finally(() => starting.release()),
      lost: loss.signal,
      handleHttpRequest: (request: Request, scope: ResponseScope) => loss.request((sending) => facet.handleHttpRequest(request, scope, { sending })),
      handleWebSocketRequest: (request: Request) => loss.request((sending) => facet.handleWebSocketRequest(request, sending)),
      release: () => {
        loss.release();
        return facet.release();
      },
      describe: () =>
        `facet '${name}' (pid ${params.pid})`
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
function describeImageDelivery(delivery: ProcessImageDelivery): string {
  return `fs image: reflink ${delivery.reflink}, module map ≤ ${delivery.moduleCeilingBytes}B, `
    + `storage ${delivery.storageSharedWithSession ? 'shared with the session' : 'its own'}`;
}

// ── peer: the process is a child of a sibling session DO ────────────────────

/**
 * How many sibling names to try before accepting one that co-located with a
 * process already running. Measured: 1 shared pair in 24 fresh peers.
 */
export const PEER_PLACEMENT_MAX_ATTEMPTS = 4;
const PEER_OWNERS_KEY_PREFIX = 'process-peer:';
export interface PeerOwner { pid: number; workerKey: string; peerName: string }

/** The committed placement, without contacting or waking its hosting actor. */
export async function peerPlacement(ctx: Pick<DurableObjectState, 'storage'>, pid: number): Promise<PeerOwner | null> {
  const rows = await ctx.storage.list<PeerOwner>({ prefix: PEER_OWNERS_KEY_PREFIX });
  return [...rows.values()].find((row) => row.pid === pid) ?? null;
}

/** The host-process surface a sibling session DO exposes. */
interface ProcessPeerStub {
  _rpcProcessHostProbe(): Promise<{ isolateToken: string }>;
  _rpcHostProcess(boot: ResidentBootSpec, opts: HostProcessOpts): Promise<{ ok: boolean; incarnation: string }>;
  /** The boot's payload, or the error its leaf's boot rejected with (`refused`): the leaf's answer either way. */
  _rpcAwaitHostedBoot(workerKey: string): Promise<{ payload: unknown } | { refused: unknown }>;
  _rpcRouteHostedHttp(workerKey: string, request: HostedHttpRequest): Promise<HostedHttpResponse>;
  _rpcAbandonHostedHttp(workerKey: string, capability: string, id: number): Promise<void>;
  _rpcCancelHostProcess(workerKey: string): Promise<{ cancelled: boolean }>;
  fetch(request: Request): Promise<Response>;
}

/**
 * Peer stubs forward one supervisorOp entrypoint: every method the host-
 * process surface needs is an envelope op, not a private _rpc* method.
 */
function peerNamespace(env: object): HostNamespaceBinding {
  try {
    return hostNamespaceBinding(env, 'ProcessFabric');
  } catch (e) {
    if (e instanceof BindingError) {
      throw new BindingError(
        e.message
          + " NIMBUS_PROCESS_HOST='peer' hosts every resident process on a sibling "
          + "Durable Object; name the host's own binding with composeFabric({ hostNamespace }).",
      );
    }
    throw e;
  }
}

const PeerProbeResult = z.object({ isolateToken: z.string() });
const PeerOpenResult = z.object({ ok: z.boolean(), incarnation: z.string() });
const PeerBootResult = z.object({ payload: z.unknown(), refused: z.unknown() }).partial();
const PeerCancelResult = z.object({ cancelled: z.boolean() });
const PeerHttpResult = z.object({
  status: z.number().int(),
  statusText: z.string(),
  headers: z.array(z.tuple([z.string(), z.string()])),
  body: z.instanceof(ReadableStream).nullable(),
});
/** A peer's failure: its host lost, and whether the peer refused the request unsent (`notAdmitted`, the pid it names). */
const PeerFailure = z.object({ hostLost: z.string(), notAdmitted: z.number().int().optional() });
function peerAnswer<T>(schema: z.ZodType<T>, value: unknown): T {
  try { return parsePeerAnswer(schema, value); }
  finally { disposeRpcResource(value); }
}

function parsePeerAnswer<T>(schema: z.ZodType<T>, value: unknown): T {
  const failure = PeerFailure.safeParse(value);
  if (failure.success) {
    throw failure.data.notAdmitted === undefined ? new ProcessHostLost(failure.data.hostLost) : new ProcessNotAdmitted(failure.data.notAdmitted, failure.data.hostLost);
  }
  return schema.parse(value);
}

function processPeerStub(value: object, peerName: string): ProcessPeerStub {
  const dispatch = hostOpDispatch(value, `ProcessFabric peer '${peerName}'`);
  const fetchFn = (typeof value === 'object' || typeof value === 'function') && value !== null
    ? Reflect.get(value, 'fetch')
    : undefined;
  if (typeof fetchFn !== 'function') {
    throw new BindingError(
      `ProcessFabric: peer '${peerName}' exposes no fetch() — the hosted-websocket `
        + 'upgrade leg still travels as a service-binding fetch.',
    );
  }
  const adapter: ProcessPeerStub = {
    _rpcProcessHostProbe: async () => peerAnswer(PeerProbeResult, await dispatch({ op: 'processHostProbe', args: [] })),
    _rpcHostProcess: async (boot, opts) => peerAnswer(PeerOpenResult, await dispatch({ op: 'hostProcess', args: [boot, opts] })),
    _rpcAwaitHostedBoot: async (key) => {
      const result = peerAnswer(PeerBootResult, await dispatch({ op: 'awaitHostedBoot', args: [key] }));
      // A refusal is the error its leaf's boot rejected with, never undefined.
      return result.refused !== undefined ? { refused: result.refused } : { payload: result.payload };
    },
    _rpcRouteHostedHttp: async (key, request) => parsePeerAnswer(PeerHttpResult, await dispatch({ op: 'routeHostedHttp', args: [key, request] })),
    _rpcAbandonHostedHttp: async (key, capability, id) => { await dispatch({ op: 'abandonHostedHttp', args: [key, capability, id] }); },
    _rpcCancelHostProcess: async (key) => peerAnswer(PeerCancelResult, await dispatch({ op: 'cancelHostProcess', args: [key] })),
    fetch: async (request) => {
      const response = await Reflect.apply(fetchFn, value, [request]);
      if (!(response instanceof Response)) throw new BindingError(`ProcessFabric: peer '${peerName}' returned no Response`);
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

interface PeerPlacement {
  peerName: string;
  isolateToken: string;
}

/** One process's stub to its peer while its host observation is open, or none while it is idle. */
interface PeerLink {
  stub?: ProcessPeerStub;
}

interface PeerResidency {
  abort: AbortController;
  socket: WebSocket | null;
}

class PeerProcessHost implements ProcessHost {
  assertDurableStorage(): never {
    throw new Error('Nimbus: a durable spawn must be facet-hosted on its own coordinator; NIMBUS_PROCESS_HOST=peer cannot own retained application storage');
  }
  /**
   * A peer buys independent CPU and its own storage budget, and pays for both
   * with the image path: nothing crosses a Durable Object boundary by
   * reference, so the whole session filesystem has to travel as bytes.
   */
  readonly imageDelivery: ProcessImageDelivery = {
    reflink: 'impossible',
    moduleCeilingBytes: DYNAMIC_WORKER_CODE_LIMIT_BYTES,
    storageSharedWithSession: false,
  };

  private readonly ns: HostNamespaceBinding;
  private readonly env: ResidentFacetEnv;
  private readonly coordDoId: string;
  /** pid → the isolate token of the peer currently hosting that process. */
  private readonly tokensInUse = new Map<number, string>();
  private readonly residencies = new Map<string, PeerResidency>();
  private reconciliation: Promise<void> | undefined;
  private closed = false;

  constructor(
    private readonly ctx: DurableObjectState,
    env: unknown,
    private readonly network: () => WorkspaceNetwork,
    private readonly supervise: Supervise,
  ) {
    if (env === null || (typeof env !== 'object' && typeof env !== 'function')) {
      throw new BindingError('ProcessFabric: a peer host requires environment bindings');
    }
    this.ns = peerNamespace(env);
    this.env = (env ?? {}) as ResidentFacetEnv;
    this.coordDoId = ctx.id.toString();
    onColdStart(ctx, () => this.closed ? Promise.resolve() : this.reconcile());
  }

  /**
   * Not placed on a sibling, and that is not a gap in this substrate.
   * `peer` exists to buy a resident process independent CPU; a program that
   * ends with the call it was started by has no residency to place, and its
   * map is fully inline — so a hop would meet the RPC ceiling that by-path
   * boot specs exist to avoid while buying nothing. It runs as a dynamic
   * worker of the coordinator here exactly as it does on `facet`.
   */
  runOnce<T>(params: OneShotParams, consume: (response: Response) => Promise<T>): Promise<T> {
    const supervisor = supervisorBindingProps(this.ctx, params.pid, { writerId: params.writerId, network: this.network() });
    return this.reconcile().then(() => {
      if (this.closed) throw new Error('Nimbus: the process host is closed');
      return processes(this.ctx, this.env).run(supervisor, this.supervise, params, consume);
    });
  }

  /** In the coordinator, as runOnce: a runner has no residency to place. */
  callRunner<I extends object, T>(params: RunnerCallParams<I>, consume: (answer: object) => T): Promise<T> {
    return this.reconcile().then(() => {
      if (this.closed) throw new Error('Nimbus: the process host is closed');
      return processes(this.ctx, this.env).callRunner(() => supervisorBindingProps(this.ctx, params.pid, { writerId: params.writerId, network: this.network() }), params, consume);
    });
  }

  async open(params: ProcessHostParams): Promise<HostedProcess> {
    if (this.closed) throw new Error('Nimbus: the process host is closed');
    if (params.facet) {
      // A durable application's facet must be a child of the COORDINATOR's
      // Durable Object — its `app-slot-<n>` row and retained SQLite live in
      // that DO's storage. A sibling host would own storage the coordinator's
      // durable-slot book and removeDurableApp cannot reach.
      this.assertDurableStorage();
    }
    await this.reconcile();
    const supervisor = supervisorBindingProps(this.ctx, params.pid, { writerId: params.writerId, network: this.network() });
    // Reserves its isolate for this pid: from here every way out frees it.
    const placement = await this._place(params.pid);
    // Minted per open, held only by this coordinator and the peer that hosts
    // the process. The workerKey is derivable from a pid; this is not.
    const webSocketCapability = crypto.randomUUID();

    const loss = new HostLoss(params.pid);
    let stopObserving = () => {};
    const residency: PeerResidency = { abort: new AbortController(), socket: null };
    this.residencies.set(params.workerKey, residency);
    try {
      if (this.closed) throw new Error('Nimbus: the process host is closed');
      await this.ctx.storage.put(PEER_OWNERS_KEY_PREFIX + params.workerKey, { pid: params.pid, workerKey: params.workerKey, peerName: placement.peerName } satisfies PeerOwner);
      if (this.closed) throw new Error('Nimbus: the process host is closed');
      const opened = await this.withPeer(placement.peerName, (stub) => stub._rpcHostProcess(params.boot, {
        coordinatorDoId: supervisor.doId,
        route: supervisor.route,
        pid: supervisor.pid,
        writerId: params.writerId,
        hostIncarnation: supervisor.hostIncarnation,
        // The process's egress crosses to the peer, which mints the process's binding with it.
        network: networkRef(this.network().forProcess(params.pid)),
        workerKey: params.workerKey,
        webSocketCapability,
        startArgs: params.startArgs,
      }));
      if (this.closed) throw new Error('Nimbus: the process host is closed');
      const response = await this.withPeer(placement.peerName, (stub) => stub.fetch(new Request('https://nimbus-process.invalid/', {
        signal: residency.abort.signal,
        headers: { Upgrade: 'websocket', [HOSTED_RESIDENCY_HEADER]: params.workerKey, [HOSTED_WEBSOCKET_CAPABILITY_HEADER]: webSocketCapability },
      })).then((response) => peerFetchAnswer(response, webSocketCapability)));
      residency.abort.signal.throwIfAborted();
      if (response.status !== 101 || !response.webSocket || response.headers.get(HOST_INCARNATION_HEADER) !== opened.incarnation) {
        throw new Error('Nimbus: the hosting peer did not establish coordinator residency');
      }
      // Accepting this endpoint starts a receive loop that pins the coordinator.
      // Its process-owned fetch signal, not a close handshake, releases residency.
      residency.socket = response.webSocket;
      if (this.closed) throw new Error('Nimbus: the process host is closed');
      // The stub an open observation holds: data calls made while it is open share it.
      const link: PeerLink = {};
      const observation = hostActivity(this.ctx).observe(
        (signal) => this.watchPeer(placement.peerName, params.workerKey, webSocketCapability, signal, link),
        (error) => loss.lose(error), opened.incarnation,
      );
      stopObserving = observation.close;
      const starting = hostActivity(this.ctx).acquire();
      // The boot is its leaf's to answer, as a facet's is: a refusal (a run's
      // stop) crosses as itself. Only a failed leg to the peer is the host's.
      const started = loss.route(() => this.withPeer(placement.peerName, (stub) => stub._rpcAwaitHostedBoot(params.workerKey)))
        .then((boot) => { if ('refused' in boot) throw boot.refused; return boot.payload; })
        .finally(() => starting.release());
      started.catch(() => {});
      let released = false;
      const sent = new SentRequests();
      const peered = <T>(call: (stub: ProcessPeerStub) => Promise<T>) => link.stub ? call(link.stub) : this.withPeer(placement.peerName, call);
      const abandon = (id: number) => peered((stub) => stub._rpcAbandonHostedHttp(params.workerKey, webSocketCapability, id));
      return {
        started,
        lost: loss.signal,
        // Sent to the peer at once: a loss its coordinator sees first fails the
        // request by the loss's name, though the peer may have refused it
        // unsent. Only the peer's own answer says that (ProcessNotAdmitted,
        // typed across its reply), when it comes first, and only for a request
        // whose body did not go to the peer with it: one that did cannot be
        // sent again, so its refusal is the loss.
        handleHttpRequest: (request: Request, scope: ResponseScope) => loss.request(async (sendingToPeer) => {
          const lease = observation.acquire();
          sendingToPeer();
          const sending = sent.send();
          scope.settled((delivered) => {
            lease.release();
            sent.settled(sending.id, delivered, abandon);
          });
          try {
            const response = await peered((stub) => routeThroughPeer(stub, params.workerKey, webSocketCapability, request, sending));
            if (sending.abandoned) sent.received(sending);
            return response;
          } catch (error) {
            if (!leafReceived(error)) sent.unsent(sending);
            else if (sending.abandoned) sent.received(sending);
            lease.release();
            throw error instanceof ProcessNotAdmitted && request.body !== null ? new ProcessHostLost(error.cause) : error;
          }
        }),
        // An upgrade hands its socket to the caller at the handshake.
        handleWebSocketRequest: (request: Request) => loss.request(async (sendingToPeer) => {
          const lease = observation.acquire();
          sendingToPeer();
          try { return await this.withPeer(placement.peerName, (stub) => routeWebSocketThroughPeer(stub, params.workerKey, webSocketCapability, request)); }
          finally { lease.release(); }
        }),
        release: async () => {
          if (released) return;
          released = true;
          stopObserving();
          loss.release();
          residency.abort.abort();
          this.residencies.delete(params.workerKey);
          this.tokensInUse.delete(params.pid);
          await this._cancel(params.workerKey, placement.peerName);
          await this.ctx.storage.delete(PEER_OWNERS_KEY_PREFIX + params.workerKey);
        },
        describe: () =>
          `peer '${placement.peerName}' (isolate ${placement.isolateToken.slice(0, 8)})`
          + `; ${describeImageDelivery(this.imageDelivery)}`,
      };
    } catch (error) {
      stopObserving();
      loss.release();
      residency.abort.abort();
      this.residencies.delete(params.workerKey);
      this.tokensInUse.delete(params.pid);
      // Awaited, not fired off: a spawn that rejects must mean nothing was
      // left running, which is what a throw from `processes().spawn` means on
      // the other substrate.
      await this._cancel(params.workerKey, placement.peerName);
      await this.ctx.storage.delete(PEER_OWNERS_KEY_PREFIX + params.workerKey);
      throw error;
    }
  }

  private reconcile(): Promise<void> {
    if (!this.reconciliation) {
      this.reconciliation = this.clearPlacements().catch((error) => { this.reconciliation = undefined; throw error; });
    }
    return this.reconciliation;
  }

  private async clearPlacements(): Promise<void> {
    const rows = await this.ctx.storage.list<PeerOwner>({ prefix: PEER_OWNERS_KEY_PREFIX });
    await Promise.all([...rows].map(async ([key, row]) => {
      await this._cancel(row.workerKey, row.peerName);
      await this.ctx.storage.delete(key);
    }));
  }

  async close(): Promise<void> {
    this.closed = true;
    hostActivity(this.ctx).close();
    for (const residency of this.residencies.values()) residency.abort.abort();
    this.residencies.clear();
    this.tokensInUse.clear();
    await this.clearPlacements();
  }

  /**
   * Probe successive sibling names until one reports an isolate token distinct
   * from this coordinator's and from every peer already hosting a process or
   * being placed. A peer that co-located bought nothing — it shares the CPU it
   * was chosen to escape — so placement verifies rather than assumes. The
   * chosen isolate is reserved for `pid` (tokensInUse) the moment it is
   * accepted, before anything else awaits, so a placement running at the same
   * time sees it; the open's release or failure frees it.
   */
  private async _place(pid: number): Promise<PeerPlacement> {
    const accept = (candidate: PeerPlacement): PeerPlacement => {
      this.tokensInUse.set(pid, candidate.isolateToken);
      return candidate;
    };
    for (let attempt = 0; attempt < PEER_PLACEMENT_MAX_ATTEMPTS - 1; attempt++) {
      const candidate = await this._probePlacement(pid, attempt);
      if (candidate.isolateToken !== isolateToken() && !this.isolateInUse(candidate.isolateToken)) return accept(candidate);
    }
    // Every attempt co-located, which happens in single-process topologies. Use
    // the last one anyway: it runs the process correctly, it just shares the
    // CPU it was chosen to escape, and the placement line names the isolate it
    // landed in so that is visible rather than assumed.
    return accept(await this._probePlacement(pid, PEER_PLACEMENT_MAX_ATTEMPTS - 1));
  }

  private isolateInUse(token: string): boolean {
    for (const inUse of this.tokensInUse.values()) if (inUse === token) return true;
    return false;
  }

  /** One sibling name, resolved and probed. Leaks nothing on failure. */
  private async _probePlacement(pid: number, attempt: number): Promise<PeerPlacement> {
    const peerName = `${this.coordDoId}:proc:${pid}:${attempt}`;
    const probe = await this._probe(peerName);
    return { peerName, isolateToken: probe.isolateToken };
  }

  /**
   * First contact with a possibly-cold sibling DO: retry transient platform
   * resets on the fanout peers' schedule. An overloaded sibling fails the
   * probe at once, as does any other failure: the spawn then fails fast
   * rather than wait the overload schedule out.
   */
  private async _probe(peerName: string): Promise<{ isolateToken: string }> {
    for (let attempt = 0; ; attempt++) {
      try {
        const probe = await this.withPeer(peerName, (stub) => stub._rpcProcessHostProbe());
        if (!probe || typeof probe.isolateToken !== 'string' || probe.isolateToken.length === 0) {
          throw new Error(`ProcessFabric: peer '${peerName}' returned no isolate token`);
        }
        return probe;
      } catch (err) {
        const backoff = peerRetryDelay(err, attempt, { retryOverloaded: false });
        if (backoff !== null) {
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }
        throw err;
      }
    }
  }

  private async withPeer<T>(peerName: string, use: (stub: ProcessPeerStub) => Promise<T>): Promise<T> {
    const stub = this.getPeer(peerName);
    try { return await use(stub); }
    finally { disposeRpcResource(stub); }
  }

  private async watchPeer(peerName: string, workerKey: string, capability: string, signal: AbortSignal, link: PeerLink): Promise<Response> {
    signal.throwIfAborted();
    let stub: ProcessPeerStub | undefined = this.getPeer(peerName);
    link.stub = stub;
    const release = () => {
      if (!stub) return;
      if (link.stub === stub) link.stub = undefined;
      disposeRpcResource(stub);
      stub = undefined;
      signal.removeEventListener('abort', release);
    };
    signal.addEventListener('abort', release, { once: true });
    try {
      return await peerFetchAnswer(await stub.fetch(new Request('https://nimbus-process.invalid/', {
        signal, headers: { Upgrade: 'websocket', [HOSTED_WATCH_HEADER]: workerKey, [HOSTED_WEBSOCKET_CAPABILITY_HEADER]: capability },
      })), capability);
    } catch (error) { release(); throw error; }
  }

  private getPeer(peerName: string): ProcessPeerStub {
    const resource = this.ns.get(this.ns.idFromName(peerName));
    try { return processPeerStub(resource, peerName); }
    catch (error) { disposeRpcResource(resource); throw error; }
  }

  /**
   * A fresh stub to the hosting peer fires `_rpcCancelHostProcess`, which
   * releases the peer's facet — the exact teardown a local facet gets — and
   * only answers once it has. Awaiting it is what makes "released" mean the
   * same thing on both substrates, so the writer identity is retired at the
   * same point in the process's life either way. Also handed to `waitUntil`,
   * so a kill nobody awaited still completes.
   */
  private _cancel(workerKey: string, peerName: string): Promise<void> {
    const cancelled = this.withPeer(peerName, (stub) => stub._rpcCancelHostProcess(workerKey)).then(() => undefined);
    this.ctx.waitUntil(cancelled);
    return cancelled;
  }
}

/**
 * One open process's host loss: the platform reset or killed the actor it
 * runs in (its facet, or a peer), and the process is over. Fired once, by
 * whichever shows it first: an owned host observation failing, or a call to
 * the host failing with a reset's own words
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
  private gone: ProcessHostLost | null = null;
  /** Nimbus released the process itself (a kill, a stop): what fails after that is no loss. */
  private released = false;
  private reject: (lost: ProcessHostLost) => void = () => {};
  readonly signal = new Promise<never>((_, reject) => { this.reject = reject; });
  /** Requests routed and not yet sent: the loss refuses them unsent (`request`). */
  private unsent = 0;

  constructor(private readonly pid: number, held?: Promise<unknown>) {
    this.signal.catch(() => {});
    held?.then(() => undefined, (error: unknown) => { if (!this.released) this.lose(error); });
  }

  /** The host is gone; `refused` when the loss shows as the host refusing a request unsent (ProcessNotAdmitted). */
  lose(error: unknown, refused = false): ProcessHostLost {
    if (this.gone === null) {
      this.gone = new ProcessHostLost(error instanceof ProcessHostLost ? error.cause : error, refused || this.unsent > 0);
      this.reject(this.gone);
    }
    return this.gone;
  }

  /** The host is being released on purpose: the facet or peer ending now is that, not a loss. */
  release(): void {
    this.released = true;
  }

  /** A call to the host, which fails by the loss's name once the host is gone. */
  route<T>(leg: () => Promise<T>): Promise<T> {
    if (this.gone !== null) return Promise.reject(this.gone);
    const call = leg().catch((error: unknown) => {
      if (error instanceof ProcessNotAdmitted) throw this.released ? error : this.lose(error, true);
      throw this.gone ?? (!this.released && (error instanceof ProcessHostLost || isHostReset(error)) ? this.lose(error) : error);
    });
    return Promise.race([call, this.signal]);
  }

  /**
   * A request to the process, which says when it is sent (`sending`). One the
   * loss finds unsent, or that comes after it, was never sent; one its host
   * refused unsent says so itself (a peer's answer). Either is refused as
   * ProcessNotAdmitted, owed a run, and the loss says it refused one. One in
   * flight fails by the loss's name, as `route`'s calls do: it may have run.
   */
  request<T>(leg: (sending: () => void) => Promise<T>): Promise<T> {
    if (this.gone !== null) return Promise.reject(new ProcessNotAdmitted(this.pid, this.gone));
    let sent = false;
    let refused: ProcessNotAdmitted | null = null;
    this.unsent++;
    const sending = () => {
      if (sent) return;
      sent = true;
      this.unsent--;
    };
    const call = this.route(() => leg(sending).catch((error: unknown) => {
      if (error instanceof ProcessNotAdmitted) refused = error;
      throw error;
    }));
    return call.catch((error: unknown) => {
      if (refused !== null) throw refused;
      if (sent || error !== this.gone) throw error;
      throw new ProcessNotAdmitted(this.pid, error);
    }).finally(sending);
  }
}

async function routeThroughPeer(
  stub: ProcessPeerStub,
  workerKey: string,
  capability: string,
  request: Request,
  sending: HostRequest,
): Promise<Response> {
  const result = await stub._rpcRouteHostedHttp(workerKey, {
    capability,
    method: request.method,
    url: request.url,
    headers: headerPairs(request.headers),
    body: request.method === 'GET' || request.method === 'HEAD' ? null : request.body,
    ...sending,
  });
  const responseHeaders = new Headers();
  for (const [key, value] of result.headers) responseHeaders.append(key, value);
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
async function routeWebSocketThroughPeer(
  stub: ProcessPeerStub,
  workerKey: string,
  capability: string,
  request: Request,
): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.set(HOSTED_WEBSOCKET_KEY_HEADER, workerKey);
  headers.set(HOSTED_WEBSOCKET_CAPABILITY_HEADER, capability);
  return peerFetchAnswer(await stub.fetch(new Request(request.url, { method: request.method, headers })), capability);
}

async function peerFetchAnswer(response: Response, capability: string): Promise<Response> {
  if (response.headers.get(HOSTED_FAILURE_HEADER) !== capability) return response;
  const notAdmitted = response.headers.get(HOSTED_NOT_ADMITTED_HEADER);
  throw notAdmitted === null ? new ProcessHostLost(await response.text()) : new ProcessNotAdmitted(Number(notAdmitted), await response.text());
}
