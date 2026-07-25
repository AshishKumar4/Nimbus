/**
 * Supervisor-local byte-budget back-pressure for transient allocations.
 *
 * A DO can share its isolate's 128 MiB platform ceiling with peer DOs, so
 * independent "safe" allocations cannot each assume the full ceiling.
 * Module scope gives every allocator in one supervisor isolate a single FIFO
 * budget. Full-budget owners are exclusive; weighted owners may overlap only
 * while their retained-byte claims fit together.
 */
import { type ResizableCreditLease } from '../_shared/weighted-credit-pool.js';
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
export declare class SupervisorAllocationBudget {
    readonly capacity: number;
    private readonly lifecycle;
    private readonly credits;
    private active;
    constructor(capacity: number, lifecycle?: AllocationBudgetLifecycle);
    get stats(): SupervisorAllocationBudgetStats;
    acquire(bytes: number, signal?: AbortSignal): Promise<ResizableCreditLease>;
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
/**
 * Reserve the full budget for an allocation whose retained size is not known
 * accurately enough to overlap safely with other heavy work.
 */
export declare function acquireHeavyAlloc(signal?: AbortSignal): Promise<() => void>;
export declare function readSupervisorAllocationBudget(): SupervisorAllocationBudgetStats;
export {};
//# sourceMappingURL=heavy-alloc-coord.d.ts.map