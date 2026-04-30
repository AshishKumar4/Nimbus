/**
 * heavy-alloc-coord.ts — supervisor-local back-pressure between the
 * fire-and-forget pre-bundle phase and other heap-heavy supervisor work
 * (today: `npm run dev` booting cirrus-real).
 *
 * Why this exists
 * ───────────────
 * Pre-bundle dispatches up to PRE_BUNDLE_CONCURRENCY facets in parallel.
 * Each holds ~28 MiB slice while the facet RPC is in flight. The Mini-PRD
 * "DO shared isolate issues" reports DO resets at <128 MiB when the
 * isolate is shared with another DO; our 128 MiB headroom calculation
 * is therefore aspirational. Concurrent allocations in the supervisor —
 * notably cirrus-real's user-vite-config bundle + plugin-react +
 * extraSyntheticFiles — can push a shared isolate over the cap mid
 * pre-bundle, causing a reset that surfaces as the user seeing the boot
 * banner reprint several times.
 *
 * Mechanism
 * ─────────
 * A single-bit gate. Heavy-alloc owners (cirrus-real boot today) call
 * `acquireHeavyAlloc()` before allocating, releasing via the returned
 * `release()` once steady-state. Pre-bundle's runSlot awaits
 * `waitForLowAllocPressure()` between iterations — no-op when the gate
 * is open, otherwise a short sleep loop until released.
 *
 * Idempotent / re-entrant: multiple acquires increment a refcount.
 * `release()` is a one-shot (returned by acquire) so callers can't
 * accidentally double-decrement.
 *
 * Why globalThis vs. dependency injection
 * ───────────────────────────────────────
 * Pre-bundle runs in the supervisor isolate, called from npm-installer
 * which is constructed by NimbusSession's command handler. cirrus-real
 * is constructed by a different command handler in the same session.
 * Both share the supervisor's globalThis. Threading an explicit handle
 * from the session through every command path would touch ~10 sites
 * for a one-bit signal. globalThis-keyed singletons are already the
 * pattern for `__NIMBUS_*` symbols in the codebase.
 *
 * Lifetime: the coordinator is process-local, lasts as long as the
 * supervisor isolate. After a DO restart it's re-created — that's
 * acceptable since pre-bundle would also re-dispatch from scratch.
 */

const KEY = '__NIMBUS_HEAVY_ALLOC_COORD__';

interface Coord {
  /** Number of outstanding acquires. >0 means "pause heavy-bg work". */
  count: number;
}

function getCoord(): Coord {
  const g = globalThis as any;
  if (!g[KEY]) {
    g[KEY] = { count: 0 } as Coord;
  }
  return g[KEY] as Coord;
}

/** True if any heavy-alloc owner has the gate open. */
export function isHeavyAllocActive(): boolean {
  return getCoord().count > 0;
}

/**
 * Mark a heavy-alloc phase as active. Returns a one-shot release fn —
 * call it once the phase is complete. Safe to discard the release
 * (refcount can drift up if a caller forgets — only blocks pre-bundle,
 * never blocks user work — but please don't).
 */
export function acquireHeavyAlloc(): () => void {
  const coord = getCoord();
  coord.count++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (coord.count > 0) coord.count--;
  };
}

/**
 * Wait until the gate is open. Polls every `pollMs` (default 200 ms)
 * up to `maxWaitMs` (default 30 s). Returns whether the gate opened
 * within the window — callers can decide to continue regardless.
 *
 * Why polling vs. a Promise: heavy-alloc events (cirrus boot) happen
 * once per session at most. The few hundred-ms granularity is fine,
 * and a poll loop avoids carrying an event-emitter or extra Promise
 * chain through the coordinator. Pre-bundle wall time is dominated by
 * facet RPC; a 200 ms idle here is invisible.
 */
export async function waitForLowAllocPressure(opts?: {
  pollMs?: number;
  maxWaitMs?: number;
}): Promise<boolean> {
  const pollMs = opts?.pollMs ?? 200;
  const maxWaitMs = opts?.maxWaitMs ?? 30_000;
  const start = Date.now();
  while (isHeavyAllocActive()) {
    if (Date.now() - start > maxWaitMs) return false;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return true;
}
