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
    readonly exit: {
        readonly at: number;
    } | null;
    readonly lastActivity: number;
    readonly subscribers: {
        readonly size: number;
    };
}
export declare class ProcessLogRetention {
    private readonly list;
    /**
     * The pids only persisted rows hold: what an earlier instance flushed and
     * this one has not touched. Listed from `list` on the first question (null
     * until then); it only shrinks, as a pid is held or dropped.
     */
    private persistedOnly;
    /**
     * @param list The persisted pids, minus any already queued for deletion;
     *   null while the store persists nothing.
     */
    constructor(list: () => PersistedLogPid[] | null);
    /**
     * The earliest deadline over `held` and the persisted-only pids, or null
     * when nothing retained will expire by itself.
     */
    next(held: ReadonlyMap<number, HeldLog>, ageMs: number, isOrphan?: (pid: number) => boolean): number | null;
    /**
     * Every pid due at `now`: held ones for the store to drop from memory, and
     * persisted-only ones, which leave this set here. The store drops the rows
     * of both.
     */
    due(held: ReadonlyMap<number, HeldLog>, now: number, ageMs: number, isOrphan?: (pid: number) => boolean): number[];
    /** The store holds `pid` now (created or hydrated): its memory state answers for it. */
    held(pid: number): void;
    /** The persisted rows changed owner (a new adapter): list them again. */
    reset(): void;
    private listed;
}
//# sourceMappingURL=process-log-retention.d.ts.map