/**
 * session/hibernation.ts — W9 hibernation persistence + alarm dispatch.
 *
 * Workerd hibernates Durable Objects between requests to free memory.
 * On wake, the new isolate must rebuild its in-memory state from
 * SQL — but it also needs to know "is this the same lifecycle as
 * before, or did workerd recycle me?" That distinction matters for
 * recovery (warmJoin vs cold init) and is captured by isolateGen,
 * a counter persisted across hibernations.
 *
 * Surfaces:
 *   - wireHibernationOnConstruct(ctx) — runs configureWsHibernation in
 *     the DO ctor; graceful-degrades on throw.
 *   - wireProcessLogPersist(host, ctx) — installs the SQL-backed
 *     PersistAdapter on the process supervisor's log store; its
 *     activity hook schedules debounced flushes.
 *   - ensureHibSchema(host, ctx) — idempotent CREATE TABLE for
 *     w9_proc_logs + w9_proc_exits.
 *   - scheduleHibFlush(host, ctx) — debounced setTimeout + best-effort
 *     setAlarm for post-hibernation drain.
 *   - dispatchAlarm(host) — alarm() handler body: the fabric's generic
 *     reason dispatcher with this session's handlers registered.
 *   - flushOnClose(host) — synchronous flush on ws close.
 *
 * The alarm multiplexer itself (reason map, scheduleAlarm, the per-instance
 * chain) and maybeBumpIsolateGen are fabric machinery —
 * `@nimbus-sh/fabric/alarms.js`; this module registers the session's reasons
 * ('w9-flush' | 'log-janitor' | 'resident-launch') on top of it.
 *
 * **`ctx` taken as a separate arg from `host`** because the parent
 * `CloudflareDurableObject` class declares `ctx` as `protected`, which
 * is nominal-typed in TS and cannot appear on a public interface
 * (DEFECT-D1 found at S3; documented in session-refactor-build-progress.md).
 *
 * Per plan §VI.7 F.2 invariant: `_w9PersistWired` must be reset
 * between log-store replacement (`processes.resetLogStore()`) and
 * re-wire on `/api/_test/hib/simulate`. The class-side handler is
 * responsible for setting `host._w9PersistWired = false` BEFORE calling
 * wireProcessLogPersist again.
 */
import { configureWsHibernation } from '@nimbus-sh/fabric/ws-hibernation-config.js';
import { dispatchAlarm as dispatchAlarmReasons, scheduleAlarm, } from '@nimbus-sh/fabric/alarms.js';
import { SESSION_DESTROYED_KEY, W9_FLUSH_DEBOUNCE_MS } from './keys.js';
/**
 * Run at DO ctor time. Returns the result for the class to assign to
 * `_w9WsConfig`. Failures are non-fatal — older workerd builds may lack
 * the API; the result lands in /api/_diag/memory.hib for verification.
 */
export function wireHibernationOnConstruct(ctx) {
    try {
        return configureWsHibernation(ctx);
    }
    catch (e) {
        console.warn('[nimbus/W9] configureWsHibernation threw:', e?.message);
        return {
            autoResponseConfigured: false,
            timeoutSetMs: null,
            autoResponseError: e?.message,
            timeoutError: e?.message,
        };
    }
}
/**
 * W9: install the SQL-backed PersistAdapter on the process supervisor's
 * log store.
 *
 * NOTE: any future alarm-driven subsystem MUST coordinate via a single
 * `alarm()` dispatcher (e.g., a `nextAlarmReason` storage key checked
 * inside the dispatcher). Today W9 is the only consumer; the dispatcher
 * lives in `dispatchAlarm()` below, invoked from the class's `alarm()`
 * handler.
 *
 * Idempotent: gated by host._w9PersistWired. Caller MUST reset that
 * flag to false before re-invoking after a log-store replacement
 * (per /api/_test/hib/simulate flow; plan §VI.7 F.2 invariant).
 */
export function wireProcessLogPersist(host, ctx) {
    if (host._w9PersistWired)
        return;
    host._w9PersistWired = true;
    const adapter = {
        load(pid) {
            try {
                ensureHibSchema(host, ctx);
                const sql = ctx.storage.sql;
                const chunkRows = [...sql.exec('SELECT pid, seq, ts, stream, data, binary FROM w9_proc_logs WHERE pid = ? ORDER BY seq ASC', pid)];
                const exitRows = [...sql.exec('SELECT code, at, reason FROM w9_proc_exits WHERE pid = ?', pid)];
                const chunks = chunkRows.map((r) => ({
                    ts: Number(r.ts),
                    stream: r.stream === 'stderr' ? 'stderr' : 'stdout',
                    data: String(r.data),
                    binary: !!r.binary,
                    ...(r.seq !== undefined ? { seq: Number(r.seq) } : {}),
                }));
                const exit = exitRows.length > 0
                    ? {
                        code: Number(exitRows[0].code),
                        at: Number(exitRows[0].at),
                        reason: exitRows[0].reason ?? undefined,
                    }
                    : null;
                return { chunks, exit };
            }
            catch {
                return null;
            }
        },
        persistChunks(pid, rows) {
            if (rows.length === 0)
                return;
            try {
                ensureHibSchema(host, ctx);
                const sql = ctx.storage.sql;
                // Use a single transactionSync wrapping the per-row INSERTs so
                // a partial write either fully lands or fully rolls back. Real
                // multi-row VALUES (?,?,?), (?,?,?), … is faster but requires
                // dynamic-arity SQL building — clarity wins here; flushes
                // happen at most once per debounce window so the volume is low.
                ctx.storage.transactionSync(() => {
                    for (const r of rows) {
                        const c = r.chunk;
                        sql.exec('INSERT OR REPLACE INTO w9_proc_logs (pid, seq, ts, stream, data, binary) VALUES (?, ?, ?, ?, ?, ?)', pid, r.seq, c.ts, c.stream, c.data, c.binary ? 1 : 0);
                    }
                });
            }
            catch (e) {
                console.warn('[nimbus/W9] persistChunks failed:', e?.message);
            }
        },
        persistExit(pid, info) {
            try {
                ensureHibSchema(host, ctx);
                const sql = ctx.storage.sql;
                sql.exec('INSERT OR REPLACE INTO w9_proc_exits (pid, code, at, reason) VALUES (?, ?, ?, ?)', pid, info.code, info.at, info.reason ?? null);
            }
            catch (e) {
                console.warn('[nimbus/W9] persistExit failed:', e?.message);
            }
        },
        dropPid(pid) {
            try {
                ensureHibSchema(host, ctx);
                const sql = ctx.storage.sql;
                ctx.storage.transactionSync(() => {
                    sql.exec('DELETE FROM w9_proc_logs WHERE pid = ?', pid);
                    sql.exec('DELETE FROM w9_proc_exits WHERE pid = ?', pid);
                });
            }
            catch (e) {
                console.warn('[nimbus/W9] dropPid failed:', e?.message);
            }
        },
        pruneBeforeSeq(pid, seq) {
            try {
                ensureHibSchema(host, ctx);
                const sql = ctx.storage.sql;
                sql.exec('DELETE FROM w9_proc_logs WHERE pid = ? AND seq < ?', pid, seq);
            }
            catch (e) {
                console.warn('[nimbus/W9] pruneBeforeSeq failed:', e?.message);
            }
        },
    };
    // The supervisor fires the activity hook after every appendOutput /
    // markExit. Exit-on-process-end is a strong "flush soon" signal — if
    // the process crashed we want the dump persisted before the actor can
    // hibernate. Schedule but don't bypass debounce, so a fast
    // exit-after-spawn doesn't double-fire. The store doesn't (and
    // shouldn't) know about timers — flush scheduling is the host's
    // responsibility.
    //
    // The W1 log-janitor sweep is armed here too — on log ACTIVITY, not in
    // the DO constructor. A constructor-armed janitor re-armed itself on
    // every boot, including boots caused by a destroyed session's own
    // leftover alarm, making every session DO ever created fire an alarm
    // every ~60s forever (see dispatchAlarm's re-arm condition below).
    host.processes.setLogPersist(adapter, () => {
        scheduleHibFlush(host, ctx);
        ensureLogJanitor(host, ctx);
    });
}
/**
 * W1: arm the log-janitor alarm cycle for this instance. Called from the
 * log-activity hook so only sessions that actually produce process logs
 * carry the sweep alarm. Idempotent per instance via `_w1JanitorArmed`;
 * dispatchAlarm clears the flag when it stops re-arming (idle session)
 * so the next burst of log activity re-arms the cycle.
 *
 * Why alarm-based instead of setTimeout: a recurring setTimeout prevents
 * the DO from hibernating (billed duration continuously). Alarms persist
 * across hibernation; the DO sleeps between fires.
 */
/**
 * W1: lift the destroyed-session tombstone when a destroyed session id is
 * LEGITIMATELY re-initialized (documented SDK flow: stable job ids reuse a
 * session id after destroy — the id maps deterministically to the same DO).
 * Without this the recreated session would work but never re-arm the
 * log-janitor, so its persisted w9_proc_logs would grow unswept forever.
 * Called only from the session-init seams (shell WS attach / SDK ready) —
 * straggler facet RPCs never reach them, so a dead session stays inert.
 */
export function clearDestroyedTombstone(host, ctx) {
    if (!host._w1SessionDestroyed)
        return;
    host._w1SessionDestroyed = false;
    void Promise.resolve(ctx?.storage?.delete?.(SESSION_DESTROYED_KEY)).catch((e) => {
        console.warn('[nimbus/W1] tombstone clear failed:', e?.message);
    });
}
export function ensureLogJanitor(host, ctx) {
    if (host._w1JanitorArmed)
        return;
    // A destroyed session must stay inert: a straggler facet RPC that wakes
    // the dead DO and appends output would otherwise re-arm the alarm cycle
    // on a session that no longer exists (the zombie-alarm hazard).
    if (host._w1SessionDestroyed)
        return;
    // Optimistic flag (dedupes same-tick appends), CONFIRMED by the schedule
    // outcome: scheduleAlarm swallows storage errors, and a failure with the
    // flag left set would mean no alarm AND nothing ever re-arming until the
    // instance recycles.
    host._w1JanitorArmed = true;
    void scheduleAlarm(host, ctx, 'log-janitor', Date.now() + 60_000).then((ok) => {
        if (!ok)
            host._w1JanitorArmed = false;
    });
}
/** W9: idempotent SQL schema bootstrap. */
export function ensureHibSchema(host, ctx) {
    if (host._w9SchemaInit)
        return;
    host._w9SchemaInit = true;
    try {
        const sql = ctx.storage.sql;
        sql.exec('CREATE TABLE IF NOT EXISTS w9_proc_logs (' +
            'pid INTEGER NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL, ' +
            'stream TEXT NOT NULL, data TEXT NOT NULL, binary INTEGER NOT NULL, ' +
            'PRIMARY KEY (pid, seq))');
        sql.exec('CREATE INDEX IF NOT EXISTS w9_proc_logs_ts ON w9_proc_logs(ts)');
        sql.exec('CREATE TABLE IF NOT EXISTS w9_proc_exits (' +
            'pid INTEGER PRIMARY KEY, code INTEGER NOT NULL, at INTEGER NOT NULL, ' +
            'reason TEXT)');
    }
    catch (e) {
        console.warn('[nimbus/W9] schema init failed:', e?.message);
        host._w9SchemaInit = false; // retry next time
    }
}
/**
 * W9: ensure the alarm is set for the next flush window. Cheap to
 * call repeatedly — we only schedule the in-isolate flush timer if
 * it isn't already set. The persistent alarm goes through scheduleAlarm
 * so it coordinates with W1's log-janitor sweep.
 */
export function scheduleHibFlush(host, ctx) {
    if (host._w9FlushTimer)
        return;
    // Local timer for fast in-isolate flush. SHORT-LIVED (250 ms); the
    // callback nulls itself so this timer does not persistently prevent
    // hibernation — once it fires, the DO is timer-free again.
    // Per CF docs, transient setTimeout during an active request is the
    // expected pattern; what blocks hibernation is a RECURRING timer.
    host._w9FlushTimer = setTimeout(() => {
        host._w9FlushTimer = null;
        try {
            host.processes.flushLogs();
        }
        catch (e) {
            console.warn('[nimbus/W9] flush threw:', e?.message);
        }
    }, W9_FLUSH_DEBOUNCE_MS);
    // Persistent alarm: fires post-hibernation if the in-isolate timer
    // didn't get a chance to run (DO evicted under memory pressure
    // before the 250ms debounce expired). Coordinated via scheduleAlarm
    // so W1's log-janitor doesn't clobber it (or vice-versa).
    // Fire-and-forget — scheduleAlarm is fail-soft.
    void scheduleAlarm(host, ctx, 'w9-flush', Date.now() + W9_FLUSH_DEBOUNCE_MS * 4);
}
/**
 * W1: this session's alarm() handler body — the fabric's multi-reason
 * dispatcher with this session's handlers registered:
 *   - `'w9-flush'` → processes.flushLogs()
 *   - `'resident-launch'` → pumpResidentLaunches()
 *   - `'log-janitor'` → processes.dropLogsOlderThan(orphanCheck); re-arm
 *     for next 60s cycle while the session still has anything to sweep.
 *
 * `janitorOrphanCheck` is the orphan-pid predicate provided by the
 * caller (typically `(pid) => !host.processes.get(pid)`). Decoupled
 * so HibHost doesn't need to import ProcessTable.
 */
export function dispatchAlarm(host, ctx, janitorOrphanCheck, pumpResidentLaunches) {
    return dispatchAlarmReasons(host, ctx, {
        'w9-flush': () => {
            host.processes.flushLogs();
        },
        'resident-launch': async () => {
            // Awaited, not fired and forgotten: this invocation is the fresh
            // turn the launch asked for, and it has to stay the one paying for
            // the chunk it just released.
            await pumpResidentLaunches?.();
        },
        'log-janitor': (now) => {
            host.processes.dropLogsOlderThan(undefined, janitorOrphanCheck);
            // Re-arm only while the session still has running processes or
            // buffered logs to sweep. An idle, abandoned, or destroyed
            // session must NOT keep an eternal 60s alarm loop alive: the
            // janitor used to self-renew unconditionally (and the DO
            // constructor re-armed it on every alarm-triggered boot), so
            // every session ever created kept booting its DO every ~60s
            // forever. The accumulated fleet of deleted probe sessions
            // produced continuous DO-storage churn (measured ~24 zombie
            // boots/s on 2026-07-13) that intermittently reset LIVE
            // session DOs mid-run ("Internal error in Durable Object
            // storage caused object to be reset"). The next log append
            // re-arms the cycle via ensureLogJanitor.
            if (host.processes.stats.running > 0 || host.processes.logStats.totalPids > 0) {
                return { rearmAt: now + 60_000 };
            }
            host._w1JanitorArmed = false;
        },
    }, () => {
        // Legacy path: pre-W1 deploys had no map. dispatchAlarm was called
        // with no map and unconditionally ran the log flush. Preserve
        // that on a missing map (one-time post-deploy, then the map is
        // populated by the next scheduleHibFlush / scheduleAlarm call).
        try {
            host.processes.flushLogs();
        }
        catch (e) {
            console.warn('[nimbus/W9] legacy flush threw:', e?.message);
        }
    });
}
/**
 * W9: synchronous flush of the process-log ring on session close.
 * Wraps `processes.flushLogs()` in a try/catch so a flush failure
 * doesn't take down the close handler. Cheap when there's nothing
 * dirty (idempotent inside the store).
 */
export function flushOnClose(host) {
    try {
        host.processes.flushLogs();
    }
    catch (e) {
        console.warn('[nimbus/W9] flush-on-close failed:', e?.message);
    }
}
