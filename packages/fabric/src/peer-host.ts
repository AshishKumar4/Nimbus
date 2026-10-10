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
import { RESIDENT_KEEPALIVE_MS } from '@nimbus-sh/platform/limits.js';
import { z } from 'zod/v4';
import { hostNamespaceBinding, hostOpDispatch } from './host-dispatch.js';
import type { HostRoute } from './composition.js';
import type { ResidentBootSpec, ResidentDiskReader, ResidentSupervisorProps } from './process-fabric.js';
import { bindingSupervisor, supervisorBindingProps } from './supervisor-props.js';
import { processes, type ResidentFacet, type ResidentFacetEnv } from './workerd-facet-host.js';

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

/** What the object hosting processes supplies: the two things the fabric cannot know. */
export interface PeerHostOptions {
  /**
   * The boot-spec schema with the embedder's own stage
   * (residentBootSpecSchema): the host leg is this peer's trust boundary for
   * what it boots.
   */
  bootSpec: z.ZodType<ResidentBootSpec>;
  /**
   * Arm the hosting watch through the object's own scheduler: a session's
   * timer mux, or an embedder's lifecycle, which owns its alarm.
   */
  scheduleWatch(at: number): Promise<void>;
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
  cancel(): void;
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

/** What a host keeps of a process it holds: whom to tell, and the proof it hosted it. */
interface HostingRecord {
  coordinatorDoId: string;
  route?: HostRoute;
  workerKey: string;
  /** The per-open capability (HostProcessOpts.webSocketCapability): known only to the session and this host. */
  capability: string;
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
 * it, and the installed runtime images are world-readable too.
 */
const RESIDENT_READ_RANGE_BYTES = 4 * 1024 * 1024;

interface SupervisorFileReader {
  stat(path: string): Promise<{ size?: number } | null>;
  fsReadRangeUncached(path: string, offset: number, length: number): Promise<Uint8Array | null>;
}

function peerDiskReader(supervisor: ResidentSupervisorProps): ResidentDiskReader {
  const fs = bindingSupervisor(supervisor) as SupervisorFileReader;
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
  async host(boot: unknown, opts: unknown): Promise<{ ok: boolean }> {
    const hostOpts = HostProcessOptsSchema.parse(opts);
    const spec = this.options.bootSpec.parse(boot);
    const { workerKey } = hostOpts;
    const supervisor: ResidentSupervisorProps = {
      ...supervisorBindingProps(this.ctx, hostOpts.pid, {
        writerId: hostOpts.writerId, doId: hostOpts.coordinatorDoId, route: hostOpts.route,
        network: hostOpts.network === undefined ? ISOLATE_NETWORK : workspaceNetwork(hostOpts.network.egress, hostOpts.network.id),
      }),
      ...(hostOpts.hostIncarnation === undefined ? {} : { hostIncarnation: hostOpts.hostIncarnation }),
    };

    let cancel = () => {};
    const cancelled = new Promise<void>((resolve) => { cancel = resolve; });
    let settleFacet: (f: ResidentFacet) => void = () => {};
    let failFacet: (e: unknown) => void = () => {};
    const facetPromise = new Promise<ResidentFacet>((resolve, reject) => {
      settleFacet = resolve;
      failFacet = reject;
    });
    let settleStarted: (v: unknown) => void = () => {};
    let failStarted: (e: unknown) => void = () => {};
    const startedPromise = new Promise<unknown>((resolve, reject) => {
      settleStarted = resolve;
      failStarted = reject;
    });
    // Nothing awaits these unless a leg asks for them; keep the runtime from
    // reporting them as unhandled while the process is healthy.
    facetPromise.catch(() => {});
    startedPromise.catch(() => {});
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
    const hosting: HostingRecord = {
      coordinatorDoId: hostOpts.coordinatorDoId,
      ...(hostOpts.route === undefined ? {} : { route: hostOpts.route }),
      workerKey,
      capability: hostOpts.webSocketCapability,
    };

    let facet: ResidentFacet | undefined;
    try {
      await this.ctx.storage.put(hostingKey, hosting);
      await this.armWatch();
      facet = processes(this.ctx, this.env).spawn(
        () => peerDiskReader(supervisor),
        supervisor,
        {
          pid: hostOpts.pid,
          workerKey,
          boot: spec,
          writerId: hostOpts.writerId,
          startArgs: hostOpts.startArgs,
        },
      );
      settleFacet(facet);
      facet.started.then(settleStarted, failStarted);
      // The facet lost here fails the held leg, which is how the session hears of it.
      await Promise.race([cancelled, facet.lost]);
      return { ok: true };
    } catch (e) {
      failFacet(e);
      failStarted(e);
      throw e;
    } finally {
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
  async awaitOpen(workerKey: string): Promise<{ ok: boolean }> {
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
  async awaitBoot(workerKey: string): Promise<{ payload: unknown }> {
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
  async routeHttp(workerKey: string, wire: HostedHttpRequest): Promise<HostedHttpResponse> {
    const record = await this.awaitRecord(workerKey);
    const facet = await record.facet;
    const headers = new Headers();
    for (const [k, v] of wire.headers) headers.append(k, v);
    const init: RequestInit & { duplex?: 'half' } = { method: wire.method, headers };
    if (wire.body) { init.body = wire.body; init.duplex = 'half'; }
    const response = await facet.handleHttpRequest(new Request(wire.url, init));
    let body: ReadableStream | null = null;
    if (response.body) {
      const { readable, writable } = new IdentityTransformStream();
      this.ctx.waitUntil(response.body.pipeTo(writable).catch(() => {}));
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
    if (!capability) return new Response('Not found', { status: 404 });
    const headers = new Headers(request.headers);
    headers.delete(HOSTED_WEBSOCKET_KEY_HEADER);
    headers.delete(HOSTED_WEBSOCKET_CAPABILITY_HEADER);
    const record = await this.awaitRecord(workerKey);
    if (record.webSocketCapability !== capability) return new Response('Not found', { status: 404 });
    const facet = await record.facet;
    return facet.handleWebSocketRequest(new Request(request.url, { method: request.method, headers }));
  }

  /**
   * Deterministic kill of a hosted process — the same teardown a coordinator
   * applies to a facet of its own, and it does not answer until it has
   * happened. The facet is released HERE rather than left to the held call's
   * `finally`, because a caller that has to guess whether the process is really
   * gone cannot retire the writer identity behind it.
   */
  async cancel(workerKey: string): Promise<{ cancelled: boolean }> {
    const record = this.records.get(workerKey);
    if (!record) return { cancelled: false };
    const facet = await record.facet.catch(() => null);
    await facet?.release();
    try { record.cancel(); } catch { /* best-effort */ }
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
  async watchFired(): Promise<number | null> {
    const again = Date.now() + HOSTING_WATCH_MS;
    try {
      const rows = await this.ctx.storage.list<HostingRecord>({ prefix: HOSTING_KEY_PREFIX });
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
        } catch (error) {
          console.warn(`[process-host] could not tell session ${row.coordinatorDoId.slice(-12)} that its process ${row.workerKey} was lost; trying again:`, errorText(error));
          watching = true;
          continue;
        }
        await this.ctx.storage.delete(key);
      }
      return watching ? again : null;
    } catch (error) {
      console.warn('[process-host] the hosting watch could not read or drop its records; trying again:', errorText(error));
      return again;
    }
  }

  /** One that cannot be armed throws, and the host refuses the process rather than hold one nothing would report the loss of. */
  private async armWatch(): Promise<void> {
    try {
      await this.options.scheduleWatch(Date.now() + HOSTING_WATCH_MS);
    } catch (error) {
      throw new Error(`Nimbus: this host could not arm the alarm that reports its own reset, so it does not host the process: ${errorText(error)}`);
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
  private awaitRecord(workerKey: string): Promise<HostedProcessRecord> {
    const existing = this.records.get(workerKey);
    if (existing) return Promise.resolve(existing);
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
