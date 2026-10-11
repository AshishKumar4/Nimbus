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
import { AsyncLocalStorage } from 'node:async_hooks';
import { errorText } from '@nimbus-sh/core/_shared/error-text.js';
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
/** How many times {@link Timers.arm} asks before it gives up and throws. */
const TIMER_ARM_ATTEMPTS = 3;
/**
 * The epoch of the dispatch whose handlers are running, in their async
 * context: an arm they make once a reset voided it writes nothing, as the
 * dispatch itself does not (see {@link Timers.reset}).
 */
const dispatchEpoch = new AsyncLocalStorage();
/**
 * One actor's timers: the reason map over its ONE platform alarm.
 *
 * A cheap accessor over `(host, ctx)` — the chain that serializes the map's
 * read-modify-write lives on the host instance, so every `timers()` call for
 * one instance coordinates through the same chain.
 */
export function timers(host, ctx) {
    return new Timers(host, ctx);
}
export class Timers {
    host;
    ctx;
    constructor(host, ctx) {
        this.host = host;
        this.ctx = ctx;
    }
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
    schedule(reason, whenMs) {
        const { host, ctx } = this;
        const inDispatch = dispatchEpoch.getStore();
        const epoch = inDispatch?.host === host ? inDispatch.epoch : host._timerEpoch ?? 0;
        // Serialize every read-modify-write of the reasons map through one
        // per-instance chain: two schedulers firing back-to-back from one activity
        // hook would otherwise interleave their get→put cycles and silently drop
        // whichever reason wrote first.
        const run = async () => {
            try {
                const setAlarmFn = ctx?.storage?.setAlarm;
                if (typeof setAlarmFn !== 'function')
                    return false;
                const existing = (await ctx.storage.get(TIMER_REASONS_KEY));
                // Requested before a reset: it belongs to the timers the reset voided.
                if ((host._timerEpoch ?? 0) !== epoch)
                    return false;
                const map = { ...(existing || {}) };
                // Earliest-deadline-first: only update if new request is sooner or
                // this reason has no pending entry. A deadline a running dispatch
                // fired is no pending entry: this request replaces it, and that
                // dispatch no longer drops it.
                let written;
                if (!(reason in map) || whenMs < map[reason] || host._timerFiring?.get(reason) === map[reason]) {
                    map[reason] = whenMs;
                    written = ctx.storage.put(TIMER_REASONS_KEY, map);
                }
                // Issued in the turn the epoch was checked in: a reset after this
                // point wipes and disarms after these, never before. Awaited after
                // that: an alarm write that failed is a timer not armed, and the
                // caller is told so.
                const armed = setAlarmFn.call(ctx.storage, Math.min(...Object.values(map)));
                // Joined: either failing is the one failure, and neither is left unhandled.
                await Promise.all([written, armed]);
                if (written !== undefined)
                    host._timerFiring?.delete(reason);
                return true;
            }
            catch (e) {
                console.warn('[nimbus/W1] timers.schedule threw:', errorText(e));
                return false;
            }
        };
        return link(host, run);
    }
    /**
     * {@link schedule}, for a caller that cannot go on unarmed: a refused arm
     * is retried, up to TIMER_ARM_ATTEMPTS in all, and one still refused
     * throws, naming the reason. A false from schedule is a timer that will not
     * fire, so a caller that ignored it would wait forever.
     */
    async arm(reason, whenMs) {
        for (let attempt = 0; attempt < TIMER_ARM_ATTEMPTS; attempt++) {
            if (await this.schedule(reason, whenMs))
                return;
        }
        throw new Error(`Nimbus: the '${reason}' timer could not be armed (${TIMER_ARM_ATTEMPTS} attempts)`);
    }
    /**
     * Void every timer of this instance: a schedule or dispatch already
     * requested — still queued on the chain, or a dispatch whose handlers are
     * running — writes no reason and arms no alarm from here on. For a
     * deliberate end of the actor's state (a session destroy): call it before
     * wiping storage and deleting the alarm, so nothing in flight writes the
     * map back or re-arms after the wipe. Requests made after it proceed.
     */
    reset() {
        this.host._timerEpoch = (this.host._timerEpoch ?? 0) + 1;
    }
    /**
     * Multi-reason timer dispatcher. Called from the DO's `alarm()` handler
     * with the embedder's handler map.
     *
     * For each pending reason whose deadline has passed, run its handler.
     * Handlers are awaited in place: the alarm invocation is the fresh turn a
     * re-entering subsystem asked for, and it has to stay the one paying for the
     * work it just released. They run off the chain: what they wait for may
     * itself wait on an arm, from inside a handler or from anywhere else.
     *
     * After running fireable reasons, re-arms `ctx.storage.setAlarm` at the
     * earliest remaining deadline, the map read again for it: what was armed
     * while the handlers ran is kept, and a fired reason goes unless it was
     * armed again meanwhile. Until then the map keeps every fired reason, so an
     * alarm retried after a reset mid-handler fires them again.
     * If no reasons remain, deletes the map key and does NOT call setAlarm —
     * the DO becomes hibernation-eligible after the 10s idle window.
     *
     * Forward/back-compat: unknown reasons silently dropped. `onLegacyAlarm`
     * covers an alarm that fires with no map at all — a deploy from before the
     * map existed left a bare `setAlarm` behind, and the embedder decides what
     * that one-time fire means (one dispatch later the map is populated by the
     * next schedule call).
     */
    dispatch(handlers, onLegacyAlarm, alarmInfo) {
        const { host, ctx } = this;
        return dispatchBody(host, ctx, host._timerEpoch ?? 0, handlers, onLegacyAlarm, alarmInfo);
    }
    /** The platform alarm, the reasons it carries, and the dispatch running: what it fired and for how long. */
    async state(now = Date.now()) {
        const { _timerFiring: fired, _timerFiringSince: since } = this.host;
        return {
            alarmAt: (await this.ctx.storage.getAlarm?.()) ?? null,
            reasons: (await this.ctx.storage.get(TIMER_REASONS_KEY)) ?? null,
            dispatching: fired === undefined || since === undefined ? null : { reasons: [...fired.keys()], ms: now - since },
        };
    }
}
/** `step` queued on `host`'s chain after every read-modify-write of the map before it. */
function link(host, step) {
    const chained = (host._timerChain ?? Promise.resolve()).then(step, step);
    host._timerChain = chained;
    return chained;
}
/**
 * One dispatch, requested in `epoch`: once a reset voids it, no further
 * handler runs and nothing is written or armed — the reset's caller is wiping
 * this state, and a write after the wipe would outlive it. The map is read,
 * and written back, on the chain; the handlers run between, off it.
 */
async function dispatchBody(host, ctx, epoch, handlers, onLegacyAlarm, alarmInfo) {
    const current = () => (host._timerEpoch ?? 0) === epoch;
    const now = Date.now();
    const fired = new Map();
    const rearms = new Map();
    try {
        const existing = await link(host, async () => (await ctx?.storage?.get?.(TIMER_REASONS_KEY)));
        if (!current())
            return;
        // Snapshot fireable reasons BEFORE running any of them, so a handler
        // that schedules itself for the next cycle doesn't get immediately
        // re-fired in the same dispatch.
        for (const [reason, when] of Object.entries(existing ?? {})) {
            if (when <= now)
                fired.set(reason, when);
        }
        host._timerFiring = fired;
        host._timerFiringSince = now;
        if (Object.keys(existing ?? {}).length === 0) {
            dispatchEpoch.run({ host, epoch }, () => onLegacyAlarm?.());
        }
        else {
            for (const reason of [...fired.keys()]) {
                if (!current())
                    return;
                const handler = handlers[reason];
                // Unknown reasons silently dropped (forward-compat).
                if (!handler)
                    continue;
                try {
                    const result = await dispatchEpoch.run({ host, epoch }, () => handler(now, alarmInfo));
                    if (result && typeof result.rearmAt === 'number')
                        rearms.set(reason, result.rearmAt);
                }
                catch (e) {
                    console.warn(`[nimbus/W1] dispatch ${reason} threw:`, errorText(e));
                }
            }
        }
        // A reset while the handlers ran: the map read above is gone, and
        // writing it back — or arming for it — would revive what was ended.
        if (!current())
            return;
        await link(host, async () => {
            const stored = (await ctx.storage.get(TIMER_REASONS_KEY));
            if (!current())
                return;
            const map = { ...(stored || {}) };
            for (const reason of fired.keys())
                delete map[reason];
            for (const [reason, at] of rearms) {
                if (!(reason in map) || at < map[reason])
                    map[reason] = at;
            }
            // Re-arm or clear, issued in the turn the epoch was checked in: a reset
            // after this point wipes and disarms after these, never before.
            const setAlarmFn = ctx?.storage?.setAlarm;
            if (Object.keys(map).length > 0) {
                const written = ctx.storage.put(TIMER_REASONS_KEY, map);
                // Not at the time of the alarm being run: that is no change to the
                // platform, which then counts it delivered.
                const at = Math.min(...Object.values(map));
                const armed = typeof setAlarmFn === 'function'
                    ? setAlarmFn.call(ctx.storage, alarmInfo !== undefined && at <= alarmInfo.scheduledTime ? alarmInfo.scheduledTime + 1 : at)
                    : undefined;
                // Joined: a failed write or re-arm surfaces here, in the one warning below.
                await Promise.all([written, armed]);
            }
            else if (stored !== undefined) {
                try {
                    await ctx.storage.delete(TIMER_REASONS_KEY);
                }
                catch { }
                // No remaining reasons → no setAlarm call → DO becomes
                // hibernation-eligible after the 10s idle window.
            }
        });
    }
    catch (e) {
        console.warn('[nimbus/W1] timers.dispatch threw:', errorText(e));
    }
    finally {
        if (host._timerFiring === fired) {
            host._timerFiring = undefined;
            host._timerFiringSince = undefined;
        }
    }
}
