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
 *            workerd memory budget. Measured once on the prod shape under
 *            synthetic load: 8 peers × ~150 MiB held concurrently, and a peer
 *            OOM left its siblings and the coordinator running in 12 of 12
 *            checks. The live opencode gate that followed was weaker — 1 of
 *            its 12 runs reset the session, unattributed. Both numbers come
 *            from probe deployments since deleted; neither report is in the
 *            repo.
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
 * Inbound HTTP to a peer-hosted process
 * ─────────────────────────────────────
 * A peer-hosted facet serves inbound HTTP through `routeThroughPeer` below:
 * the coordinator's PortRegistry holds one route target per pid and cannot
 * tell peer from local, because the target carries the request's PARTS to
 * `_rpcRouteHostedHttp` on the hosting peer, which re-enters its own facet and
 * returns the response's parts. Bodies are plain ReadableStreams both ways, so
 * nothing is buffered and an SSE or chunked body still streams live.
 *
 * STILL BROKEN, and the failure is narrower than it looked. Routing a real
 * peer-hosted `node --watch server.js` through `/s/<sid>/port/3000/` returns
 * `DataCloneError: Entrypoints to dynamically-loaded workers cannot be
 * transferred to other Workers` (reproduced 2026-07-27 on real Nimbus under
 * `wrangler dev`). What is now PROVEN about it:
 *
 *   - It is not the response. Replacing the node facet's handler with a bare
 *     `new Response("SENTINEL-OK")` fails identically, so every body/stream/
 *     buffering hypothesis was aimed at the wrong stage.
 *   - The facet is NEVER ENTERED. Logging the first line of the facet's
 *     `handleHttpRequest` produces nothing: workerd refuses to DELIVER the
 *     call. The throw is at `method.call(ep, …)` in
 *     `NimbusLoadedEntrypoint.handleHttpRequest`.
 *   - A peer CAN call into its own dynamically-loaded facet: `startProcess`
 *     on the very same facet, from the very same peer, works — the node
 *     server boots and registers its port. Only the code-free route path
 *     fails, so the DO→DO hop is not itself the problem.
 *   - Not the peer's `ctx.exports` identity (it is a first-write-wins module
 *     singleton, so a peer sharing an isolate inherits the coordinator's —
 *     genuinely wrong, worth fixing, but forcing `self.ctx.exports` changes
 *     nothing here).
 *   - Not a missing reload recipe: giving the route stub the full boot spec,
 *     so the loader callback can genuinely reconstruct the worker, changes
 *     nothing.
 *
 * A standalone probe mirroring this shape — held-open host call, the
 * SUPERVISOR doId override, a code-free route stub minted in the using
 * context, inbound HTTP in a later request, an 8 MiB facet-generated body —
 * serves byte-exact in BOTH deployed production and local `wrangler dev`. So
 * the difference lives somewhere in this worker's own
 * NimbusLoadedEntrypoint/Worker-Loader path, not in the peer topology. The
 * scheduler test below drives a MOCKED peer and never re-enters a real facet,
 * which is why it stayed green throughout.
 *
 * Until it is fixed, no primitive that binds a port may be `heavy`.
 *
 * Policy
 * ──────
 * One field, one policy point. Each launch primitive DECLARES a
 * `processClass` where it is defined, and `startResidentProcess` is the only
 * consumer. There is no command-name or argv matching anywhere in this file.
 * A primitive is `heavy` when it is RESIDENT (it accumulates memory over its
 * lifetime and is worth a whole workerd process) and binds no port. Exactly
 * one primitive qualifies today: the opencode attach TUI.
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
import { OpencodeStageSpecSchema, type OpencodeStageSpec } from '../facets/opencode-staging.js';
import type { RouteableFacetTarget } from '../runtime/port-registry.js';
import { getCtxExports } from '../session/ctx-exports.js';
import { disposeRpcResource, disposeRpcResources } from '../_shared/rpc-dispose.js';
import { BindingError } from './vendor/errors.js';
import { isTransientDoReset } from '../observability/oom-classify.js';
import { PEER_TRANSIENT_RESET_RETRIES, PEER_RETRY_BACKOFF_MS } from './fanout-pool.js';

/**
 * Memory class of a resident process. Declared by the launch primitive that
 * defines the process kind (`facets/opencode-staging.ts` for the staged
 * opencode modes, `facets/manager.ts` for the node/worker spawn primitives);
 * consumed by exactly one policy point — `ProcessFabric.startResidentProcess`.
 */
export type ProcessClass = 'light' | 'heavy';

/**
 * Runner contract for `startProcess()`. A property of the generated runner,
 * not of placement:
 *
 *   lifetime — the call is held open for the process's whole life and settles
 *              only at exit (opencode attached + server, attached-TTY node).
 *   boot     — the call returns a boot payload once the process is up and the
 *              facet stays resident behind its retained resources (node
 *              servers, the python/ruby socket runners).
 */
export type StartContract = 'lifetime' | 'boot';

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

export type ResidentCodeSpec = z.infer<typeof ResidentCodeSpecSchema>;

export const ResidentBootSpecSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('staged'), stage: OpencodeStageSpecSchema }),
  z.object({ kind: z.literal('code'), code: ResidentCodeSpecSchema }),
]);

export type ResidentBootSpec = z.infer<typeof ResidentBootSpecSchema>;

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

let _isolateToken: string | null = null;

/**
 * Lazy module-scope isolate token. Two Durable Objects that report the same
 * token share one isolate — and, since all NimbusSession DOs run the same
 * script, one workerd process. The scheduler compares peer tokens against its
 * own and those already in use to verify a heavy process landed in a distinct
 * process (the probe-proven placement check).
 */
export function isolateToken(): string {
  if (!_isolateToken) _isolateToken = crypto.randomUUID();
  return _isolateToken;
}

// ── Loaded-worker entrypoint plumbing ───────────────────────────────────────

/** Structural surface of a NimbusLoadedEntrypoint RPC stub. */
export interface LoadedWorkerEntrypointStub {
  startProcess?: (args?: unknown) => Promise<unknown>;
  handleHttpRequest?: (request: Request) => Promise<Response>;
  fetch?(request: Request): Promise<Response>;
}

export interface NimbusCtxExports {
  SupervisorRPC?: (options: {
    props: { doId: string; pid: number; writerId: string };
  }) => unknown;
  NimbusLoadedEntrypoint?: (options: {
    props: {
      key: string;
      name: string | null;
      depth: number;
      code: unknown;
      supervisor: { doId: string; pid: number; writerId: string };
      stage?: OpencodeStageSpec;
      residentCode?: ResidentCodeSpec;
    };
  }) => LoadedWorkerEntrypointStub;
}

export function getNimbusCtxExports(): NimbusCtxExports {
  const ctxExports = getCtxExports();
  if (!ctxExports || typeof ctxExports !== 'object') {
    throw new Error('Nimbus: ctx.exports unavailable');
  }
  return ctxExports as NimbusCtxExports;
}

/**
 * Mint a NimbusLoadedEntrypoint stub for a keyed dynamic worker. The
 * `supervisor` identity controls where the facet's SUPERVISOR binding routes:
 * a peer host passes the COORDINATOR's doId so every syscall lands on the
 * user's session DO, not the peer.
 */
export async function createLoadedWorkerEntrypoint(
  ctxExports: NimbusCtxExports,
  code: unknown,
  supervisor: { doId: string; pid: number; writerId: string },
  name: string | null = null,
  key = `nimbus-process:${supervisor.doId}:${supervisor.pid}`,
  boot?: ResidentBootSpec,
): Promise<LoadedWorkerEntrypointStub> {
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

// ── Host-side boot (runs on the coordinator OR on a peer, identically) ──────

/** Everything a host needs to boot one resident process. */
export interface ResidentHost {
  /**
   * The HOSTING DO's own ctx.exports — this is what decides which workerd
   * process the facet lands in.
   */
  ctxExports: NimbusCtxExports;
  /** Always the COORDINATOR's identity, whichever DO is hosting. */
  supervisor: { doId: string; pid: number; writerId: string };
  workerKey: string;
}

/** A booted facet, owned by its host. */
export interface HostedResidentProcess {
  /** Invoke the runner's startProcess; see StartContract. */
  start(args: unknown): Promise<unknown>;
  /** Re-resolvable inbound-HTTP target for the running facet. */
  route: RouteableFacetTarget;
  /** Release the resources pinning the facet — the facet dies with them. */
  dispose(): void;
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
export async function hostResidentProcess(
  host: ResidentHost,
  boot: ResidentBootSpec,
): Promise<HostedResidentProcess> {
  const route = await createRouteTarget(host);
  let startStub: LoadedWorkerEntrypointStub;
  try {
    startStub = await createLoadedWorkerEntrypoint(
      host.ctxExports, undefined, host.supervisor, null, host.workerKey, boot,
    );
  } catch (error) {
    disposeRpcResource(route);
    throw error;
  }
  if (typeof startStub.startProcess !== 'function') {
    disposeRpcResources([startStub, route]);
    throw new Error('Nimbus: resident process entrypoint has no startProcess method');
  }
  return {
    start: (args) => startStub.startProcess!(args),
    route,
    dispose: onceDisposed([startStub, route]),
  };
}

/** Disposal is idempotent: kill, host-call teardown and respawn can all fire. */
function onceDisposed(resources: unknown[]): () => void {
  let done = false;
  return () => {
    if (done) return;
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
async function createRouteTarget(host: ResidentHost): Promise<RouteableFacetTarget> {
  const stub = await createLoadedWorkerEntrypoint(
    host.ctxExports, undefined, host.supervisor, null, host.workerKey,
  );
  if (typeof stub.handleHttpRequest !== 'function') {
    disposeRpcResource(stub);
    throw new Error('Nimbus: resident process entrypoint has no HTTP request handler');
  }
  return stub as RouteableFacetTarget;
}

// ── Peer stub surface ───────────────────────────────────────────────────────

/** Options the coordinator hands a hosting peer. */
export interface HostProcessOpts {
  coordinatorDoId: string;
  pid: number;
  writerId: string;
  workerKey: string;
  startContract: StartContract;
  startArgs?: unknown;
}

/**
 * Inbound HTTP for a peer-hosted process travels as PARTS, not as a
 * Request/Response pair: workerd refuses to transfer an object owned by a
 * dynamically-loaded worker across a sibling-DO hop. Bodies are plain
 * ReadableStreams, which RPC carries with flow control, so nothing is
 * buffered and a live SSE body still streams.
 */
interface HostedHttpWire {
  method: string;
  url: string;
  headers: [string, string][];
  body: ReadableStream | null;
}

interface HostedHttpResult {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: ReadableStream | null;
}

interface ProcessPeerStub {
  _rpcHostProcessProbe(): Promise<{ isolateToken: string }>;
  _rpcHostProcess(boot: ResidentBootSpec, opts: HostProcessOpts): Promise<{ ok: boolean }>;
  _rpcAwaitHostedBoot(workerKey: string): Promise<{ payload: unknown }>;
  _rpcRouteHostedHttp(workerKey: string, request: HostedHttpWire): Promise<HostedHttpResult>;
  _rpcCancelHostProcess(workerKey: string): Promise<{ cancelled: boolean }>;
}

async function routeThroughPeer(
  stub: ProcessPeerStub,
  workerKey: string,
  request: Request,
): Promise<Response> {
  const headers: [string, string][] = [];
  request.headers.forEach((value, key) => { headers.push([key, value]); });
  const result = await stub._rpcRouteHostedHttp(workerKey, {
    method: request.method,
    url: request.url,
    headers,
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

interface PeerNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): unknown;
}

function isPeerNamespace(value: unknown): value is PeerNamespace {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false;
  return typeof Reflect.get(value, 'idFromName') === 'function'
    && typeof Reflect.get(value, 'get') === 'function';
}

/** Extract the NIMBUS_SESSION peer namespace from a raw env, if present. */
export function peerNamespaceFromEnv(env: unknown): PeerNamespace | undefined {
  const ns = ((typeof env === 'object' || typeof env === 'function') && env !== null)
    ? Reflect.get(env, 'NIMBUS_SESSION')
    : undefined;
  return isPeerNamespace(ns) ? ns : undefined;
}

function processPeerStub(value: unknown, peerName: string): ProcessPeerStub {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    throw new BindingError(`ProcessFabric: NIMBUS_SESSION.get() returned no stub for peer '${peerName}'.`);
  }
  if (typeof Reflect.get(value, '_rpcHostProcess') !== 'function'
    || typeof Reflect.get(value, '_rpcHostProcessProbe') !== 'function') {
    throw new BindingError(`ProcessFabric: peer '${peerName}' does not expose the host-process RPC surface.`);
  }
  return value as unknown as ProcessPeerStub;
}

// ── Handle ──────────────────────────────────────────────────────────────────

type ProcessPlacement =
  | { kind: 'local' }
  | { kind: 'peer'; slot: number; peerName: string; isolateToken: string };

function describePlacement(placement: ProcessPlacement): string {
  if (placement.kind === 'local') return 'local facet (coordinator process)';
  return `peer slot=${placement.slot} peer=${placement.peerName.slice(-12)} `
    + `token=${placement.isolateToken.slice(0, 8)}`;
}

/**
 * Resource handle for one resident process — the whole surface the kernel
 * above this module sees. It is placement-free throughout: `booted`, `done`,
 * `kill` and `routeTarget` all behave identically whether the facet runs in
 * the coordinator's workerd process or a sibling's.
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
  readonly done: Promise<void>;
  readonly processClass: ProcessClass;
  /**
   * Inbound-HTTP target for PortRegistry; follows the process across respawns
   * by reading the live placement on every request. Placement-free like the
   * rest of the handle: on a peer it carries the request's parts to the
   * hosting peer, locally it is the facet's own entrypoint, and PortRegistry
   * cannot tell the two apart.
   */
  readonly routeTarget: RouteableFacetTarget;
  /** Peer respawns consumed (heavy only). */
  respawns = 0;
  #booted: () => Promise<unknown>;
  #kill: () => void;
  #killed = false;
  #placement: () => ProcessPlacement;

  constructor(init: {
    processClass: ProcessClass;
    placement: () => ProcessPlacement;
    done: Promise<void>;
    booted: () => Promise<unknown>;
    routeTarget: RouteableFacetTarget;
    kill: () => void;
  }) {
    this.processClass = init.processClass;
    this.#placement = init.placement;
    this.done = init.done;
    this.#booted = init.booted;
    this.routeTarget = init.routeTarget;
    this.#kill = init.kill;
    // Symbol.dispose may be absent from older lib targets; wire defensively
    // so disposeRpcResource() (which probes for it) finds the disposer.
    const disposeSym = (Symbol as SymbolConstructor & { readonly dispose?: symbol }).dispose;
    if (disposeSym) {
      Object.defineProperty(this, disposeSym, { value: () => this.kill() });
    }
  }

  /**
   * The runner's startProcess payload. The runner is started as part of the
   * spawn, so this is a handle on that one boot — awaiting it twice is safe
   * and never re-starts anything. For a `lifetime` runner it settles at exit.
   */
  booted(): Promise<unknown> {
    return this.#booted();
  }

  get killed(): boolean {
    return this.#killed;
  }

  /**
   * Human-readable placement, for the NIMBUS_DEBUG process-log line. Callers
   * log the string; they never branch on it — placement stays in here.
   */
  describePlacement(): string {
    return describePlacement(this.#placement());
  }

  /** Idempotent: sever the process's RPC chain and block respawn. */
  kill(): void {
    if (this.#killed) return;
    this.#killed = true;
    try { this.#kill(); } catch { /* best-effort teardown */ }
  }
}

// ── The scheduler ───────────────────────────────────────────────────────────

export interface ResidentProcessSpawn {
  /** Declared by the launch primitive that defines this process kind. */
  processClass: ProcessClass;
  /** Declared by the runner the primitive generates. */
  startContract: StartContract;
  /** Supervisor-assigned pid of the process entry on the coordinator. */
  pid: number;
  /** Keyed dynamic-worker identity (`nimbus-process:${doId}:${pid}`). */
  workerKey: string;
  /** What the facet boots from. */
  boot: ResidentBootSpec;
  /** Forwarded verbatim to the runner's startProcess, and replayed on respawn. */
  startArgs?: unknown;
  /**
   * Consulted before a respawn: return true only while the process is still
   * expected to run (e.g. its ProcessTable entry is 'running'). A killed or
   * torn-down process must not respawn.
   */
  shouldRespawn?: () => boolean;
  /**
   * Invoked after a host death when a respawn WILL be attempted, with the
   * error that killed the previous host. Callers surface it to the process
   * log so a death-plus-recovery is never silent.
   */
  onRespawn?: (cause: unknown) => void;
  /**
   * Called before any concrete host capability can expose this writer.
   * A spawn must not proceed unless the supervisor accepts the authority.
   */
  onWriterActivated: (writerId: string) => void;
  /** Called only after the concrete host resources for this writer are revoked. */
  onWriterRetired: (writerId: string) => void;
}

interface PeerPlacementInternal {
  stub: ProcessPeerStub;
  slot: number;
  peerName: string;
  isolateToken: string;
}

/** A promise that settles only when the process is killed. */
function heldUntilKilled(): { promise: Promise<void>; release: () => void } {
  let release = () => {};
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

export class ProcessFabric {
  private readonly ctx: DurableObjectState;
  private readonly ns: PeerNamespace | undefined;
  private readonly coordDoId: string;
  /** pid → isolate token of the peer currently hosting that process. */
  private readonly tokensInUse = new Map<number, string>();
  /** Monotonic slot counter: respawns and new spawns land on fresh peers. */
  private nextSlot = 0;

  constructor(ctx: DurableObjectState, env: unknown) {
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
  async startResidentProcess(spawn: ResidentProcessSpawn): Promise<ResidentProcessHandle> {
    return spawn.processClass === 'light'
      ? this._startLocal(spawn)
      : this._startPeer(spawn);
  }

  // ── light: the facet lands in the coordinator's own workerd process ───

  private async _startLocal(spawn: ResidentProcessSpawn): Promise<ResidentProcessHandle> {
    // The facet-local append sequence starts at one when its module evaluates.
    // Bind that sequence to this concrete host, then retire it only after the
    // host resources are disposed; a later host must use a fresh incarnation.
    const writerId = crypto.randomUUID();
    spawn.onWriterActivated(writerId);
    let hosted: HostedResidentProcess;
    try {
      hosted = await hostResidentProcess(this._localHost(spawn, writerId), spawn.boot);
    } catch (error) {
      spawn.onWriterRetired(writerId);
      throw error;
    }
    let started: Promise<unknown>;
    try {
      started = hosted.start(spawn.startArgs);
    } catch (error) {
      hosted.dispose();
      spawn.onWriterRetired(writerId);
      throw error;
    }
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
      done: done.finally(() => {
        hosted.dispose();
        spawn.onWriterRetired(writerId);
      }),
      booted: () => started,
      routeTarget: hosted.route,
      kill: () => { held.release(); hosted.dispose(); },
    });
  }

  private _localHost(spawn: ResidentProcessSpawn, writerId: string): ResidentHost {
    return {
      ctxExports: getNimbusCtxExports(),
      supervisor: {
        doId: this.coordDoId,
        pid: spawn.pid,
        writerId,
      },
      workerKey: spawn.workerKey,
    };
  }

  // ── heavy: the facet lands in a sibling DO's workerd process ──────────

  private _requireNs(): PeerNamespace {
    if (!this.ns) {
      throw new BindingError(
        'ProcessFabric: env.NIMBUS_SESSION binding missing or invalid. '
          + 'Heavy-class processes require the peer-DO namespace. '
          + 'Add the binding via durable_objects.bindings in wrangler.jsonc.',
      );
    }
    return this.ns;
  }

  private async _startPeer(spawn: ResidentProcessSpawn): Promise<ResidentProcessHandle> {
    // First placement happens inline so a placement failure rejects the
    // spawn itself (matching the local path's boot-failure surface).
    const first = await this._placeDistinctPeer();
    const firstWriterId = this._activatePeerWriter(spawn, first);
    const state = { current: first, handle: undefined as ResidentProcessHandle | undefined };
    // The route target follows the process across respawns by reading the
    // live placement on every request — PortRegistry keeps one binding.
    const routeTarget: RouteableFacetTarget = {
      handleHttpRequest: (request: Request) =>
        routeThroughPeer(state.current.stub, spawn.workerKey, request),
    };
    const done = this._runPeerLifecycle(spawn, state, firstWriterId);
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
  private async _runPeerLifecycle(
    spawn: ResidentProcessSpawn,
    state: { current: PeerPlacementInternal; handle: ResidentProcessHandle | undefined },
    initialWriterId: string,
  ): Promise<void> {
    let respawnsLeft = HEAVY_RESPAWN_BUDGET;
    let writerId = initialWriterId;
    for (;;) {
      const placement = state.current;
      this.tokensInUse.set(spawn.pid, placement.isolateToken);
      try {
        await placement.stub._rpcHostProcess(spawn.boot, {
          coordinatorDoId: this.coordDoId,
          pid: spawn.pid,
          writerId,
          workerKey: spawn.workerKey,
          startContract: spawn.startContract,
          startArgs: spawn.startArgs,
        });
        return; // clean lifecycle end — the facet reported its own exit
      } catch (e) {
        const killed = state.handle?.killed === true;
        const wanted = spawn.shouldRespawn ? spawn.shouldRespawn() : true;
        if (killed || !wanted || respawnsLeft <= 0) throw e;
        respawnsLeft--;
        try { spawn.onRespawn?.(e); } catch { /* observability must not break the lifecycle */ }
      } finally {
        this.tokensInUse.delete(spawn.pid);
        disposeRpcResource(placement.stub);
        spawn.onWriterRetired(writerId);
      }
      // Respawn: fresh slot, re-verified placement. The handle's route target
      // and start() read `state.current`, so both re-point automatically.
      const next = await this._placeDistinctPeer();
      writerId = this._activatePeerWriter(spawn, next);
      state.current = next;
      if (state.handle) state.handle.respawns++;
    }
  }

  private _activatePeerWriter(
    spawn: ResidentProcessSpawn,
    placement: PeerPlacementInternal,
  ): string {
    // A respawn re-evaluates the facet module and resets its local sequence.
    // Register a fresh incarnation before exposing this placement to a host
    // RPC or to the placement-following handle.
    const writerId = crypto.randomUUID();
    try {
      spawn.onWriterActivated(writerId);
      return writerId;
    } catch (error) {
      disposeRpcResource(placement.stub);
      throw error;
    }
  }

  /**
   * Probe successive slots until one reports an isolate token distinct from
   * the coordinator's own and every token already hosting a process. Falls
   * back to the last probed candidate when every attempt co-locates (dev
   * single-process topologies) — see the module header.
   */
  private async _placeDistinctPeer(): Promise<PeerPlacementInternal> {
    const ns = this._requireNs();
    const denied = new Set<string>([isolateToken(), ...this.tokensInUse.values()]);
    let colocated: PeerPlacementInternal | null = null;
    for (let attempt = 0; attempt < HEAVY_PLACEMENT_MAX_ATTEMPTS; attempt++) {
      const slot = this.nextSlot++;
      const peerName = `${this.coordDoId}:proc:${slot}`;
      let resource: unknown;
      try {
        resource = ns.get(ns.idFromName(peerName));
        const stub = processPeerStub(resource, peerName);
        const probe = await this._probePeer(stub, peerName);
        const candidate: PeerPlacementInternal = {
          stub,
          slot,
          peerName,
          isolateToken: probe.isolateToken,
        };
        if (!denied.has(probe.isolateToken)) {
          if (colocated) disposeRpcResource(colocated.stub);
          return candidate;
        }
        if (colocated) disposeRpcResource(colocated.stub);
        colocated = candidate;
      } catch (error) {
        disposeRpcResource(resource);
        if (colocated) disposeRpcResource(colocated.stub);
        throw error;
      }
    }
    return colocated!;
  }

  /**
   * First contact with a possibly-cold sibling DO: retry transient platform
   * resets with the same bounded policy the fanout peers ship
   * (fanout-pool.ts PEER_TRANSIENT_RESET_RETRIES). Non-transient failures
   * propagate on the first hit.
   */
  private async _probePeer(stub: ProcessPeerStub, peerName: string): Promise<{ isolateToken: string }> {
    for (let attempt = 0; ; attempt++) {
      try {
        const probe = await stub._rpcHostProcessProbe();
        if (!probe || typeof probe.isolateToken !== 'string' || probe.isolateToken.length === 0) {
          throw new Error(`ProcessFabric: peer '${peerName}' returned no isolate token`);
        }
        return probe;
      } catch (err) {
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
  private _cancelPeer(workerKey: string, peerName: string): void {
    const ns = this.ns;
    if (!ns) return;
    try {
      const stub = processPeerStub(ns.get(ns.idFromName(peerName)), peerName);
      this.ctx.waitUntil(
        Promise.resolve(stub._rpcCancelHostProcess(workerKey))
          .catch(() => { /* peer already gone — the held RPC is severed either way */ })
          .finally(() => disposeRpcResource(stub)),
      );
    } catch { /* best-effort */ }
  }
}
