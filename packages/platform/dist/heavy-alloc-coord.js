/**
 * Supervisor-local byte-budget back-pressure for transient allocations.
 *
 * A DO can share its isolate's 128 MiB platform ceiling with peer DOs, so
 * independent "safe" allocations cannot each assume the full ceiling.
 * Module scope gives every allocator in one supervisor isolate a single FIFO
 * budget. Full-budget owners are exclusive; weighted owners may overlap only
 * while their retained-byte claims fit together.
 */
import { CHUNK_SIZE, SUPERVISOR_IN_FLIGHT_ALLOCATION_BUDGET_BYTES, SUPERVISOR_LOAD_WAIT_MS, SUPERVISOR_READ_RESERVE_BYTES, } from './limits.js';
import { WeightedCreditPool, } from './weighted-credit-pool.js';
/**
 * A facet's load the budget did not admit within its bound
 * (SUPERVISOR_LOAD_WAIT_MS): nothing of it was read, and the facet is not
 * started. Resource temporarily unavailable, as the ledger's refusal of a
 * wait no release can satisfy is.
 */
export class SupervisorLoadWaitError extends Error {
    load;
    bytes;
    waitedMs;
    code = 'EAGAIN';
    errno = -11;
    constructor(load, bytes, waitedMs, held) {
        super(`Resource temporarily unavailable: ${load} (${bytes.toLocaleString('en-US')} bytes) waited ${waitedMs} ms `
            + `for this isolate's transient allocation budget and was not admitted (${held.current.toLocaleString('en-US')} `
            + `of ${held.capacity.toLocaleString('en-US')} bytes held, ${held.queued} owners queued)`);
        this.load = load;
        this.bytes = bytes;
        this.waitedMs = waitedMs;
        this.name = 'SupervisorLoadWaitError';
    }
}
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
    /**
     * Reserve what a facet's load holds while the loader takes its module map:
     * `bytes`, or for a load larger than the whole budget the whole budget, so
     * that it holds it alone and every owner after it waits. Granted in the
     * budget's one FIFO order, so no owner queued after a load overtakes it,
     * however small, and refused with SupervisorLoadWaitError when not granted
     * within `waitMs`. Like a copy it holds bytes the session already has, for
     * as long as the load takes, so the disposable VFS cache is not shrunk.
     */
    async acquireLoad(load, bytes, options) {
        options.signal?.throwIfAborted();
        const wanted = Math.min(bytes, this.capacity);
        // Granted at once when nothing is queued and it fits, with no bound to arm.
        const now = this.tryAcquire(wanted, false);
        if (now)
            return now;
        const started = Date.now();
        const bound = new AbortController();
        // Cleared as the wait settles: a pending timer keeps the hosting object from hibernating.
        const timer = setTimeout(() => bound.abort(), options.waitMs);
        try {
            return await this._acquire(wanted, options.signal ? AbortSignal.any([bound.signal, options.signal]) : bound.signal, false);
        }
        catch (error) {
            if (bound.signal.aborted && options.signal?.aborted !== true)
                throw new SupervisorLoadWaitError(load, bytes, Date.now() - started, this.stats);
            throw error;
        }
        finally {
            clearTimeout(timer);
        }
    }
    /** Reserve bytes now or not at all, driving the lifecycle as acquire does (or not, `drivesLifecycle` false). */
    tryAcquire(bytes, drivesLifecycle = true) {
        const credit = this.credits.tryAcquire(bytes);
        return credit ? this.wrap(credit, drivesLifecycle) : null;
    }
    async _acquire(bytes, signal, drivesLifecycle) {
        return this.wrap(await this.credits.acquire(bytes, signal), drivesLifecycle);
    }
    wrap(credit, drivesLifecycle) {
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
/** Reserve bytes now if they can be granted without waiting, else null. */
export function tryAcquireSupervisorAllocation(bytes) {
    return supervisorAllocationBudget.tryAcquire(bytes);
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
 * Reserve bytes for a short-lived copy of what the session already holds
 * (a launch's module map made from a staged state), now or not at all, or
 * by waiting (`signal`): the byte credit bounds how many such copies are
 * live at once, but the disposable VFS cache is not shrunk for one, as it
 * is not for a read. Shrinking it for every launch of a program already
 * built cost each one its cache, and the copy is no install.
 */
export function tryAcquireSupervisorCopyAllocation(bytes) {
    return supervisorAllocationBudget.tryAcquire(bytes, false);
}
/** {@link tryAcquireSupervisorCopyAllocation}, waiting for room. */
export function acquireSupervisorCopyAllocation(bytes, signal) {
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
 * back, shrink it, or take credit without waiting (tryAcquire).
 */
export function acquireSupervisorLoad(name, bytes, signal) {
    return supervisorAllocationBudget.acquireLoad(name, bytes, { waitMs: SUPERVISOR_LOAD_WAIT_MS, signal });
}
/** acquireSupervisorLoad's credit now, without waiting, or null: all a load may take while it holds a worker. */
export function tryAcquireSupervisorLoad(bytes) {
    return supervisorAllocationBudget.tryAcquire(Math.min(bytes, supervisorAllocationBudget.capacity), false);
}
/** Run `load` holding acquireSupervisorLoad's credit for `bytes`, given back as it settles; for a load no worker hold waits on. */
export async function withSupervisorLoadAllocation(name, bytes, signal, load) {
    if (bytes === 0)
        return load();
    const lease = await acquireSupervisorLoad(name, bytes, signal);
    try {
        return await load();
    }
    finally {
        lease.release();
    }
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
