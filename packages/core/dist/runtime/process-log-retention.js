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
/** When a pid's logs are due to go; null while nothing ends them (it runs, or is not known gone). */
function deadline(pid, exitAt, lastActivity, ageMs, isOrphan) {
    if (exitAt !== null)
        return exitAt + ageMs;
    return isOrphan?.(pid) ? lastActivity + ageMs * 3 : null;
}
/**
 * Every retained pid with a deadline: the held ones without a reader, then
 * the persisted ones the store does not hold.
 */
function* deadlines(held, persisted, ageMs, isOrphan) {
    for (const [pid, log] of held) {
        if (log.subscribers.size !== 0)
            continue;
        const at = deadline(pid, log.exit?.at ?? null, log.lastActivity, ageMs, isOrphan);
        if (at !== null)
            yield [pid, at];
    }
    for (const [pid, row] of persisted) {
        if (held.has(pid))
            continue;
        const at = deadline(pid, row.exitAt, row.lastActivity, ageMs, isOrphan);
        if (at !== null)
            yield [pid, at];
    }
}
export class ProcessLogRetention {
    list;
    /**
     * The pids persisted rows hold: what an earlier instance flushed. Listed
     * from `list` on the first question (null until then); it only shrinks, as
     * a pid's logs are dropped. A pid the store also holds in memory answers
     * for itself and its row is skipped, but kept: the store lets go of a pid
     * whose hydrate came back empty (a load that failed), and its rows still
     * have to go.
     */
    persisted = null;
    /**
     * @param list The persisted pids, minus any already queued for deletion;
     *   null while the store persists nothing.
     */
    constructor(list) {
        this.list = list;
    }
    /**
     * The earliest deadline over `held` and the persisted pids it does not
     * hold, or null when nothing retained will expire by itself.
     */
    next(held, ageMs, isOrphan) {
        let next = null;
        for (const [, at] of deadlines(held, this.listed(), ageMs, isOrphan)) {
            if (next === null || at < next)
                next = at;
        }
        return next;
    }
    /**
     * Every pid due at `now`: held ones for the store to drop from memory, and
     * persisted ones it does not hold. All of them leave this set here; the
     * store drops their rows.
     */
    due(held, now, ageMs, isOrphan) {
        const persisted = this.listed();
        const due = [];
        for (const [pid, at] of deadlines(held, persisted, ageMs, isOrphan)) {
            if (at <= now)
                due.push(pid);
        }
        for (const pid of due)
            persisted.delete(pid);
        return due;
    }
    /** The store dropped `pid`'s logs for another reason (the pid cap): its rows are going. */
    forget(pid) {
        this.persisted?.delete(pid);
    }
    /** The persisted rows changed owner (a new adapter): list them again. */
    reset() {
        this.persisted = null;
    }
    listed() {
        if (this.persisted)
            return this.persisted;
        let rows;
        try {
            rows = this.list();
        }
        catch {
            // Fail-soft like every adapter call, and asked once: a listing that
            // throws would otherwise throw again on every question.
            rows = [];
        }
        if (rows === null)
            return new Map();
        this.persisted = new Map(rows.map((row) => [row.pid, row]));
        return this.persisted;
    }
}
