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
 *   - dispatchAlarm(host) — alarm() handler body.
 *   - maybeBumpIsolateGen(host, ctx) — increment + persist isolate-gen
 *     counter once per fresh isolate.
 *   - flushOnClose(host) — synchronous flush on ws close.
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
import { type WsHibernationConfigResult } from './ws-hibernation-config.js';
export type { WsHibernationConfigResult };
/**
 * Minimal host shape. `_w9*` fields drop `private` on the class so
 * this interface can declare them. `processes` is a public class
 * field so no relaxation needed there.
 *
 * `ctx` is NOT in this interface — passed as a separate arg.
 */
export interface HibHost {
    processes: SessionProcessSupervisor;
    _w9IsolateGen: number;
    _w9IsolateGenPersisted: boolean;
    _w9SchemaInit: boolean;
    _w9PersistWired: boolean;
    _w9FlushTimer: any;
    /** W1: log-janitor alarm believed armed for this instance (cheap guard). */
    _w1JanitorArmed: boolean;
    /** W1: destroyed-session tombstone — never re-arm alarms while set. */
    _w1SessionDestroyed: boolean;
    /** W1: serializes every alarm-map read-modify-write (see scheduleAlarm). */
    _w1AlarmChain?: Promise<unknown>;
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
 * W1: canonical alarm-reason strings. Stored in the
 * `W1_NEXT_ALARM_REASONS_KEY` map. Forward-compat: dispatcher silently
 * drops unknown reasons so a rollback from a future deploy that added
 * new reasons doesn't leave the alarm stuck.
 */
export type AlarmReason = 'w9-flush' | 'log-janitor' | 'resident-launch';
/**
 * W1: schedule (or re-schedule) an alarm reason. Coordinated via a
 * single map in DO storage so multiple subsystems (W9 debounced flush +
 * W1 log-janitor sweep) don't clobber each other's `setAlarm()` calls.
 *
 * Semantics:
 *   - Reads the existing reasons map.
 *   - Sets `map[reason] = whenMs` IF `whenMs` is sooner than the
 *     currently-pending deadline for that reason (or no entry exists).
 *     Later-than-pending requests are silently ignored — the existing
 *     alarm will fire and re-arm anyway.
 *   - Writes the map back and calls `ctx.storage.setAlarm(min(deadlines))`.
 *
 * Cost: 1 storage read + 1 storage write + 1 setAlarm per call. setAlarm
 * itself is billed as 1 row written per DO pricing. At W1's 60s
 * cadence, this is ~$0.05/mo/session at scale — dwarfed by the
 * hibernation duration savings.
 *
 * Fail-soft: any throw is swallowed with a warn. On older runtimes /
 * wrangler-dev where setAlarm is unavailable, this is a no-op (the
 * subsystem's in-isolate setTimeout fallback continues to work).
 */
export declare function scheduleAlarm(host: HibHost, ctx: any, reason: AlarmReason, whenMs: number): Promise<boolean>;
/**
 * W9: ensure the alarm is set for the next flush window. Cheap to
 * call repeatedly — we only schedule the in-isolate flush timer if
 * it isn't already set. The persistent alarm goes through scheduleAlarm
 * so it coordinates with W1's log-janitor sweep.
 */
export declare function scheduleHibFlush(host: HibHost, ctx: any): void;
/**
 * W1: multi-reason alarm dispatcher. Called from the DO's `alarm()`
 * handler.
 *
 * For each pending reason whose deadline has passed, run its handler.
 * Reasons supported today:
 *   - `'w9-flush'` → processes.flushLogs()
 *   - `'log-janitor'` → processes.dropLogsOlderThan(orphanCheck); re-arm
 *     for next 60s cycle.
 *
 * `janitorOrphanCheck` is the orphan-pid predicate provided by the
 * caller (typically `(pid) => !host.processes.get(pid)`). Decoupled
 * so HibHost doesn't need to import ProcessTable.
 *
 * After running fireable reasons, re-arms `ctx.storage.setAlarm` at the
 * earliest remaining deadline. If no reasons remain, deletes the map
 * key and does NOT call setAlarm — the DO becomes hibernation-eligible
 * after the 10s idle window.
 *
 * Forward/back-compat: unknown reasons silently dropped.
 */
export declare function dispatchAlarm(host: HibHost, ctx: any, janitorOrphanCheck?: (pid: number) => boolean, pumpResidentLaunches?: () => Promise<void>): Promise<void>;
/** W9: increment + persist isolate-gen counter once per fresh isolate. */
export declare function maybeBumpIsolateGen(host: HibHost, ctx: any): Promise<void>;
/**
 * W9: synchronous flush of the process-log ring on session close.
 * Wraps `processes.flushLogs()` in a try/catch so a flush failure
 * doesn't take down the close handler. Cheap when there's nothing
 * dirty (idempotent inside the store).
 */
export declare function flushOnClose(host: HibHost): void;
//# sourceMappingURL=hibernation.d.ts.map