/**
 * Supervisor-local byte-budget back-pressure for transient allocations.
 *
 * A DO can share its isolate's 128 MiB platform ceiling with peer DOs, so
 * independent "safe" allocations cannot each assume the full ceiling.
 * Module scope gives every allocator in one supervisor isolate a single FIFO
 * budget. Full-budget owners are exclusive; weighted owners may overlap only
 * while their retained-byte claims fit together.
 */
import { type ResizableCreditLease, type WeightedCreditPoolOptions } from './weighted-credit-pool.js';
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
export declare class SupervisorLoadWaitError extends Error {
    readonly load: string;
    readonly bytes: number;
    readonly waitedMs: number;
    readonly code = "EAGAIN";
    readonly errno = -11;
    constructor(load: string, bytes: number, waitedMs: number, held: SupervisorAllocationBudgetStats);
}
interface AllocationBudgetLifecycle {
    onActive?: () => void;
    onIdle?: () => void;
}
/**
 * Reusable contract behind the supervisor singleton. A separate instance is
 * useful in tests and keeps the invariant independent of Nimbus internals.
 */
export declare class SupervisorAllocationBudget {
    readonly capacity: number;
    private readonly lifecycle;
    private readonly credits;
    private active;
    /**
     * Leases that drive the disposable-cache lifecycle. Occupancy cannot stand
     * in for this: a read holds credit too, and a read must not sacrifice the
     * cache it is filling.
     */
    private lifecycleHolders;
    constructor(capacity: number, lifecycle?: AllocationBudgetLifecycle, reserve?: WeightedCreditPoolOptions);
    get stats(): SupervisorAllocationBudgetStats;
    /**
     * Reserve bytes and, while held, mark the budget active so observers can
     * free heap headroom. For owners whose payload is what the headroom is for:
     * installs, clones, pre-bundles, boot payloads, streamed writes.
     */
    acquire(bytes: number, signal?: AbortSignal): Promise<ResizableCreditLease>;
    /**
     * Reserve bytes WITHOUT driving the cache lifecycle, for owners that are
     * filling the disposable cache rather than competing with it. Shrinking a
     * chunk cache to serve a chunk read is circular: sequentially the budget
     * empties between every read, so an occupancy-edged observer fires once per
     * read and the cache is pinned at its shrunk floor for the whole workload,
     * never warming. The byte credit is still taken — back-pressure is what
     * stops a large read overlapping a large write.
     */
    acquireWithoutLifecycle(bytes: number, signal?: AbortSignal): Promise<ResizableCreditLease>;
    /**
     * Reserve what a facet's load holds while the loader takes its module map:
     * `bytes`, or for a load larger than the whole budget the whole budget, so
     * that it holds it alone and every owner after it waits. Granted in the
     * budget's one FIFO order, so no owner queued after a load overtakes it,
     * however small, and refused with SupervisorLoadWaitError when not granted
     * within `waitMs`. Like a copy it holds bytes the session already has, for
     * as long as the load takes, so the disposable VFS cache is not shrunk.
     */
    acquireLoad(load: string, bytes: number, options: {
        waitMs: number;
        signal?: AbortSignal;
    }): Promise<ResizableCreditLease>;
    /** Reclaimers of parked launches' retained credit, oldest registered first (reclaimable). */
    private readonly reclaimers;
    /**
     * Register `reclaim`, which gives a parked launch's retained credit back
     * before it returns (its map dropped, its lease released, the launch sent
     * back to prepare), for running work to call when nothing else frees what
     * it needs (acquireRunning). Unregistered just before it is called; the
     * returned function unregisters it.
     */
    reclaimable(reclaim: () => void): () => void;
    /**
     * Running work's credit, the lock order's one exception
     * (acquireSupervisorLoad): granted at once where it fits, ahead of every
     * queued ask; else, queued ahead of them all, it reclaims parked launches'
     * retained credit, the oldest first, until it is granted; else it waits
     * only for credit other running work holds.
     */
    acquireRunning(bytes: number, signal?: AbortSignal, drivesLifecycle?: boolean): Promise<ResizableCreditLease>;
    /** acquireRunning's credit now, ahead of every queued ask, without reclaiming, or null. */
    tryAcquireRunning(bytes: number): ResizableCreditLease | null;
    /** Reserve bytes now or not at all, driving the lifecycle as acquire does (or not, `drivesLifecycle` false). */
    tryAcquire(bytes: number, drivesLifecycle?: boolean): ResizableCreditLease | null;
    private _acquire;
    private wrap;
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
/**
 * Register an observer that fires when the shared allocation budget
 * transitions idle → active and active → idle.
 * Returns an unsubscribe function. Idempotent: registering the same
 * observer twice is a no-op (Set semantics).
 *
 * NimbusSession uses this to shrink the disposable VFS LRU while transient
 * payloads are admitted.
 */
export declare function registerAllocObserver(o: AllocObserver): () => void;
/**
 * Reserve an exact number of supervisor-resident bytes.
 */
export declare function acquireSupervisorAllocation(bytes: number, signal?: AbortSignal): Promise<ResizableCreditLease>;
/** Reserve bytes now if they can be granted without waiting, else null. */
export declare function tryAcquireSupervisorAllocation(bytes: number): ResizableCreditLease | null;
/**
 * Reserve bytes for a running process's filesystem READ (its read RPCs):
 * running work (acquireRunning), which does not shrink the disposable VFS
 * cache, which reads are there to fill.
 */
export declare function acquireSupervisorReadAllocation(bytes: number, signal?: AbortSignal): Promise<ResizableCreditLease>;
/**
 * Reserve bytes for a short-lived copy of what the session already holds
 * (a launch's module map made from a staged state), now or not at all, or
 * by waiting (`signal`): the byte credit bounds how many such copies are
 * live at once, but the disposable VFS cache is not shrunk for one, as it
 * is not for a read. Shrinking it for every launch of a program already
 * built cost each one its cache, and the copy is no install.
 */
export declare function tryAcquireSupervisorCopyAllocation(bytes: number): ResizableCreditLease | null;
/** {@link tryAcquireSupervisorCopyAllocation}, waiting for room. */
export declare function acquireSupervisorCopyAllocation(bytes: number, signal?: AbortSignal): Promise<ResizableCreditLease>;
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
export declare function acquireSupervisorLoad(name: string, bytes: number, signal?: AbortSignal): Promise<ResizableCreditLease>;
/** acquireSupervisorLoad's credit now, without waiting, or null: all a load may take while it holds a worker. */
export declare function tryAcquireSupervisorLoad(bytes: number): ResizableCreditLease | null;
/**
 * Running work's credit (SupervisorAllocationBudget.acquireRunning): what a
 * running process needs to go on (its write waves, the session RPCs it
 * makes), never held up by a launch that is not running.
 */
export declare function acquireSupervisorRunningAllocation(bytes: number, signal?: AbortSignal): Promise<ResizableCreditLease>;
/** acquireSupervisorRunningAllocation's credit now, ahead of every queued ask, without reclaiming, or null. */
export declare function tryAcquireSupervisorRunningAllocation(bytes: number): ResizableCreditLease | null;
/** Register a parked launch's reclaimer on the isolate's budget (SupervisorAllocationBudget.reclaimable). */
export declare function reclaimableSupervisorAllocation(reclaim: () => void): () => void;
/** Run `load` holding acquireSupervisorLoad's credit for `bytes`, given back as it settles; for a load no worker hold waits on. */
export declare function withSupervisorLoadAllocation<T>(name: string, bytes: number, signal: AbortSignal | undefined, load: () => Promise<T>): Promise<T>;
/**
 * Reserve the full budget for an allocation whose retained size is not known
 * accurately enough to overlap safely with other heavy work.
 */
export declare function acquireHeavyAlloc(signal?: AbortSignal): Promise<() => void>;
export declare function readSupervisorAllocationBudget(): SupervisorAllocationBudgetStats;
export {};
//# sourceMappingURL=heavy-alloc-coord.d.ts.map