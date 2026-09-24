/**
 * workerd-facet-host.ts — how a resident process is actually made, on workerd.
 *
 * `process-fabric.ts` says what a resident process IS, in terms no
 * runtime owns: a boot spec, a start contract, a handle that can be routed to
 * and released. This module is the one implementation of that on Cloudflare,
 * and everything here is a workerd mechanism rather than a Nimbus concept —
 * `ctx.facets`, the Worker Loader, `ctx.exports`, and the facet-index
 * arithmetic the slot book exists to satisfy.
 *
 * The split is what lets the contract be read without the platform: a host
 * that is not a Durable Object implements `ProcessHost` against the same
 * `HostedProcess` and never imports this file.
 */

import { disposeRpcResource } from '@nimbus-sh/platform/rpc-dispose.js';
import {
  getCtxExports,
  stagedBootAssembler,
  supervisorEntrypoint,
  supervisorEntrypointName,
} from './composition.js';
import {
  assertModuleMapWithinCodeLimit,
  beginLoaderFetch,
  facetNameCount,
  facetNameCountDurable,
  recordFacetNameMinted,
  recordLoaderId,
  withDynamicWorkerCapNamed,
  withFacetBudgetNamed,
} from './budgets.js';
import {
  RESIDENT_PROCESS_CLASS,
  residentLoaderConfig,
  type HostedProcess,
  type OneShotCodeSpec,
  type OneShotParams,
  type ProcessHostParams,
  type ResidentBootSpec,
  type ResidentDiskReader,
  type ResidentSupervisorProps,
} from './process-fabric.js';

// ── Loaded-worker entrypoint plumbing ───────────────────────────────────────

/** Structural surface of a NimbusLoadedEntrypoint RPC stub. */
export interface LoadedWorkerEntrypointStub {
  handleHttpRequest?: (request: Request) => Promise<Response>;
  fetch?(request: Request): Promise<Response>;
}

export interface NimbusCtxExports {
  NimbusLoadedEntrypoint?: (options: {
    props: {
      key: string;
      name: string | null;
      depth: number;
      supervisor: { doId: string; pid: number; writerId: string };
      stage?: unknown;
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
 * Mint a NimbusLoadedEntrypoint stub for a keyed dynamic worker. Used by the
 * one-shot runtime paths, which run a program to completion inside a single
 * request rather than leaving it resident: their module map is assembled in
 * that stateless entrypoint's own isolate, never in a session DO.
 */
export async function createLoadedWorkerEntrypoint(
  ctxExports: NimbusCtxExports,
  supervisor: { doId: string; pid: number; writerId: string },
  stage: unknown,
  name: string | null = null,
): Promise<LoadedWorkerEntrypointStub> {
  if (!ctxExports.NimbusLoadedEntrypoint) {
    throw new Error('Nimbus: ctx.exports.NimbusLoadedEntrypoint unavailable');
  }
  return await ctxExports.NimbusLoadedEntrypoint({
    props: {
      key: `nimbus-process:${supervisor.doId}:${supervisor.pid}`,
      name,
      depth: 0,
      supervisor,
      stage,
    },
  });
}

// ── Facet plumbing ──────────────────────────────────────────────────────────

/** The subset of a facet stub a resident process exposes to whoever opened it. */
interface ResidentFacetStub {
  startProcess(args?: unknown): Promise<unknown>;
  handleHttpRequest(request: Request): Promise<Response>;
  /**
   * A facet stub is a Durable Object stub, so it fetches. That is the one path
   * an upgrade can take: a 101 owns a live socket, which the RPC
   * Request/Response transport reconstructs rather than hands over.
   */
  fetch(request: Request): Promise<Response>;
}

/** `ctx.facets` — a Durable Object's named child actors. */
interface FacetContainer {
  get(name: string, start: () => Promise<{ class: unknown }>): ResidentFacetStub;
  abort(name: string, reason?: unknown): void;
  delete(name: string): void;
  /**
   * Present on deployed Cloudflare workerd, absent from the pinned
   * `@cloudflare/workers-types` and from local workerd ≤ 1.20260603.1 — see
   * {@link cloneStorage}, the one way the fabric calls it.
   */
  clone?(src: string, dst: string): void;
}

/** What an unkeyed `LOADER.load` hands back. */
interface LoadedWorkerStub {
  getEntrypoint(): LoadedWorkerEntrypointStub;
}

/**
 * `env.LOADER` — the Worker Loader binding, as used from inside a DO.
 *
 * Both arms are here because both are the same platform affordance seen from
 * the two lifetimes Nimbus runs programs under: `get` is keyed and yields a
 * Durable Object class, so a resident process can be re-entered; `load` is
 * unkeyed and yields a stateless entrypoint, which is all a program that ends
 * with its call can ever need.
 *
 * `get` stays wide on purpose: the platform passes a null id for the unkeyed
 * call and answers the callback with the code object or a promise of it, so a
 * narrower declaration would refuse the real binding. The fabric itself always
 * passes a string id and a promise callback.
 */
interface WorkerLoaderBinding {
  get(id: string | null, code: () => unknown): { getDurableObjectClass(name: string): unknown };
  load(code: unknown): LoadedWorkerStub;
}

/**
 * The bindings `processes` needs off whichever DO is hosting. A
 * staged boot's assembler may read more off the same env (Nimbus's reads
 * ASSETS); the env travels to it whole, so nothing further is named here.
 */
export interface ResidentFacetEnv {
  LOADER?: WorkerLoaderBinding;
}

function facetContainer(ctx: DurableObjectState): FacetContainer {
  const facets = (ctx as { facets?: unknown }).facets as FacetContainer | undefined;
  if (!facets || typeof facets.get !== 'function') {
    throw new Error(
      'Nimbus: ctx.facets is unavailable in this Durable Object; '
        + 'resident processes cannot be hosted',
    );
  }
  return facets;
}

/**
 * Fork one facet's entire SQLite into another by copy-on-write — the one way
 * the fabric calls `ctx.facets.clone`, because the raw call carries a hazard
 * measured on production workerd: ANY `src` that does not resolve to a
 * populated facet — a typo, a name not created yet, not merely the obvious
 * `''`/`'.'`/`'/'` — silently EMPTIES the destination and reports success. A
 * blocklist of bad names would pass a typo straight through and wipe a
 * process's filesystem while returning ok, so validation is positive on both
 * ends: the source must answer as populated before the clone runs, the
 * destination must answer as populated after it, and anything else fails
 * loud.
 *
 * `populated` is the caller's probe because populated-ness is the caller's
 * schema. The hosting actor cannot read a facet's SQLite from outside it, and
 * an EMPTIED facet still reports a 4,096-byte database — one page, the empty
 * file — so only a check that positively finds the caller's own data means
 * anything. The post-clone probe is not redundant with the pre-clone one: the
 * probe answers off the caller's accounting, and the capture races un-awaited
 * writes to the source, so the destination is verified rather than inferred.
 *
 * The primitive itself, measured: a reflink, 18–31 ms for a 45.73 MB corpus
 * and 34–54 ms for 1 GB — flat, because nothing is copied — with the data
 * visible from the destination's constructor. Same-Durable-Object only.
 * Quiesce and await writes to the source first; the destination name consumes
 * a facet ID on first use like any other facet name; and the shared ~10 GiB
 * storage budget grants no copy-on-write credit — crossing it resets the
 * object rather than raising an error.
 */
export async function cloneStorage(
  ctx: DurableObjectState,
  clone: {
    src: string;
    dst: string;
    populated(name: string): boolean | Promise<boolean>;
  },
): Promise<void> {
  const facets = facetContainer(ctx);
  if (typeof facets.clone !== 'function') {
    throw new Error(
      'Nimbus: ctx.facets.clone is unavailable in this runtime; the reflink image '
        + 'path needs deployed Cloudflare workerd (local workerd <= 1.20260603.1 lacks it)',
    );
  }
  const { src, dst } = clone;
  if (!(await clone.populated(src))) {
    throw new Error(
      `Nimbus: refusing to clone facet '${src}' into '${dst}': the source does not `
        + 'answer as populated, and cloning an unresolvable source silently EMPTIES '
        + 'the destination while reporting success',
    );
  }
  facets.clone(src, dst);
  if (!(await clone.populated(dst))) {
    throw new Error(
      `Nimbus: clone of facet '${src}' left the destination '${dst}' without the `
        + "source's data; the destination must not be booted from",
    );
  }
}

/**
 * The facet name for an ephemeral slot. Reused, and that is the entire point.
 *
 * A Durable Object admits 65,536 facets over its LIFETIME: the IDs are
 * append-only and are never reclaimed, so the bound is on facets ever CREATED,
 * not facets alive at once. Naming a facet after its pid, when pids never
 * repeat, therefore burned one of those IDs on every spawn — a long-lived
 * session would eventually exhaust its facet index with no way back, and the
 * failure is unrecoverable rather than merely slow.
 *
 * Reusing a NAME costs no new ID. So the name comes from a free list and the
 * pid stays what it always was: the process identity in the ProcessTable. The
 * two were only ever conflated because one of them happened to be handy.
 *
 * The book shares the facet-ID space with one other namespace: durable
 * applications, which mint `app-slot-<n>` names of their own (one ID per app,
 * ever). The prefixes are disjoint BY CONSTRUCTION, and that disjointness is
 * load-bearing — a proc-slot name reissued onto a durable app's retained
 * storage would boot the wrong process into someone else's disk.
 */
export function residentFacetName(slot: number): string {
  return `proc-slot-${slot}`;
}

/** The prefix every durable application's facet name carries. */
export const DURABLE_FACET_NAME_PREFIX = 'app-slot-';

/** One hosting actor's slot book. */
interface SlotBook {
  /** Returned slots, lowest reused first so the high-water mark stays low. */
  free: number[];
  /** The next never-yet-issued slot. */
  next: number;
  /** Slot held by each live pid, so release can find it. */
  held: Map<number, number>;
  /** Explicit (`app-slot-`) names this incarnation started a process under and has not released. */
  live: Set<string>;
}

/**
 * Slot books, per hosting actor, because the facet index is per Durable
 * Object.
 *
 * Keyed weakly off `ctx`, so a book describes one incarnation. A facet that
 * is still running when that incarnation ends outlives it (measured: a timer
 * or an outgoing call keeps it going), and a `get` of its name with a new
 * class then resets the whole object. So a fresh incarnation's first get of
 * each name ends whatever runs there first: a minted `proc-slot-` name is
 * deleted, which also wipes the storage a previous incarnation left, and an
 * explicit name is aborted, which keeps it.
 *
 * The book allocates only the `proc-slot-` space. Durable `app-slot-` names
 * are allocated against DO storage instead (their owner survives a reset), so
 * a fresh incarnation's `next` starting at 0 can never collide with them even
 * before the durable ledger is adopted.
 */
const slotBooks = new WeakMap<DurableObjectState, SlotBook>();

function slotBook(ctx: DurableObjectState): SlotBook {
  let book = slotBooks.get(ctx);
  if (!book) {
    book = { free: [], next: 0, held: new Map(), live: new Set() };
    slotBooks.set(ctx, book);
  }
  return book;
}

/**
 * Take a slot for `pid`, reusing a returned one before minting a new name.
 * `minted` names may still hold storage a previous incarnation of this actor
 * left there, so the caller deletes it before the first get.
 */
function acquireSlot(ctx: DurableObjectState, pid: number): { slot: number; minted: boolean } {
  const book = slotBook(ctx);
  const existing = book.held.get(pid);
  if (existing !== undefined) return { slot: existing, minted: false };
  const reused = book.free.length > 0;
  const slot = reused ? book.free.shift()! : book.next++;
  book.held.set(pid, slot);
  // A fresh name is a permanently consumed facet ID; the durable count lives
  // in the budgets ledger (see budgets.ts).
  if (!reused) recordFacetNameMinted(ctx, book.next);
  return { slot, minted: !reused };
}

/** Return `pid`'s slot to the free list. */
function releaseSlot(ctx: DurableObjectState, pid: number): void {
  const book = slotBook(ctx);
  const slot = book.held.get(pid);
  if (slot === undefined) return;
  book.held.delete(pid);
  book.free.push(slot);
  book.free.sort((a, b) => a - b);
}

/**
 * Drop one facet's SQLite by name — the ONLY call site that may delete facet
 * storage. `spawnResident` releases ephemeral processes with abort+delete
 * (storage is slot-reuse hygiene) and durable ones with abort alone (the
 * storage IS the durable application's state); explicit removal arrives here
 * through the coordinator's durable-slot book, owner-checked.
 */
export function deleteFacetStorage(ctx: DurableObjectState, name: string): void {
  facetContainer(ctx).delete(name);
}



/**
 * What `processes(ctx, env).spawn` hands back: a running process, minus its placement.
 *
 * `name` is the facet's real name and `slot` its ephemeral book entry (absent
 * for a durable spawn, whose name its coordinator allocated out of storage).
 * Both ride along because the caller's `describe` needs them and neither is
 * derivable from the pid — reading a slot back out of the book would race the
 * release that empties it.
 */
export type ResidentFacet = Omit<HostedProcess, 'describe'> & { name: string; slot?: number };

/**
 * The process surface of one hosting actor: how a resident process comes
 * into existence on workerd, and how a one-shot program runs to completion.
 *
 * `spawn` is the ONE way a resident process comes into existence, and every
 * substrate goes through it: the facet host calls it with the coordinator's
 * own `ctx`, the peer host calls it — over one RPC — with a sibling session
 * DO's. Everything a substrate could plausibly want to special-case is a
 * PARAMETER here rather than a branch: which actor hosts the child, and how
 * the boot spec's by-path members are read.
 */
export function processes(ctx: DurableObjectState, env: ResidentFacetEnv): Processes {
  return new Processes(ctx, env);
}

export class Processes {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: ResidentFacetEnv,
  ) {}

  /** Open a resident process as a facet of this actor, and start its runner. */
  spawn(
    disk: () => ResidentDiskReader,
    supervisor: ResidentSupervisorProps,
    params: ProcessHostParams,
  ): ResidentFacet {
    return spawnResident(this.ctx, this.env, disk, supervisor, params);
  }

  /**
   * Run one program to completion as an UNKEYED dynamic worker.
   *
   * Unkeyed is the whole difference from `spawn`: nothing can re-resolve this
   * worker into a later request's context, so it can never be a routeable
   * target and never has to be released by name. It exists for the duration
   * of one call and its stubs are dropped as that call unwinds.
   *
   * Shared by both substrates on purpose. `peer` places processes that have a
   * residency to place; a one-shot has none, and shipping its fully-inline
   * map across a sibling hop would meet the 32 MiB RPC ceiling that by-path
   * boot specs exist to avoid — for a run that gains nothing by moving.
   */
  run<T>(
    supervisor: ResidentSupervisorProps,
    params: OneShotParams,
    consume: (response: Response) => Promise<T>,
  ): Promise<T> {
    return runOneShot(this.ctx, this.env, supervisor, params, consume);
  }
}

function spawnResident(
  ctx: DurableObjectState,
  env: ResidentFacetEnv,
  disk: () => ResidentDiskReader,
  supervisor: ResidentSupervisorProps,
  params: ProcessHostParams,
): ResidentFacet {
  const facets = facetContainer(ctx);
  // An explicit name is the durable path: the caller allocated an
  // `app-slot-<n>` identity out of DO storage and this facet keeps its SQLite
  // across aborts. Anything else takes the in-memory book — and that book's
  // `proc-slot-` names must never be minted for it, or an ephemeral release's
  // delete would wipe the app's storage and a reused slot would land a new
  // process on someone else's disk.
  const explicit = params.facet;
  if (explicit && !explicit.name.startsWith(DURABLE_FACET_NAME_PREFIX)) {
    throw new Error(
      `Nimbus: an explicit facet name must carry the '${DURABLE_FACET_NAME_PREFIX}' `
        + `prefix, got '${explicit.name}'`,
    );
  }
  const grant = explicit ? undefined : acquireSlot(ctx, params.pid);
  const slot = grant?.slot;
  const name = explicit ? explicit.name : residentFacetName(slot!);
  if (grant?.minted) {
    try { facets.delete(name); } catch { /* nothing stored under this name */ }
  }
  // The start callback is the ONLY way this facet is ever created, and it
  // fires AT MOST ONCE. Every later use goes through the stub below, so the
  // callback running a second time means the facet was released or died —
  // and re-running it would evaluate the user's program again, answering a
  // request from a process they never started while the one they did start
  // is gone. Both cases are reported instead.
  let evaluated = false;
  let released = false;
  const start = async (): Promise<{ class: unknown }> => {
    if (released) {
      throw new Error(`Nimbus: resident process ${params.pid} is no longer running`);
    }
    if (evaluated) {
      throw new Error(
        `Nimbus: resident process ${params.pid} is no longer loaded (its facet was lost); `
          + 'it is not restarted',
      );
    }
    evaluated = true;
    return { class: residentProcessClass(ctx, env, disk, supervisor, params) };
  };
  const book = slotBook(ctx);
  let facet: ResidentFacetStub;
  try {
    // get() with a new class on a facet an earlier incarnation left running resets this object.
    if (explicit && !book.live.has(name)) {
      facets.abort(name, new Error('Nimbus: a new incarnation takes this facet name'));
    }
    facet = facets.get(name, start);
  } catch (error) {
    if (slot !== undefined) releaseSlot(ctx, params.pid);
    throw withFacetBudgetNamed(facetNameCount(ctx), error);
  }
  if (explicit) book.live.add(name);

  let disposed = false;
  const release = async () => {
    if (disposed) return;
    disposed = true;
    released = true;
    try { facets.abort(name, new Error('Nimbus: resident process released')); } catch { /* already gone */ }
    if (explicit) book.live.delete(name);
    // The two release classes: an ephemeral facet's SQLite is slot-reuse
    // hygiene — the name is handed out again, so the store must not be — and
    // a durable one's is the application itself: abort ends the process, the
    // data stays for the next boot, and only removeDurableApp's explicit
    // deleteFacetStorage call ever drops it.
    if (!explicit?.durable) {
      try { facets.delete(name); } catch { /* already gone */ }
    }
    // Only after the facet is gone. A slot handed out while its previous
    // tenant were still being torn down would have two processes on one name.
    if (slot !== undefined) releaseSlot(ctx, params.pid);
  };

  let started: Promise<unknown>;
  try {
    started = facet.startProcess(params.startArgs);
  } catch (error) {
    void release();
    throw withFacetBudgetNamed(facetNameCount(ctx), error);
  }
  // The rejection that carries the platform's failure at ID exhaustion is
  // this one, and it is annotated AFTER awaiting the ledger — the first
  // failure of a fresh incarnation must compare against the persisted count,
  // not the zero its adoption read has not yet replaced.
  started = started.catch(async (error) => {
    throw withFacetBudgetNamed(await facetNameCountDurable(ctx), error);
  });
  // A caller reads whichever of `started` and the lifecycle it needs, so keep
  // the runtime from reporting the other as an unhandled rejection.
  started.catch(() => {});
  return {
    started,
    // A facet cannot die without taking its Durable Object — and this object —
    // with it, so there is no independent death to report.
    lost: new Promise<never>(() => {}),
    handleHttpRequest: (request: Request) => facet.handleHttpRequest(request),
    handleWebSocketRequest: (request: Request) => facet.fetch(request),
    release,
    name,
    slot,
  };
}

/**
 * The dynamic worker's Durable Object class, minted in the caller's request
 * context. `LOADER.get` runs its callback only on a cache miss, so a process
 * assembles its module map at most once and the bytes never stay resident in
 * the hosting DO's heap.
 */
function residentProcessClass(
  ctx: DurableObjectState,
  env: ResidentFacetEnv,
  disk: () => ResidentDiskReader,
  supervisor: ResidentSupervisorProps,
  params: ProcessHostParams,
): unknown {
  const loader = env.LOADER;
  if (!loader || typeof loader.get !== 'function') {
    throw new Error(
      'Nimbus: env.LOADER binding missing or invalid. Resident processes require '
        + 'the Worker Loader binding; add it via worker_loaders in wrangler.jsonc.',
    );
  }
  try {
    const worker = loader
      .get(params.workerKey, () => residentWorkerConfig(env, disk, supervisor, params.boot))
      .getDurableObjectClass(RESIDENT_PROCESS_CLASS);
    recordLoaderId(ctx, params.workerKey);
    return worker;
  } catch (error) {
    throw withDynamicWorkerCapNamed(ctx, error);
  }
}

async function runOneShot<T>(
  ctx: DurableObjectState,
  env: ResidentFacetEnv,
  supervisor: ResidentSupervisorProps,
  params: OneShotParams,
  consume: (response: Response) => Promise<T>,
): Promise<T> {
  const loader = env.LOADER;
  if (!loader || typeof loader.load !== 'function') {
    throw new Error(
      'Nimbus: env.LOADER binding missing or invalid. Running a program requires '
        + 'the Worker Loader binding; add it via worker_loaders in wrangler.jsonc.',
    );
  }
  const supervisorRpc = supervisorEntrypoint(undefined, supervisor.route?.supervisorEntrypoint);
  let supervisorBinding: unknown;
  let worker: LoadedWorkerStub | undefined;
  let entrypoint: LoadedWorkerEntrypointStub | undefined;
  try {
    // Built before the capability is minted: nothing can write as this writer
    // until there is a program to do the writing, and a map that fails to
    // assemble should not have granted append authority on its way out.
    let spec: OneShotCodeSpec | undefined = await params.code();
    assertModuleMapWithinCodeLimit(spec.modules);
    if (supervisorRpc) {
      params.onWriterActivated(params.writerId);
      supervisorBinding = supervisorRpc({ props: supervisor });
    }
    worker = loader.load({
      compatibilityDate: spec.compatibilityDate,
      compatibilityFlags: spec.compatibilityFlags,
      mainModule: spec.mainModule,
      modules: spec.modules,
      ...(supervisorBinding ? { env: { SUPERVISOR: supervisorBinding } } : {}),
    });
    // The loader has taken the map; holding it here would keep a second full
    // copy of the program alive for as long as the program runs.
    spec = undefined;
    entrypoint = worker.getEntrypoint();
    // Narrowed by the runtime check; kept as a property call on the stub —
    // extracting the method builds a pipelined `fetch.call` path workerd
    // refuses for dynamically-loaded workers.
    const ep = entrypoint as LoadedWorkerEntrypointStub & { fetch(request: Request): Promise<Response> };
    if (typeof ep.fetch !== 'function') {
      throw new Error('Nimbus: one-shot runtime entrypoint has no fetch method');
    }
    params.onLoaded?.();
    // The unkeyed worker is a live dynamic worker for exactly this call, so
    // the run is a Loader fetch on the hosting actor's ledger — bracketed,
    // never wrapped: see beginLoaderFetch for the measured DO-poisoning
    // hazard, and the pipelined-`fetch.call` note above for its sibling.
    const endFetch = beginLoaderFetch(ctx);
    let response: Response;
    try {
      response = await ep.fetch(params.request);
    } finally {
      endFetch();
    }
    try {
      return await consume(response);
    } finally {
      disposeRpcResource(response);
    }
  } catch (error) {
    throw withDynamicWorkerCapNamed(ctx, error);
  } finally {
    disposeRpcResource(entrypoint);
    disposeRpcResource(worker);
    disposeRpcResource(supervisorBinding);
  }
}

/**
 * The WorkerCode the loader callback returns for one resident boot: the
 * module map from {@link residentLoaderConfig} (or the staged assembler),
 * plus the isolate's env and network posture.
 *
 * A `code` boot with an explicit `env` — defined, even as `{}` — is the
 * embedder's whole statement about the isolate: the env rides through
 * exactly as minted (loopback stubs by reference), and the composed supervisor
 * entrypoint is not consulted at all, so no SUPERVISOR binding appears.
 * Without one, the default holds: inherited network plus a SUPERVISOR
 * minted from the composed entrypoint for the coordinator's identity.
 */
export async function residentWorkerConfig(
  env: ResidentFacetEnv,
  disk: () => ResidentDiskReader,
  supervisor: ResidentSupervisorProps,
  boot: ResidentBootSpec,
): Promise<Record<string, unknown>> {
  if (boot.kind === 'code' && boot.code.env !== undefined) {
    const isolated = await residentLoaderConfig(boot.code, disk());
    assertModuleMapWithinCodeLimit(configModules(isolated));
    return isolated;
  }
  const config = boot.kind === 'staged'
    ? await stagedBootAssembler()(env, boot.stage)
    : await residentLoaderConfig(boot.code, disk());
  assertModuleMapWithinCodeLimit(configModules(config));
  const supervisorRpc = supervisorEntrypoint(undefined, supervisor.route?.supervisorEntrypoint);
  if (!supervisorRpc) {
    throw new Error(`Nimbus: ctx.exports.${supervisor.route?.supervisorEntrypoint ?? supervisorEntrypointName() ?? '<supervisor entrypoint>'} unavailable`);
  }
  return { ...config, env: { SUPERVISOR: supervisorRpc({ props: supervisor }) } };
}

/** The module map a loader config assembled, or empty when it named none. */
function configModules(config: object): Record<string, unknown> {
  const modules: unknown = 'modules' in config ? config.modules : undefined;
  if (typeof modules !== 'object' || modules === null) return {};
  // Loader configs only ever carry a module map under this key.
  const map: Record<string, unknown> = modules as Record<string, unknown>;
  return map;
}
