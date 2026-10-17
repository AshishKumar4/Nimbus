/**
 * Supervisor-local byte-budget back-pressure for transient allocations.
 *
 * A DO can share its isolate's 128 MiB platform ceiling with peer DOs, so
 * independent "safe" allocations cannot each assume the full ceiling.
 * Module scope gives every allocator in one supervisor isolate a single FIFO
 * budget. Full-budget owners are exclusive; weighted owners may overlap only
 * while their retained-byte claims fit together.
 */

import {
  CHUNK_SIZE,
  SUPERVISOR_IN_FLIGHT_ALLOCATION_BUDGET_BYTES,
  SUPERVISOR_LOAD_WAIT_MS,
  SUPERVISOR_READ_RESERVE_BYTES,
} from './limits.js';
import {
  WeightedCreditPool,
  type ResizableCreditLease,
  type WeightedCreditPoolOptions,
} from './weighted-credit-pool.js';

export interface SupervisorAllocationBudgetStats {
  readonly capacity: number;
  readonly current: number;
  readonly peak: number;
  readonly queued: number;
}

/**
 * A facet's load the budget did not admit within its bound
 * (SUPERVISOR_LOAD_WAIT_MS): nothing of it was read, and the facet is not
 * started. Resource temporarily unavailable, as the ledger's refusal of a
 * wait no release can satisfy is.
 */
export class SupervisorLoadWaitError extends Error {
  readonly code = 'EAGAIN';
  readonly errno = -11;
  constructor(readonly load: string, readonly bytes: number, readonly waitedMs: number, held: SupervisorAllocationBudgetStats) {
    super(
      `Resource temporarily unavailable: ${load} (${bytes.toLocaleString('en-US')} bytes) waited ${waitedMs} ms `
        + `for this isolate's transient allocation budget and was not admitted (${held.current.toLocaleString('en-US')} `
        + `of ${held.capacity.toLocaleString('en-US')} bytes held, ${held.queued} owners queued)`,
    );
    this.name = 'SupervisorLoadWaitError';
  }
}

interface AllocationBudgetLifecycle {
  onActive?: () => void;
  onIdle?: () => void;
}

/**
 * Reusable contract behind the supervisor singleton. A separate instance is
 * useful in tests and keeps the invariant independent of Nimbus internals.
 */
export class SupervisorAllocationBudget {
  private readonly credits: WeightedCreditPool;
  private active = false;
  /**
   * Leases that drive the disposable-cache lifecycle. Occupancy cannot stand
   * in for this: a read holds credit too, and a read must not sacrifice the
   * cache it is filling.
   */
  private lifecycleHolders = 0;

  constructor(
    readonly capacity: number,
    private readonly lifecycle: AllocationBudgetLifecycle = {},
    reserve: WeightedCreditPoolOptions = {},
  ) {
    this.credits = new WeightedCreditPool(capacity, reserve);
  }

  get stats(): SupervisorAllocationBudgetStats {
    return {
      capacity: this.capacity,
      ...this.credits.stats,
    };
  }

  /**
   * Reserve bytes and, while held, mark the budget active so observers can
   * free heap headroom. For owners whose payload is what the headroom is for:
   * installs, clones, pre-bundles, boot payloads, streamed writes.
   */
  acquire(bytes: number, signal?: AbortSignal): Promise<ResizableCreditLease> {
    return this._acquire(bytes, signal, true);
  }

  /**
   * Reserve bytes WITHOUT driving the cache lifecycle, for owners that are
   * filling the disposable cache rather than competing with it. Shrinking a
   * chunk cache to serve a chunk read is circular: sequentially the budget
   * empties between every read, so an occupancy-edged observer fires once per
   * read and the cache is pinned at its shrunk floor for the whole workload,
   * never warming. The byte credit is still taken — back-pressure is what
   * stops a large read overlapping a large write.
   */
  acquireWithoutLifecycle(bytes: number, signal?: AbortSignal): Promise<ResizableCreditLease> {
    return this._acquire(bytes, signal, false);
  }

  /**
   * Reserve what a facet's load holds while the loader takes its module map:
   * `bytes`, or for a load larger than the whole budget the whole budget, so
   * that it holds it alone and every owner after it waits. Granted in the
   * budget's one FIFO order, so no owner queued after a load overtakes it,
   * however small, and refused with SupervisorLoadWaitError when not granted
   * within `waitMs`. Like a copy it holds bytes the session already has, for
   * as long as the load takes, so the disposable VFS cache is not shrunk.
   */
  async acquireLoad(load: string, bytes: number, options: { waitMs: number; signal?: AbortSignal }): Promise<ResizableCreditLease> {
    options.signal?.throwIfAborted();
    const wanted = Math.min(bytes, this.capacity);
    // Granted at once when nothing is queued and it fits, with no bound to arm.
    const now = this.tryAcquire(wanted, false);
    if (now) return now;
    const started = Date.now();
    const bound = new AbortController();
    // Cleared as the wait settles: a pending timer keeps the hosting object from hibernating.
    const timer = setTimeout(() => bound.abort(), options.waitMs);
    try {
      return await this._acquire(wanted, options.signal ? AbortSignal.any([bound.signal, options.signal]) : bound.signal, false);
    } catch (error) {
      if (bound.signal.aborted && options.signal?.aborted !== true) throw new SupervisorLoadWaitError(load, bytes, Date.now() - started, this.stats);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Reclaimers of parked launches' retained credit, oldest registered first (reclaimable). */
  private readonly reclaimers = new Set<() => void>();

  /**
   * Register `reclaim`, which gives a parked launch's retained credit back
   * before it returns (its map dropped, its lease released, the launch sent
   * back to prepare), for running work to call when nothing else frees what
   * it needs (acquireRunning). Unregistered just before it is called; the
   * returned function unregisters it.
   */
  reclaimable(reclaim: () => void): () => void {
    this.reclaimers.add(reclaim);
    return () => {
      this.reclaimers.delete(reclaim);
    };
  }

  /**
   * Running work's credit, the lock order's one exception
   * (acquireSupervisorLoad): granted at once where it fits, ahead of every
   * queued ask; else, queued ahead of them all, it reclaims parked launches'
   * retained credit, the oldest first, until it is granted; else it waits
   * only for credit other running work holds.
   */
  async acquireRunning(bytes: number, signal?: AbortSignal, drivesLifecycle = true): Promise<ResizableCreditLease> {
    const wait = this.credits.acquireAhead(Math.min(bytes, this.capacity), signal);
    // What a reclaim frees goes to the asks ahead first, so to this one.
    for (const reclaim of this.reclaimers) {
      if (wait.granted()) break;
      this.reclaimers.delete(reclaim);
      reclaim();
    }
    return this.wrap(await wait.lease, drivesLifecycle);
  }

  /** acquireRunning's credit now, ahead of every queued ask, without reclaiming, or null. */
  tryAcquireRunning(bytes: number): ResizableCreditLease | null {
    const credit = this.credits.tryAcquireAhead(Math.min(bytes, this.capacity));
    return credit ? this.wrap(credit, true) : null;
  }

  /** Reserve bytes now or not at all, driving the lifecycle as acquire does (or not, `drivesLifecycle` false). */
  tryAcquire(bytes: number, drivesLifecycle = true): ResizableCreditLease | null {
    const credit = this.credits.tryAcquire(bytes);
    return credit ? this.wrap(credit, drivesLifecycle) : null;
  }

  private async _acquire(
    bytes: number,
    signal: AbortSignal | undefined,
    drivesLifecycle: boolean,
  ): Promise<ResizableCreditLease> {
    return this.wrap(await this.credits.acquire(bytes, signal), drivesLifecycle);
  }

  private wrap(credit: ResizableCreditLease, drivesLifecycle: boolean): ResizableCreditLease {
    if (drivesLifecycle) {
      this.lifecycleHolders++;
      if (!this.active) {
        this.active = true;
        this.lifecycle.onActive?.();
      }
    }

    let released = false;
    return {
      get bytes() {
        return credit.bytes;
      },
      shrinkTo: (nextBytes: number) => {
        credit.shrinkTo(nextBytes);
      },
      release: () => {
        if (released) return;
        released = true;
        credit.release();
        if (!drivesLifecycle) return;
        this.lifecycleHolders--;
        if (this.lifecycleHolders === 0 && this.active) {
          this.active = false;
          this.lifecycle.onIdle?.();
        }
      },
    };
  }
}

/**
 * A registered observer (typically a SqliteVFS) receives shrink/restore
 * signals when the shared budget transitions idle↔active.
 */
interface AllocObserver {
  /** Called when budget occupancy transitions idle → active. */
  onAcquire?: () => void;
  /** Called when budget occupancy transitions active → idle. */
  onRelease?: () => void;
}

interface Coord {
  observers: Set<AllocObserver>;
  active: boolean;
}

const coord: Coord = { observers: new Set(), active: false };

function getCoord(): Coord {
  return coord;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Register an observer that fires when the shared allocation budget
 * transitions idle → active and active → idle.
 * Returns an unsubscribe function. Idempotent: registering the same
 * observer twice is a no-op (Set semantics).
 *
 * NimbusSession uses this to shrink the disposable VFS LRU while transient
 * payloads are admitted.
 */
export function registerAllocObserver(o: AllocObserver): () => void {
  const c = getCoord();
  const isNew = !c.observers.has(o);
  c.observers.add(o);
  if (isNew && c.active) {
    try { o.onAcquire?.(); } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[heavy-alloc-coord] observer.onAcquire threw:', errorMessage(error));
    }
  }
  return () => { c.observers.delete(o); };
}

function fireOnAcquire(): void {
  const c = getCoord();
  c.active = true;
  for (const o of c.observers) {
    try { o.onAcquire?.(); } catch (error) {
      // Observer errors must NOT break the heavy-alloc protocol.
      // Log and continue.
      // eslint-disable-next-line no-console
      console.error('[heavy-alloc-coord] observer.onAcquire threw:', errorMessage(error));
    }
  }
}

function fireOnRelease(): void {
  const c = getCoord();
  c.active = false;
  for (const o of c.observers) {
    try { o.onRelease?.(); } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[heavy-alloc-coord] observer.onRelease threw:', errorMessage(error));
    }
  }
}

const supervisorAllocationBudget = new SupervisorAllocationBudget(
  SUPERVISOR_IN_FLIGHT_ALLOCATION_BUDGET_BYTES,
  {
    onActive: fireOnAcquire,
    onIdle: fireOnRelease,
  },
  // A chunk-sized read draws on this rather than queueing behind a
  // multi-megabyte owner for a wait unrelated to its own cost.
  { smallRequestBytes: CHUNK_SIZE, reserve: SUPERVISOR_READ_RESERVE_BYTES },
);

/**
 * Reserve an exact number of supervisor-resident bytes.
 */
export function acquireSupervisorAllocation(
  bytes: number,
  signal?: AbortSignal,
): Promise<ResizableCreditLease> {
  return supervisorAllocationBudget.acquire(bytes, signal);
}

/** Reserve bytes now if they can be granted without waiting, else null. */
export function tryAcquireSupervisorAllocation(bytes: number): ResizableCreditLease | null {
  return supervisorAllocationBudget.tryAcquire(bytes);
}

/**
 * Reserve bytes for a running process's filesystem READ (its read RPCs):
 * running work (acquireRunning), which does not shrink the disposable VFS
 * cache, which reads are there to fill.
 */
export function acquireSupervisorReadAllocation(
  bytes: number,
  signal?: AbortSignal,
): Promise<ResizableCreditLease> {
  return supervisorAllocationBudget.acquireRunning(bytes, signal, false);
}

/**
 * Reserve bytes for a short-lived copy of what the session already holds
 * (a launch's module map made from a staged state), now or not at all, or
 * by waiting (`signal`): the byte credit bounds how many such copies are
 * live at once, but the disposable VFS cache is not shrunk for one, as it
 * is not for a read. Shrinking it for every launch of a program already
 * built cost each one its cache, and the copy is no install.
 */
export function tryAcquireSupervisorCopyAllocation(bytes: number): ResizableCreditLease | null {
  return supervisorAllocationBudget.tryAcquire(bytes, false);
}

/** {@link tryAcquireSupervisorCopyAllocation}, waiting for room. */
export function acquireSupervisorCopyAllocation(bytes: number, signal?: AbortSignal): Promise<ResizableCreditLease> {
  return supervisorAllocationBudget.acquireWithoutLifecycle(bytes, signal);
}

/**
 * `bytes` of this isolate for a facet's load (the wasm images read for it;
 * `name` says whose), admitted on the supervisor budget
 * (SupervisorAllocationBudget.acquireLoad): FIFO, the whole budget for one
 * larger than it, refused by name after SUPERVISOR_LOAD_WAIT_MS. `signal`
 * ends the wait.
 *
 * Lock order: supervisor credit, then a Dynamic Worker. Nothing waits for
 * credit (SupervisorAllocationBudget acquire or acquireLoad, or growing a
 * lease) while it holds a worker's fetch hold (beginLoaderFetch,
 * claimAdmission, readmitRefused). While it holds one, it may give credit
 * back, shrink it, or take credit without waiting (tryAcquire). Running work
 * is the one exception, and comes first. Credit a running process needs (its
 * write waves and the session RPCs it makes, through acquireRunning)
 * overtakes every queued ask. When nothing else frees it, it reclaims parked
 * launches' retained maps, oldest parked first: each is dropped, its launch
 * is sent back to prepare, and the map is rebuilt at that launch's turn.
 * Otherwise it waits only for credit other running work holds. A facet's load
 * is not running work.
 */
export function acquireSupervisorLoad(name: string, bytes: number, signal?: AbortSignal): Promise<ResizableCreditLease> {
  return supervisorAllocationBudget.acquireLoad(name, bytes, { waitMs: SUPERVISOR_LOAD_WAIT_MS, signal });
}

/** acquireSupervisorLoad's credit now, without waiting, or null: all a load may take while it holds a worker. */
export function tryAcquireSupervisorLoad(bytes: number): ResizableCreditLease | null {
  return supervisorAllocationBudget.tryAcquire(Math.min(bytes, supervisorAllocationBudget.capacity), false);
}

/**
 * Running work's credit (SupervisorAllocationBudget.acquireRunning): what a
 * running process needs to go on (its write waves, the session RPCs it
 * makes), never held up by a launch that is not running.
 */
export function acquireSupervisorRunningAllocation(bytes: number, signal?: AbortSignal): Promise<ResizableCreditLease> {
  return supervisorAllocationBudget.acquireRunning(bytes, signal);
}

/** acquireSupervisorRunningAllocation's credit now, ahead of every queued ask, without reclaiming, or null. */
export function tryAcquireSupervisorRunningAllocation(bytes: number): ResizableCreditLease | null {
  return supervisorAllocationBudget.tryAcquireRunning(bytes);
}

/** Register a parked launch's reclaimer on the isolate's budget (SupervisorAllocationBudget.reclaimable). */
export function reclaimableSupervisorAllocation(reclaim: () => void): () => void {
  return supervisorAllocationBudget.reclaimable(reclaim);
}

/** Run `load` holding acquireSupervisorLoad's credit for `bytes`, given back as it settles; for a load no worker hold waits on. */
export async function withSupervisorLoadAllocation<T>(
  name: string,
  bytes: number,
  signal: AbortSignal | undefined,
  load: () => Promise<T>,
): Promise<T> {
  if (bytes === 0) return load();
  const lease = await acquireSupervisorLoad(name, bytes, signal);
  try {
    return await load();
  } finally {
    lease.release();
  }
}

/**
 * Reserve the full budget for an allocation whose retained size is not known
 * accurately enough to overlap safely with other heavy work.
 */
export async function acquireHeavyAlloc(signal?: AbortSignal): Promise<() => void> {
  const lease = await acquireSupervisorAllocation(
    SUPERVISOR_IN_FLIGHT_ALLOCATION_BUDGET_BYTES,
    signal,
  );
  return lease.release;
}

export function readSupervisorAllocationBudget(): SupervisorAllocationBudgetStats {
  return supervisorAllocationBudget.stats;
}
