/**
 * Supervisor-local byte-budget back-pressure for transient allocations.
 *
 * A DO can share its isolate's 128 MiB platform ceiling with peer DOs, so
 * independent "safe" allocations cannot each assume the full ceiling.
 * Module scope gives every allocator in one supervisor isolate a single FIFO
 * budget. Full-budget owners are exclusive; weighted owners may overlap only
 * while their retained-byte claims fit together.
 */

import { SUPERVISOR_IN_FLIGHT_ALLOCATION_BUDGET_BYTES } from '../constants.js';
import {
  WeightedCreditPool,
  type ResizableCreditLease,
} from '../_shared/weighted-credit-pool.js';

export interface SupervisorAllocationBudgetStats {
  readonly capacity: number;
  readonly current: number;
  readonly peak: number;
  readonly queued: number;
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
  ) {
    this.credits = new WeightedCreditPool(capacity);
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

  private async _acquire(
    bytes: number,
    signal: AbortSignal | undefined,
    drivesLifecycle: boolean,
  ): Promise<ResizableCreditLease> {
    const credit = await this.credits.acquire(bytes, signal);
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

/**
 * Reserve bytes for a filesystem READ. Takes the same byte credit as any
 * other owner but does not shrink the disposable VFS cache, which reads are
 * there to fill.
 */
export function acquireSupervisorReadAllocation(
  bytes: number,
  signal?: AbortSignal,
): Promise<ResizableCreditLease> {
  return supervisorAllocationBudget.acquireWithoutLifecycle(bytes, signal);
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
