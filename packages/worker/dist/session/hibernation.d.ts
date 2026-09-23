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
 *   - ensureResidentKeepalive(host, ctx) — arm the keep-alive alarm that
 *     holds this object in memory while a resident process runs.
 *   - dispatchAlarm(host) — alarm() handler body: the fabric's generic
 *     reason dispatcher with this session's handlers registered.
 *   - flushOnClose(host) — synchronous flush on ws close.
 *
 * The timer multiplexer itself (reason map, schedule, the per-instance
 * chain) is fabric machinery — `@nimbus-sh/fabric/timers.js`; this module
 * registers the session's reasons ('w9-flush' | 'log-janitor' |
 * 'resident-launch' | 'resident-keepalive') on top of it.
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
import { type TimerHost } from '@nimbus-sh/fabric/timers.js';
export type { WsHibernationConfigResult };
/**
 * Minimal host shape. `_w9*` fields drop `private` on the class so
 * this interface can declare them. `processes` is a public class
 * field so no relaxation needed there.
 *
 * `ctx` is NOT in this interface — passed as a separate arg.
 */
export interface HibHost extends TimerHost {
    processes: SessionProcessSupervisor;
    _w9SchemaInit: boolean;
    _w9PersistWired: boolean;
    _w9FlushTimer: any;
    /** W1: log-janitor alarm believed armed for this instance (cheap guard). */
    _w1JanitorArmed: boolean;
    /** W1: resident keep-alive alarm believed armed for this instance. */
    _w1KeepaliveArmed: boolean;
    /**
     * W1: when a client last reached this session over HTTP (an exec, a file
     * read, a port preview, a socket upgrade). Facet RPCs are not clients: a
     * process's own traffic must not keep its abandoned session alive.
     */
    _w1LastClientActivityAt: number;
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
export declare function installLogPersistence(host: Pick<HibHost, '_w9PersistWired' | '_w9SchemaInit' | 'processes'>, ctx: DurableObjectState, onActivity: () => void): void;
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
/** The fields the keep-alive rule reads and keeps; both hosts carry them. */
export type ResidentKeepaliveHost = Pick<HibHost, 'processes' | '_w1KeepaliveArmed' | '_w1LastClientActivityAt' | '_w1SessionDestroyed'>;
/** Arm the host's `resident-keepalive` alarm at `at`; resolves false when it could not. */
export type ResidentKeepaliveSchedule = (at: number) => Promise<boolean>;
/** Where a host's attached clients are counted: its hibernatable sockets. */
export type KeepaliveClients = Partial<Pick<DurableObjectState, 'getWebSockets'>>;
/**
 * W1: arm the keep-alive alarm cycle for this instance, from the spawn hook
 * of a LONG-RUNNING process only.
 *
 * A resident process lives in a facet, and a facet dies with its parent; the
 * platform evicts an idle object after roughly ten seconds, and a pending
 * `ctx.waitUntil` is not the in-flight event that counts (see
 * RESIDENT_KEEPALIVE_MS). A quiet process sends no RPC, so without this the
 * host idles out and the launch journal re-drives the process under a new
 * pid namespace, dropping its attached terminal and its port. The alarm is
 * the event; its dispatch is the whole payload.
 *
 * The one rule for both hosts: the session DO schedules through the fabric
 * timer mux, a hosted runtime through its embedder's lifecycle. Idempotent
 * per instance via `_w1KeepaliveArmed`; `residentKeepaliveFired` clears the
 * flag when the cycle ends, so the next resident spawn re-arms it.
 */
export declare function armResidentKeepalive(host: ResidentKeepaliveHost, schedule: ResidentKeepaliveSchedule): void;
/**
 * W1: the keep-alive alarm fired. Deliberately no work: the alarm exists so
 * the object HAS an event, and being dispatched is the entire payload.
 * Returns when to fire next, or null after clearing the armed flag.
 *
 * Re-arms only while a resident process runs AND a client is present — the
 * rule the janitor learned the hard way (see dispatchAlarm): an
 * unconditional self-renewal makes every session boot its DO forever, and
 * the fleet doing that resets live ones. Bounded by the resident alone, an
 * abandoned dev server did exactly that. The next resident spawn, or the
 * client's return, re-arms the cycle.
 */
export declare function residentKeepaliveFired(host: ResidentKeepaliveHost, ctx: KeepaliveClients, now: number): number | null;
/**
 * W1: a client reached the host. Records the moment, and re-arms the
 * keep-alive if a resident is running and the cycle had lapsed: a host
 * whose client came back before the platform evicted it still holds its
 * process, and the next quiet stretch must not idle it out mid-session.
 */
export declare function noteResidentClient(host: ResidentKeepaliveHost, schedule: ResidentKeepaliveSchedule): void;
export declare function ensureResidentKeepalive(host: HibHost, ctx: any): void;
/** W9: idempotent SQL schema bootstrap. */
export declare function ensureHibSchema(host: Pick<HibHost, '_w9SchemaInit'>, ctx: any): void;
/**
 * Whether a client is here: a hibernatable socket attached (terminal,
 * process log, file watch) or a request within the detached grace. The
 * keep-alive re-arms on this and on a running resident, never on the
 * resident alone.
 */
export declare function residentClientPresent(host: ResidentKeepaliveHost, ctx: KeepaliveClients, now: number): boolean;
/** W1: a client reached the session DO (see noteResidentClient). */
export declare function noteClientActivity(host: HibHost, ctx: any): void;
/**
 * W1: this session's canonical alarm-reason strings, registered on the
 * fabric's reason map. Forward-compat: the dispatcher silently drops unknown
 * reasons so a rollback from a future deploy that added new reasons doesn't
 * leave the alarm stuck.
 */
export type AlarmReason = 'w9-flush' | 'log-janitor' | 'resident-launch' | 'resident-keepalive';
/**
 * W9: ensure the alarm is set for the next flush window. Cheap to
 * call repeatedly — we only schedule the in-isolate flush timer if
 * it isn't already set. The persistent alarm goes through timers.schedule
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
 *   - `'resident-keepalive'` → no work; the fire IS the work. Re-arms
 *     while a resident process is running, so the object stays in memory.
 *
 * `janitorOrphanCheck` is the orphan-pid predicate provided by the
 * caller (typically `(pid) => !host.processes.get(pid)`). Decoupled
 * so HibHost doesn't need to import ProcessTable.
 */
export declare function dispatchAlarm(host: HibHost, ctx: any, janitorOrphanCheck?: (pid: number) => boolean, pumpResidentLaunches?: () => Promise<void>, alarmInfo?: AlarmInvocationInfo): Promise<void>;
/**
 * W9: synchronous flush of the process-log ring on session close.
 * Wraps `processes.flushLogs()` in a try/catch so a flush failure
 * doesn't take down the close handler. Cheap when there's nothing
 * dirty (idempotent inside the store).
 */
export declare function flushOnClose(host: HibHost): void;
//# sourceMappingURL=hibernation.d.ts.map