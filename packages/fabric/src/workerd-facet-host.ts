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
  supervisorEntrypoint,
  supervisorEntrypointName,
} from './ctx-exports.js';
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
  requireStagedBootAssembler,
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
   * {@link cloneFacetStorage}, the one way the fabric calls it.
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
 */
interface WorkerLoaderBinding {
  get(id: string, code: () => Promise<unknown>): { getDurableObjectClass(name: string): unknown };
  load(code: unknown): LoadedWorkerStub;
}

/**
 * The bindings `openResidentFacet` needs off whichever DO is hosting. A
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
export async function cloneFacetStorage(
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
 * The facet name for a slot. Reused, and that is the entire point.
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
 */
export function residentFacetName(slot: number): string {
  return `proc-slot-${slot}`;
}

/** One hosting actor's slot book. */
interface SlotBook {
  /** Returned slots, lowest reused first so the high-water mark stays low. */
  free: number[];
  /** The next never-yet-issued slot. */
  next: number;
  /** Slot held by each live pid, so release can find it. */
  held: Map<number, number>;
}

/**
 * Slot books, per hosting actor, because the facet index is per Durable
 * Object.
 *
 * Keyed weakly off `ctx`, and that is sound rather than lossy: a facet cannot
 * outlive the Durable Object hosting it, so a book that goes away with its
 * host describes nothing that still exists. A fresh incarnation restarts at
 * slot 0 and re-attaches to the SQLite a previous incarnation left there —
 * which is safe for the reason the store is sealed until it has reconciled.
 * Its persisted cursor is either datable against the current authority, in
 * which case the ACQUIRE delta brings it current, or it carries a different
 * VFS epoch, in which case `invalidatedSince` can only answer poison and the
 * whole store is dropped. A process therefore cannot boot onto a previous
 * tenant's filesystem even when release never ran.
 */
const slotBooks = new WeakMap<DurableObjectState, SlotBook>();

function slotBook(ctx: DurableObjectState): SlotBook {
  let book = slotBooks.get(ctx);
  if (!book) {
    book = { free: [], next: 0, held: new Map() };
    slotBooks.set(ctx, book);
  }
  return book;
}

/** Take a slot for `pid`, reusing a returned one before minting a new name. */
function acquireSlot(ctx: DurableObjectState, pid: number): number {
  const book = slotBook(ctx);
  const existing = book.held.get(pid);
  if (existing !== undefined) return existing;
  const reused = book.free.length > 0;
  const slot = reused ? book.free.shift()! : book.next++;
  book.held.set(pid, slot);
  // A fresh name is a permanently consumed facet ID; the durable count lives
  // in the budgets ledger (see budgets.ts).
  if (!reused) recordFacetNameMinted(ctx, book.next);
  return slot;
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
 * What `openResidentFacet` hands back: a running process, minus its placement.
 *
 * `slot` rides along because the caller's `describe` needs the facet's real
 * name and the slot is not derivable from the pid — that indirection is the
 * whole point of the free list. Reading it back out of the book later would
 * also race the release that empties it.
 */
export type ResidentFacet = Omit<HostedProcess, 'describe'> & { slot: number };

/**
 * Open a resident process as a facet of the actor whose `ctx` and `env` are
 * given, and start its runner.
 *
 * This is the ONE way a resident process comes into existence, and every
 * substrate goes through it: the facet host calls it with the coordinator's
 * own `ctx`, the peer host calls it — over one RPC — with a sibling session
 * DO's. Everything a substrate could plausibly want to special-case is a
 * PARAMETER here rather than a branch: which actor hosts the child, and how
 * the boot spec's by-path members are read.
 */
export function openResidentFacet(
  ctx: DurableObjectState,
  env: ResidentFacetEnv,
  disk: () => ResidentDiskReader,
  supervisor: ResidentSupervisorProps,
  params: ProcessHostParams,
): ResidentFacet {
  const facets = facetContainer(ctx);
  const slot = acquireSlot(ctx, params.pid);
  const name = residentFacetName(slot);
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
  let facet: ResidentFacetStub;
  try {
    facet = facets.get(name, start);
  } catch (error) {
    releaseSlot(ctx, params.pid);
    throw withFacetBudgetNamed(facetNameCount(ctx), error);
  }

  let disposed = false;
  const release = async () => {
    if (disposed) return;
    disposed = true;
    released = true;
    try { facets.abort(name, new Error('Nimbus: resident process released')); } catch { /* already gone */ }
    try { facets.delete(name); } catch { /* already gone */ }
    // Only after the facet is gone. A slot handed out while its previous
    // tenant were still being torn down would have two processes on one name.
    releaseSlot(ctx, params.pid);
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

/**
 * Run one program to completion as an UNKEYED dynamic worker.
 *
 * Unkeyed is the whole difference from `openResidentFacet`: nothing can
 * re-resolve this worker into a later request's context, so it can never be a
 * routeable target and never has to be released by name. It exists for the
 * duration of one call and its stubs are dropped as that call unwinds.
 *
 * Shared by both substrates on purpose. `peer` places processes that have a
 * residency to place; a one-shot has none, and shipping its fully-inline map
 * across a sibling hop would meet the 32 MiB RPC ceiling that by-path boot
 * specs exist to avoid — for a run that gains nothing by moving.
 */
export async function runOneShotWorker<T>(
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
  const supervisorRpc = supervisorEntrypoint();
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

async function residentWorkerConfig(
  env: ResidentFacetEnv,
  disk: () => ResidentDiskReader,
  supervisor: ResidentSupervisorProps,
  boot: ResidentBootSpec,
): Promise<Record<string, unknown>> {
  const config = boot.kind === 'staged'
    ? await requireStagedBootAssembler()(env, boot.stage)
    : await residentLoaderConfig(boot.code, disk());
  assertModuleMapWithinCodeLimit(
    (config as { modules?: Record<string, unknown> }).modules ?? {},
  );
  const supervisorRpc = supervisorEntrypoint();
  if (!supervisorRpc) {
    throw new Error(
      `Nimbus: ctx.exports.${supervisorEntrypointName() ?? '<supervisor entrypoint>'} unavailable`,
    );
  }
  return { ...config, env: { SUPERVISOR: supervisorRpc({ props: supervisor }) } };
}
