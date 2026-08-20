/**
 * timers.ts — Durable Object alarm multiplexing, persisted across
 * hibernation.
 *
 * A Durable Object has ONE alarm, and a second `setAlarm()` silently
 * overwrites the first — so every alarm-driven subsystem coordinates through
 * a single reason→deadline map and one dispatcher. Reasons are plain strings
 * registered by the embedder: `timers(host, ctx).schedule` arms one, and
 * `timers(host, ctx).dispatch` runs the embedder-supplied handler for every
 * reason whose deadline has passed.
 */

import { errorText } from '@nimbus-sh/core/_shared/error-text.js';

/**
 * The storage the timer map lives in. `setAlarm` is optional because
 * `wrangler dev` serves a storage without it, which is the whole reason
 * scheduling degrades to a no-op instead of throwing.
 */
export interface TimerStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  setAlarm?(scheduledTime: number): Promise<void>;
}

/** The hosting actor's context, as the timer coordination reads it. */
export interface TimerContext {
  storage: TimerStorage;
}

/**
 * Multi-reason timer coordination map.
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
export const TIMER_REASONS_KEY = 'w1_next_alarm_reasons';

/**
 * The host instance carrying the per-instance timer chain. The field lives on
 * the embedder's DO instance so one chain serializes every timer-map
 * read-modify-write for that instance (see {@link Timers.schedule}).
 */
export interface TimerHost {
  _timerChain?: Promise<unknown>;
}

/**
 * What one timer handler may return: nothing, or a deadline this reason
 * re-arms itself at. Re-arming through the return value keeps the map's
 * read-modify-write inside the dispatcher, where it is serialized.
 */
export type TimerHandlerResult = void | { rearmAt: number };

/**
 * The platform's alarm-invocation report, forwarded to every handler: the
 * platform retries a failed alarm() with backoff and abandons it after its
 * retry budget, and `isRetry`/`retryCount` are the only way a handler can
 * tell how close it is to that abandonment. Structurally identical to
 * workers-types' AlarmInvocationInfo; declared here so the module stays
 * usable without the ambient types.
 */
export interface TimerAlarmInfo {
  readonly isRetry: boolean;
  readonly retryCount: number;
  readonly scheduledTime: number;
}

/** The embedder's reasons, each with the handler that answers it. */
export type TimerHandlers = Record<
  string,
  (now: number, info?: TimerAlarmInfo) => TimerHandlerResult | Promise<TimerHandlerResult>
>;

/**
 * One actor's timers: the reason map over its ONE platform alarm.
 *
 * A cheap accessor over `(host, ctx)` — the chain that serializes the map's
 * read-modify-write lives on the host instance, so every `timers()` call for
 * one instance coordinates through the same chain.
 */
export function timers(host: TimerHost, ctx: TimerContext): Timers {
  return new Timers(host, ctx);
}

export class Timers {
  constructor(
    private readonly host: TimerHost,
    private readonly ctx: TimerContext,
  ) {}

  /**
   * Schedule (or re-schedule) a timer reason. Coordinated via a single map in
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
  schedule(reason: string, whenMs: number): Promise<boolean> {
    const { host, ctx } = this;
    // Serialize every read-modify-write of the reasons map through one
    // per-instance chain: two schedulers firing back-to-back from one activity
    // hook would otherwise interleave their get→put cycles and silently drop
    // whichever reason wrote first.
    const run = async (): Promise<boolean> => {
      try {
        const setAlarmFn = ctx?.storage?.setAlarm;
        if (typeof setAlarmFn !== 'function') return false;
        const existing = (await ctx.storage.get(TIMER_REASONS_KEY)) as
          | Record<string, number>
          | undefined;
        const map: Record<string, number> = { ...(existing || {}) };
        // Earliest-deadline-first: only update if new request is sooner or
        // this reason has no pending entry.
        if (!(reason in map) || whenMs < map[reason]) {
          map[reason] = whenMs;
          await ctx.storage.put(TIMER_REASONS_KEY, map);
        }
        const earliest = Math.min(...Object.values(map));
        setAlarmFn.call(ctx.storage, earliest);
        return true;
      } catch (e) {
        console.warn('[nimbus/W1] timers.schedule threw:', errorText(e));
        return false;
      }
    };
    const chained = (host._timerChain ?? Promise.resolve()).then(run, run);
    host._timerChain = chained;
    return chained;
  }

  /**
   * Multi-reason timer dispatcher. Called from the DO's `alarm()` handler
   * with the embedder's handler map.
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
   * next schedule call).
   */
  dispatch(
    handlers: TimerHandlers,
    onLegacyAlarm?: () => void,
    alarmInfo?: TimerAlarmInfo,
  ): Promise<void> {
    const { host, ctx } = this;
    // Same serialization as schedule: the dispatcher's read→handlers→write
    // cycle must not interleave with an activity-hook schedule.
    const chained = (host._timerChain ?? Promise.resolve()).then(
      () => dispatchBody(ctx, handlers, onLegacyAlarm, alarmInfo),
      () => dispatchBody(ctx, handlers, onLegacyAlarm, alarmInfo),
    );
    host._timerChain = chained;
    return chained;
  }
}

async function dispatchBody(
  ctx: TimerContext,
  handlers: TimerHandlers,
  onLegacyAlarm?: () => void,
  alarmInfo?: TimerAlarmInfo,
): Promise<void> {
  try {
    const now = Date.now();
    const existing = (await ctx?.storage?.get?.(TIMER_REASONS_KEY)) as
      | Record<string, number>
      | undefined;
    if (!existing || Object.keys(existing).length === 0) {
      onLegacyAlarm?.();
      return;
    }
    const map: Record<string, number> = { ...existing };
    // Snapshot fireable reasons BEFORE running any of them, so a
    // handler that schedules itself for the next cycle doesn't get
    // immediately re-fired in the same dispatch.
    const fired: string[] = [];
    for (const [reason, when] of Object.entries(map)) {
      if (when <= now) fired.push(reason);
    }
    for (const reason of fired) {
      delete map[reason];
      const handler = handlers[reason];
      // Unknown reasons silently dropped (forward-compat).
      if (!handler) continue;
      try {
        const result = await handler(now, alarmInfo);
        if (result && typeof result.rearmAt === 'number') {
          map[reason] = result.rearmAt;
        }
      } catch (e) {
        console.warn(`[nimbus/W1] dispatch ${reason} threw:`, errorText(e));
      }
    }
    // Re-arm or clear.
    const setAlarmFn = ctx?.storage?.setAlarm;
    if (Object.keys(map).length > 0) {
      await ctx.storage.put(TIMER_REASONS_KEY, map);
      const earliest = Math.min(...Object.values(map));
      if (typeof setAlarmFn === 'function') {
        setAlarmFn.call(ctx.storage, earliest);
      }
    } else {
      try { await ctx.storage.delete(TIMER_REASONS_KEY); } catch {}
      // No remaining reasons → no setAlarm call → DO becomes
      // hibernation-eligible after the 10s idle window.
    }
  } catch (e) {
    console.warn('[nimbus/W1] timers.dispatch threw:', errorText(e));
  }
}
