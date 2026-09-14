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
 * The resident-launch journal of one Durable Object instance.
 *
 * In-memory state here is per-instance on purpose: `journalledPids` tracks the
 * rows THIS instance wrote, and `recovered` whether this instance has already
 * read the journal a reset leaves behind. Rows from a previous instance are
 * recovery's to consume, never the release path's.
 */
export class FencedWork {
    storage;
    host;
    /**
     * Pids THIS instance holds journal rows for. What keeps the terminal hook —
     * which fires for every process, shells and one-shots included — from
     * paying a storage delete for pids that never had a row.
     */
    journalledPids = new Set();
    /** Re-drives in flight, by journal key — recovery's un-awaited ones and a
     *  caller-driven one share the same drive for the same row. */
    drives = new Map();
    /** Whether this instance has already read the journal a reset leaves behind. */
    recovered = false;
    constructor(storage, host) {
        this.storage = storage;
        this.host = host;
    }
    /**
     * Record a launch as in flight, so an instance that replaces this one knows
     * it never finished. A launch that cannot be journalled does not start: the
     * rejection reaches the caller, which reports it like any launch failure.
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
    async journal(record) {
        this.journalledPids.add(record.pid);
        try {
            await this.storage.put(`${FENCED_WORK_KEY_PREFIX}${record.pid}`, record);
            await this.storage.sync();
        }
        catch (cause) {
            throw new Error('resident launch journal write failed', { cause });
        }
    }
    /** True while this instance holds a journal row for `pid`. */
    has(pid) {
        return this.journalledPids.has(pid);
    }
    /**
     * The journal row's one release: the process is over, nothing is owed.
     * Synced so an instance reset moments later cannot roll the delete back and
     * resurrect a process the user watched end.
     */
    async release(pid) {
        if (!this.journalledPids.delete(pid))
            return;
        await this.storage.delete(`${FENCED_WORK_KEY_PREFIX}${pid}`);
        await this.storage.sync();
    }
    /**
     * Drop every row `predicate` claims, live-pid bookkeeping included, synced
     * like {@link release}. The one bulk delete the journal admits: an owner
     * that removes its durable application is owed no recovery, however many
     * generations back its rows were written.
     */
    async purgeWhere(predicate) {
        const rows = await this.storage.list({ prefix: FENCED_WORK_KEY_PREFIX });
        let purged = 0;
        for (const [key, record] of rows) {
            if (!predicate(record))
                continue;
            this.journalledPids.delete(record.pid);
            await this.storage.delete(key);
            purged += 1;
        }
        if (purged > 0)
            await this.storage.sync();
        return purged;
    }
    /**
     * Every journal row, storage-true — the rows this instance wrote and the
     * ones a previous instance left behind. The one read surface a request-
     * driven recovery needs to find the durable launch a port belongs to.
     */
    async rows() {
        return this.storage.list({ prefix: FENCED_WORK_KEY_PREFIX });
    }
    /**
     * Re-drive one journal row — the awaited sibling of recovery's un-awaited
     * re-drives, for a caller that must know whether the launch actually came
     * back. Single-flight per row: a request-driven drive and recovery's own
     * never boot the same launch twice. Resolves true only when the re-drive
     * itself FAILED and the failure was reported; a settled drive supersedes
     * the row the same way recovery's does.
     */
    drive(key, record) {
        let inflight = this.drives.get(key);
        if (inflight === undefined) {
            inflight = (async () => {
                if (record.attempt >= FENCED_WORK_MAX_ATTEMPT) {
                    this.host.onAbandoned?.(record);
                    await this.supersede(key);
                    return true;
                }
                let failed = false;
                try {
                    await this.host.redrive(record, record.attempt + 1);
                }
                catch (e) {
                    this.host.onRedriveFailed?.(record, e);
                    failed = true;
                }
                // A reported failure is settled business — supersede either way, so
                // the row never re-surfaces on the next recovery.
                await this.supersede(key);
                return failed;
            })();
            this.drives.set(key, inflight);
            inflight.finally(() => {
                if (this.drives.get(key) === inflight)
                    this.drives.delete(key);
            });
        }
        return inflight;
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
     * Runs once per instance — re-calls in the same instance are no-ops — and
     * re-drives every row whose pid is `> 0` and at or below `generationBase()`
     * with `attempt < FENCED_WORK_MAX_ATTEMPT`; the rest are abandoned. What the
     * re-drive resolver receives is the journalled recipe and nothing else:
     * env and credentials are never written to storage, so the resolver's
     * embedder re-resolves them rather than reading them back.
     */
    async recoverInterrupted() {
        if (this.recovered)
            return;
        this.recovered = true;
        const journal = await this.storage.list({ prefix: FENCED_WORK_KEY_PREFIX });
        const base = this.host.generationBase();
        const abandoned = [];
        const redriven = [];
        for (const [key, record] of journal) {
            // A pid at or below this instance's base was allocated by a PREVIOUS one
            // (process-table.ts, PID_GEN_STRIDE), so its launch never finished; above
            // the base is this instance's own, still running. Same predicate as
            // `session/rpc.ts` uses to attribute a prior generation's pid.
            if (!(record.pid > 0 && record.pid <= base))
                continue;
            (record.attempt >= FENCED_WORK_MAX_ATTEMPT ? abandoned : redriven).push([key, record]);
        }
        // The attempt is SPENT in storage, synced, before any re-drive starts.
        // Deleting the row here instead would open a loss window: writes flush in
        // order, so a reset between the delete's flush and the re-driven launch's
        // own journal write leaves a durable state with no row for an owed
        // launch — and the un-awaited re-drive dies with the instance (waitUntil
        // retains nothing). With the rewrite, every durable cut is either the
        // untouched row (recovery re-runs) or a spent attempt (the recurrence
        // abandons loudly). The superseded row is deleted only when its re-drive
        // settles, after the launch's own row exists.
        for (const [key] of abandoned)
            await this.storage.delete(key);
        for (const [key, record] of redriven) {
            await this.storage.put(key, { ...record, attempt: record.attempt + 1 });
        }
        if (abandoned.length > 0 || redriven.length > 0)
            await this.storage.sync();
        for (const [, record] of abandoned)
            this.host.onAbandoned?.(record);
        for (const [key, record] of redriven) {
            this.host.onRedrive?.(record);
            // Not awaited: this call is running inside the alarm that granted the
            // turn, and the launch it starts asks for turns of its own through that
            // same alarm — awaiting it here would be waiting on an alarm that cannot
            // be scheduled until this one returns. `drive` single-flights it: a
            // request that arrives mid-launch waits on this same drive rather than
            // booting a second process.
            this.host.waitUntil(this.drive(key, record));
        }
    }
    /**
     * Delete a row whose re-drive has settled — succeeded, failed and been
     * reported, or handed off to its own journal row. Not `release()`: that
     * path is for pids THIS instance journalled, and this row's pid belongs to
     * a previous generation the terminal hook will never fire for.
     */
    async supersede(key) {
        this.journalledPids.delete(Number(key.slice(FENCED_WORK_KEY_PREFIX.length)));
        await this.storage.delete(key);
        await this.storage.sync();
    }
}
