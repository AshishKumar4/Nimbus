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

interface CreditWaiter {
  readonly bytes: number;
  readonly resolve: (lease: ResizableCreditLease) => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
}

/** One FIFO queue over one byte capacity. */
class CreditLane {
  private current = 0;
  private peak = 0;
  private readonly waiters: CreditWaiter[] = [];

  constructor(readonly capacity: number) {}

  get stats(): WeightedCreditPoolStats {
    return { current: this.current, peak: this.peak, queued: this.waiters.length };
  }

  tryAcquire(bytes: number): ResizableCreditLease | null {
    if (this.waiters.length > 0 || this.current + bytes > this.capacity) return null;
    return this.grant(bytes);
  }

  acquire(bytes: number, signal?: AbortSignal): Promise<ResizableCreditLease> {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    const immediate = this.tryAcquire(bytes);
    if (immediate) return Promise.resolve(immediate);

    return new Promise<ResizableCreditLease>((resolve, reject) => {
      const waiter: CreditWaiter = {
        bytes,
        resolve,
        reject,
        signal,
        onAbort: signal
          ? () => {
              const index = this.waiters.indexOf(waiter);
              if (index < 0) return;
              this.waiters.splice(index, 1);
              signal.removeEventListener('abort', waiter.onAbort!);
              reject(abortError(signal));
              this.drain();
            }
          : undefined,
      };
      this.waiters.push(waiter);
      signal?.addEventListener('abort', waiter.onAbort!, { once: true });
      if (signal?.aborted) {
        waiter.onAbort!();
        return;
      }
      this.drain();
    });
  }

  private grant(bytes: number): ResizableCreditLease {
    this.current += bytes;
    this.peak = Math.max(this.peak, this.current);
    let leasedBytes = bytes;
    let released = false;
    return {
      get bytes() {
        return leasedBytes;
      },
      shrinkTo: (nextBytes: number) => {
        if (released) {
          throw new Error('cannot shrink a released weighted credit lease');
        }
        if (
          !Number.isSafeInteger(nextBytes)
          || nextBytes <= 0
          || nextBytes > leasedBytes
        ) {
          throw new RangeError(
            `weighted credit lease can only shrink to a positive safe integer no larger than ${leasedBytes}: ${nextBytes}`,
          );
        }
        this.current -= leasedBytes - nextBytes;
        leasedBytes = nextBytes;
        this.drain();
      },
      release: () => {
        if (released) return;
        released = true;
        this.current -= leasedBytes;
        if (this.current < 0) {
          throw new Error('weighted credit accounting underflow');
        }
        this.drain();
      },
    };
  }

  private drain(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters[0];
      if (waiter.signal?.aborted) {
        this.waiters.shift();
        waiter.signal.removeEventListener('abort', waiter.onAbort!);
        waiter.reject(abortError(waiter.signal));
        continue;
      }
      if (this.current + waiter.bytes > this.capacity) return;
      this.waiters.shift();
      waiter.signal?.removeEventListener('abort', waiter.onAbort!);
      waiter.resolve(this.grant(waiter.bytes));
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
  private readonly general: CreditLane;
  private readonly small: CreditLane | null;
  private readonly smallRequestBytes: number;

  constructor(readonly capacity: number, options: WeightedCreditPoolOptions = {}) {
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
      throw new RangeError(
        `a small request (${smallRequestBytes}) must fit in the reserve (${reserve}) or it could never be granted`,
      );
    }
    this.general = new CreditLane(capacity);
    this.smallRequestBytes = smallRequestBytes;
    this.small = smallRequestBytes > 0 ? new CreditLane(reserve) : null;
  }

  get stats(): WeightedCreditPoolStats {
    const general = this.general.stats;
    if (!this.small) return general;
    const small = this.small.stats;
    return {
      current: general.current + small.current,
      peak: general.peak + small.peak,
      queued: general.queued + small.queued,
    };
  }

  private isSmall(bytes: number): boolean {
    return this.small !== null && bytes <= this.smallRequestBytes;
  }

  tryAcquire(bytes: number): ResizableCreditLease | null {
    this.validateRequest(bytes);
    const shared = this.general.tryAcquire(bytes);
    if (shared || !this.isSmall(bytes)) return shared;
    return this.small!.tryAcquire(bytes);
  }

  acquire(bytes: number, signal?: AbortSignal): Promise<ResizableCreditLease> {
    try {
      this.validateRequest(bytes);
    } catch (error) {
      return Promise.reject(error as Error);
    }
    if (this.isSmall(bytes)) {
      // Shared capacity while it is free — a small request should get the
      // same concurrency as any other when nothing is contending. It never
      // joins the shared queue, so it cannot be parked behind a large owner.
      const shared = this.general.tryAcquire(bytes);
      if (shared) return Promise.resolve(shared);
      return this.small!.acquire(bytes, signal);
    }
    return this.general.acquire(bytes, signal);
  }

  private validateRequest(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > this.capacity) {
      throw new RangeError(
        `weighted credit request must be a positive safe integer no larger than ${this.capacity}: ${bytes}`,
      );
    }
  }
}

function abortError(signal: AbortSignal): DOMException {
  const reason = signal.reason;
  return new DOMException(
    reason instanceof Error ? reason.message : String(reason ?? 'The operation was aborted'),
    'AbortError',
  );
}
