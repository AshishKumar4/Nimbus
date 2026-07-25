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

interface CreditWaiter {
  readonly bytes: number;
  readonly resolve: (lease: ResizableCreditLease) => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
}

/**
 * FIFO byte-credit pool shared by concurrent allocation owners.
 * Capacity is measured in retained bytes, not operation count.
 */
export class WeightedCreditPool {
  private current = 0;
  private peak = 0;
  private readonly waiters: CreditWaiter[] = [];

  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new RangeError(`weighted credit capacity must be a positive safe integer: ${capacity}`);
    }
  }

  get stats(): WeightedCreditPoolStats {
    return {
      current: this.current,
      peak: this.peak,
      queued: this.waiters.length,
    };
  }

  tryAcquire(bytes: number): ResizableCreditLease | null {
    this.validateRequest(bytes);
    if (this.waiters.length > 0 || this.current + bytes > this.capacity) return null;
    return this.grant(bytes);
  }

  acquire(bytes: number, signal?: AbortSignal): Promise<ResizableCreditLease> {
    try {
      this.validateRequest(bytes);
    } catch (error) {
      return Promise.reject(error);
    }
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

  private validateRequest(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > this.capacity) {
      throw new RangeError(
        `weighted credit request must be a positive safe integer no larger than ${this.capacity}: ${bytes}`,
      );
    }
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

function abortError(signal: AbortSignal): DOMException {
  const reason = signal.reason;
  return new DOMException(
    reason instanceof Error ? reason.message : String(reason ?? 'The operation was aborted'),
    'AbortError',
  );
}
