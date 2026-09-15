/** One FIFO queue over one byte capacity. */
class CreditLane {
    capacity;
    current = 0;
    peak = 0;
    resident = 0;
    waiters = [];
    constructor(capacity) {
        this.capacity = capacity;
    }
    get stats() {
        return {
            current: this.current, peak: this.peak, queued: this.waiters.length, resident: this.resident,
        };
    }
    tryAcquire(bytes) {
        if (this.waiters.length > 0 || this.current + bytes > this.capacity)
            return null;
        return this.grant(bytes, false);
    }
    /**
     * The largest claim this lane can ever grant: capacity less what resident
     * owners hold for their whole lifetime. A claim above it cannot be
     * satisfied by waiting, because nothing it is waiting for will be
     * released.
     */
    get grantableCeiling() {
        return this.capacity - this.resident;
    }
    acquire(bytes, signal, resident = false) {
        if (signal?.aborted)
            return Promise.reject(abortError(signal));
        // Refuse a claim no amount of waiting can satisfy, rather than parking it
        // in the FIFO forever. A parked claim is indistinguishable from a caller
        // that stopped: no error, no timeout, and — because the queue refuses
        // everyone behind it — no further progress anywhere in the isolate. That
        // is what a real-vite launch looked like for four rounds of debugging.
        if (bytes > this.grantableCeiling) {
            return Promise.reject(new RangeError(`weighted credit claim of ${bytes} bytes can never be granted: capacity is ${this.capacity} `
                + `and ${this.resident} bytes are held by resident owners, leaving ${this.grantableCeiling}`));
        }
        const immediate = resident ? null : this.tryAcquire(bytes);
        if (immediate)
            return Promise.resolve(immediate);
        if (resident && this.waiters.length === 0 && this.current + bytes <= this.capacity) {
            return Promise.resolve(this.grant(bytes, true));
        }
        return new Promise((resolve, reject) => {
            const waiter = {
                bytes,
                resident,
                resolve,
                reject,
                signal,
                onAbort: signal
                    ? () => {
                        const index = this.waiters.indexOf(waiter);
                        if (index < 0)
                            return;
                        this.waiters.splice(index, 1);
                        signal.removeEventListener('abort', waiter.onAbort);
                        reject(abortError(signal));
                        this.drain();
                    }
                    : undefined,
            };
            this.waiters.push(waiter);
            signal?.addEventListener('abort', waiter.onAbort, { once: true });
            if (signal?.aborted) {
                waiter.onAbort();
                return;
            }
            this.drain();
        });
    }
    grant(bytes, resident) {
        this.current += bytes;
        if (resident)
            this.resident += bytes;
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
                if (resident)
                    this.resident -= leasedBytes - nextBytes;
                leasedBytes = nextBytes;
                this.drain();
            },
            release: () => {
                if (released)
                    return;
                released = true;
                this.current -= leasedBytes;
                if (resident)
                    this.resident -= leasedBytes;
                if (this.current < 0) {
                    throw new Error('weighted credit accounting underflow');
                }
                this.drain();
            },
        };
    }
    drain() {
        while (this.waiters.length > 0) {
            const waiter = this.waiters[0];
            if (waiter.signal?.aborted) {
                this.waiters.shift();
                waiter.signal.removeEventListener('abort', waiter.onAbort);
                waiter.reject(abortError(waiter.signal));
                continue;
            }
            if (this.current + waiter.bytes > this.capacity)
                return;
            this.waiters.shift();
            waiter.signal?.removeEventListener('abort', waiter.onAbort);
            waiter.resolve(this.grant(waiter.bytes, waiter.resident));
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
            resident: general.resident + small.resident,
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
    acquire(bytes, signal) {
        try {
            this.validateRequest(bytes);
        }
        catch (error) {
            return Promise.reject(error);
        }
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
    /**
     * Take credit that will be held for the owner's whole lifetime rather than
     * for one operation — the esbuild pool's wasm image is the case.
     *
     * Recorded as a floor so a later claim that could never fit around it is
     * refused with both numbers instead of parking in the FIFO forever.
     */
    acquireResident(bytes, signal) {
        try {
            this.validateRequest(bytes);
        }
        catch (error) {
            return Promise.reject(error);
        }
        return this.general.acquire(bytes, signal, true);
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
