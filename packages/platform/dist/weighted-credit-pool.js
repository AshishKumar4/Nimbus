/**
 * One byte capacity and its queues: FIFO, but for asks `ahead` of it (a
 * running program's), which are served first, FIFO among themselves.
 */
class CreditLane {
    capacity;
    current = 0;
    peak = 0;
    waiters = [];
    ahead = [];
    constructor(capacity) {
        this.capacity = capacity;
    }
    get stats() {
        return { current: this.current, peak: this.peak, queued: this.waiters.length + this.ahead.length };
    }
    /** Whether an ask ahead is queued. */
    get aheadQueued() {
        return this.ahead.length > 0;
    }
    /** Granted now, or null: an ask ahead waits only for asks ahead of it, any other for every ask queued. */
    tryAcquire(bytes, ahead = false) {
        if (this.ahead.length > 0 || (!ahead && this.waiters.length > 0) || this.current + bytes > this.capacity)
            return null;
        return this.grant(bytes);
    }
    acquire(bytes, signal) {
        return this.wait(bytes, signal, false);
    }
    /** acquire, ahead of every ordinary ask: granted as soon as it fits, after only the asks ahead before it. */
    acquireAhead(bytes, signal) {
        return this.wait(bytes, signal, true);
    }
    wait(bytes, signal, ahead) {
        if (signal?.aborted)
            return Promise.reject(abortError(signal));
        const immediate = this.tryAcquire(bytes, ahead);
        if (immediate)
            return Promise.resolve(immediate);
        const queue = ahead ? this.ahead : this.waiters;
        return new Promise((resolve, reject) => {
            const queued = {
                bytes,
                resolve,
                reject,
                signal,
                onAbort: signal
                    ? () => {
                        const index = queue.indexOf(queued);
                        if (index < 0)
                            return;
                        queue.splice(index, 1);
                        signal.removeEventListener('abort', queued.onAbort);
                        reject(abortError(signal));
                        this.drain();
                    }
                    : undefined,
            };
            queue.push(queued);
            signal?.addEventListener('abort', queued.onAbort, { once: true });
            if (signal?.aborted)
                queued.onAbort();
            else
                this.drain();
        });
    }
    grant(bytes) {
        this.current += bytes;
        this.peak = Math.max(this.peak, this.current);
        let leasedBytes = bytes;
        let released = false;
        return {
            get bytes() {
                return leasedBytes;
            },
            shrinkTo: (nextBytes) => {
                if (released) {
                    throw new Error('cannot shrink a released weighted credit lease');
                }
                if (!Number.isSafeInteger(nextBytes)
                    || nextBytes <= 0
                    || nextBytes > leasedBytes) {
                    throw new RangeError(`weighted credit lease can only shrink to a positive safe integer no larger than ${leasedBytes}: ${nextBytes}`);
                }
                this.current -= leasedBytes - nextBytes;
                leasedBytes = nextBytes;
                this.drain();
            },
            tryGrowTo: (nextBytes) => {
                if (released) {
                    throw new Error('cannot grow a released weighted credit lease');
                }
                if (!Number.isSafeInteger(nextBytes) || nextBytes < leasedBytes || nextBytes > this.capacity) {
                    throw new RangeError(`weighted credit lease can only grow to a safe integer from ${leasedBytes} to ${this.capacity}: ${nextBytes}`);
                }
                // Never ahead of a queued ask, as an ordinary tryAcquire.
                if (this.ahead.length > 0 || this.waiters.length > 0 || this.current + nextBytes - leasedBytes > this.capacity)
                    return false;
                this.current += nextBytes - leasedBytes;
                this.peak = Math.max(this.peak, this.current);
                leasedBytes = nextBytes;
                return true;
            },
            release: () => {
                if (released)
                    return;
                released = true;
                this.current -= leasedBytes;
                if (this.current < 0) {
                    throw new Error('weighted credit accounting underflow');
                }
                this.drain();
            },
        };
    }
    drain() {
        // Asks ahead first; the ordinary queue only once none is waiting.
        for (const queue of [this.ahead, this.waiters]) {
            for (let waiter = queue[0]; waiter !== undefined; waiter = queue[0]) {
                if (waiter.signal?.aborted) {
                    queue.shift();
                    waiter.signal.removeEventListener('abort', waiter.onAbort);
                    waiter.reject(abortError(waiter.signal));
                    continue;
                }
                if (this.current + waiter.bytes > this.capacity)
                    return;
                queue.shift();
                waiter.signal?.removeEventListener('abort', waiter.onAbort);
                waiter.resolve(this.grant(waiter.bytes));
            }
        }
    }
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
export class WeightedCreditPool {
    capacity;
    general;
    small;
    smallRequestBytes;
    constructor(capacity, options = {}) {
        this.capacity = capacity;
        if (!Number.isSafeInteger(capacity) || capacity <= 0) {
            throw new RangeError(`weighted credit capacity must be a positive safe integer: ${capacity}`);
        }
        const smallRequestBytes = options.smallRequestBytes ?? 0;
        const reserve = options.reserve ?? 0;
        if (!Number.isSafeInteger(smallRequestBytes) || smallRequestBytes < 0
            || !Number.isSafeInteger(reserve) || reserve < 0) {
            throw new RangeError('weighted credit reserve and small-request size must be non-negative safe integers');
        }
        if (smallRequestBytes > reserve) {
            throw new RangeError(`a small request (${smallRequestBytes}) must fit in the reserve (${reserve}) or it could never be granted`);
        }
        this.general = new CreditLane(capacity);
        this.smallRequestBytes = smallRequestBytes;
        this.small = smallRequestBytes > 0 ? new CreditLane(reserve) : null;
    }
    get stats() {
        const general = this.general.stats;
        if (!this.small)
            return general;
        const small = this.small.stats;
        return {
            current: general.current + small.current,
            peak: general.peak + small.peak,
            queued: general.queued + small.queued,
        };
    }
    isSmall(bytes) {
        return this.small !== null && bytes <= this.smallRequestBytes;
    }
    tryAcquire(bytes) {
        this.validateRequest(bytes);
        const shared = this.general.tryAcquire(bytes);
        if (shared || !this.isSmall(bytes))
            return shared;
        return this.small.tryAcquire(bytes);
    }
    /**
     * A running program's ask (SupervisorAllocationBudget.acquireRunning),
     * ahead of every ordinary ask: granted now if it fits beside what is held,
     * whatever is queued (a small one in its reserve too), or else as soon as
     * it fits in the shared capacity, the credit running work and reclaims
     * free. It never waits on the reserve, which neither frees.
     */
    acquireAhead(bytes, signal) {
        this.validateRequest(bytes);
        const now = signal?.aborted ? null : this.tryAcquireAhead(bytes);
        return now ? Promise.resolve(now) : this.general.acquireAhead(bytes, signal);
    }
    /** Whether a running program's ask (acquireAhead) waits. */
    get aheadQueued() {
        return this.general.aheadQueued;
    }
    /** acquireAhead's credit now, or null. */
    tryAcquireAhead(bytes) {
        this.validateRequest(bytes);
        const shared = this.general.tryAcquire(bytes, true);
        const small = this.isSmall(bytes) ? this.small : null;
        return shared ?? small?.tryAcquire(bytes, true) ?? null;
    }
    acquire(bytes, signal) {
        try {
            this.validateRequest(bytes);
        }
        catch (error) {
            return Promise.reject(error);
        }
        // Refused before any lane is asked, whichever would have granted it.
        if (signal?.aborted)
            return Promise.reject(abortError(signal));
        if (this.isSmall(bytes)) {
            // Shared capacity while it is free — a small request should get the
            // same concurrency as any other when nothing is contending. It never
            // joins the shared queue, so it cannot be parked behind a large owner.
            const shared = this.general.tryAcquire(bytes);
            if (shared)
                return Promise.resolve(shared);
            return this.small.acquire(bytes, signal);
        }
        return this.general.acquire(bytes, signal);
    }
    validateRequest(bytes) {
        if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > this.capacity) {
            throw new RangeError(`weighted credit request must be a positive safe integer no larger than ${this.capacity}: ${bytes}`);
        }
    }
}
function abortError(signal) {
    const reason = signal.reason;
    return new DOMException(reason instanceof Error ? reason.message : String(reason ?? 'The operation was aborted'), 'AbortError');
}
