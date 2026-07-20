export interface CreditLease {
    readonly bytes: number;
    release(): void;
}
export interface WeightedCreditPoolStats {
    readonly current: number;
    readonly peak: number;
    readonly queued: number;
}
/**
 * FIFO weighted credit shared by the write streams of one SqliteVFS.
 * Capacity is measured in retained payload bytes, not stream or RPC count.
 */
export declare class WeightedCreditPool {
    readonly capacity: number;
    private current;
    private peak;
    private readonly waiters;
    constructor(capacity: number);
    get stats(): WeightedCreditPoolStats;
    tryAcquire(bytes: number): CreditLease | null;
    acquire(bytes: number, signal?: AbortSignal): Promise<CreditLease>;
    private validateRequest;
    private grant;
    private drain;
}
//# sourceMappingURL=write-stream-credit-pool.d.ts.map