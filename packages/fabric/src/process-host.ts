/**
 * process-host.ts — the two substrates a resident process can run on, and the
 * one value that picks between them.
 *
 * `process-fabric.ts` owns what a resident process IS. This module
 * owns only where it lives, behind `ProcessHost`:
 *
 *   facet — the process is a named child actor of the user's own session DO.
 *   peer  — the process is a named child actor of a SIBLING session DO, and
 *           the coordinator reaches it over one held-open RPC.
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

import { disposeRpcResource } from '@nimbus-sh/platform/rpc-dispose.js';
import { isTransientDoReset } from '@nimbus-sh/platform/oom-classify.js';
import { PEER_RETRY_BACKOFF_MS, PEER_TRANSIENT_RESET_RETRIES } from './fanout.js';
import {
  type HostedProcess,
  type OneShotParams,
  type ProcessHost,
  type ProcessHostParams,
  type ProcessImageDelivery,
  type ResidentBootSpec,
  type ResidentDiskReader,
  type ResidentSupervisorProps,
} from './process-fabric.js';
import { DYNAMIC_WORKER_CODE_LIMIT_BYTES } from './budgets.js';
import {
  processes,
  residentFacetName,
  type ResidentFacetEnv,
} from './workerd-facet-host.js';
import { BindingError } from './vendor/errors.js';

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
  disk: () => ResidentDiskReader,
): ProcessHost {
  return mode === 'peer'
    ? new PeerProcessHost(ctx, env)
    : new FacetProcessHost(ctx, env, disk);
}

// ── facet: the process is a child of the user's own session DO ──────────────

class FacetProcessHost implements ProcessHost {
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
    private readonly disk: () => ResidentDiskReader,
  ) {
    this.env = (env ?? {}) as ResidentFacetEnv;
    this.coordDoId = ctx.id.toString();
  }

  runOnce<T>(params: OneShotParams, consume: (response: Response) => Promise<T>): Promise<T> {
    return processes(this.ctx, this.env).run(
      { doId: this.coordDoId, pid: params.pid, writerId: params.writerId },
      params,
      consume,
    );
  }

  async open(params: ProcessHostParams): Promise<HostedProcess> {
    const supervisor: ResidentSupervisorProps = {
      doId: this.coordDoId,
      pid: params.pid,
      writerId: params.writerId,
    };
    const { slot, ...facet } = processes(this.ctx, this.env).spawn(this.disk, supervisor, params);
    return {
      ...facet,
      describe: () =>
        `facet '${residentFacetName(slot)}' (pid ${params.pid})`
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
const PEER_PLACEMENT_MAX_ATTEMPTS = 4;

/**
 * This workerd process's identity. Module scope, so two Durable Objects
 * reporting the same token are in the same process — which is exactly the CPU
 * sharing a peer exists to avoid, and the only way to detect it.
 */
let _isolateToken: string | null = null;
export function isolateToken(): string {
  if (!_isolateToken) _isolateToken = crypto.randomUUID();
  return _isolateToken;
}

/** Options the coordinator hands a hosting peer. */
export interface HostProcessOpts {
  coordinatorDoId: string;
  pid: number;
  writerId: string;
  workerKey: string;
  /** Unforgeable capability for the fetch-semantic WebSocket hop. */
  webSocketCapability: string;
  startArgs?: unknown;
}

/**
 * Inbound HTTP for a peer-hosted process travels as PARTS, not as a
 * Request/Response pair: workerd refuses to transfer an object owned by a
 * dynamically-loaded worker across a sibling-DO hop. Bodies are plain
 * ReadableStreams, which RPC carries with flow control, so nothing is buffered
 * and a live SSE body still streams.
 */
export interface HostedHttpRequest {
  method: string;
  url: string;
  headers: [string, string][];
  body: ReadableStream | null;
}

export interface HostedHttpResponse {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: ReadableStream | null;
}

/**
 * Every method a hosting sibling must answer. Checked as a set at first
 * contact: a stub that has the probe but not the router is a deployment skew,
 * and finding that out mid-process is finding it out too late.
 */
const PROCESS_PEER_METHODS = [
  '_rpcProcessHostProbe',
  '_rpcHostProcess',
  '_rpcAwaitHostedOpen',
  '_rpcAwaitHostedBoot',
  '_rpcRouteHostedHttp',
  '_rpcCancelHostProcess',
] as const;

/** The host-process surface a sibling session DO exposes. */
interface ProcessPeerStub {
  _rpcProcessHostProbe(): Promise<{ isolateToken: string }>;
  _rpcHostProcess(boot: ResidentBootSpec, opts: HostProcessOpts): Promise<{ ok: boolean }>;
  _rpcAwaitHostedOpen(workerKey: string): Promise<{ ok: boolean }>;
  _rpcAwaitHostedBoot(workerKey: string): Promise<{ payload: unknown }>;
  _rpcRouteHostedHttp(workerKey: string, request: HostedHttpRequest): Promise<HostedHttpResponse>;
  _rpcCancelHostProcess(workerKey: string): Promise<{ cancelled: boolean }>;
  fetch(request: Request): Promise<Response>;
}

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

interface PeerNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): unknown;
}

function peerNamespace(env: unknown): PeerNamespace {
  const ns = (typeof env === 'object' || typeof env === 'function') && env !== null
    ? Reflect.get(env, 'NIMBUS_SESSION')
    : undefined;
  if ((typeof ns !== 'object' && typeof ns !== 'function') || ns === null
    || typeof Reflect.get(ns, 'idFromName') !== 'function'
    || typeof Reflect.get(ns, 'get') !== 'function') {
    throw new BindingError(
      'ProcessFabric: env.NIMBUS_SESSION binding missing or invalid. '
        + "NIMBUS_PROCESS_HOST='peer' hosts every resident process on a sibling "
        + 'Durable Object; add the binding via durable_objects.bindings in wrangler.jsonc.',
    );
  }
  return ns as unknown as PeerNamespace;
}

function processPeerStub(value: unknown, peerName: string): ProcessPeerStub {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    throw new BindingError(`ProcessFabric: NIMBUS_SESSION.get() returned no stub for peer '${peerName}'.`);
  }
  for (const method of PROCESS_PEER_METHODS) {
    if (typeof Reflect.get(value, method) !== 'function') {
      throw new BindingError(
        `ProcessFabric: peer '${peerName}' does not expose ${method}(). `
          + 'A sibling that answers some of the host-process surface and not the rest '
          + 'would fail somewhere inside a running process instead of here.',
      );
    }
  }
  return value as unknown as ProcessPeerStub;
}

interface PeerPlacement {
  stub: ProcessPeerStub;
  peerName: string;
  isolateToken: string;
}

class PeerProcessHost implements ProcessHost {
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

  private readonly ns: PeerNamespace;
  private readonly env: ResidentFacetEnv;
  private readonly coordDoId: string;
  /** pid → the isolate token of the peer currently hosting that process. */
  private readonly tokensInUse = new Map<number, string>();

  constructor(private readonly ctx: DurableObjectState, env: unknown) {
    this.ns = peerNamespace(env);
    this.env = (env ?? {}) as ResidentFacetEnv;
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
  runOnce<T>(params: OneShotParams, consume: (response: Response) => Promise<T>): Promise<T> {
    return processes(this.ctx, this.env).run(
      { doId: this.coordDoId, pid: params.pid, writerId: params.writerId },
      params,
      consume,
    );
  }

  async open(params: ProcessHostParams): Promise<HostedProcess> {
    const placement = await this._place(params.pid);
    this.tokensInUse.set(params.pid, placement.isolateToken);
    // Minted per open, held only by this coordinator and the peer that hosts
    // the process. The workerKey is derivable from a pid; this is not.
    const webSocketCapability = crypto.randomUUID();

    // Held open for the process's whole life: it is the lifecycle, and it is
    // also what keeps the hosting DO resident. It settles when a `lifetime`
    // runner exits or when a `boot` runner's host is cancelled, and rejects if
    // the peer dies under either.
    const hostLeg = placement.stub._rpcHostProcess(params.boot, {
      coordinatorDoId: this.coordDoId,
      pid: params.pid,
      writerId: params.writerId,
      workerKey: params.workerKey,
      webSocketCapability,
      startArgs: params.startArgs,
    });
    hostLeg.catch(() => {});
    // The peer starts the runner as part of hosting it; this reads back that
    // one boot payload without re-running anything, so `started` means exactly
    // what it means on a facet. Racing the host leg is what turns a peer that
    // died before the boot landed into a rejection rather than a hang — the
    // peer that would have answered is the thing that is gone.
    const booted = placement.stub._rpcAwaitHostedBoot(params.workerKey).then((r) => r.payload);
    booted.catch(() => {});
    const started = Promise.race([booted, hostLeg.then(() => booted)]);
    started.catch(() => {});
    // Do not return a handle for a process that was never opened. Opening a
    // facet of one's own DO either throws or does not, before any handle
    // exists; this is that same moment, one hop away.
    try {
      await Promise.race([
        placement.stub._rpcAwaitHostedOpen(params.workerKey),
        hostLeg.then(() => ({ ok: true })),
      ]);
    } catch (error) {
      this.tokensInUse.delete(params.pid);
      // Awaited, not fired off: a spawn that rejects must mean nothing was
      // left running, which is what a throw from `processes().spawn` means on
      // the other substrate.
      try { await this._cancel(params.workerKey, placement.peerName); }
      finally { disposeRpcResource(placement.stub); }
      throw error;
    }

    let released = false;
    return {
      started,
      // The held leg IS the process's residency here. It settles cleanly when
      // the coordinator releases; anything else is the host going away under a
      // process that was up, and the fabric ends the process on it.
      lost: hostLeg.then(() => new Promise<never>(() => {})),
      handleHttpRequest: (request: Request) =>
        routeThroughPeer(placement.stub, params.workerKey, request),
      handleWebSocketRequest: (request: Request) =>
        routeWebSocketThroughPeer(placement.stub, params.workerKey, webSocketCapability, request),
      release: async () => {
        if (released) return;
        released = true;
        this.tokensInUse.delete(params.pid);
        try {
          await this._cancel(params.workerKey, placement.peerName);
        } finally {
          disposeRpcResource(placement.stub);
        }
      },
      describe: () =>
        `peer '${placement.peerName}' (isolate ${placement.isolateToken.slice(0, 8)})`
        + `; ${describeImageDelivery(this.imageDelivery)}`,
    };
  }

  /**
   * Probe successive sibling names until one reports an isolate token distinct
   * from this coordinator's and from every peer already hosting a process. A
   * peer that co-located bought nothing — it shares the CPU it was chosen to
   * escape — so placement verifies rather than assumes.
   */
  private async _place(pid: number): Promise<PeerPlacement> {
    const denied = new Set<string>([isolateToken(), ...this.tokensInUse.values()]);
    for (let attempt = 0; attempt < PEER_PLACEMENT_MAX_ATTEMPTS - 1; attempt++) {
      const candidate = await this._probePlacement(pid, attempt);
      if (!denied.has(candidate.isolateToken)) return candidate;
      disposeRpcResource(candidate.stub);
    }
    // Every attempt co-located, which happens in single-process topologies. Use
    // the last one anyway: it runs the process correctly, it just shares the
    // CPU it was chosen to escape, and the placement line names the isolate it
    // landed in so that is visible rather than assumed.
    return this._probePlacement(pid, PEER_PLACEMENT_MAX_ATTEMPTS - 1);
  }

  /** One sibling name, resolved and probed. Leaks nothing on failure. */
  private async _probePlacement(pid: number, attempt: number): Promise<PeerPlacement> {
    const peerName = `${this.coordDoId}:proc:${pid}:${attempt}`;
    let resource: unknown;
    try {
      resource = this.ns.get(this.ns.idFromName(peerName));
      const stub = processPeerStub(resource, peerName);
      const probe = await this._probe(stub, peerName);
      return { stub, peerName, isolateToken: probe.isolateToken };
    } catch (error) {
      disposeRpcResource(resource);
      throw error;
    }
  }

  /**
   * First contact with a possibly-cold sibling DO: retry transient platform
   * resets with the same bounded policy the fanout peers ship. Non-transient
   * failures propagate on the first hit.
   */
  private async _probe(stub: ProcessPeerStub, peerName: string): Promise<{ isolateToken: string }> {
    for (let attempt = 0; ; attempt++) {
      try {
        const probe = await stub._rpcProcessHostProbe();
        if (!probe || typeof probe.isolateToken !== 'string' || probe.isolateToken.length === 0) {
          throw new Error(`ProcessFabric: peer '${peerName}' returned no isolate token`);
        }
        return probe;
      } catch (err) {
        if (attempt < PEER_TRANSIENT_RESET_RETRIES && isTransientDoReset(err)) {
          await new Promise((r) => setTimeout(
            r, PEER_RETRY_BACKOFF_MS[Math.min(attempt, PEER_RETRY_BACKOFF_MS.length - 1)],
          ));
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
  private _cancel(workerKey: string, peerName: string): Promise<void> {
    let stub: ProcessPeerStub;
    try {
      stub = processPeerStub(this.ns.get(this.ns.idFromName(peerName)), peerName);
    } catch {
      return Promise.resolve();
    }
    const cancelled = Promise.resolve(stub._rpcCancelHostProcess(workerKey))
      .then(() => undefined)
      .catch(() => { /* peer already gone — the held leg is severed either way */ })
      .finally(() => disposeRpcResource(stub));
    this.ctx.waitUntil(cancelled);
    return cancelled;
  }
}

async function routeThroughPeer(
  stub: ProcessPeerStub,
  workerKey: string,
  request: Request,
): Promise<Response> {
  const result = await stub._rpcRouteHostedHttp(workerKey, {
    method: request.method,
    url: request.url,
    headers: headerPairs(request.headers),
    body: request.method === 'GET' || request.method === 'HEAD' ? null : request.body,
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
function routeWebSocketThroughPeer(
  stub: ProcessPeerStub,
  workerKey: string,
  capability: string,
  request: Request,
): Promise<Response> {
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
export function headerPairs(headers: Headers): [string, string][] {
  const pairs: [string, string][] = [];
  headers.forEach((value, key) => {
    if (key.toLowerCase() !== 'set-cookie') pairs.push([key, value]);
  });
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const cookies = typeof getSetCookie === 'function'
    ? getSetCookie.call(headers)
    : (headers.get('set-cookie') ? [headers.get('set-cookie') as string] : []);
  for (const cookie of cookies) pairs.push(['set-cookie', cookie]);
  return pairs;
}
