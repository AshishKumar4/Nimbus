/**
 * Supervisor-local byte-budget back-pressure for transient allocations.
 *
 * A DO can share its isolate's 128 MiB platform ceiling with peer DOs, so
 * independent "safe" allocations cannot each assume the full ceiling.
 * Module scope gives every allocator in one supervisor isolate a single FIFO
 * budget. Full-budget owners are exclusive; weighted owners may overlap only
 * while their retained-byte claims fit together.
 */
import { CHUNK_SIZE, SUPERVISOR_IN_FLIGHT_ALLOCATION_BUDGET_BYTES, SUPERVISOR_READ_RESERVE_BYTES, } from './limits.js';
import { WeightedCreditPool, } from './weighted-credit-pool.js';
/**
 * Reusable contract behind the supervisor singleton. A separate instance is
 * useful in tests and keeps the invariant independent of Nimbus internals.
 */
export class SupervisorAllocationBudget {
    capacity;
    lifecycle;
    credits;
    active = false;
    /**
     * Leases that drive the disposable-cache lifecycle. Occupancy cannot stand
     * in for this: a read holds credit too, and a read must not sacrifice the
     * cache it is filling.
     */
    lifecycleHolders = 0;
    constructor(capacity, lifecycle = {}, reserve = {}) {
        this.capacity = capacity;
        this.lifecycle = lifecycle;
        this.credits = new WeightedCreditPool(capacity, reserve);
    }
    get stats() {
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
    acquire(bytes, signal) {
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
    acquireWithoutLifecycle(bytes, signal) {
        return this._acquire(bytes, signal, false);
    }
    async _acquire(bytes, signal, drivesLifecycle) {
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
            shrinkTo: (nextBytes) => {
                credit.shrinkTo(nextBytes);
            },
            release: () => {
                if (released)
                    return;
                released = true;
                credit.release();
                if (!drivesLifecycle)
                    return;
                this.lifecycleHolders--;
                if (this.lifecycleHolders === 0 && this.active) {
                    this.active = false;
                    this.lifecycle.onIdle?.();
                }
            },
        };
    }
}
const coord = { observers: new Set(), active: false };
function getCoord() {
    return coord;
}
function errorMessage(error) {
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
export function registerAllocObserver(o) {
    const c = getCoord();
    const isNew = !c.observers.has(o);
    c.observers.add(o);
    if (isNew && c.active) {
        try {
            o.onAcquire?.();
        }
        catch (error) {
            // eslint-disable-next-line no-console
            console.error('[heavy-alloc-coord] observer.onAcquire threw:', errorMessage(error));
        }
    }
    return () => { c.observers.delete(o); };
}
function fireOnAcquire() {
    const c = getCoord();
    c.active = true;
    for (const o of c.observers) {
        try {
            o.onAcquire?.();
        }
        catch (error) {
            // Observer errors must NOT break the heavy-alloc protocol.
            // Log and continue.
            // eslint-disable-next-line no-console
            console.error('[heavy-alloc-coord] observer.onAcquire threw:', errorMessage(error));
        }
    }
}
function fireOnRelease() {
    const c = getCoord();
    c.active = false;
    for (const o of c.observers) {
        try {
            o.onRelease?.();
        }
        catch (error) {
            // eslint-disable-next-line no-console
            console.error('[heavy-alloc-coord] observer.onRelease threw:', errorMessage(error));
        }
    }
}
const supervisorAllocationBudget = new SupervisorAllocationBudget(SUPERVISOR_IN_FLIGHT_ALLOCATION_BUDGET_BYTES, {
    onActive: fireOnAcquire,
    onIdle: fireOnRelease,
}, 
// A chunk-sized read draws on this rather than queueing behind a
// multi-megabyte owner for a wait unrelated to its own cost.
{ smallRequestBytes: CHUNK_SIZE, reserve: SUPERVISOR_READ_RESERVE_BYTES });
/**
 * Reserve an exact number of supervisor-resident bytes.
 */
export function acquireSupervisorAllocation(bytes, signal) {
    return supervisorAllocationBudget.acquire(bytes, signal);
}
/**
 * Reserve bytes for a filesystem READ. Takes the same byte credit as any
 * other owner but does not shrink the disposable VFS cache, which reads are
 * there to fill.
 */
export function acquireSupervisorReadAllocation(bytes, signal) {
    return supervisorAllocationBudget.acquireWithoutLifecycle(bytes, signal);
}
/**
 * Reserve the full budget for an allocation whose retained size is not known
 * accurately enough to overlap safely with other heavy work.
 */
export async function acquireHeavyAlloc(signal) {
    const lease = await acquireSupervisorAllocation(SUPERVISOR_IN_FLIGHT_ALLOCATION_BUDGET_BYTES, signal);
    return lease.release;
}
export function readSupervisorAllocationBudget() {
    return supervisorAllocationBudget.stats;
}
