/**
 * ProcessLogRetention — when a process's logs are due to go, for the
 * ProcessLogStore.
 *
 * The one rule: a pid's logs go `ageMs` after its exit is recorded, or,
 * with no exit recorded, three times that after its last output once its
 * process is gone (an orphan). A pid with a reader stays. That covers the
 * pids a store holds in memory and the ones only its persisted rows hold:
 * an instance woken from hibernation holds none of its predecessor's pids,
 * and a sweep of memory alone would never drop them.
 *
 * A host sweeps (`due`) at the earliest deadline (`next`) and asks for the
 * next one only when a deadline may have appeared, never on a cadence, so an
 * idle object has nothing pending but that one alarm.
 */

/** A pid as its persisted rows describe it to retention. */
export interface PersistedLogPid {
  pid: number;
  /** When its exit was recorded; null when none was. */
  exitAt: number | null;
  /** Its newest chunk or exit, whichever is later. */
  lastActivity: number;
}

/** What retention reads of a pid a store holds in memory. */
export interface HeldLog {
  readonly exit: { readonly at: number } | null;
  readonly lastActivity: number;
  readonly subscribers: { readonly size: number };
}

/** When a pid's logs are due to go; null while nothing ends them (it runs, or is not known gone). */
function deadline(pid: number, exitAt: number | null, lastActivity: number, ageMs: number, isOrphan?: (pid: number) => boolean): number | null {
  if (exitAt !== null) return exitAt + ageMs;
  return isOrphan?.(pid) ? lastActivity + ageMs * 3 : null;
}

export class ProcessLogRetention {
  /**
   * The pids only persisted rows hold: what an earlier instance flushed and
   * this one has not touched. Listed from `list` on the first question (null
   * until then); it only shrinks, as a pid is held or dropped.
   */
  private persistedOnly: Map<number, PersistedLogPid> | null = null;

  /**
   * @param list The persisted pids, minus any already queued for deletion;
   *   null while the store persists nothing.
   */
  constructor(private readonly list: () => PersistedLogPid[] | null) {}

  /**
   * The earliest deadline over `held` and the persisted-only pids, or null
   * when nothing retained will expire by itself.
   */
  next(held: ReadonlyMap<number, HeldLog>, ageMs: number, isOrphan?: (pid: number) => boolean): number | null {
    let next: number | null = null;
    for (const [pid, log] of held) {
      if (log.subscribers.size !== 0) continue;
      const at = deadline(pid, log.exit?.at ?? null, log.lastActivity, ageMs, isOrphan);
      if (at !== null && (next === null || at < next)) next = at;
    }
    for (const [pid, row] of this.listed(held)) {
      const at = deadline(pid, row.exitAt, row.lastActivity, ageMs, isOrphan);
      if (at !== null && (next === null || at < next)) next = at;
    }
    return next;
  }

  /**
   * Every pid due at `now`: held ones for the store to drop from memory, and
   * persisted-only ones, which leave this set here. The store drops the rows
   * of both.
   */
  due(held: ReadonlyMap<number, HeldLog>, now: number, ageMs: number, isOrphan?: (pid: number) => boolean): number[] {
    const due: number[] = [];
    for (const [pid, log] of held) {
      if (log.subscribers.size !== 0) continue;
      const at = deadline(pid, log.exit?.at ?? null, log.lastActivity, ageMs, isOrphan);
      if (at !== null && at <= now) due.push(pid);
    }
    const persistedOnly = this.listed(held);
    for (const [pid, row] of persistedOnly) {
      const at = deadline(pid, row.exitAt, row.lastActivity, ageMs, isOrphan);
      if (at === null || at > now) continue;
      persistedOnly.delete(pid);
      due.push(pid);
    }
    return due;
  }

  /** The store holds `pid` now (created or hydrated): its memory state answers for it. */
  held(pid: number): void {
    this.persistedOnly?.delete(pid);
  }

  /** The persisted rows changed owner (a new adapter): list them again. */
  reset(): void {
    this.persistedOnly = null;
  }

  private listed(held: ReadonlyMap<number, HeldLog>): Map<number, PersistedLogPid> {
    if (this.persistedOnly) return this.persistedOnly;
    let rows: PersistedLogPid[] | null;
    try {
      rows = this.list();
    } catch {
      // Fail-soft like every adapter call, and asked once: a listing that
      // throws would otherwise throw again on every question.
      rows = [];
    }
    if (rows === null) return new Map();
    this.persistedOnly = new Map(rows.filter((row) => !held.has(row.pid)).map((row) => [row.pid, row]));
    return this.persistedOnly;
  }
}
