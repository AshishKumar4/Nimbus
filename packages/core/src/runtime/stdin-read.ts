/**
 * What a synchronous read of stdin may hold while it waits.
 *
 * Node's `fs.readFileSync(0)` blocks the program until its writer ends stdin.
 * A Nimbus process cannot block, so the run stops at such a read and the
 * session reads the rest of the pipe until it ends, then runs the program
 * again with all of it (worker runtime/stop-replay.ts, FacetManager.exec).
 * What the session holds meanwhile is bounded here, per read and across the
 * session.
 */

/**
 * The most of a pipe a synchronous read of stdin waits for. A writer that
 * ends within it is all handed to the run after the stop; past it, the read
 * fails naming this bound (FacetManager.exec), so an endless writer
 * (`yes | node -e "fs.readFileSync(0)"`) costs this much at most. It also
 * bounds what a synchronous reader of a `< file` redirect holds of the file
 * (fd 0 is the file; process.stdin streams the rest of it).
 *
 * What the session reads of a pipe while a run is stopped is held in the
 * session Durable Object until the next run takes it, so this is one budget
 * for the whole session (ReadAheadBudget), shared by its concurrent stops as
 * they read: a read the budget cannot cover fails rather than holding more.
 * Measured on a throwaway, when the same bytes were read ahead of a program
 * (2026-09-30;
 * GraphQL durableObjectsPeriodicGroups, max memoryUsageBytes of the session
 * object per minute; `yes | head -c N | node -e "fs.readFileSync(0)"`):
 * one 16 MiB read ahead at a time peaked at 59.5-82.0 MB of the 128 MB
 * isolate, no higher than the same session's ordinary `echo x | node` launch
 * (71.8-82.0 MB); three at once peaked at 115.2 MB, too close to the limit,
 * whose reset ends every process in the session.
 */
export const STDIN_SYNC_READ_BYTES = 16 * 1024 * 1024;

/**
 * What one process holds of a ReadAheadBudget: bytes taken as they are about
 * to be read, and given back when it no longer holds them.
 */
export interface ReadAheadAccount {
  /** Bytes this process holds now. */
  readonly held: number;
  /** Take up to `max` bytes from the budget; returns how many it got (0 when none is free). */
  take(max: number): number;
  /** Give back `n` bytes (all this process holds when omitted); never more than it holds. */
  give(n?: number): void;
}

/**
 * The session's budget for stdin held across stops. It counts the bytes the
 * session's Durable Object holds, not what stops might hold: a stop takes
 * bytes from it a piece at a time, just before reading that piece, so one
 * waiting on a slow writer holds almost none of it. It gives them back
 * however the process ends (exit, abort, a failed launch).
 */
export class ReadAheadBudget {
  private heldBytes = 0;

  constructor(readonly capacity: number) {}

  /** Bytes held now, across all processes. */
  get held(): number {
    return this.heldBytes;
  }

  /** An account for one process's held stdin. */
  open(): ReadAheadAccount {
    let mine = 0;
    return {
      get held() { return mine; },
      take: (max) => {
        const got = Math.max(0, Math.min(max, this.capacity - this.heldBytes));
        this.heldBytes += got;
        mine += got;
        return got;
      },
      give: (n = mine) => {
        const back = Math.max(0, Math.min(n, mine));
        mine -= back;
        this.heldBytes -= back;
      },
    };
  }
}
