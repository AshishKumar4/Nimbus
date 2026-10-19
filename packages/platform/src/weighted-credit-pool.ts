export interface CreditLease {
  readonly bytes: number;
  release(): void;
}

export interface ResizableCreditLease extends CreditLease {
  shrinkTo(bytes: number): void;
  /**
   * Holds `bytes` in all if the rest can be granted now, in its own lane, as
   * tryAcquire would grant it; else holds what it held and answers false.
   */
  tryGrowTo(bytes: number): boolean;
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
 * How long a waiter woken to its turn keeps it for its own continuation to
 * take the credit. workerd cancels the continuations of a request that has
 * completed or been canceled when another request's code resolves its
 * promise (the cross-request promise rule, on by date since 2024-10-14), so
 * a waiter whose request is gone is woken and never takes: its turn lapses
 * and the next waiter's comes. A live continuation takes it in far less.
 */
export const CREDIT_TURN_MS = 1000;

/**
 * A place in a lane's queue. `woken` resolves when its turn comes; `take`,
 * called from the waiter's own continuation, holds the credit then, or
 * answers null when the turn lapsed, the credit no longer fits, or it was
 * aborted, and the place waits again. `leave` gives up the place.
 */
export interface CreditTurn {
  woken(): Promise<void>;
  take(): ResizableCreditLease | null;
  leave(): void;
}

/**
 * An ask queued in a lane. `waiting` for its turn; `woken` to it at
 * `wokenAt`, its credit free for it to take; `lapsed` when the turn passed
 * untaken (out of the queue, back in at the end if it ever takes); `done`
 * once it took its credit, left, or was aborted.
 */
class Turn implements CreditTurn {
  state: 'waiting' | 'woken' | 'lapsed' | 'done' = 'waiting';
  wokenAt = 0;
  /** Its wait for the turn it is queued for, resolved as it is woken or aborted. */
  turn: Promise<void>;
  wake: () => void = () => {};
  /** Its look at the line every CREDIT_TURN_MS while it is queued. */
  recheck: ReturnType<typeof setInterval> | undefined = undefined;

  constructor(readonly lane: CreditLane, readonly bytes: number, readonly signal: AbortSignal | undefined, readonly ahead: boolean) {
    this.turn = this.arm();
  }

  /** A fresh wait for its turn. */
  arm(): Promise<void> {
    this.state = 'waiting';
    this.turn = new Promise<void>((resolve) => { this.wake = resolve; });
    return this.turn;
  }

  woken(): Promise<void> { return this.turn; }
  take(): ResizableCreditLease | null { return this.lane.take(this); }
  leave(): void { this.lane.leave(this); }
  handleEvent(): void { this.lane.abandon(this); }
}

/**
 * One byte capacity and its queues: FIFO, but for asks `ahead` of it (a
 * running program's), which are served first, FIFO among themselves.
 */
class CreditLane {
  private current = 0;
  private peak = 0;
  private readonly waiters: Turn[] = [];
  private readonly ahead: Turn[] = [];

  /** `largest`: the most one lease of this lane may hold (a small request's bound, for the reserve). */
  constructor(readonly capacity: number, private readonly largest = capacity) {}

  get stats(): WeightedCreditPoolStats {
    return { current: this.current, peak: this.peak, queued: this.waiters.length + this.ahead.length };
  }

  /**
   * Whether the asks ahead want more than is free: what reclaiming more is
   * for. Each holds its bytes once its turn is taken, so they are counted
   * together, a turn woken and not yet taken included.
   */
  get aheadStarved(): boolean {
    return this.ahead.reduce((wanted, waiter) => wanted + waiter.bytes, this.current) > this.capacity;
  }

  /** Granted now, or null: an ask ahead waits only for asks ahead of it, any other for every ask queued. */
  tryAcquire(bytes: number, ahead = false): ResizableCreditLease | null {
    if (this.ahead.length > 0 || (!ahead && this.waiters.length > 0) || this.current + bytes > this.capacity) return null;
    return this.grant(bytes);
  }

  acquire(bytes: number, signal?: AbortSignal): Promise<ResizableCreditLease> {
    return this.wait(bytes, signal, false);
  }

  /** acquire, ahead of every ordinary ask: granted as soon as it fits, after only the asks ahead before it. */
  acquireAhead(bytes: number, signal?: AbortSignal): Promise<ResizableCreditLease> {
    return this.wait(bytes, signal, true);
  }

  private wait(bytes: number, signal: AbortSignal | undefined, ahead: boolean): Promise<ResizableCreditLease> {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    const immediate = this.tryAcquire(bytes, ahead);
    return immediate ? Promise.resolve(immediate) : this.takeInTurn(this.queue(bytes, signal, ahead), signal);
  }

  private async takeInTurn(turn: Turn, signal: AbortSignal | undefined): Promise<ResizableCreditLease> {
    try {
      for (;;) {
        await turn.turn;
        const lease = this.take(turn);
        if (lease) return lease;
        if (signal?.aborted) throw abortError(signal);
      }
    } finally {
      this.leave(turn);
    }
  }

  /**
   * A place at the end of the queue for `bytes` (ahead of every ordinary ask,
   * if `ahead`). While it is queued it looks at the line again every
   * CREDIT_TURN_MS, so a turn another waiter never took lapses even when
   * nothing else touches the lane. Asked with a signal already aborted, it
   * is done at once, as it would be on the abort.
   */
  queue(bytes: number, signal: AbortSignal | undefined, ahead: boolean): Turn {
    const turn = new Turn(this, bytes, signal, ahead);
    signal?.addEventListener('abort', turn, { once: true });
    this.place(turn);
    if (signal?.aborted) this.abandon(turn);
    else this.drain();
    return turn;
  }

  private place(turn: Turn): void {
    (turn.ahead ? this.ahead : this.waiters).push(turn);
    if (turn.recheck !== undefined) return;
    const timer = setInterval(() => {
      if (turn.state === 'waiting' || turn.state === 'woken') this.drain();
      else { clearInterval(timer); turn.recheck = undefined; }
    }, CREDIT_TURN_MS);
    turn.recheck = timer;
  }

  private remove(turn: Turn): void {
    const queue = turn.ahead ? this.ahead : this.waiters;
    const index = queue.indexOf(turn);
    if (index >= 0) queue.splice(index, 1);
  }

  /** Its signal aborted: it is done, its wait ends, and the next turn may come. */
  abandon(turn: Turn): void {
    if (turn.state === 'done') return;
    this.remove(turn);
    turn.state = 'done';
    turn.wake();
    this.drain();
  }

  take(turn: Turn): ResizableCreditLease | null {
    if (turn.state === 'done') return null;
    const now = Date.now();
    // Taken past its turn: the turn passed, as if a look at the line had seen it first.
    if (turn.state === 'woken' && now - turn.wokenAt >= CREDIT_TURN_MS) {
      this.remove(turn);
      turn.state = 'lapsed';
      this.drain(now);
    }
    if (turn.state === 'lapsed') {
      turn.arm();
      this.place(turn);
      this.drain(now);
      return null;
    }
    // Its turn, its credit still free, and no running ask before an ordinary one: its own now.
    if (turn.state === 'woken' && this.current + turn.bytes <= this.capacity && (turn.ahead || this.ahead.length === 0)) {
      this.remove(turn);
      turn.state = 'done';
      const lease = this.grant(turn.bytes);
      this.drain(now);
      return lease;
    }
    // Not its turn yet, or no longer room: it waits again, in its place.
    if (turn.state === 'woken') turn.arm();
    return null;
  }

  leave(turn: Turn): void {
    turn.signal?.removeEventListener('abort', turn);
    if (turn.recheck !== undefined) clearInterval(turn.recheck);
    turn.recheck = undefined;
    if (turn.state !== 'done') {
      this.remove(turn);
      turn.state = 'done';
    }
    this.drain();
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
      tryGrowTo: (nextBytes: number) => {
        if (released) {
          throw new Error('cannot grow a released weighted credit lease');
        }
        if (!Number.isSafeInteger(nextBytes) || nextBytes < leasedBytes) {
          throw new RangeError(`weighted credit lease can only grow to a safe integer no smaller than ${leasedBytes}: ${nextBytes}`);
        }
        // Never ahead of a queued ask, as an ordinary tryAcquire.
        if (nextBytes > this.largest || this.ahead.length > 0 || this.waiters.length > 0
          || this.current + nextBytes - leasedBytes > this.capacity) return false;
        this.current += nextBytes - leasedBytes;
        this.peak = Math.max(this.peak, this.current);
        leasedBytes = nextBytes;
        return true;
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

  /**
   * Wake the first waiter whose credit is free to its turn, asks ahead first;
   * the ordinary queue only once none is waiting. The credit is never handed
   * over: the waiter takes it in its own continuation (CreditTurn.take), so
   * one whose continuation never runs holds nothing. A woken turn holds its
   * queue until it is taken or lapses (CREDIT_TURN_MS), one turn at a time.
   */
  private drain(now = Date.now()): void {
    for (const queue of [this.ahead, this.waiters]) {
      for (let waiter = queue[0]; waiter !== undefined; waiter = queue[0]) {
        if (waiter.state === 'woken') {
          if (now - waiter.wokenAt < CREDIT_TURN_MS) return;
          // Never taken: its continuation is gone, or late and back at the end of the line if it ever takes.
          queue.shift();
          waiter.state = 'lapsed';
          continue;
        }
        if (this.current + waiter.bytes > this.capacity) return;
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
    this.small = smallRequestBytes > 0 ? new CreditLane(reserve, smallRequestBytes) : null;
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

  /**
   * A running program's ask (SupervisorAllocationBudget.acquireRunning),
   * ahead of every ordinary ask: granted now if it fits beside what is held,
   * whatever is queued (a small one in its reserve too), or else as soon as
   * it fits in the shared capacity, the credit running work and reclaims
   * free. It never waits on the reserve, which neither frees.
   */
  acquireAhead(bytes: number, signal?: AbortSignal): Promise<ResizableCreditLease> {
    this.validateRequest(bytes);
    const now = signal?.aborted ? null : this.tryAcquireAhead(bytes);
    return now ? Promise.resolve(now) : this.general.acquireAhead(bytes, signal);
  }

  /** Whether a running program's ask (acquireAhead) waits for credit no woken turn is taking (CreditLane.aheadStarved). */
  get aheadStarved(): boolean {
    return this.general.aheadStarved;
  }

  /** acquireAhead's credit now, or null. */
  tryAcquireAhead(bytes: number): ResizableCreditLease | null {
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
  queue(bytes: number, signal?: AbortSignal): CreditTurn {
    this.validateRequest(bytes);
    return (this.small !== null && this.isSmall(bytes) ? this.small : this.general).queue(bytes, signal, false);
  }

  acquire(bytes: number, signal?: AbortSignal): Promise<ResizableCreditLease> {
    try {
      this.validateRequest(bytes);
    } catch (error) {
      return Promise.reject(error as Error);
    }
    // Refused before any lane is asked, whichever would have granted it.
    if (signal?.aborted) return Promise.reject(abortError(signal));
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
