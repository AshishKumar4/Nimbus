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
import type { SessionProcessSupervisor } from '@nimbus-sh/core/runtime/session-process-supervisor.js';
import { type WsHibernationConfigResult } from '@nimbus-sh/fabric/ws-hibernation-config.js';
import { type AlarmHost, type IsolateGenHost } from '@nimbus-sh/fabric/alarms.js';
export type { WsHibernationConfigResult };
/**
 * Minimal host shape. `_w9*` fields drop `private` on the class so
 * this interface can declare them. `processes` is a public class
 * field so no relaxation needed there.
 *
 * `ctx` is NOT in this interface — passed as a separate arg.
 */
export interface HibHost extends AlarmHost, IsolateGenHost {
    processes: SessionProcessSupervisor;
    _w9SchemaInit: boolean;
    _w9PersistWired: boolean;
    _w9FlushTimer: any;
    /** W1: log-janitor alarm believed armed for this instance (cheap guard). */
    _w1JanitorArmed: boolean;
    /** W1: destroyed-session tombstone — never re-arm alarms while set. */
    _w1SessionDestroyed: boolean;
}
/**
 * Run at DO ctor time. Returns the result for the class to assign to
 * `_w9WsConfig`. Failures are non-fatal — older workerd builds may lack
 * the API; the result lands in /api/_diag/memory.hib for verification.
 */
export declare function wireHibernationOnConstruct(ctx: any): WsHibernationConfigResult;
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
export declare function wireProcessLogPersist(host: HibHost, ctx: any): void;
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
export declare function clearDestroyedTombstone(host: HibHost, ctx: any): void;
export declare function ensureLogJanitor(host: HibHost, ctx: any): void;
/** W9: idempotent SQL schema bootstrap. */
export declare function ensureHibSchema(host: HibHost, ctx: any): void;
/**
 * W1: this session's canonical alarm-reason strings, registered on the
 * fabric's reason map. Forward-compat: the dispatcher silently drops unknown
 * reasons so a rollback from a future deploy that added new reasons doesn't
 * leave the alarm stuck.
 */
export type AlarmReason = 'w9-flush' | 'log-janitor' | 'resident-launch';
/**
 * W9: ensure the alarm is set for the next flush window. Cheap to
 * call repeatedly — we only schedule the in-isolate flush timer if
 * it isn't already set. The persistent alarm goes through scheduleAlarm
 * so it coordinates with W1's log-janitor sweep.
 */
export declare function scheduleHibFlush(host: HibHost, ctx: any): void;
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
export declare function dispatchAlarm(host: HibHost, ctx: any, janitorOrphanCheck?: (pid: number) => boolean, pumpResidentLaunches?: () => Promise<void>): Promise<void>;
/**
 * W9: synchronous flush of the process-log ring on session close.
 * Wraps `processes.flushLogs()` in a try/catch so a flush failure
 * doesn't take down the close handler. Cheap when there's nothing
 * dirty (idempotent inside the store).
 */
export declare function flushOnClose(host: HibHost): void;
//# sourceMappingURL=hibernation.d.ts.map