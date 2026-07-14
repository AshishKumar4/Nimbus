export interface CreditLease {
  readonly bytes: number;
  release(): void;
}

export interface WeightedCreditPoolStats {
  readonly current: number;
  readonly peak: number;
  readonly queued: number;
}

interface CreditWaiter {
  readonly bytes: number;
  readonly resolve: (lease: CreditLease) => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
}

/**
 * FIFO weighted credit shared by the write streams of one SqliteVFS.
 * Capacity is measured in retained payload bytes, not stream or RPC count.
 */
export class WeightedCreditPool {
  private current = 0;
  private peak = 0;
  private readonly waiters: CreditWaiter[] = [];

  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new RangeError(`write-stream credit capacity must be a positive safe integer: ${capacity}`);
    }
  }

  get stats(): WeightedCreditPoolStats {
    return {
      current: this.current,
      peak: this.peak,
      queued: this.waiters.length,
    };
  }

  tryAcquire(bytes: number): CreditLease | null {
    this.validateRequest(bytes);
    if (this.waiters.length > 0 || this.current + bytes > this.capacity) return null;
    return this.grant(bytes);
  }

  acquire(bytes: number, signal?: AbortSignal): Promise<CreditLease> {
    try {
      this.validateRequest(bytes);
    } catch (error) {
      return Promise.reject(error);
    }
    if (signal?.aborted) return Promise.reject(abortError(signal));
    const immediate = this.tryAcquire(bytes);
    if (immediate) return Promise.resolve(immediate);

    return new Promise<CreditLease>((resolve, reject) => {
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
        `write-stream credit request must be a positive safe integer no larger than ${this.capacity}: ${bytes}`,
      );
    }
  }

  private grant(bytes: number): CreditLease {
    this.current += bytes;
    this.peak = Math.max(this.peak, this.current);
    let released = false;
    return {
      bytes,
      release: () => {
        if (released) return;
        released = true;
        this.current -= bytes;
        if (this.current < 0) {
          throw new Error('write-stream credit accounting underflow');
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
