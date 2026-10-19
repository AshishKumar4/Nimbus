export interface CreditLease {
    readonly bytes: number;
    release(): void;
}
export interface ResizableCreditLease extends CreditLease {
    shrinkTo(bytes: number): void;
    /**
     * Holds `bytes` in all if the rest can be granted now, in its own lane, as
     * tryAcquire would grant it; else holds what it held and answers false.
     */
    tryGrowTo(bytes: number): boolean;
}
export interface WeightedCreditPoolStats {
    readonly current: number;
    readonly peak: number;
    readonly queued: number;
}
export interface WeightedCreditPoolOptions {
    /**
     * Requests at or below this size draw from `reserve` instead of the shared
     * capacity. Omit to keep a single lane.
     */
    readonly smallRequestBytes?: number;
    /**
     * Bytes set aside for small requests. Held apart from `capacity` so a
     * full-capacity owner stays grantable and small requests stay servable
     * while it works.
     */
    readonly reserve?: number;
}
/**
 * How long a waiter woken to its turn keeps it for its own continuation to
 * take the credit. workerd cancels the continuations of a request that has
 * completed or been canceled when another request's code resolves its
 * promise (the cross-request promise rule, on by date since 2024-10-14), so
 * a waiter whose request is gone is woken and never takes: its turn lapses
 * and the next waiter's comes. A live continuation takes it in far less.
 */
export declare const CREDIT_TURN_MS = 1000;
/**
 * A place in a lane's queue. `woken` resolves when its turn comes; `take`,
 * called from the waiter's own continuation, holds the credit then, or
 * answers null when the turn lapsed or the credit no longer fits, and the
 * place waits again. `leave` gives up the place.
 */
export interface CreditTurn {
    woken(): Promise<void>;
    take(): ResizableCreditLease | null;
    leave(): void;
}
/**
 * FIFO byte-credit pool shared by concurrent allocation owners.
 * Capacity is measured in retained bytes, not operation count.
 *
 * One FIFO queue makes every request wait behind the one ahead of it even
 * when the pool has room to spare — `tryAcquire` refuses outright while
 * anyone is queued — so a single multi-megabyte owner parks every request
 * behind it for as long as it holds. Between owners of comparable size that
 * is the point. For a chunk-sized filesystem read it means a wait with
 * nothing to do with its own cost.
 *
 * So a request at or below `smallRequestBytes` takes shared capacity when
 * that can be granted outright, and otherwise falls back to a separate
 * `reserve` where it queues only among its own kind. It never joins the
 * shared queue, so it is never parked behind a larger owner.
 *
 * Neither side can starve the other. Shared capacity stops admitting small
 * requests the moment anything is queued for it, so a large waiter is never
 * overtaken; and the reserve is held apart from `capacity`, so a
 * full-capacity owner stays grantable while small requests stay servable.
 * Peak occupancy only reaches `capacity + reserve` while the shared lane is
 * contended.
 */
export declare class WeightedCreditPool {
    readonly capacity: number;
    private readonly general;
    private readonly small;
    private readonly smallRequestBytes;
    constructor(capacity: number, options?: WeightedCreditPoolOptions);
    get stats(): WeightedCreditPoolStats;
    private isSmall;
    tryAcquire(bytes: number): ResizableCreditLease | null;
    /**
     * A running program's ask (SupervisorAllocationBudget.acquireRunning),
     * ahead of every ordinary ask: granted now if it fits beside what is held,
     * whatever is queued (a small one in its reserve too), or else as soon as
     * it fits in the shared capacity, the credit running work and reclaims
     * free. It never waits on the reserve, which neither frees.
     */
    acquireAhead(bytes: number, signal?: AbortSignal): Promise<ResizableCreditLease>;
    /** Whether a running program's ask (acquireAhead) waits. */
    get aheadQueued(): boolean;
    /** acquireAhead's credit now, or null. */
    tryAcquireAhead(bytes: number): ResizableCreditLease | null;
    /**
     * A place in line for `bytes`, in the lane it would wait in, for a caller
     * that takes its turn itself (CreditTurn): what acquire does once nothing
     * is free.
     */
    queue(bytes: number, signal?: AbortSignal): CreditTurn;
    acquire(bytes: number, signal?: AbortSignal): Promise<ResizableCreditLease>;
    private validateRequest;
}
//# sourceMappingURL=weighted-credit-pool.d.ts.map