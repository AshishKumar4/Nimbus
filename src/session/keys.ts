/**
 * session/keys.ts — DO-storage key constants.
 *
 * Centralised to keep the storage namespace grep-able in one place.
 * Renaming or adding a key forces a touch here, which forces the
 * change to be reviewed alongside the migration plan (rename without
 * migration = orphan rows).
 *
 * Originally `private static readonly` fields on NimbusSession itself;
 *   `NimbusSession`. Sibling modules (-hib.ts, -ws.ts) need to reference
 *   them, but `import type { NimbusSession }` provides no runtime
 *   binding and `private static readonly` is not reachable from outside
 *   the class anyway (TS-2341 + nominal-type rule). A dedicated leaf
 *   module solves both: every consumer imports the bare names directly.
 *
 * Stability contract:
 *   These keys persist DO state across deploys. Renaming any key is a
 *   storage migration — never do it without an explicit migration plan.
 */

/** W9: storage key for the isolate-generation counter (cold-start +
 *  post-hibernation wake; one increment per fresh isolate). */
export const W9_ISOLATE_GEN_KEY = 'w9_isolate_gen';

/** W9: debounce window in ms before flushing pending process-log writes
 *  to SQL. Hot path (every append schedules a flush via this debounce). */
export const W9_FLUSH_DEBOUNCE_MS = 250;

/** W5: storage key for the OOM-discriminator ring snapshot.
 *  Bounded ≤20 KB by oom-discriminator.ts; persisted on ws close/error
 *  so cf-tail-style forensics survive DO hibernation. */
export const W5_RING_STORAGE_KEY = 'w5_oom_ring_v1';

/** Storage key for the session URL prefix (e.g. /s/nimble-otter-4271).
 *  Set once per session from the X-Nimbus-Base header. */
export const SESSION_BASE_PATH_KEY = 'session-base-path';

/** Storage key for the persisted vite-config blob. Survives DO
 *  hibernation so vite resumes serving after wake without re-running
 *  /api/start-vite. */
export const VITE_CONFIG_KEY = 'vite-config';
