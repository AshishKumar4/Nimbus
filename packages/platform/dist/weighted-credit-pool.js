/**
 * How long a waiter woken to its turn keeps it for its own continuation to
 * take the credit. workerd cancels the continuations of a request that has
 * completed or been canceled when another request's code resolves its
 * promise (the cross-request promise rule, on by date since 2024-10-14), so
 * a waiter whose request is gone is woken and never takes: its turn lapses
 * and the next waiter's comes. A live continuation takes it in far less.
 */
export const CREDIT_TURN_MS = 1000;
/**
 * One byte capacity and its queues: FIFO, but for asks `ahead` of it (a
 * running program's), which are served first, FIFO among themselves.
 */
class CreditLane {
    capacity;
    largest;
    current = 0;
    peak = 0;
    waiters = [];
    ahead = [];
    /** `largest`: the most one lease of this lane may hold (a small request's bound, for the reserve). */
    constructor(capacity, largest = capacity) {
        this.capacity = capacity;
        this.largest = largest;
    }
    get stats() {
        return { current: this.current, peak: this.peak, queued: this.waiters.length + this.ahead.length };
    }
    /**
     * Whether the asks ahead want more than is free: what reclaiming more is
     * for. Each holds its bytes once its turn is taken, so they are counted
     * together, a turn woken and not yet taken included.
     */
    get aheadStarved() {
        return this.ahead.reduce((wanted, waiter) => wanted + waiter.bytes, this.current) > this.capacity;
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
    async wait(bytes, signal, ahead) {
        if (signal?.aborted)
            throw abortError(signal);
        const immediate = this.tryAcquire(bytes, ahead);
        if (immediate)
            return immediate;
        const turn = this.queue(bytes, signal, ahead);
        try {
            for (;;) {
                await turn.woken();
                const lease = turn.take();
                if (lease)
                    return lease;
                if (signal?.aborted)
                    throw abortError(signal);
            }
        }
        finally {
            turn.leave();
        }
    }
    /**
     * A place at the end of the queue for `bytes` (ahead of every ordinary ask,
     * if `ahead`). While it is queued it looks at the line again every
     * CREDIT_TURN_MS, so a turn another waiter never took lapses even when
     * nothing else touches the lane.
     */
    queue(bytes, signal, ahead) {
        const queue = ahead ? this.ahead : this.waiters;
        const waiter = { bytes, state: 'waiting', wokenAt: 0, turn: Promise.resolve(), wake: () => { }, refuse: () => { } };
        let recheck;
        const arm = () => {
            waiter.state = 'waiting';
            waiter.turn = new Promise((resolve, reject) => { waiter.wake = resolve; waiter.refuse = reject; });
            // Refused with no one waiting on it (a turn never observed), it is no unhandled rejection.
            waiter.turn.catch(() => { });
        };
        const place = () => {
            arm();
            queue.push(waiter);
            if (recheck !== undefined)
                return;
            const timer = setInterval(() => {
                if (waiter.state === 'waiting' || waiter.state === 'woken')
                    this.drain();
                else {
                    clearInterval(timer);
                    recheck = undefined;
                }
            }, CREDIT_TURN_MS);
            recheck = timer;
        };
        const remove = () => {
            const index = queue.indexOf(waiter);
            if (index >= 0)
                queue.splice(index, 1);
        };
        const listen = (aborted) => {
            const onAbort = () => {
                if (waiter.state === 'done')
                    return;
                remove();
                waiter.state = 'done';
                waiter.refuse(abortError(aborted));
                this.drain();
            };
            aborted.addEventListener('abort', onAbort, { once: true });
            return () => aborted.removeEventListener('abort', onAbort);
        };
        const unlisten = signal ? listen(signal) : () => { };
        place();
        this.drain();
        return {
            woken: () => waiter.turn,
            take: () => {
                if (waiter.state === 'done')
                    return null;
                const now = Date.now();
                // Taken past its turn: the turn passed, as if a look at the line had seen it first.
                if (waiter.state === 'woken' && now - waiter.wokenAt >= CREDIT_TURN_MS) {
                    remove();
                    waiter.state = 'lapsed';
                    this.drain(now);
                }
                if (waiter.state === 'lapsed') {
                    place();
                    this.drain(now);
                    return null;
                }
                // Its turn, its credit still free, and no running ask before an ordinary one: its own now.
                if (waiter.state === 'woken' && this.current + bytes <= this.capacity && (ahead || this.ahead.length === 0)) {
                    remove();
                    waiter.state = 'done';
                    const lease = this.grant(bytes);
                    this.drain(now);
                    return lease;
                }
                // Not its turn yet, or no longer room: it waits again, in its place.
                if (waiter.state === 'woken')
                    arm();
                return null;
            },
            leave: () => {
                unlisten();
                if (recheck !== undefined)
                    clearInterval(recheck);
                recheck = undefined;
                if (waiter.state !== 'done') {
                    remove();
                    waiter.state = 'done';
                }
                this.drain();
            },
        };
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
                if (!Number.isSafeInteger(nextBytes) || nextBytes < leasedBytes) {
                    throw new RangeError(`weighted credit lease can only grow to a safe integer no smaller than ${leasedBytes}: ${nextBytes}`);
                }
                // Never ahead of a queued ask, as an ordinary tryAcquire.
                if (nextBytes > this.largest || this.ahead.length > 0 || this.waiters.length > 0
                    || this.current + nextBytes - leasedBytes > this.capacity)
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
    /**
     * Wake the first waiter whose credit is free to its turn, asks ahead first;
     * the ordinary queue only once none is waiting. The credit is never handed
     * over: the waiter takes it in its own continuation (CreditTurn.take), so
     * one whose continuation never runs holds nothing. A woken turn holds its
     * queue until it is taken or lapses (CREDIT_TURN_MS), one turn at a time.
     */
    drain(now = Date.now()) {
        for (const queue of [this.ahead, this.waiters]) {
            for (let waiter = queue[0]; waiter !== undefined; waiter = queue[0]) {
                if (waiter.state === 'woken') {
                    if (now - waiter.wokenAt < CREDIT_TURN_MS)
                        return;
                    // Never taken: its continuation is gone, or late and back at the end of the line if it ever takes.
                    queue.shift();
                    waiter.state = 'lapsed';
                    continue;
                }
                if (this.current + waiter.bytes > this.capacity)
                    return;
                waiter.state = 'woken';
                waiter.wokenAt = now;
                waiter.wake();
                return;
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
        this.small = smallRequestBytes > 0 ? new CreditLane(reserve, smallRequestBytes) : null;
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
    /** Whether a running program's ask (acquireAhead) waits for credit no woken turn is taking (CreditLane.aheadStarved). */
    get aheadStarved() {
        return this.general.aheadStarved;
    }
    /** acquireAhead's credit now, or null. */
    tryAcquireAhead(bytes) {
        this.validateRequest(bytes);
        const shared = this.general.tryAcquire(bytes, true);
        const small = this.isSmall(bytes) ? this.small : null;
        return shared ?? small?.tryAcquire(bytes, true) ?? null;
    }
    /**
     * A place in line for `bytes`, in the lane it would wait in, for a caller
     * that takes its turn itself (CreditTurn): what acquire does once nothing
     * is free.
     */
    queue(bytes, signal) {
        this.validateRequest(bytes);
        return (this.small !== null && this.isSmall(bytes) ? this.small : this.general).queue(bytes, signal, false);
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
