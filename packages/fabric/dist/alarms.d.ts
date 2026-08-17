/**
 * alarms.ts — Durable Object alarm multiplexing + isolate-generation
 * machinery, persisted across hibernation.
 *
 * Workerd hibernates Durable Objects between requests to free memory. On
 * wake, the new isolate must rebuild its in-memory state from SQL — but it
 * also needs to know "is this the same lifecycle as before, or did workerd
 * recycle me?" That distinction matters for recovery (warmJoin vs cold init)
 * and is captured by the isolate generation, a counter persisted across
 * hibernations.
 *
 * A Durable Object has ONE alarm, and a second `setAlarm()` silently
 * overwrites the first — so every alarm-driven subsystem coordinates through
 * a single reason→deadline map and one dispatcher. Reasons are plain strings
 * registered by the embedder: `scheduleAlarm` arms one, and `dispatchAlarm`
 * runs the embedder-supplied handler for every reason whose deadline has
 * passed.
 */
/**
 * Multi-reason alarm coordination map.
 *
 * JSON-serialised `Record<reason, deadlineMsEpoch>` where keys are the
 * embedder's canonical reason strings (e.g. 'w9-flush', 'log-janitor'). The
 * alarm() dispatcher reads this on fire, dispatches every reason whose
 * deadline has passed, and re-arms `ctx.storage.setAlarm` at the earliest
 * remaining deadline.
 *
 * Why a map (not a single nextAlarmAt + reason): two subsystems can have
 * distinct deadlines. Without the map, the later setAlarm() call would
 * overwrite the earlier reason silently, breaking whichever subsystem
 * expected its deadline.
 *
 * Forward-compat: the dispatcher silently drops unknown reasons so a
 * rollback from a future deploy that added new reasons doesn't leave the
 * alarm stuck.
 *
 * The VALUE is live production DO storage ('w1_next_alarm_reasons', from the
 * workstream that introduced it) and must never change — renaming a storage
 * key is a migration, and orphaned rows are the least of what it breaks.
 */
export declare const ALARM_REASONS_KEY = "w1_next_alarm_reasons";
/**
 * Storage key for the isolate-generation counter (cold-start +
 * post-hibernation wake; one increment per fresh isolate).
 *
 * The VALUE is live production DO storage ('w9_isolate_gen') and must never
 * change, same contract as {@link ALARM_REASONS_KEY}.
 */
export declare const ISOLATE_GEN_KEY = "w9_isolate_gen";
/**
 * The host instance carrying the per-instance alarm chain. The field lives on
 * the embedder's DO instance so one chain serializes every alarm-map
 * read-modify-write for that instance (see {@link scheduleAlarm}).
 */
export interface AlarmHost {
    _alarmChain?: Promise<unknown>;
}
/** The host instance carrying the isolate-generation state. */
export interface IsolateGenHost {
    _isolateGen: number;
    _isolateGenPersisted: boolean;
}
/**
 * Schedule (or re-schedule) an alarm reason. Coordinated via a single map in
 * DO storage so multiple subsystems don't clobber each other's `setAlarm()`
 * calls.
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
 * itself is billed as 1 row written per DO pricing. At a 60s janitor
 * cadence, this is ~$0.05/mo/session at scale — dwarfed by the
 * hibernation duration savings.
 *
 * Fail-soft: any throw is swallowed with a warn. On older runtimes /
 * wrangler-dev where setAlarm is unavailable, this is a no-op (the
 * subsystem's in-isolate setTimeout fallback continues to work).
 */
export declare function scheduleAlarm(host: AlarmHost, ctx: any, reason: string, whenMs: number): Promise<boolean>;
/**
 * What one alarm handler may return: nothing, or a deadline this reason
 * re-arms itself at. Re-arming through the return value keeps the map's
 * read-modify-write inside the dispatcher, where it is serialized.
 */
export type AlarmHandlerResult = void | {
    rearmAt: number;
};
/** The embedder's reasons, each with the handler that answers it. */
export type AlarmHandlers = Record<string, (now: number) => AlarmHandlerResult | Promise<AlarmHandlerResult>>;
/**
 * Multi-reason alarm dispatcher. Called from the DO's `alarm()` handler with
 * the embedder's handler map.
 *
 * For each pending reason whose deadline has passed, run its handler.
 * Handlers are awaited in place: the alarm invocation is the fresh turn a
 * re-entering subsystem asked for, and it has to stay the one paying for the
 * work it just released.
 *
 * After running fireable reasons, re-arms `ctx.storage.setAlarm` at the
 * earliest remaining deadline. If no reasons remain, deletes the map key and
 * does NOT call setAlarm — the DO becomes hibernation-eligible after the 10s
 * idle window.
 *
 * Forward/back-compat: unknown reasons silently dropped. `onLegacyAlarm`
 * covers an alarm that fires with no map at all — a deploy from before the
 * map existed left a bare `setAlarm` behind, and the embedder decides what
 * that one-time fire means (one dispatch later the map is populated by the
 * next scheduleAlarm call).
 */
export declare function dispatchAlarm(host: AlarmHost, ctx: any, handlers: AlarmHandlers, onLegacyAlarm?: () => void): Promise<void>;
/** Increment + persist the isolate-gen counter once per fresh isolate. */
export declare function maybeBumpIsolateGen(host: IsolateGenHost, ctx: any): Promise<void>;
//# sourceMappingURL=alarms.d.ts.map