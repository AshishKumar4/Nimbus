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
const DEFAULT_ALLOCATION_OWNER = { owner: 'supervisor allocation' };
const MAX_ALLOCATION_OWNER_ROWS = 16;
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
    held;
    code = 'EAGAIN';
    errno = -11;
    constructor(load, bytes, waitedMs, held) {
        super(`Resource temporarily unavailable: ${load} (${bytes.toLocaleString('en-US')} bytes) waited ${waitedMs} ms `
            + `for this isolate's transient allocation budget and was not admitted (${held.current.toLocaleString('en-US')} `
            + `of ${held.capacity.toLocaleString('en-US')} bytes held, ${held.queued} owners queued); `
            + `holders=${JSON.stringify(held.holders)} waiting=${JSON.stringify(held.waiting)}`);
        this.load = load;
        this.bytes = bytes;
        this.waitedMs = waitedMs;
        this.held = held;
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
    holders = new Set();
    waiting = new Set();
    constructor(capacity, lifecycle = {}, reserve = {}) {
        this.capacity = capacity;
        this.lifecycle = lifecycle;
        this.credits = new WeightedCreditPool(capacity, reserve);
    }
    get stats() {
        const now = Date.now();
        const describe = (owner, bytes, since) => ({
            owner: owner.owner.slice(0, 256), bytes, ageMs: Math.max(0, now - since),
            ...(owner.pid === undefined ? {} : { pid: owner.pid }), ...(owner.session === undefined ? {} : { session: owner.session }),
        });
        return {
            capacity: this.capacity,
            ...this.credits.stats,
            holders: [...this.holders].sort((a, b) => b.credit.bytes - a.credit.bytes).slice(0, MAX_ALLOCATION_OWNER_ROWS)
                .map(({ owner, credit, since }) => describe(owner, credit.bytes, since)),
            waiting: [...this.waiting].slice(0, MAX_ALLOCATION_OWNER_ROWS).map(({ owner, bytes, since }) => describe(owner, bytes, since)),
        };
    }
    get attributed() {
        const totals = { prefetchBundleBytes: 0, preBundleSliceBytes: 0 };
        for (const { owner, credit } of this.holders)
            if (owner.attribution !== undefined)
                totals[owner.attribution] += credit.bytes;
        return totals;
    }
    /**
     * Reserve bytes and, while held, mark the budget active so observers can
     * free heap headroom. For owners whose payload is what the headroom is for:
     * installs, clones, pre-bundles, boot payloads, streamed writes.
     */
    acquire(bytes, signal, owner = DEFAULT_ALLOCATION_OWNER) {
        return this._acquire(bytes, signal, true, owner);
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
    acquireWithoutLifecycle(bytes, signal, owner = DEFAULT_ALLOCATION_OWNER) {
        return this._acquire(bytes, signal, false, owner);
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
        const owner = options.owner ?? { owner: load };
        const now = this.tryAcquire(wanted, false, owner);
        if (now)
            return now;
        const started = Date.now();
        const bound = new AbortController();
        // Cleared as the wait settles: a pending timer keeps the hosting object from hibernating.
        const timer = setTimeout(() => bound.abort(), options.waitMs);
        try {
            return await this._acquire(wanted, options.signal ? AbortSignal.any([bound.signal, options.signal]) : bound.signal, false, owner);
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
    /** Reclaimers of parked launches' retained credit, oldest registered first (reclaimable). */
    reclaimers = new Set();
    /**
     * Register `reclaim`, which gives a parked launch's retained credit back
     * before it returns (its map dropped, its lease released, the launch sent
     * back to prepare), for running work to call when nothing else frees what
     * it needs (acquireRunning). Unregistered just before it is called; the
     * returned function unregisters it.
     */
    reclaimable(reclaim) {
        this.reclaimers.add(reclaim);
        // A running ask queued before this launch parked is owed it, once the registration has returned.
        if (this.credits.aheadQueued)
            queueMicrotask(() => this.reclaimForRunning());
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
    async acquireRunning(bytes, signal, drivesLifecycle = true, owner = DEFAULT_ALLOCATION_OWNER) {
        const wanted = Math.min(bytes, this.capacity);
        const waiter = { owner: { ...owner }, bytes: wanted, since: Date.now() };
        this.waiting.add(waiter);
        try {
            const lease = this.credits.acquireAhead(wanted, signal);
            this.reclaimForRunning();
            return this.wrap(await lease, drivesLifecycle, owner);
        }
        finally {
            this.waiting.delete(waiter);
        }
    }
    /** Reclaim parked launches' credit, the oldest parked first, while a running ask waits: what a reclaim frees goes to running asks first. */
    reclaimForRunning() {
        for (const reclaim of this.reclaimers) {
            if (!this.credits.aheadQueued)
                return;
            this.reclaimers.delete(reclaim);
            reclaim();
        }
    }
    /** acquireRunning's credit now, ahead of every queued ask, without reclaiming, or null. */
    tryAcquireRunning(bytes, owner = DEFAULT_ALLOCATION_OWNER) {
        const credit = this.credits.tryAcquireAhead(Math.min(bytes, this.capacity));
        return credit ? this.wrap(credit, true, owner) : null;
    }
    /** Reserve bytes now or not at all, driving the lifecycle as acquire does (or not, `drivesLifecycle` false). */
    tryAcquire(bytes, drivesLifecycle = true, owner = DEFAULT_ALLOCATION_OWNER) {
        const credit = this.credits.tryAcquire(bytes);
        return credit ? this.wrap(credit, drivesLifecycle, owner) : null;
    }
    async _acquire(bytes, signal, drivesLifecycle, owner) {
        const waiter = { owner: { ...owner }, bytes, since: Date.now() };
        this.waiting.add(waiter);
        try {
            return this.wrap(await this.credits.acquire(bytes, signal), drivesLifecycle, owner);
        }
        finally {
            this.waiting.delete(waiter);
        }
    }
    wrap(credit, drivesLifecycle, owner) {
        if (drivesLifecycle) {
            this.lifecycleHolders++;
            if (!this.active) {
                this.active = true;
                this.lifecycle.onActive?.();
            }
        }
        let released = false;
        const holder = { owner: { ...owner }, credit, since: Date.now() };
        this.holders.add(holder);
        return {
            get bytes() {
                return credit.bytes;
            },
            shrinkTo: (nextBytes) => {
                credit.shrinkTo(nextBytes);
            },
            attribute: (attribution) => { if (!released)
                holder.owner = { ...holder.owner, attribution }; },
            release: () => {
                if (released)
                    return;
                released = true;
                this.holders.delete(holder);
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
export function acquireSupervisorAllocation(bytes, signal, owner) {
    return supervisorAllocationBudget.acquire(bytes, signal, owner);
}
/** Reserve bytes now if they can be granted without waiting, else null. */
export function tryAcquireSupervisorAllocation(bytes, owner) {
    return supervisorAllocationBudget.tryAcquire(bytes, true, owner);
}
/**
 * Reserve bytes for a running process's filesystem READ (its read RPCs):
 * running work (acquireRunning), which does not shrink the disposable VFS
 * cache, which reads are there to fill.
 */
export function acquireSupervisorReadAllocation(bytes, signal, owner) {
    return supervisorAllocationBudget.acquireRunning(bytes, signal, false, owner ?? { owner: 'running filesystem read' });
}
/**
 * Reserve bytes for a short-lived copy of what the session already holds
 * (a launch's module map made from a staged state), now or not at all, or
 * by waiting (`signal`): the byte credit bounds how many such copies are
 * live at once, but the disposable VFS cache is not shrunk for one, as it
 * is not for a read. Shrinking it for every launch of a program already
 * built cost each one its cache, and the copy is no install.
 */
export function tryAcquireSupervisorCopyAllocation(bytes, owner) {
    return supervisorAllocationBudget.tryAcquire(bytes, false, owner ?? { owner: 'supervisor copy' });
}
/** {@link tryAcquireSupervisorCopyAllocation}, waiting for room. */
export function acquireSupervisorCopyAllocation(bytes, signal, owner) {
    return supervisorAllocationBudget.acquireWithoutLifecycle(bytes, signal, owner ?? { owner: 'supervisor copy' });
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
export function acquireSupervisorLoad(name, bytes, signal, owner) {
    return supervisorAllocationBudget.acquireLoad(name, bytes, { waitMs: SUPERVISOR_LOAD_WAIT_MS, signal, owner });
}
/** acquireSupervisorLoad's credit now, without waiting, or null: all a load may take while it holds a worker. */
export function tryAcquireSupervisorLoad(bytes, owner = { owner: 'facet load' }) {
    return supervisorAllocationBudget.tryAcquire(Math.min(bytes, supervisorAllocationBudget.capacity), false, owner);
}
/**
 * Running work's credit (SupervisorAllocationBudget.acquireRunning): what a
 * running process needs to go on (its write waves, the session RPCs it
 * makes), never held up by a launch that is not running.
 */
export function acquireSupervisorRunningAllocation(bytes, signal, owner) {
    return supervisorAllocationBudget.acquireRunning(bytes, signal, true, owner ?? { owner: 'running supervisor work' });
}
/** acquireSupervisorRunningAllocation's credit now, ahead of every queued ask, without reclaiming, or null. */
export function tryAcquireSupervisorRunningAllocation(bytes, owner) {
    return supervisorAllocationBudget.tryAcquireRunning(bytes, owner ?? { owner: 'running supervisor work' });
}
/** Register a parked launch's reclaimer on the isolate's budget (SupervisorAllocationBudget.reclaimable). */
export function reclaimableSupervisorAllocation(reclaim) {
    return supervisorAllocationBudget.reclaimable(reclaim);
}
/** Run `load` holding acquireSupervisorLoad's credit for `bytes`, given back as it settles; for a load no worker hold waits on. */
export async function withSupervisorLoadAllocation(name, bytes, signal, load, owner) {
    if (bytes === 0)
        return load();
    const lease = await acquireSupervisorLoad(name, bytes, signal, owner);
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
export async function acquireHeavyAlloc(signal, owner = { owner: 'heavy supervisor work' }) {
    const lease = await acquireSupervisorAllocation(SUPERVISOR_IN_FLIGHT_ALLOCATION_BUDGET_BYTES, signal, owner);
    return lease.release;
}
export function readSupervisorAllocationBudget() {
    return supervisorAllocationBudget.stats;
}
export function readSupervisorAllocationAttribution() {
    return supervisorAllocationBudget.attributed;
}
