/**
 * fenced-work.ts — durable record of the resident launches a Durable Object
 * owes, and their recovery after an instance reset.
 *
 * The platform resets a session Durable Object over what one turn has
 * outstanding in storage ("Internal error in Durable Object storage caused
 * object to be reset"), and a resident launch is the largest writer a session
 * has. Everything a launch holds is in memory, so the process it is building
 * and the terminal watching it both go with the instance — the journal is what
 * a LATER instance reads to know that happened, and this module is the whole
 * of that mechanism: the put→sync durability barrier on the way in, the
 * delete→sync release on the way out, and the once-per-instance recovery pump
 * that re-drives what a previous generation left behind.
 *
 * What a launch IS stays the embedder's: the journal stores the record it is
 * given and hands it back on recovery. The mechanism reads only the fields in
 * {@link FencedWorkRecord}; everything else in the record rides through
 * opaquely.
 */

/**
 * Prefix for the resident-process journal: one row per resident this session
 * owes the user, keyed by the pid it was built for.
 *
 * A resident holds its state in memory — the process table entry, the facet
 * handle, the terminal — so an instance reset destroys it silently. The row
 * is what a LATER instance reads to know a resident ended that way rather
 * than on purpose: a pid at or below the reader's own pid base was allocated
 * by a previous generation (PID_GEN_STRIDE, core's process-table). Written
 * (and synced) before the launch's first byte of work, rewritten as `running`
 * when the launch settles, and released only when the PROCESS ends — because
 * the resets this row survives strike after the launch as often as during it
 * (measured live, staging 2026-08-13: every observed reset landed seconds
 * AFTER settle).
 *
 * The VALUE is live production DO storage and must never change — renaming a
 * storage key is a migration, and orphaned rows are the least of what it
 * breaks.
 */
export const FENCED_WORK_KEY_PREFIX = 'resident-launch:';

/** A launch is re-driven once. A reset that recurs is not the transient one. */
export const FENCED_WORK_MAX_ATTEMPT = 1;

/**
 * A resident process this session owes the user, as a later instance would
 * have to re-drive it.
 *
 * The launch's own inputs and nothing derived from them: everything a launch
 * builds is a pure function of these, and the images it writes are content-
 * addressed, so re-driving is the same work again rather than a repair. The
 * inputs themselves are the embedder's — a record type extends this base with
 * whatever its `redrive` needs, and the journal never reads those fields.
 *
 * The row lives for the PROCESS's lifetime, not the launch's. Measured live
 * (staging, 2026-08-13): every observed reset struck seconds AFTER the launch
 * settled — the platform kills the object while the resident runs, which is
 * when a launch-scoped row had already been deleted and recovery had nothing
 * to find. A resident's facet cannot outlive its session instance (the
 * process host's held-open leg dies with it), so a row from a previous
 * generation always names a process that is genuinely gone.
 */
export interface FencedWorkRecord {
  pid: number;
  command: string;
  /** 0 for a launch the user asked for; 1 for the one re-drive it may get. */
  attempt: number;
  /** Where the resident was when its instance died: still being built, or
   *  booted and running. Running residents re-drive with a fresh attempt
   *  budget — their launch already proved itself once. */
  phase: 'starting' | 'running';
}

/**
 * The slice of Durable Object storage the journal writes through. Exactly a
 * `DurableObjectStorage`, narrowed to what the mechanism performs — `sync()`
 * is load-bearing, see {@link FencedWork.journal}.
 */
export interface FencedWorkStorage {
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T = unknown>(options: { prefix: string }): Promise<Map<string, T>>;
  sync(): Promise<void>;
}

/** What the journal's recovery needs from its embedder. */
export interface FencedWorkHost<R extends FencedWorkRecord> {
  /**
   * The current instance generation's pid floor. A pid at or below it was
   * allocated by a PREVIOUS instance (core's process-table, PID_GEN_STRIDE),
   * so its launch never finished; above it is this instance's own, still
   * running. The journal takes the base rather than the predicate so the one
   * definition of what a prior-generation pid is stays in the process table.
   */
  generationBase(): number;
  /**
   * Root a recovery re-drive on the instance (`ctx.waitUntil`) so it is not
   * an abandoned promise between turns.
   */
  waitUntil(promise: Promise<unknown>): void;
  /**
   * Re-drive an interrupted launch from its journalled inputs. `attempt` is
   * the budget the re-drive spends — the mechanism computes it, the embedder
   * carries it into the launch it starts. The result is discarded: a re-drive
   * owns its own process, and nobody is waiting on the pid it allocates.
   */
  redrive(record: R, attempt: number): Promise<unknown>;
  /** A re-drive is being started for this record. */
  onRedrive?(record: R): void;
  /** The record's re-drive budget is spent; the resident stays stopped. */
  onAbandoned?(record: R): void;
  /** The re-drive itself failed. */
  onRedriveFailed?(record: R, error: unknown): void;
}

/**
 * The resident-launch journal of one Durable Object instance.
 *
 * In-memory state here is per-instance on purpose: `journalledPids` tracks the
 * rows THIS instance wrote, and `recovered` whether this instance has already
 * read the journal a reset leaves behind. Rows from a previous instance are
 * recovery's to consume, never the release path's.
 */
export class FencedWork<R extends FencedWorkRecord> {
  /**
   * Pids THIS instance holds journal rows for. What keeps the terminal hook —
   * which fires for every process, shells and one-shots included — from
   * paying a storage delete for pids that never had a row.
   */
  private journalledPids = new Set<number>();
  /** Whether this instance has already read the journal a reset leaves behind. */
  private recovered = false;

  constructor(
    private readonly storage: FencedWorkStorage,
    private readonly host: FencedWorkHost<R>,
  ) {}

  /**
   * Record a launch as in flight, so an instance that replaces this one knows
   * it never finished. Best-effort: a launch that cannot be journalled still
   * runs, and a reset then costs exactly what it cost before the journal.
   *
   * Synced, not merely put: `await put()` resolves before durability, and the
   * reset this journal exists for destroys every write its turn still had
   * outstanding — measured live, a launch killed in its first chunks left NO
   * row for the replacement instance to find, which is how the recovery this
   * feeds sat inert while its own test stayed green. `sync()` is the storage
   * layer's durability barrier: the row is on disk before the launch performs
   * its first byte of real work. What remains is a reset between the put and
   * the sync's completion — and a launch that dies there has not started, so
   * losing its row costs a retype, not a recovery.
   */
  async journal(record: R): Promise<void> {
    try {
      this.journalledPids.add(record.pid);
      await this.storage.put(`${FENCED_WORK_KEY_PREFIX}${record.pid}`, record);
      await this.storage.sync();
    } catch (e: unknown) {
      console.warn('[nimbus] resident launch journal write failed:', errorMessage(e));
    }
  }

  /** True while this instance holds a journal row for `pid`. */
  has(pid: number): boolean {
    return this.journalledPids.has(pid);
  }

  /**
   * The journal row's one release: the process is over, nothing is owed.
   * Synced so an instance reset moments later cannot roll the delete back and
   * resurrect a process the user watched end.
   */
  async release(pid: number): Promise<void> {
    if (!this.journalledPids.delete(pid)) return;
    try {
      await this.storage.delete(`${FENCED_WORK_KEY_PREFIX}${pid}`);
      await this.storage.sync();
    } catch (e: unknown) {
      console.warn('[nimbus] resident launch journal delete failed:', errorMessage(e));
    }
  }

  /**
   * Re-drive the launches a previous instance was building when it was reset.
   *
   * Sited on the launch-turn pump because the pump is what an alarm calls, and
   * a launch that was suspended has an alarm armed for it — a reset during a
   * chunk fails that alarm, and the platform re-delivers it to the instance
   * that replaces this one. So the first turn after a reset is already this
   * one.
   *
   * Runs once per instance: the journal only changes when a launch of THIS
   * instance starts or settles, and those are rows this instance wrote.
   */
  async recoverInterrupted(): Promise<void> {
    if (this.recovered) return;
    this.recovered = true;
    const journal = await this.storage.list<R>({ prefix: FENCED_WORK_KEY_PREFIX });
    const base = this.host.generationBase();
    for (const [key, record] of journal) {
      // A pid at or below this instance's base was allocated by a PREVIOUS one
      // (process-table.ts, PID_GEN_STRIDE), so its launch never finished; above
      // the base is this instance's own, still running. Same predicate as
      // `session/rpc.ts` uses to attribute a prior generation's pid.
      if (!(record.pid > 0 && record.pid <= base)) continue;
      await this.storage.delete(key);
      if (record.attempt >= FENCED_WORK_MAX_ATTEMPT) {
        this.host.onAbandoned?.(record);
        continue;
      }
      this.host.onRedrive?.(record);
      // Not awaited: this call is running inside the alarm that granted the
      // turn, and the launch it starts asks for turns of its own through that
      // same alarm — awaiting it here would be waiting on an alarm that cannot
      // be scheduled until this one returns.
      this.host.waitUntil(
        this.host.redrive(record, record.attempt + 1)
          .catch((e: unknown) => {
            this.host.onRedriveFailed?.(record, e);
          }),
      );
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
