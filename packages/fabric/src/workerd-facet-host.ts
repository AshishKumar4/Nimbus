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
import { describeError, isUnexplainedPlatformError } from '@nimbus-sh/platform/oom-classify.js';
import { errorText } from '@nimbus-sh/core/_shared/error-text.js';
import { StorageLedger, forgetFacetStorage } from '@nimbus-sh/core/runtime/storage-ledger.js';
import type { SqlDatabase } from '@nimbus-sh/core/runtime/os-contracts.js';
import {
  getCtxExports,
  stagedBootAssembler,
  supervisorEntrypoint,
  supervisorEntrypointName,
} from './composition.js';
import {
  assertModuleMapWithinCodeLimit,
  beginLoaderFetch,
  beginLoaderFetchWhenFree,
  claimAdmission,
  facetNameCount,
  facetNameCountDurable,
  chargeFacetSlot,
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
import { supervisorLoaderKey, mintProcessSupervisor, type SupervisorBindingProps } from './supervisor-props.js';

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
      supervisor: ResidentSupervisorProps;
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
  supervisor: ResidentSupervisorProps,
  stage: unknown,
  name: string | null = null,
): Promise<LoadedWorkerEntrypointStub> {
  if (!ctxExports.NimbusLoadedEntrypoint) {
    throw new Error('Nimbus: ctx.exports.NimbusLoadedEntrypoint unavailable');
  }
  return await ctxExports.NimbusLoadedEntrypoint({
    props: {
      // The entrypoint's loader outlives this instance, and a warm worker keeps
      // the SUPERVISOR binding it was built with.
      key: supervisorLoaderKey(`nimbus-process:${supervisor.doId}:${supervisor.pid}`, supervisor),
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
   * Declared by `@cloudflare/workers-types` 5 and present in workerd
   * ≥ 1.20260926.1 and in production; an embedder's older local workerd
   * (≤ 1.20260603.1) lacks it — see {@link cloneStorage}, the one way the
   * fabric calls it.
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
        + 'path needs workerd 1.20260926.1 or later, or deployed Cloudflare workerd',
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
 * The facet name for an ephemeral slot.
 *
 * A Durable Object admits 65,536 facets over its LIFETIME: the IDs are
 * append-only and are never reclaimed, so every name ever created spends one,
 * and the lifetime ledger (budgets.ts) counts them and names the wall.
 *
 * A released name is not handed to a later process of the same incarnation,
 * though that would cost no new ID. Getting a name a just-released process
 * held, with the next process's class, failed on Cloudflare: the next
 * process's first call answered "internal error; reference = …" with
 * durableObjectReset. That was vite8 after vinext, 7 of 7 on a throwaway,
 * while 4 of 4 started on a fresh name (2026-10-07). An earlier reuse, of a
 * released name's kept store, reset the whole object (82894375b). The
 * platform gives no signal that a released facet is gone, so no reuse can be
 * timed to follow it. The pid stays what it always was: the process
 * identity in the ProcessTable.
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
    book = { next: 0, held: new Map(), live: new Set() };
    slotBooks.set(ctx, book);
  }
  return book;
}

/**
 * Take the next slot for `pid` (residentFacetName: never one a released
 * process held), or the one it holds. A `minted` name may still hold storage
 * a previous incarnation of this actor left there, so the caller deletes it
 * before the first get. The caller charges the slot (chargeFacetSlot) before
 * its facet is created.
 */
function acquireSlot(ctx: DurableObjectState, pid: number): { slot: number; minted: boolean } {
  const book = slotBook(ctx);
  const existing = book.held.get(pid);
  if (existing !== undefined) return { slot: existing, minted: false };
  const slot = book.next++;
  book.held.set(pid, slot);
  return { slot, minted: true };
}

/** `pid` holds no slot from here on; its name is never handed out again. */
function releaseSlot(ctx: DurableObjectState, pid: number): void {
  slotBook(ctx).held.delete(pid);
}

/**
 * Drop one facet's SQLite by name, and its row in the session's storage
 * ledger (N18) in the same step: the only way a facet database is deleted.
 * `spawnResident` releases ephemeral processes with abort+delete (storage is
 * slot-reuse hygiene) and durable ones with abort alone (the storage IS the
 * durable application's state); explicit removal arrives here through the
 * coordinator's durable-slot book, owner-checked.
 */
/** The session's storage ledger (N18), over this actor's SQL; null where it has none. */
function sessionLedger(ctx: DurableObjectState): StorageLedger | null {
  const sql = (ctx as { storage?: { sql?: SqlDatabase } }).storage?.sql;
  return sql ? new StorageLedger(sql) : null;
}

const facetNames = new WeakMap<object, Map<number, string>>();

function facetOfPid(ctx: DurableObjectState): Map<number, string> {
  let names = facetNames.get(ctx);
  if (!names) facetNames.set(ctx, names = new Map());
  return names;
}

/** The facet a running resident process `pid` lives in on this actor, for its storage ledger row. */
export function residentFacetOf(ctx: DurableObjectState, pid: number): string | undefined {
  return facetNames.get(ctx)?.get(pid);
}

export function deleteFacetStorage(ctx: DurableObjectState, name: string): void {
  facetContainer(ctx).delete(name);
  const sql = (ctx as { storage?: { sql?: SqlDatabase } }).storage?.sql;
  if (sql) forgetFacetStorage(sql, name);
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
    try { deleteFacetStorage(ctx, name); } catch { /* nothing stored under this name */ }
  }
  // A slot's name is a lifetime facet ID the first time it is created, so it
  // is charged, durably, before the first call creates the facet. Charged on
  // every use: a slot whose charge failed is reused uncharged otherwise, and
  // one already counted costs nothing. An explicit name was charged when it
  // was allocated (acquireDurableFacetSlot).
  const charged = slot === undefined ? Promise.resolve() : chargeFacetSlot(ctx, slot);
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
    return { class: residentProcessClass(env, disk, supervisor, params, loaderKey) };
  };
  const book = slotBook(ctx);
  const ledger = sessionLedger(ctx);
  // A warm worker keeps the SUPERVISOR binding it was built with, and the
  // loader outlives this instance.
  const loaderKey = supervisorLoaderKey(params.workerKey, supervisor);
  let facet: ResidentFacetStub;
  try {
    // N18: the fill is admitted, and recorded under the facet's name, before
    // the facet exists; a refusal leaves no facet.
    if (ledger !== null && params.storageBytes !== undefined) ledger.fill(name, params.storageBytes);
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
  // The facet's worker is one Dynamic Worker in flight for as long as the
  // process is resident, not only while a call is open: its WebSockets and
  // streamed responses outlive the calls the ledger could bracket, and a
  // request can reach it at any moment. Held from here to `release`, so no
  // fan-out spends the slot a running process needs.
  const endResidency = beginLoaderFetch(ctx, loaderKey, undefined, params.pid);
  facetOfPid(ctx).set(params.pid, name);

  let disposed = false;
  const release = async () => {
    if (disposed) return;
    disposed = true;
    released = true;
    facetOfPid(ctx).delete(params.pid);
    endResidency();
    try { facets.abort(name, new Error('Nimbus: resident process released')); } catch { /* already gone */ }
    if (explicit) book.live.delete(name);
    // The two release classes: an ephemeral facet's SQLite is the process's
    // alone, so it goes with it, and a durable one's is the application
    // itself: abort ends the process, the data stays for the next boot, and
    // only removeDurableApp's explicit deleteFacetStorage call ever drops it.
    if (!explicit?.durable) {
      try { deleteFacetStorage(ctx, name); } catch { /* already gone */ }
    }
    if (slot !== undefined) releaseSlot(ctx, params.pid);
  };

  let started: Promise<unknown>;
  try {
    // The allowance the ledger admitted, for the facet's store to keep under.
    const startArgs = ledger !== null && params.storageBytes !== undefined && params.startArgs !== null && typeof params.startArgs === 'object'
      ? { ...(params.startArgs as Record<string, unknown>), storage: { facet: name, grant: params.storageBytes } }
      : params.startArgs;
    started = charged.then(() => facet.startProcess(startArgs));
  } catch (error) {
    void release();
    throw withFacetBudgetNamed(facetNameCount(ctx), error);
  }
  // The rejection that carries the platform's failure at ID exhaustion is
  // this one, and it is annotated AFTER awaiting the ledger — the first
  // failure of a fresh incarnation must compare against the persisted count,
  // not the zero its adoption read has not yet replaced.
  started = started.then((payload) => {
    // Once the facet is up (N18) its row is the cap its store keeps under
    // (what it measures plus what it may still grow into), or what it
    // measures if that is more (overshoot).
    const { databaseSize: size, storageCap: cap } = (payload ?? {}) as { databaseSize?: unknown; storageCap?: unknown };
    const measured = typeof size === 'number' && Number.isFinite(size) ? size : null;
    const capped = typeof cap === 'number' && Number.isFinite(cap) ? cap : null;
    const row = capped !== null ? Math.max(capped, measured ?? 0) : measured;
    if (ledger !== null && row !== null) ledger.reportSize(name, row);
    return payload;
  }, async (error) => {
    // A start that rejects after its release is the process ending or being
    // ended as it booted (json-server --version), not a failure to start.
    const named = released ? error : startFailure(error, name, params.pid);
    // The count is read only to name the budget: a count storage cannot answer names nothing.
    const consumed = await facetNameCountDurable(ctx).catch(() => null);
    throw consumed === null ? named : withFacetBudgetNamed(consumed, named);
  });
  // A caller reads whichever of `started` and the lifecycle it needs, so keep
  // the runtime from reporting the other as an unhandled rejection.
  started.catch(() => {});
  return {
    started,
    // A facet cannot die without taking its Durable Object — and this object —
    // with it, so there is no independent death to report.
    lost: new Promise<never>(() => {}),
    // A request can arrive before the boot call; it creates the facet as that call would.
    handleHttpRequest: (request: Request) => charged.then(() => facet.handleHttpRequest(request)),
    handleWebSocketRequest: (request: Request) => charged.then(() => facet.fetch(request)),
    release,
    name,
    slot,
  };
}

/**
 * A resident's failed start, logged to the session's log with the facet and
 * process it was, and answered as the error the user sees. A failure the
 * platform does not explain (isUnexplainedPlatformError) is named for them:
 * which facet, which process, whether the platform reset it, and its
 * reference. Any other failure already says what went wrong and stands.
 */
function startFailure(error: unknown, name: string, pid: number): unknown {
  const reset = typeof error === 'object' && error !== null && Reflect.get(error, 'durableObjectReset') === true;
  console.error(`Nimbus: process ${pid} failed to start in facet '${name}'${reset ? ', which the platform reset' : ''}: ${describeError(error)}`);
  if (!isUnexplainedPlatformError(error)) return error;
  const what = reset
    ? `reset facet '${name}' as it started process ${pid}`
    : `failed to start process ${pid} in facet '${name}'`;
  return new Error(`Nimbus: Cloudflare ${what}, and gave no cause (${errorText(error)})`, { cause: error });
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
  loaderKey: string,
): unknown {
  const loader = env.LOADER;
  if (!loader || typeof loader.get !== 'function') {
    throw new Error(
      'Nimbus: env.LOADER binding missing or invalid. Resident processes require '
        + 'the Worker Loader binding; add it via worker_loaders in wrangler.jsonc.',
    );
  }
  return loader
    .get(loaderKey, () => residentWorkerConfig(env, disk, supervisor, params.boot))
    .getDurableObjectClass(RESIDENT_PROCESS_CLASS);
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
  // The unkeyed worker is one distinct dynamic worker in flight until its
  // response is consumed (the body streams from it), keyed by this run's
  // writer id. It is let in by the ledger: while this Durable Object has its
  // limit of workers in flight (other runs, residents, fan-outs), the run
  // waits, before its module map is assembled, for a release to make room,
  // rather than being refused by the platform. So a burst of programs (a
  // parent's children, a shell's background jobs) runs as wide as the limit
  // and no wider, and holds at most that many maps at once. The run's own
  // abort (a kill, Ctrl-C) ends the wait, and so does the ledger when room
  // can never come, every holder blocked on children that wait here
  // (DynamicWorkerDeadlockError, EAGAIN). Bracketed, never
  // wrapped: see beginLoaderFetch for the measured DO-poisoning hazard, and
  // the pipelined-`fetch.call` note below for its sibling.
  // A run inside an admitted launch (withLaunchAdmission) is that launch's
  // worker, already let in (claimAdmission), whatever pid it runs as.
  const endFetch = claimAdmission(ctx, params.pid) ?? await beginLoaderFetchWhenFree(ctx, `one-shot:${params.writerId}`, {
    signal: params.request.signal,
    process: { pid: params.pid },
  });
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
      supervisorBinding = mintProcessSupervisor(supervisorRpc, supervisor);
    }
    worker = loader.load({
      compatibilityDate: spec.compatibilityDate,
      compatibilityFlags: spec.compatibilityFlags,
      mainModule: spec.mainModule,
      modules: spec.modules,
      ...(supervisorBinding ? { env: { SUPERVISOR: supervisorBinding, ...egressMarker(supervisor) } } : {}),
      // The same binding answers its network (SupervisorRPC.fetch/connect), which goes out
      // through the workspace's egress; else the egress itself, when there is one.
      ...(supervisorBinding && params.outbound
        ? { globalOutbound: supervisorBinding }
        : supervisor.egress !== undefined ? { globalOutbound: supervisor.egress } : {}),
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
    try {
      const response = await ep.fetch(params.request);
      try {
        return await consume(response);
      } finally {
        disposeRpcResource(response);
      }
    } catch (error) {
      // A limit refusal pauses the ledger's admissions (beginLoaderFetchWhenFree).
      endFetch(error);
      throw error;
    }
  } catch (error) {
    throw withDynamicWorkerCapNamed(ctx, error);
  } finally {
    endFetch();
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
    const isolated = workspaceOutbound(await residentLoaderConfig(boot.code, disk()), supervisor);
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
  return { ...workspaceOutbound(config, supervisor), env: { SUPERVISOR: mintProcessSupervisor(supervisorRpc, supervisor), ...egressMarker(supervisor) } };
}

/**
 * What tells a process its network goes through an egress (`NIMBUS_EGRESS`):
 * its node:tls refuses a TLS socket by name (EGRESS_TLS_REFUSAL), since the
 * egress's connect carries plain TCP only.
 */
function egressMarker(supervisor: Pick<SupervisorBindingProps, 'egress'>): { NIMBUS_EGRESS?: true } {
  return supervisor.egress === undefined ? {} : { NIMBUS_EGRESS: true };
}

/**
 * `config` with the workspace's egress as its network when it states none:
 * a process inherits its workspace's network, and under an egress
 * (SupervisorBindingProps.egress) that is the egress. An explicit
 * globalOutbound (a binding that mediates, or null that denies) stands.
 */
function workspaceOutbound<C extends object>(config: C, supervisor: Pick<SupervisorBindingProps, 'egress'>): C | (C & { globalOutbound: unknown }) {
  if (supervisor.egress === undefined || 'globalOutbound' in config) return config;
  return { ...config, globalOutbound: supervisor.egress };
}

/** The module map a loader config assembled, or empty when it named none. */
function configModules(config: object): Record<string, unknown> {
  const modules: unknown = 'modules' in config ? config.modules : undefined;
  if (typeof modules !== 'object' || modules === null) return {};
  // Loader configs only ever carry a module map under this key.
  const map: Record<string, unknown> = modules as Record<string, unknown>;
  return map;
}
