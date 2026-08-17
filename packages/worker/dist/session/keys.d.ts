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
/** W9: debounce window in ms before flushing pending process-log writes
 *  to SQL. Hot path (every append schedules a flush via this debounce). */
export declare const W9_FLUSH_DEBOUNCE_MS = 250;
/** W5: storage key for the OOM-discriminator ring snapshot.
 *  Bounded ≤20 KB by oom-discriminator.ts; persisted on ws close/error
 *  so cf-tail-style forensics survive DO hibernation. */
export declare const W5_RING_STORAGE_KEY = "w5_oom_ring_v1";
/** Storage key for the session URL prefix (e.g. /s/nimble-otter-4271).
 *  Set once per session from the X-Nimbus-Base header. */
export declare const SESSION_BASE_PATH_KEY = "session-base-path";
/** Storage key for the persisted vite-config blob. Survives DO
 *  hibernation so vite resumes serving after wake without re-running
 *  /api/start-vite. */
export declare const VITE_CONFIG_KEY = "vite-config";
/**
 * Destroyed-session tombstone. Written AFTER `storage.deleteAll()` in the
 * destroy flow so a straggler facet RPC that wakes the dead DO cannot re-arm
 * the log-janitor alarm cycle (the zombie-alarm hazard). One small row of
 * metadata is the deliberate cost of keeping destroyed sessions inert.
 */
export declare const SESSION_DESTROYED_KEY = "session_destroyed";
/**
 * Prefix for the resident-process journal: one row per resident this session
 * owes the user, keyed by the pid it was built for.
 *
 * A resident holds its state in memory — the process table entry, the facet
 * handle, the terminal — so an instance reset destroys it silently. The row
 * is what a LATER instance reads to know a resident ended that way rather
 * than on purpose: a pid at or below the reader's own pid base was allocated
 * by a previous generation (see PID_GEN_STRIDE). Written (and synced) before
 * the launch's first byte of work, rewritten as `running` when the launch
 * settles, and released only when the PROCESS ends — because the resets this
 * row survives strike after the launch as often as during it (measured live,
 * staging 2026-08-13: every observed reset landed seconds AFTER settle).
 */
export declare const RESIDENT_LAUNCH_KEY_PREFIX = "resident-launch:";
/** Prefix for consumed single-use attach bootstrap token ids (`jti`).
 *  Written set-if-absent by `_rpcConsumeAttachBootstrap` on the attach
 *  exchange; an existing row means the bootstrap URL was replayed.
 *  Bounded: at most one row per `POST /new` bootstrap actually attached. */
export declare const ATTACH_BOOTSTRAP_JTI_KEY_PREFIX = "attach-bootstrap-jti:";
//# sourceMappingURL=keys.d.ts.map