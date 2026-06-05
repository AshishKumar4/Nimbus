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
/**
 * W5 Lever 8: a registered observer (typically a SqliteVFS) that
 * receives shrink/restore signals when the heavy-alloc refcount
 * transitions 0↔≥1. Kept as a duck-typed pair of callbacks so we
 * don't pull SqliteVFS as a static import (preserves layering: this
 * module is consumed by both the supervisor and tests, and shouldn't
 * acquire a heavy dependency).
 */
interface AllocObserver {
    /** Called when refcount transitions 0 → 1 (heavy-alloc phase entered). */
    onAcquire?: () => void;
    /** Called when refcount transitions ≥1 → 0 (phase exited). */
    onRelease?: () => void;
}
/**
 * W5 Lever 8 hook. Register an observer that fires when the heavy-
 * alloc refcount transitions 0 → 1 (acquire) and ≥1 → 0 (release).
 * Returns an unsubscribe function. Idempotent: registering the same
 * observer twice is a no-op (Set semantics).
 *
 * Wire from NimbusSession constructor: register an observer whose
 * onAcquire calls vfs.shrinkForInstall() and onRelease calls
 * vfs.restoreAfterInstall(). This decouples SqliteVFS from
 * heavy-alloc-coord while keeping the observer pattern simple.
 */
export declare function registerAllocObserver(o: AllocObserver): () => void;
/** True if any heavy-alloc owner has the gate open. */
export declare function isHeavyAllocActive(): boolean;
/**
 * Mark a heavy-alloc phase as active. Returns a one-shot release fn —
 * call it once the phase is complete. Safe to discard the release
 * (refcount can drift up if a caller forgets — only blocks pre-bundle,
 * never blocks user work — but please don't).
 */
export declare function acquireHeavyAlloc(): () => void;
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
export declare function waitForLowAllocPressure(opts?: {
    pollMs?: number;
    maxWaitMs?: number;
}): Promise<boolean>;
export {};
//# sourceMappingURL=heavy-alloc-coord.d.ts.map