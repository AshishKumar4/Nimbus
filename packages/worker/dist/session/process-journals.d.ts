/**
 * process-journals.ts — the session's book of the processes whose write log
 * (process-fs-journal.ts) may still hold changes: a resident logs every
 * change in its facet's store before its program is told it succeeded, and
 * what it logged and the session never answered is drained from that store
 * once the process is gone.
 *
 * A row is written when the process's facet opens and deleted once a drain
 * emptied its log: every release of the facet drains it, before its store
 * goes. A row left when the session starts again (it was evicted, it
 * crashed) is a store to drain before any process runs (`drainPending`): its
 * name is reserved from minting meanwhile, so no new process's start wipes
 * it. A row whose store cannot be read is said, named, every time, and kept.
 */
import type { VfsCred } from '@nimbus-sh/core/vfs/vfs.js';
/** The session's SQLite, as the manager holds it. */
interface Sql {
    exec(query: string, ...bindings: unknown[]): Iterable<Record<string, unknown>>;
}
export interface PendingJournal {
    facet: string;
    pid: number;
    cred: VfsCred;
}
export declare class ProcessJournals {
    private readonly sql;
    private ready;
    constructor(sql: () => Sql | undefined);
    private table;
    /** `pid`'s facet `facet` opened: its log may hold changes from now on. */
    opened(facet: string, pid: number, cred: VfsCred): void;
    /** `pid`'s log is empty: a drain emptied it. */
    settled(pid: number): void;
    /** The row of `pid`, while its log may hold changes. */
    of(pid: number): PendingJournal | undefined;
    /** Every log that may hold changes. */
    pending(): PendingJournal[];
    /**
     * Drain the logs a previous incarnation left: every name reserved from
     * minting first, before anything is awaited; then each drained in the
     * order its facet opened (`drain` empties it and drops its store), its row
     * deleted and its name freed. One that fails is said through `log`, named,
     * and kept, reserved, for the next start.
     */
    drainPending(io: {
        reserved: Set<string>;
        drain(row: PendingJournal): Promise<void>;
        log(message: string): void;
    }): Promise<void>;
}
export {};
//# sourceMappingURL=process-journals.d.ts.map