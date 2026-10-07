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
export class ProcessJournals {
    sql;
    ready = false;
    constructor(sql) {
        this.sql = sql;
    }
    table() {
        const sql = this.sql();
        if (sql === undefined)
            return undefined;
        if (!this.ready) {
            sql.exec(`CREATE TABLE IF NOT EXISTS nimbus_process_journals (
        facet TEXT PRIMARY KEY,
        pid INTEGER NOT NULL,
        cred TEXT NOT NULL,
        opened_at INTEGER NOT NULL
      )`);
            this.ready = true;
        }
        return sql;
    }
    /** `pid`'s facet `facet` opened: its log may hold changes from now on. */
    opened(facet, pid, cred) {
        this.table()?.exec('INSERT OR REPLACE INTO nimbus_process_journals (facet, pid, cred, opened_at) VALUES (?, ?, ?, ?)', facet, pid, JSON.stringify(cred), Date.now());
    }
    /** `pid`'s log is empty: a drain emptied it. */
    settled(pid) {
        this.table()?.exec('DELETE FROM nimbus_process_journals WHERE pid = ?', pid);
    }
    /** The row of `pid`, while its log may hold changes. */
    of(pid) {
        return this.pending().find((row) => row.pid === pid);
    }
    /** Every log that may hold changes. */
    pending() {
        const sql = this.table();
        if (sql === undefined)
            return [];
        return [...sql.exec('SELECT facet, pid, cred FROM nimbus_process_journals ORDER BY opened_at')].map((row) => ({
            facet: String(row.facet),
            pid: Number(row.pid),
            cred: JSON.parse(String(row.cred)),
        }));
    }
    /**
     * Drain the logs a previous incarnation left: every name reserved from
     * minting first, before anything is awaited; then each drained in the
     * order its facet opened (`drain` empties it and drops its store), its row
     * deleted and its name freed. One that fails is said through `log`, named,
     * and kept, reserved, for the next start.
     */
    async drainPending(io) {
        const pending = this.pending();
        for (const row of pending)
            io.reserved.add(row.facet);
        for (const row of pending) {
            try {
                await io.drain(row);
            }
            catch (error) {
                io.log(`[nimbus] the write log of pid ${row.pid} (facet '${row.facet}') could not be drained: `
                    + `${error instanceof Error ? error.message : String(error)}; it is kept for the next start`);
                continue;
            }
            this.settled(row.pid);
            io.reserved.delete(row.facet);
        }
    }
}
