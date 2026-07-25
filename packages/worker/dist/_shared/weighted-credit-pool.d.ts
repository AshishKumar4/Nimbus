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
/**
 * FIFO byte-credit pool shared by concurrent allocation owners.
 * Capacity is measured in retained bytes, not operation count.
 */
export declare class WeightedCreditPool {
    readonly capacity: number;
    private current;
    private peak;
    private readonly waiters;
    constructor(capacity: number);
    get stats(): WeightedCreditPoolStats;
    tryAcquire(bytes: number): ResizableCreditLease | null;
    acquire(bytes: number, signal?: AbortSignal): Promise<ResizableCreditLease>;
    private validateRequest;
    private grant;
    private drain;
}
//# sourceMappingURL=weighted-credit-pool.d.ts.map