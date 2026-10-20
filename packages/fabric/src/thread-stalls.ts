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

/** A stall: when its tick was due, how late it ran, and the work in flight across it. */
export interface ThreadStall {
  at: number;
  ms: number;
  inFlight: string[];
}

const STALL_TICK_MS = 50;

/**
 * The engine's own timer, taken when this module is evaluated: a program
 * that shares the realm (a one-shot run in-process) wraps the global one as
 * a handle of its own, and a tick on it would keep that program from ending.
 */
const engineSetTimeout = globalThis.setTimeout;
export const STALL_RECORDED_MS = 250;
const STALLS_KEPT = 16;

interface Watch {
  /** Each piece of work in flight, by its release. */
  readonly inFlight: Map<() => void, string>;
  /** The work in flight at some time since the last tick, named once each. */
  readonly sinceTick: Set<string>;
  timer: number | null;
  due: number;
  readonly stalls: ThreadStall[];
}
const watches = new WeakMap<object, Watch>();

function watchOf(ctx: object): Watch {
  let watch = watches.get(ctx);
  if (watch === undefined) {
    watch = { inFlight: new Map(), sinceTick: new Set(), timer: null, due: 0, stalls: [] };
    watches.set(ctx, watch);
  }
  return watch;
}

function schedule(watch: Watch): void {
  watch.due = Date.now() + STALL_TICK_MS;
  watch.timer = engineSetTimeout(() => tick(watch), STALL_TICK_MS);
}

/** A tick: a stall recorded if it ran late, and the next scheduled while work is in flight. */
function tick(watch: Watch): void {
  const late = Date.now() - watch.due;
  if (late >= STALL_RECORDED_MS) {
    watch.stalls.push({ at: watch.due, ms: late, inFlight: [...watch.sinceTick] });
    if (watch.stalls.length > STALLS_KEPT) watch.stalls.shift();
  }
  watch.sinceTick.clear();
  for (const name of watch.inFlight.values()) watch.sinceTick.add(name);
  watch.timer = null;
  if (watch.inFlight.size > 0) schedule(watch);
}

/**
 * `name` in flight on `ctx`'s thread until the returned release is called:
 * while anything is, `ctx` watches its thread for stalls. The tick due when
 * the last work ends still runs, once, so a stall that work caused is
 * recorded though it ended first. Released twice is released once.
 */
export function holdThreadWatch(ctx: object, name: string): () => void {
  const watch = watchOf(ctx);
  const release = (): void => { watch.inFlight.delete(release); };
  watch.inFlight.set(release, name);
  watch.sinceTick.add(name);
  if (watch.timer === null) schedule(watch);
  return release;
}

/** `ctx`'s last STALLS_KEPT stalls, oldest first. */
export function recentThreadStalls(ctx: object): ThreadStall[] {
  return (watches.get(ctx)?.stalls ?? []).map((stall) => ({ ...stall, inFlight: [...stall.inFlight] }));
}
