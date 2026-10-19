/**
 * peer-host.ts — the hosting side of the `peer` substrate (process-host.ts),
 * and the wire both sides speak.
 *
 * THIS Durable Object hosts a process for a sibling coordinator: it opens the
 * process as a facet of ITSELF — the same `processes().spawn` call the
 * coordinator makes when it hosts one directly — so the facet lands in this
 * object's workerd process, with its own memory AND its own CPU. The facet's
 * SUPERVISOR binding is minted for the COORDINATOR's doId, so every syscall
 * routes back to the user's session. Nothing here knows what the process is,
 * and nothing here decides anything: a coordinator reaches this side only
 * because its deployment chose `peer`.
 */

import {
  ISOLATE_NETWORK,
  workspaceNetwork,
  type WorkspaceEgress,
} from '@nimbus-sh/core/_shared/workspace-network.js';
import { errorText } from '@nimbus-sh/core/_shared/error-text.js';
import { isWebSocketUpgradeRequest } from '@nimbus-sh/core/_shared/websocket-upgrade.js';
import { z } from 'zod/v4';
import type { HostRoute } from './composition.js';
import { ProcessHostLost, type ResidentBootSpec, type ResidentDiskReader, type ResidentSupervisorProps } from './process-fabric.js';
import { infrastructureSupervisor, infrastructureSupervisorProps, supervisorBindingProps, type InfrastructureSupervisorProps } from './supervisor-props.js';
import { withResolvers } from './turn-budget.js';
import { processes, abortFacet, deleteFacetStorage, facetNameHeld, type ResidentFacet, type ResidentFacetEnv } from './workerd-facet-host.js';
import { HandledRequests, HOST_INCARNATION_HEADER } from './host-activity.js';
import { responseScope } from '@nimbus-sh/core/runtime/port-registry.js';
import { isHostReset } from '@nimbus-sh/platform/oom-classify.js';

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
    egress: z.custom<WorkspaceEgress>((value) => value !== null && (typeof value === 'object' || typeof value === 'function')
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

export type HostProcessOpts = z.infer<typeof HostProcessOptsSchema>;

/**
 * Inbound HTTP for a peer-hosted process travels as PARTS, not as a
 * Request/Response pair: workerd refuses to transfer an object owned by a
 * dynamically-loaded worker across a sibling-DO hop. Bodies are plain
 * ReadableStreams, which RPC carries with flow control, so nothing is buffered
 * and a live SSE body still streams.
 */
export interface HostedHttpRequest {
  capability: string;
  method: string;
  url: string;
  headers: [string, string][];
  body: ReadableStream | null;
  /** Its id, by which its coordinator can abandon it, the watermark below which the peer forgets, and abandons it carries (SentRequests). */
  id: number;
  low: number;
  abandoned?: number[];
}

export interface HostedHttpResponse {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: ReadableStream | null;
}
export type HostedReply<T> = T | { hostLost: string };
export const HOSTED_WATCH_HEADER = 'x-nimbus-hosted-watch';
export const HOSTED_RESIDENCY_HEADER = 'x-nimbus-hosted-residency';
export const HOSTED_FAILURE_HEADER = 'x-nimbus-hosted-failure';
class LostHostedProcess extends Error {}

/**
 * Which hosted process a fetched upgrade is for. An upgrade cannot travel as
 * RPC arguments, so the two values `_rpcRouteHostedHttp` would have taken ride
 * as headers on the peer fetch instead.
 *
 * The key alone is guessable from a pid, so it is not enough on its own; the
 * capability is minted per `open()` and known only to the coordinator that
 * opened the process and the peer that hosts it. PeerHost.routeWebSocket
 * strips both before the request reaches the process.
 */
export const HOSTED_WEBSOCKET_KEY_HEADER = 'x-nimbus-hosted-websocket';
export const HOSTED_WEBSOCKET_CAPABILITY_HEADER = 'x-nimbus-hosted-websocket-capability';

/**
 * Whether a fetch is the upgrade hop (PeerHost.routeWebSocket): a sibling
 * coordinator's request, not a browser's, and so answered before any route of
 * the object's own.
 */
export function isHostedWebSocket(request: Request): boolean {
  return Boolean(request.headers.get(HOSTED_WEBSOCKET_KEY_HEADER));
}
export function isHostedWatch(request: Request): boolean { return request.headers.has(HOSTED_WATCH_HEADER); }
export function isHostedResidency(request: Request): boolean { return request.headers.has(HOSTED_RESIDENCY_HEADER); }

/** The embedder's boot-spec authority. */
export interface PeerHostOptions {
  /**
   * The boot-spec schema with the embedder's own stage
   * (residentBootSpecSchema): the host leg is this peer's trust boundary for
   * what it boots.
   */
  bootSpec: z.ZodType<ResidentBootSpec>;
}

/**
 * One process this peer hosts for a coordinator sibling. Registered
 * synchronously by `host` before any await, so the boot-payload and
 * routed-HTTP legs — which the coordinator may issue concurrently — always
 * find the record and simply await it.
 */
interface HostedProcessRecord {
  facet: Promise<ResidentFacet>;
  started: Promise<unknown>;
  /** Unforgeable capability for the fetch-semantic WebSocket hop. */
  webSocketCapability: string;
  /** Its coordinator's requests, which it abandons by id (SentRequests). */
  handled: HandledRequests;
  closed: boolean;
  failure?: Error;
  watchers: Map<WebSocket, () => void>;
  residencies: Map<WebSocket, () => void>;
  release(): Promise<void>;
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
const CANCELLED_HOSTING_KEY_PREFIX = 'hosting-cancelled:';


/** What a host keeps of a process it holds: whom to tell, and the proof it hosted it. */
interface HostingRecord {
  coordinatorDoId: string;
  route?: HostRoute;
  workerKey: string;
  /** The per-open capability (HostProcessOpts.webSocketCapability): known only to the session and this host. */
  capability: string;
  incarnation: string;
  facet?: string;
}

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
 * it, and the installed runtime images are world-readable too. The reads are
 * this peer's, not the process's run's, so they go through a binding no run
 * acts through: a run whose boot is stopped and replayed (stop/replay) is
 * judged by what it received itself, and it received none of these.
 */
const RESIDENT_READ_RANGE_BYTES = 4 * 1024 * 1024;

interface SupervisorFileReader {
  stat(path: string): Promise<{ size?: number } | null>;
  fsReadRangeUncached(path: string, offset: number, length: number): Promise<Uint8Array | null>;
}

function peerDiskReader(reads: InfrastructureSupervisorProps): ResidentDiskReader {
  const fs = infrastructureSupervisor(reads) as SupervisorFileReader;
  return { readFile: (path) => readSupervisorFile(fs, path) };
}

async function readSupervisorFile(fs: SupervisorFileReader, path: string): Promise<Uint8Array> {
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
  private readonly incarnation = crypto.randomUUID();
  private readonly records = new Map<string, HostedProcessRecord>();
  private readonly waiters = new Map<string, Set<(record: HostedProcessRecord) => void>>();
  private readonly env: ResidentFacetEnv;

  constructor(
    private readonly ctx: DurableObjectState,
    env: unknown,
    private readonly options: PeerHostOptions,
  ) {
    this.env = (env ?? {}) as ResidentFacetEnv;
  }

  /**
   * Placement probe: this peer's module-scope isolate token, so the
   * coordinator can verify the peer landed in a distinct workerd process — the
   * same token means a shared process, which is the CPU sharing a peer exists
   * to escape.
   */
  probe(): { isolateToken: string } {
    return { isolateToken: isolateToken() };
  }

  /** A hosting record's current physical actor, without admitting guest work. */
  async inspect(workerKey: string): Promise<{ found: boolean; incarnation: string; facet: string | null; coordinator: string | null; residencies: number; watchers: number }> {
    const record = this.records.get(workerKey);
    const stored = await this.ctx.storage.get<HostingRecord>(HOSTING_KEY_PREFIX + workerKey);
    const facet = record && !record.closed ? (await record.facet).name : null;
    return { found: facet !== null || stored !== undefined, incarnation: this.incarnation, facet,
      coordinator: stored?.coordinatorDoId ?? null, residencies: record?.residencies.size ?? 0, watchers: record?.watchers.size ?? 0 };
  }

  /** Open once and answer. Observation and release are independently owned calls. */
  async host(boot: unknown, opts: unknown): Promise<HostedReply<{ ok: boolean; incarnation: string }>> {
    const hostOpts = HostProcessOptsSchema.parse(opts);
    const spec = this.options.bootSpec.parse(boot);
    const { workerKey } = hostOpts;
    if (this.records.get(workerKey)?.closed === false) throw new Error('Nimbus: the peer already owns this process');
    const network = hostOpts.network === undefined ? ISOLATE_NETWORK : workspaceNetwork(hostOpts.network.egress, hostOpts.network.id);
    const supervisor: ResidentSupervisorProps = {
      ...supervisorBindingProps(this.ctx, hostOpts.pid, {
        writerId: hostOpts.writerId, doId: hostOpts.coordinatorDoId, route: hostOpts.route, network,
      }),
      ...(hostOpts.hostIncarnation === undefined ? {} : { hostIncarnation: hostOpts.hostIncarnation }),
    };
    // This peer's own reads for the process (its boot images): the process's pid, way back and network, no run.
    const reads = infrastructureSupervisorProps(this.ctx, hostOpts.pid, {
      doId: hostOpts.coordinatorDoId, route: supervisor.route, network: network.forProcess(hostOpts.pid),
    });

    const opened = withResolvers<ResidentFacet>();
    const started = withResolvers<unknown>();
    // Nothing awaits these unless a leg asks for them; keep the runtime from
    // reporting them as unhandled while the process is healthy.
    opened.promise.catch(() => {});
    started.promise.catch(() => {});
    const hostingKey = `${HOSTING_KEY_PREFIX}${workerKey}`;
    let releasing: Promise<void> | undefined;
    let ownsRow = false;
    const record: HostedProcessRecord = {
      facet: opened.promise,
      started: started.promise,
      webSocketCapability: hostOpts.webSocketCapability,
      handled: new HandledRequests(),
      closed: false,
      watchers: new Map(),
      residencies: new Map(),
      release: () => {
        record.closed = true;
        return releasing ??= (async () => {
          for (const [socket, release] of record.watchers) { release(); socket.close(1000, 'process released'); }
          for (const [socket, release] of record.residencies) { release(); socket.close(); }
          const facet = await opened.promise.catch(() => null);
          await facet?.release();
          if (ownsRow) await this.ctx.storage.delete(hostingKey);
        })();
      },
    };
    this.register(workerKey, record);
    const hosting: HostingRecord = {
      coordinatorDoId: hostOpts.coordinatorDoId,
      ...(hostOpts.route === undefined ? {} : { route: hostOpts.route }),
      workerKey,
      capability: hostOpts.webSocketCapability,
      incarnation: this.incarnation,
    };

    let facet: ResidentFacet | undefined;
    try {
      if (await this.ctx.storage.get(CANCELLED_HOSTING_KEY_PREFIX + workerKey)) throw new Error('Nimbus: the peer process was cancelled before opening');
      if (await this.ctx.storage.get(hostingKey)) throw new LostHostedProcess('the peer restarted without its previous process');
      if (record.closed) throw new Error('Nimbus: the peer process was cancelled before opening');
      ownsRow = true;
      await this.ctx.storage.put(hostingKey, hosting);
      if (record.closed) throw new Error('Nimbus: the peer process was cancelled before opening');
      let located: Promise<void> | undefined;
      facet = processes(this.ctx, this.env).spawn(
        () => peerDiskReader(reads),
        supervisor,
        {
          pid: hostOpts.pid,
          workerKey,
          boot: spec,
          writerId: hostOpts.writerId,
          startArgs: hostOpts.startArgs,
          created: (name) => {
            hosting.facet = name;
            located = this.ctx.storage.put(hostingKey, hosting);
            located.catch(() => {});
          },
        },
      );
      opened.resolve(facet);
      facet.started.then(started.resolve, started.reject);
      facet.lost.catch((error) => {
        record.failure = error instanceof Error ? error : new Error(String(error));
        for (const [socket, release] of record.watchers) { release(); socket.close(1011, 'process host lost'); }
        for (const [socket, release] of record.residencies) { release(); socket.close(); }
      });
      await located;
      if (record.closed) throw new Error('Nimbus: the peer process was cancelled while opening');
      return { ok: true, incarnation: this.incarnation };
    } catch (e) {
      opened.reject(e);
      started.reject(e);
      await record.release();
      if (e instanceof LostHostedProcess) return { hostLost: e.message };
      throw e;
    }
  }

  /**
   * Read back the runner's startProcess payload. `host` started it; this
   * never starts anything, so a coordinator asking twice gets the same answer
   * a local facet would have returned inline — and for a `lifetime` runner it
   * settles at exit, exactly as the local one does.
   */
  async awaitBoot(workerKey: string): Promise<HostedReply<{ payload: unknown } | { refused: unknown }>> {
    return this.answer(workerKey, async () => {
      const record = await this.awaitRecord(workerKey);
      // The leaf's boot answers for itself, as a facet's does to its own
      // coordinator: its refusal (a run's stop, which resets the leaf) is
      // that boot's answer, never this peer's loss.
      try { return { payload: await record.started }; }
      catch (error) { return { refused: error }; }
    });
  }

  /** The coordinator abandons request `id` of a process this peer hosts (SentRequests): its leaf's call is cancelled. */
  async abandonHttp(workerKey: string, capability: string, id: number): Promise<void> {
    const record = this.records.get(workerKey);
    if (record && !record.closed && record.webSocketCapability === capability) record.handled.abandon(id);
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
   * what leaves here must not be an object the loaded worker owns. That
   * pipe's end is when this host's work for the response is done; the
   * coordinator abandons the request by its id (abandonHttp), which cancels its leaf's call,
   * before its headers or after, and the leaf's guest ending its body ends
   * the pipe.
   */
  async routeHttp(workerKey: string, wire: HostedHttpRequest): Promise<HostedReply<HostedHttpResponse>> {
    return this.answer(workerKey, async () => {
      const record = await this.awaitRecord(workerKey);
      if (record.webSocketCapability !== wire.capability) throw new LostHostedProcess('the peer no longer owns this process incarnation');
      const facet = await record.facet;
      const headers = new Headers();
      for (const [k, v] of wire.headers) headers.append(k, v);
      const init: RequestInit & { duplex?: 'half' } = { method: wire.method, headers };
      if (wire.body) { init.body = wire.body; init.duplex = 'half'; }
      // The leaf's call runs under the signal its coordinator abandons the
      // request by (HandledRequests). This relay's own end is its pipe's.
      const { scope, owner } = responseScope(new AbortController().signal);
      let response: Response;
      try { response = await facet.handleHttpRequest(new Request(wire.url, init), scope, record.handled.signal(wire)); }
      catch (error) { owner.fail(); throw error; }
      let body: ReadableStream | null = null;
      if (response.body) {
        const { readable, writable } = new IdentityTransformStream();
        this.ctx.waitUntil(response.body.pipeTo(writable).then(() => owner.settle(), () => owner.fail()));
        body = readable;
      } else owner.settle();
      return {
        status: response.status,
        statusText: response.statusText,
        headers: headerPairs(response.headers),
        body,
      };
    });
  }

  /**
   * The peer end of the upgrade hop (isHostedWebSocket). Reached by `fetch`
   * rather than RPC, so the 101 and its live socket travel back as
   * themselves. Both headers are stripped so the process never sees the
   * transport that carried it.
   *
   * The workerKey names a process and is derivable from a pid, so it does not
   * authorise on its own; the capability is minted by whoever opened the process
   * and never leaves the two objects that hold it. A mismatch is a 404 and not
   * a 403, so the route reveals nothing about what this peer is hosting.
   */
  async routeWebSocket(request: Request): Promise<Response> {
    if (!isWebSocketUpgradeRequest(request.headers)) return new Response('Expected WebSocket', { status: 426 });
    const workerKey = request.headers.get(HOSTED_WEBSOCKET_KEY_HEADER) ?? '';
    const capability = request.headers.get(HOSTED_WEBSOCKET_CAPABILITY_HEADER);
    if (!capability || !await this.authorized(workerKey, capability)) return new Response('Not found', { status: 404 });
    const headers = new Headers(request.headers);
    headers.delete(HOSTED_WEBSOCKET_KEY_HEADER);
    headers.delete(HOSTED_WEBSOCKET_CAPABILITY_HEADER);
    const result = await this.answer(workerKey, async () => {
      const record = await this.awaitRecord(workerKey);
      const facet = await record.facet;
      return facet.handleWebSocketRequest(new Request(request.url, { method: request.method, headers }));
    });
    return result instanceof Response ? result : this.gone(capability, result.hostLost);
  }

  /**
   * Deterministic kill of a hosted process — the same teardown a coordinator
   * applies to a facet of its own, and it does not answer until it has
   * happened: a caller that has to guess whether the process is gone cannot
   * retire the writer identity behind it.
   */
  async cancel(workerKey: string): Promise<{ cancelled: boolean }> {
    const pending = this.records.get(workerKey);
    if (pending) pending.closed = true;
    // A delayed host RPC must still be refused after this reply and a coordinator reset.
    await this.ctx.storage.put(CANCELLED_HOSTING_KEY_PREFIX + workerKey, true);
    const record = this.records.get(workerKey);
    if (record) await record.release();
    const key = `${HOSTING_KEY_PREFIX}${workerKey}`;
    const stored = await this.ctx.storage.get<HostingRecord>(key);
    if (!stored) return { cancelled: record !== undefined };
    // A name this incarnation has since given a newer process is that process's facet now.
    // One an earlier life of the peer left held is the cancelled process's own, ended here.
    if (stored.facet && !facetNameHeld(this.ctx, stored.facet)) { abortFacet(this.ctx, stored.facet, new Error('Nimbus: the coordinator released its previous process')); deleteFacetStorage(this.ctx, stored.facet); }
    else if (!stored.incarnation) console.warn(`[nimbus] dropped legacy peer record '${workerKey}': its peer facet could not be named`);
    await this.ctx.storage.delete(key);
    return { cancelled: true };
  }

  /** One abortable observation bridges coordinator activity to this actor. */
  async watch(request: Request): Promise<Response> {
    const key = request.headers.get(HOSTED_WATCH_HEADER) ?? '';
    const capability = request.headers.get(HOSTED_WEBSOCKET_CAPABILITY_HEADER);
    if (!capability || !await this.authorized(key, capability)) return new Response('Not found', { status: 404 });
    const result = await this.answer(key, async () => {
      const record = await this.awaitRecord(key);
      const facet = await record.facet;
      const lease = facet.acquireActivity(request.signal);
      try {
        await lease.ready;
        request.signal.throwIfAborted();
        if (record.failure) throw new LostHostedProcess(errorText(record.failure));
        if (record.closed) throw new Error('Nimbus: the hosted process is no longer running');
        return this.socket(request, record.watchers, () => lease.release());
      } catch (error) { lease.release(); throw error; }
    });
    return result instanceof Response ? result : this.gone(capability, result.hostLost);
  }

  /** The coordinator retains its endpoint unaccepted; only the peer receives events. */
  async reside(request: Request): Promise<Response> {
    const key = request.headers.get(HOSTED_RESIDENCY_HEADER) ?? '';
    const capability = request.headers.get(HOSTED_WEBSOCKET_CAPABILITY_HEADER);
    if (!capability || !await this.authorized(key, capability)) return new Response('Not found', { status: 404 });
    const result = await this.answer(key, async () => {
      const record = await this.awaitRecord(key);
      await record.facet;
      request.signal.throwIfAborted();
      return this.socket(request, record.residencies, () => {}, () => {
        if (record.closed || record.residencies.size) return;
        this.ctx.waitUntil(this.cancel(key).catch((error) => console.error('Nimbus: coordinator residency teardown failed', error)));
      });
    });
    return result instanceof Response ? result : this.gone(capability, result.hostLost);
  }

  private socket(request: Request, sockets: Map<WebSocket, () => void>, releaseOwner: () => void, afterEnd?: () => void): Response {
    const [client, server] = Object.values(new WebSocketPair());
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      request.signal.removeEventListener('abort', ended);
      sockets.delete(server);
      releaseOwner();
    };
    const ended = () => { if (released) return; release(); afterEnd?.(); server.close(); };
    sockets.set(server, release);
    server.addEventListener('close', ended);
    server.addEventListener('error', ended);
    server.accept();
    request.signal.addEventListener('abort', ended, { once: true });
    return new Response(null, { status: 101, webSocket: client, headers: { [HOST_INCARNATION_HEADER]: this.incarnation } });
  }

  private async authorized(key: string, capability: string): Promise<boolean> {
    const record = this.records.get(key);
    if (record) return record.webSocketCapability === capability;
    return (await this.ctx.storage.get<HostingRecord>(`${HOSTING_KEY_PREFIX}${key}`))?.capability === capability;
  }

  private gone(capability: string, reason: string): Response {
    return new Response(reason, { status: 410, headers: { [HOSTED_FAILURE_HEADER]: capability, [HOST_INCARNATION_HEADER]: this.incarnation } });
  }

  private async answer<T>(key: string, work: () => Promise<T>): Promise<HostedReply<T>> {
    try { return await work(); }
    catch (error) {
      const failure = this.records.get(key)?.failure;
      // A replaced leaf's refusal (ProcessHostLost) names its cause, which the coordinator wraps again.
      if (failure || error instanceof LostHostedProcess || isHostReset(error)) return { hostLost: errorText(failure ?? error) };
      if (error instanceof ProcessHostLost) return { hostLost: errorText(error.cause) };
      throw error;
    }
  }

  private register(workerKey: string, record: HostedProcessRecord): void {
    this.records.set(workerKey, record);
    const pending = this.waiters.get(workerKey);
    if (!pending) return;
    this.waiters.delete(workerKey);
    for (const notify of pending) notify(record);
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
  private async awaitRecord(workerKey: string): Promise<HostedProcessRecord> {
    const existing = this.records.get(workerKey);
    if (existing) {
      if (existing.failure) throw new LostHostedProcess(errorText(existing.failure));
      if (existing.closed) throw new Error('Nimbus: the hosted process is no longer running');
      return existing;
    }
    if (await this.ctx.storage.get(CANCELLED_HOSTING_KEY_PREFIX + workerKey)) throw new Error('Nimbus: the hosted process is no longer running');
    if (await this.ctx.storage.get(`${HOSTING_KEY_PREFIX}${workerKey}`)) throw new LostHostedProcess('the peer restarted without its process');
    const arrived = this.records.get(workerKey);
    if (arrived) return this.awaitRecord(workerKey);
    if (this.records.size > 0 || (this.waiters.size > 0 && !this.waiters.has(workerKey))) {
      return Promise.reject(new Error(`Nimbus: peer hosts no process for key '${workerKey}'`));
    }
    return new Promise<HostedProcessRecord>((resolve, reject) => {
      const pending = this.waiters.get(workerKey) ?? new Set<(record: HostedProcessRecord) => void>();
      const notify = (record: HostedProcessRecord) => { clearTimeout(timer); resolve(record); };
      const timer = setTimeout(() => {
        pending.delete(notify);
        if (pending.size === 0) this.waiters.delete(workerKey);
        reject(new Error(`Nimbus: peer hosts no process for key '${workerKey}'`));
      }, HOSTED_RECORD_WAIT_MS);
      pending.add(notify);
      this.waiters.set(workerKey, pending);
    });
  }
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
