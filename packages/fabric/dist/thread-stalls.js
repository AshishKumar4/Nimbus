/**
 * When a Durable Object's thread was held, and what was running then.
 *
 * The facets a session loads share its thread. A facet's long synchronous
 * slice keeps the session from dequeuing anything, its own calls and its
 * users' requests alike, and the platform refuses them all once the oldest
 * has waited too long ("Durable Object is overloaded. Requests queued for
 * too long."). The facets' own spans are not exported, so the session
 * watches for it itself: while work is in flight, it schedules a tick every
 * STALL_TICK_MS, and a tick that runs STALL_RECORDED_MS or more late is a
 * stall, recorded with the work in flight across it (`/api/_diag/session`).
 * A Worker's clock moves only between events, so a tick's lateness is
 * exactly how long its event waited for the thread.
 */
const STALL_TICK_MS = 50;
export const STALL_RECORDED_MS = 250;
const STALLS_KEPT = 16;
const watches = new WeakMap();
function watchOf(ctx) {
    let watch = watches.get(ctx);
    if (watch === undefined) {
        watch = { inFlight: new Map(), sinceTick: new Set(), timer: null, due: 0, stalls: [] };
        watches.set(ctx, watch);
    }
    return watch;
}
function schedule(watch) {
    watch.due = Date.now() + STALL_TICK_MS;
    watch.timer = setTimeout(() => tick(watch), STALL_TICK_MS);
}
function tick(watch) {
    const late = Date.now() - watch.due;
    if (late >= STALL_RECORDED_MS) {
        watch.stalls.push({ at: watch.due, ms: late, inFlight: [...watch.sinceTick] });
        if (watch.stalls.length > STALLS_KEPT)
            watch.stalls.shift();
    }
    watch.sinceTick.clear();
    for (const name of watch.inFlight.values())
        watch.sinceTick.add(name);
    watch.timer = null;
    if (watch.inFlight.size > 0)
        schedule(watch);
}
/**
 * `name` in flight on `ctx`'s thread until the returned release is called:
 * while anything is, `ctx` watches its thread for stalls. Released twice is
 * released once.
 */
export function holdThreadWatch(ctx, name) {
    const watch = watchOf(ctx);
    const hold = Symbol(name);
    watch.inFlight.set(hold, name);
    watch.sinceTick.add(name);
    if (watch.timer === null)
        schedule(watch);
    return () => {
        watch.inFlight.delete(hold);
        if (watch.inFlight.size > 0 || watch.timer === null)
            return;
        clearTimeout(watch.timer);
        watch.timer = null;
        watch.sinceTick.clear();
    };
}
/** `ctx`'s last STALLS_KEPT stalls, oldest first. */
export function recentThreadStalls(ctx) {
    return (watches.get(ctx)?.stalls ?? []).map((stall) => ({ ...stall, inFlight: [...stall.inFlight] }));
}
