export interface CreditLease {
    readonly bytes: number;
    release(): void;
}
export interface ResizableCreditLease extends CreditLease {
    shrinkTo(bytes: number): void;
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
    acquire(bytes: number, signal?: AbortSignal): Promise<ResizableCreditLease>;
    private validateRequest;
}
//# sourceMappingURL=weighted-credit-pool.d.ts.map