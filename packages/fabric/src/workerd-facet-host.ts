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

import { disposeRpcResource } from '@nimbus-sh/core/_shared/rpc-dispose.js';
import {
  getCtxExports,
  supervisorEntrypoint,
  supervisorEntrypointName,
} from './ctx-exports.js';
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

/**
 * Total bytes a dynamic Worker's module map may carry, across every member of
 * it. A hard platform limit, not a policy knob: 62 MiB lands and 64 MiB is
 * refused with "Dynamic Worker code size (N bytes) exceeds the maximum allowed
 * size of 67108864 bytes", confirmed at five sizes with two trials each. The
 * budget is shared, so a ruby process is already 34.3 MiB down before its disk
 * is counted.
 */
export const DYNAMIC_WORKER_CODE_LIMIT_BYTES = 67_108_864;

// ── Facet plumbing ──────────────────────────────────────────────────────────

/** The subset of a facet stub a resident process exposes to whoever opened it. */
interface ResidentFacetStub {
  startProcess(args?: unknown): Promise<unknown>;
  handleHttpRequest(request: Request): Promise<Response>;
}

/** `ctx.facets` — a Durable Object's named child actors. */
interface FacetContainer {
  get(name: string, start: () => Promise<{ class: unknown }>): ResidentFacetStub;
  abort(name: string, reason?: unknown): void;
  delete(name: string): void;
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

/**
 * Facet IDs a Durable Object is granted over its LIFETIME. Append-only and
 * never reclaimed, so crossing it is unrecoverable for the object — which is
 * why the ledger below counts consumption durably instead of leaving the
 * bound as prose the slot book merely respects.
 */
export const FACET_ID_LIFETIME_BUDGET = 65_536;

/** Where the ledger persists the count of facet names ever minted. */
export const FACET_NAME_HIGH_WATER_KEY = 'fabric_facet_name_high_water';

/** One hosting actor's slot book. */
interface SlotBook {
  /** Returned slots, lowest reused first so the high-water mark stays low. */
  free: number[];
  /** The next never-yet-issued slot. */
  next: number;
  /** Slot held by each live pid, so release can find it. */
  held: Map<number, number>;
  /**
   * The durable high-water of names ever minted, as an adopt-then-advance
   * chain. It starts as the read of {@link FACET_NAME_HIGH_WATER_KEY} and
   * every later link writes only a LARGER count — a fresh incarnation restarts
   * `next` at zero, and a write that had not adopted first would clobber the
   * lifetime count down to this incarnation's. The chain never rejects.
   */
  ledger: Promise<number>;
  /** The largest count the chain has adopted or written, for sync reads. */
  ledgerKnown: number;
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
    const created: SlotBook = {
      free: [],
      next: 0,
      held: new Map(),
      ledger: Promise.resolve(0),
      ledgerKnown: 0,
    };
    created.ledger = Promise.resolve(ctx.storage.get(FACET_NAME_HIGH_WATER_KEY))
      .then((value) => (typeof value === 'number' ? value : 0))
      .catch(() => 0)
      .then((adopted) => {
        created.ledgerKnown = Math.max(created.ledgerKnown, adopted);
        return adopted;
      });
    book = created;
    slotBooks.set(ctx, book);
  }
  return book;
}

/**
 * The lifetime facet-ID ledger: how many facet names this fabric has ever
 * minted on the Durable Object, against the 65,536 the platform will ever
 * grant it. `consumed` only ever counts FIRST uses — a reused name, in this
 * incarnation or any earlier one, cost no new ID, which is the slot book's
 * whole reason to exist. Surfaced so an operator can see proximity to a wall
 * whose crossing is unrecoverable, instead of discovering it from the
 * platform's opaque failure.
 */
export async function facetIdBudget(
  ctx: DurableObjectState,
): Promise<{ consumed: number; budget: number }> {
  const book = slotBook(ctx);
  const durable = await book.ledger;
  return {
    consumed: Math.max(durable, book.next),
    budget: FACET_ID_LIFETIME_BUDGET,
  };
}

/** Take a slot for `pid`, reusing a returned one before minting a new name. */
function acquireSlot(ctx: DurableObjectState, pid: number): number {
  const book = slotBook(ctx);
  const existing = book.held.get(pid);
  if (existing !== undefined) return existing;
  const reused = book.free.length > 0;
  const slot = reused ? book.free.shift()! : book.next++;
  book.held.set(pid, slot);
  if (!reused) recordNameMinted(ctx, book);
  return slot;
}

/**
 * Advance the durable ledger to this incarnation's name count, if it is a new
 * lifetime high. Chained behind adoption so the comparison is always against
 * the real persisted value; a failed write leaves the old link's count and the
 * next mint tries again — the ledger may transiently undercount, never over.
 */
function recordNameMinted(ctx: DurableObjectState, book: SlotBook): void {
  const count = book.next;
  book.ledger = book.ledger.then(async (durable) => {
    if (count <= durable) return durable;
    try {
      await ctx.storage.put(FACET_NAME_HIGH_WATER_KEY, count);
    } catch {
      return durable;
    }
    book.ledgerKnown = Math.max(book.ledgerKnown, count);
    return count;
  });
}

/**
 * Name the facet-ID budget on a creation failure at the wall; below it, hand
 * the error back untouched. Exhaustion is the one failure here the platform
 * reports opaquely AND that no teardown, retry or reset can undo, so the
 * ledger — the only witness to the real cause — does the naming. Not a
 * threshold: the comparison is against the budget itself.
 */
function withFacetBudgetNamed(consumed: number, error: unknown): unknown {
  if (consumed < FACET_ID_LIFETIME_BUDGET) return error;
  const platform = error instanceof Error ? error.message : String(error);
  return new Error(
    `Nimbus: facet creation failed with this Durable Object's `
      + `${FACET_ID_LIFETIME_BUDGET.toLocaleString('en-US')} facet-ID lifetime budget consumed `
      + `(${consumed} facet names ever created). Facet IDs are append-only and never reclaimed, `
      + `so this failure is permanent for the object: ${platform}`,
    { cause: error },
  );
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
  const book = slotBook(ctx);
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
    return { class: residentProcessClass(env, disk, supervisor, params) };
  };
  let facet: ResidentFacetStub;
  try {
    facet = facets.get(name, start);
  } catch (error) {
    releaseSlot(ctx, params.pid);
    throw withFacetBudgetNamed(Math.max(book.ledgerKnown, book.next), error);
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
    throw withFacetBudgetNamed(Math.max(book.ledgerKnown, book.next), error);
  }
  // The rejection that carries the platform's failure at ID exhaustion is
  // this one, and it is annotated AFTER awaiting the ledger — the first
  // failure of a fresh incarnation must compare against the persisted count,
  // not the zero its adoption read has not yet replaced.
  started = started.catch(async (error) => {
    const durable = await book.ledger;
    throw withFacetBudgetNamed(Math.max(durable, book.next), error);
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
  return loader
    .get(params.workerKey, () => residentWorkerConfig(env, disk, supervisor, params.boot))
    .getDurableObjectClass(RESIDENT_PROCESS_CLASS);
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
    if (typeof entrypoint.fetch !== 'function') {
      throw new Error('Nimbus: one-shot runtime entrypoint has no fetch method');
    }
    params.onLoaded?.();
    const response = await entrypoint.fetch(params.request);
    try {
      return await consume(response);
    } finally {
      disposeRpcResource(response);
    }
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
  const supervisorRpc = supervisorEntrypoint();
  if (!supervisorRpc) {
    throw new Error(
      `Nimbus: ctx.exports.${supervisorEntrypointName() ?? '<supervisor entrypoint>'} unavailable`,
    );
  }
  return { ...config, env: { SUPERVISOR: supervisorRpc({ props: supervisor }) } };
}
