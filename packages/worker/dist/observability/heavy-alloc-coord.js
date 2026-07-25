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
import { WeightedCreditPool, } from '../_shared/weighted-credit-pool.js';
/**
 * Reusable contract behind the supervisor singleton. A separate instance is
 * useful in tests and keeps the invariant independent of Nimbus internals.
 */
export class SupervisorAllocationBudget {
    capacity;
    lifecycle;
    credits;
    active = false;
    constructor(capacity, lifecycle = {}) {
        this.capacity = capacity;
        this.lifecycle = lifecycle;
        this.credits = new WeightedCreditPool(capacity);
    }
    get stats() {
        return {
            capacity: this.capacity,
            ...this.credits.stats,
        };
    }
    async acquire(bytes, signal) {
        const credit = await this.credits.acquire(bytes, signal);
        if (!this.active) {
            this.active = true;
            this.lifecycle.onActive?.();
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
                if (this.credits.stats.current === 0) {
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
});
/**
 * Reserve an exact number of supervisor-resident bytes.
 */
export function acquireSupervisorAllocation(bytes, signal) {
    return supervisorAllocationBudget.acquire(bytes, signal);
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
