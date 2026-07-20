/**
 * FIFO weighted credit shared by the write streams of one SqliteVFS.
 * Capacity is measured in retained payload bytes, not stream or RPC count.
 */
export class WeightedCreditPool {
    capacity;
    current = 0;
    peak = 0;
    waiters = [];
    constructor(capacity) {
        this.capacity = capacity;
        if (!Number.isSafeInteger(capacity) || capacity <= 0) {
            throw new RangeError(`write-stream credit capacity must be a positive safe integer: ${capacity}`);
        }
    }
    get stats() {
        return {
            current: this.current,
            peak: this.peak,
            queued: this.waiters.length,
        };
    }
    tryAcquire(bytes) {
        this.validateRequest(bytes);
        if (this.waiters.length > 0 || this.current + bytes > this.capacity)
            return null;
        return this.grant(bytes);
    }
    acquire(bytes, signal) {
        try {
            this.validateRequest(bytes);
        }
        catch (error) {
            return Promise.reject(error);
        }
        if (signal?.aborted)
            return Promise.reject(abortError(signal));
        const immediate = this.tryAcquire(bytes);
        if (immediate)
            return Promise.resolve(immediate);
        return new Promise((resolve, reject) => {
            const waiter = {
                bytes,
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
    validateRequest(bytes) {
        if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > this.capacity) {
            throw new RangeError(`write-stream credit request must be a positive safe integer no larger than ${this.capacity}: ${bytes}`);
        }
    }
    grant(bytes) {
        this.current += bytes;
        this.peak = Math.max(this.peak, this.current);
        let released = false;
        return {
            bytes,
            release: () => {
                if (released)
                    return;
                released = true;
                this.current -= bytes;
                if (this.current < 0) {
                    throw new Error('write-stream credit accounting underflow');
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
            waiter.resolve(this.grant(waiter.bytes));
        }
    }
}
function abortError(signal) {
    const reason = signal.reason;
    return new DOMException(reason instanceof Error ? reason.message : String(reason ?? 'The operation was aborted'), 'AbortError');
}
