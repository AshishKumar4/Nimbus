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
export const ALARM_REASONS_KEY = 'w1_next_alarm_reasons';

/**
 * Storage key for the isolate-generation counter (cold-start +
 * post-hibernation wake; one increment per fresh isolate).
 *
 * The VALUE is live production DO storage ('w9_isolate_gen') and must never
 * change, same contract as {@link ALARM_REASONS_KEY}.
 */
export const ISOLATE_GEN_KEY = 'w9_isolate_gen';

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
export function scheduleAlarm(
  host: AlarmHost,
  ctx: any,
  reason: string,
  whenMs: number,
): Promise<boolean> {
  // Serialize every read-modify-write of the reasons map through one
  // per-instance chain: two schedulers firing back-to-back from one activity
  // hook would otherwise interleave their get→put cycles and silently drop
  // whichever reason wrote first.
  const run = async (): Promise<boolean> => {
    try {
      const setAlarmFn = (ctx?.storage as any)?.setAlarm;
      if (typeof setAlarmFn !== 'function') return false;
      const existing = (await ctx.storage.get(ALARM_REASONS_KEY)) as
        | Record<string, number>
        | undefined;
      const map: Record<string, number> = { ...(existing || {}) };
      // Earliest-deadline-first: only update if new request is sooner or
      // this reason has no pending entry.
      if (!(reason in map) || whenMs < map[reason]) {
        map[reason] = whenMs;
        await ctx.storage.put(ALARM_REASONS_KEY, map);
      }
      const earliest = Math.min(...Object.values(map));
      setAlarmFn.call(ctx.storage, earliest);
      return true;
    } catch (e: any) {
      console.warn('[nimbus/W1] scheduleAlarm threw:', e?.message);
      return false;
    }
  };
  const chained = (host._alarmChain ?? Promise.resolve()).then(run, run);
  host._alarmChain = chained;
  return chained;
}

/**
 * What one alarm handler may return: nothing, or a deadline this reason
 * re-arms itself at. Re-arming through the return value keeps the map's
 * read-modify-write inside the dispatcher, where it is serialized.
 */
export type AlarmHandlerResult = void | { rearmAt: number };

/** The embedder's reasons, each with the handler that answers it. */
export type AlarmHandlers = Record<
  string,
  (now: number) => AlarmHandlerResult | Promise<AlarmHandlerResult>
>;

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
export function dispatchAlarm(
  host: AlarmHost,
  ctx: any,
  handlers: AlarmHandlers,
  onLegacyAlarm?: () => void,
): Promise<void> {
  // Same serialization as scheduleAlarm: the dispatcher's read→handlers→write
  // cycle must not interleave with an activity-hook scheduleAlarm.
  const chained = (host._alarmChain ?? Promise.resolve()).then(
    () => dispatchAlarmBody(ctx, handlers, onLegacyAlarm),
    () => dispatchAlarmBody(ctx, handlers, onLegacyAlarm),
  );
  host._alarmChain = chained;
  return chained;
}

async function dispatchAlarmBody(
  ctx: any,
  handlers: AlarmHandlers,
  onLegacyAlarm?: () => void,
): Promise<void> {
  try {
    const now = Date.now();
    const existing = (await ctx?.storage?.get?.(ALARM_REASONS_KEY)) as
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
        const result = await handler(now);
        if (result && typeof result.rearmAt === 'number') {
          map[reason] = result.rearmAt;
        }
      } catch (e: any) {
        console.warn(`[nimbus/W1] dispatch ${reason} threw:`, e?.message);
      }
    }
    // Re-arm or clear.
    const setAlarmFn = (ctx?.storage as any)?.setAlarm;
    if (Object.keys(map).length > 0) {
      await ctx.storage.put(ALARM_REASONS_KEY, map);
      const earliest = Math.min(...Object.values(map));
      if (typeof setAlarmFn === 'function') {
        setAlarmFn.call(ctx.storage, earliest);
      }
    } else {
      try { await ctx.storage.delete(ALARM_REASONS_KEY); } catch {}
      // No remaining reasons → no setAlarm call → DO becomes
      // hibernation-eligible after the 10s idle window.
    }
  } catch (e: any) {
    console.warn('[nimbus/W1] dispatchAlarm threw:', e?.message);
  }
}

/** Increment + persist the isolate-gen counter once per fresh isolate. */
export async function maybeBumpIsolateGen(host: IsolateGenHost, ctx: any): Promise<void> {
  if (host._isolateGenPersisted) return;
  host._isolateGenPersisted = true;
  try {
    const prev = (await ctx.storage.get(ISOLATE_GEN_KEY)) as number | undefined;
    // Adopt the persisted truth first, and adopt the bump only after the
    // put resolves. An unpersisted `next` would be re-read as `prev` by the
    // NEXT boot and re-issued — two instances sharing one generation is
    // exactly the pid-aliasing this counter exists to prevent. Running on
    // the previous persisted generation is the lesser lapse, and the
    // put-failure case is replica-only in practice (replicas never spawn).
    //
    // What holds the guarantee is the output gate, not this await: measured,
    // the block body resolves in 0 ms even with a confirmed put, because
    // `await storage.put()` returns before durability. The gate is what
    // keeps a pid from generation N from escaping before N is durable, which
    // is why marking this put `allowUnconfirmed` is not a free speedup — see
    // scratchpad/coldstart-s1.md.
    host._isolateGen = typeof prev === 'number' ? prev : 0;
    const next = host._isolateGen + 1;
    await ctx.storage.put(ISOLATE_GEN_KEY, next);
    host._isolateGen = next;
  } catch (e: any) {
    console.warn('[nimbus/W9] isolate-gen bump failed:', e?.message);
  }
}
