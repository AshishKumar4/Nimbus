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
 * the same three things for either placement — `start()` to boot the runner,
 * `routeTarget` for inbound HTTP, `done` for death, `kill()` for teardown — so
 * PortRegistry, the process table, stdio, the shell and the SDK never learn
 * where a process runs.
 *
 * Policy
 * ──────
 * One field, one policy point. Each launch primitive DECLARES a
 * `processClass` where it is defined, and `startResidentProcess` is the only
 * consumer. There is no command-name or argv matching anywhere in this file:
 * the classification follows the primitive's intrinsic residency (a resident
 * process accumulates memory over its lifetime and is worth a whole workerd
 * process; a one-shot command returns promptly and never reaches this module
 * at all).
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

import type { OpencodeStageSpec } from '../facets/opencode-staging.js';
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
 * Module TEXT is inline; wasm sidecars are named by VFS path and materialized
 * by the host (see the module header).
 */
export interface ResidentCodeSpec {
  compatibilityDate: string;
  compatibilityFlags: string[];
  mainModule: string;
  /**
   * Inline modules: generated source text, plus small wasm sidecars the host
   * cannot resolve for itself (they come from the worker's own ASSETS).
   */
  modules: Record<string, string | { wasm: ArrayBuffer }>;
  /**
   * Module name → absolute VFS path of a wasm image the HOST materializes.
   * This is how the big user-installed runtimes travel: ruby's
   * interpreter+stdlib image alone is 34.3 MiB, past workerd's 32 MiB RPC
   * argument limit, so its bytes can never ride inside a boot spec.
   */
  vfsWasmModules?: Record<string, string>;
}

export type ResidentBootSpec =
  | { kind: 'staged'; stage: OpencodeStageSpec }
  | { kind: 'code'; code: ResidentCodeSpec };

/** Reads one of the process's files from the COORDINATOR's disk. */
export type ProcessFileReader = (path: string, pid: number) => Promise<Uint8Array>;

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
  SupervisorRPC?: (options: { props: { doId: string; pid: number } }) => unknown;
  NimbusLoadedEntrypoint?: (options: {
    props: {
      key: string;
      name: string | null;
      depth: number;
      code: unknown;
      supervisor: { doId: string; pid: number };
      stage?: OpencodeStageSpec;
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
  supervisor: { doId: string; pid: number },
  name: string | null = null,
  key = `nimbus-process:${supervisor.doId}:${supervisor.pid}`,
  stage?: OpencodeStageSpec,
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
      ...(stage ? { stage } : {}),
    },
  });
}

// ── Host-side boot (runs on the coordinator OR on a peer, identically) ──────

/** The Worker Loader binding surface the `code` boot spec needs. */
interface WorkerLoaderBinding {
  get(key: string, load: () => Promise<unknown>): { getEntrypoint(): LoadedWorkerEntrypointStub };
}

/** Everything a host needs to boot one resident process. */
export interface ResidentHost {
  ctxExports: NimbusCtxExports;
  /** The HOSTING DO's own loader — this is what decides the workerd process. */
  loader: WorkerLoaderBinding;
  /** Always the COORDINATOR's identity, whichever DO is hosting. */
  supervisor: { doId: string; pid: number };
  workerKey: string;
  /** Resolves `code.wasmModules` paths against the coordinator's disk. */
  readProcessFile: ProcessFileReader;
}

/** A booted facet, owned by its host. */
export interface HostedResidentProcess {
  /** Invoke the runner's startProcess; see StartContract. */
  start(args: unknown): Promise<unknown>;
  /** Re-resolvable inbound-HTTP target for the facet, on the HOST's loader. */
  route: RouteableFacetTarget;
  /** Release the resources pinning the facet — the facet dies with them. */
  dispose(): void;
}

function loaderBindingFromEnv(env: unknown): WorkerLoaderBinding | undefined {
  const loader = ((typeof env === 'object' || typeof env === 'function') && env !== null)
    ? Reflect.get(env, 'LOADER')
    : undefined;
  if ((typeof loader !== 'object' && typeof loader !== 'function') || loader === null) return undefined;
  return typeof Reflect.get(loader, 'get') === 'function' ? loader as WorkerLoaderBinding : undefined;
}

/**
 * Materialize the spec's by-reference wasm sidecars from the coordinator's
 * disk. This is the one step that must run on the HOST: the bytes (34.3 MiB
 * for ruby's interpreter+stdlib image alone) exceed workerd's RPC argument
 * limit, so they can never ride inside a boot spec.
 */
async function materializeWasmModules(
  spec: ResidentCodeSpec,
  read: ProcessFileReader,
  pid: number,
): Promise<Record<string, { wasm: ArrayBuffer }>> {
  const out: Record<string, { wasm: ArrayBuffer }> = {};
  for (const [moduleName, path] of Object.entries(spec.vfsWasmModules ?? {})) {
    const bytes = await read(path, pid);
    out[moduleName] = {
      wasm: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    };
  }
  return out;
}

/**
 * Boot a resident process's facet on THIS host. Identical code runs on the
 * coordinator (local placement) and on a peer DO (peer placement) — the only
 * difference is whose `loader` and `ctxExports` are handed in.
 *
 * The two spec kinds differ only in where the module map comes from:
 *   staged — the stage rides the entrypoint props and the map is assembled
 *            inside the stateless NimbusLoadedEntrypoint isolate; its
 *            held-open startProcess call is what keeps the facet's SUPERVISOR
 *            binding context alive, so the runner contract is `lifetime`.
 *   code   — the map is completed here (wasm materialized from the
 *            coordinator's disk) and loaded through the host DO's own loader
 *            with a DO-minted SUPERVISOR binding, which outlives the request
 *            that created it. The facet is pinned by the retained resources,
 *            so a `boot`-contract runner may return from startProcess.
 */
export async function hostResidentProcess(
  host: ResidentHost,
  boot: ResidentBootSpec,
): Promise<HostedResidentProcess> {
  const route = await createRouteTarget(host);
  if (boot.kind === 'staged') {
    const startStub = await createLoadedWorkerEntrypoint(
      host.ctxExports, undefined, host.supervisor, null, host.workerKey, boot.stage,
    );
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

  const spec = boot.code;
  const supervisorBinding = host.ctxExports.SupervisorRPC
    ? host.ctxExports.SupervisorRPC({ props: host.supervisor })
    : undefined;
  let worker: { getEntrypoint(): LoadedWorkerEntrypointStub } | undefined;
  let startStub: LoadedWorkerEntrypointStub | undefined;
  try {
    const wasmModules = await materializeWasmModules(spec, host.readProcessFile, host.supervisor.pid);
    worker = host.loader.get(host.workerKey, async () => ({
      compatibilityDate: spec.compatibilityDate,
      compatibilityFlags: spec.compatibilityFlags,
      mainModule: spec.mainModule,
      modules: { ...spec.modules, ...wasmModules },
      ...(supervisorBinding ? { env: { SUPERVISOR: supervisorBinding } } : {}),
    }));
    startStub = worker.getEntrypoint();
    if (typeof startStub.startProcess !== 'function') {
      throw new Error('Nimbus: resident process entrypoint has no startProcess method');
    }
    const started = startStub.startProcess.bind(startStub);
    return {
      start: (args) => started(args),
      route,
      dispose: onceDisposed([route, startStub, worker, supervisorBinding]),
    };
  } catch (e) {
    disposeRpcResources([route, startStub, worker, supervisorBinding]);
    throw e;
  }
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
 * Inbound HTTP arrives in a LATER request context than the boot, so the
 * target must re-resolve the already-loaded worker in the caller's context —
 * and fail loud if it was evicted, rather than silently booting a fresh
 * isolate whose server never called listen().
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
  workerKey: string;
  startContract: StartContract;
  startArgs?: unknown;
}

interface ProcessPeerStub {
  _rpcHostProcessProbe(): Promise<{ isolateToken: string }>;
  _rpcHostProcess(boot: ResidentBootSpec, opts: HostProcessOpts): Promise<{ ok: boolean }>;
  _rpcAwaitHostedBoot(workerKey: string): Promise<{ payload: unknown }>;
  _rpcRouteHostedHttp(workerKey: string, request: Request): Promise<Response>;
  _rpcCancelHostProcess(workerKey: string): Promise<{ cancelled: boolean }>;
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
 * above this module sees. It is deliberately placement-free: `start`,
 * `routeTarget`, `done` and `kill` behave identically whether the facet runs
 * in the coordinator's workerd process or a sibling's.
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
  /** Inbound-HTTP target for PortRegistry; follows the process across respawns. */
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
  private readonly loader: WorkerLoaderBinding | undefined;
  private readonly readProcessFile: ProcessFileReader;
  private readonly coordDoId: string;
  /** pid → isolate token of the peer currently hosting that process. */
  private readonly tokensInUse = new Map<number, string>();
  /** Monotonic slot counter: respawns and new spawns land on fresh peers. */
  private nextSlot = 0;

  constructor(ctx: DurableObjectState, env: unknown, readProcessFile: ProcessFileReader) {
    this.ctx = ctx;
    this.ns = peerNamespaceFromEnv(env);
    this.loader = loaderBindingFromEnv(env);
    this.readProcessFile = readProcessFile;
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

  private _localHost(spawn: ResidentProcessSpawn): ResidentHost {
    if (!this.loader) {
      throw new BindingError(
        'ProcessFabric: env.LOADER binding missing or invalid. Resident processes '
          + 'require the Worker Loader binding.',
      );
    }
    return {
      ctxExports: getNimbusCtxExports(),
      loader: this.loader,
      supervisor: { doId: this.coordDoId, pid: spawn.pid },
      workerKey: spawn.workerKey,
      readProcessFile: this.readProcessFile,
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
    const state = { current: first, handle: undefined as ResidentProcessHandle | undefined };
    // The route target follows the process across respawns by reading the
    // live placement on every request — PortRegistry keeps one binding.
    const routeTarget: RouteableFacetTarget = {
      handleHttpRequest: (request: Request) =>
        state.current.stub._rpcRouteHostedHttp(spawn.workerKey, request),
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
  private async _runPeerLifecycle(
    spawn: ResidentProcessSpawn,
    state: { current: PeerPlacementInternal; handle: ResidentProcessHandle | undefined },
  ): Promise<void> {
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
      } catch (e) {
        const killed = state.handle?.killed === true;
        const wanted = spawn.shouldRespawn ? spawn.shouldRespawn() : true;
        if (killed || !wanted || respawnsLeft <= 0) throw e;
        respawnsLeft--;
        try { spawn.onRespawn?.(e); } catch { /* observability must not break the lifecycle */ }
      } finally {
        this.tokensInUse.delete(spawn.pid);
        disposeRpcResource(placement.stub);
      }
      // Respawn: fresh slot, re-verified placement. The handle's route target
      // and start() read `state.current`, so both re-point automatically.
      state.current = await this._placeDistinctPeer();
      if (state.handle) state.handle.respawns++;
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
      const stub = processPeerStub(ns.get(ns.idFromName(peerName)), peerName);
      const probe = await this._probePeer(stub, peerName);
      const candidate: PeerPlacementInternal = { stub, slot, peerName, isolateToken: probe.isolateToken };
      if (!denied.has(probe.isolateToken)) {
        if (colocated) disposeRpcResource(colocated.stub);
        return candidate;
      }
      if (colocated) disposeRpcResource(colocated.stub);
      colocated = candidate;
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
