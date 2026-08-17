/**
 * state-store.ts — DO-SQLite-backed persistence for session state
 * that must survive isolate teardown [Phase 3 Track B'].
 *
 * Why this exists
 * ───────────────
 * Pre-Phase-3 the supervisor's session state lived entirely in
 * isolate memory: the LIFO Shell instance owned cwd + env vars; the
 * LIFO Kernel owned mount points; the WebSocketTerminal had no
 * persistence at all. A wsClose / wsError nulled all three
 * (src/nimbus-session-ws.ts:165-167, :221-223), and the next /ws
 * upgrade rebuilt them from defaults. Result: cwd reset to ~,
 * env vars lost, scrollback gone, MOTD reprinted — the user-
 * visible Bug C symptom.
 *
 * The architectural fix is to move every observable session-state
 * field into DO SQLite. The in-memory fields become CACHES of the
 * SQL row, not the master copy. A wsClose flushes the cache and
 * clears the in-memory copy; a /ws upgrade reads SQL and seeds the
 * fresh Shell/Kernel/Terminal.
 *
 * Schema overview
 * ───────────────
 * Three tables, all keyed by single-row sentinels:
 *
 *   nimbus_session_kv (k TEXT PRIMARY KEY, v TEXT)
 *     — generic key/value bag for primitives. Today stores 'cwd'
 *       and 'env' (the env is JSON-serialised). One row per key.
 *
 *   nimbus_kernel_mounts (mount_point TEXT PRIMARY KEY)
 *     — explicit mount-point list (B'.2). Empty until B'.2 lands.
 *
 *   nimbus_terminal_scrollback (seq INTEGER PRIMARY KEY, ts INTEGER, data TEXT)
 *     — bounded ring of recent terminal output (B'.3). Empty until
 *       B'.3 lands.
 *
 * Stability contract
 * ──────────────────
 * Every storage key + table name in this module is part of the DO's
 * persistent schema. Renaming any of them is a storage migration —
 * never do it without an explicit migration plan. New tables can be
 * added; existing tables can be ALTER-ADDed columns (schema is
 * forward-compatible if the rehydrate path reads-with-default for
 * missing columns).
 */
/** Module-level cap on the env-row JSON length. The whole env is one
 *  row in nimbus_session_kv; if the user's env explodes (eg every
 *  npm-install side-effects 100 vars), we want to surface that as a
 *  clear error rather than a silent storage-row-too-long failure.
 *
 *  DO SQLite caps a string, BLOB or table row at 2 MB
 *  (https://developers.cloudflare.com/durable-objects/platform/limits/);
 *  we set a much tighter 256 KiB ceiling so a misbehaving
 *  session can't approach the platform limit. */
export declare const SESSION_ENV_MAX_BYTES: number;
/** Module-level cap on the per-session terminal scrollback in DO
 *  SQLite. Each WS `output` frame written by WebSocketTerminal is
 *  persisted as one row; on every insert we evict the oldest rows
 *  until total bytes ≤ this cap.
 *
 *  1 MiB ≈ ~10,000 lines of ANSI-coloured prompt+output text — many
 *  multiples of typical xterm.js scrollback default (1000 rows ×
 *  ~100B = ~100KB). The headroom matters: real workloads commonly
 *  produce a single huge frame (eg `cat package-lock.json` ≈ 200 KiB)
 *  followed by many small frames (prompt updates, cd output). With
 *  the cap at 256 KiB, the big frame consumes the entire budget and
 *  every subsequent prompt update displaces it via eviction. With
 *  1 MiB we have room for the big frame plus the next dozens of
 *  command outputs.
 *
 *  This is a SOFT cap on persistence. The live terminal still gets
 *  every byte the shell writes; only the rehydrate-on-reconnect
 *  replay is bounded. A user who exceeds 1 MiB mid-session sees
 *  full output live, but on reconnect only the most recent ~1 MiB
 *  replays. That's the right trade-off — losing early-session output
 *  > losing recent output, and DO storage is cheap relative to a
 *  good UX.
 *
 *  Per row, individual frames > MAX_FRAME_BYTES are TRUNCATED to
 *  their last MAX_FRAME_BYTES — same trade-off applied at the
 *  single-frame granularity for pathological multi-MB cat output. */
export declare const SCROLLBACK_MAX_BYTES: number;
/** Per-row cap. A single coalesced WS frame larger than this is
 *  trimmed to its trailing MAX_FRAME_BYTES bytes before insert. Set
 *  smaller than SCROLLBACK_MAX_BYTES so a single huge frame can't
 *  consume the whole budget; with this gap, the eviction loop never
 *  has to delete the just-inserted row to fit a subsequent small
 *  one. 256 KiB per frame is generous (a screenful of dense text +
 *  ANSI). */
export declare const SCROLLBACK_MAX_FRAME_BYTES: number;
/** Storage key names. Module-scope constants so a future migration
 *  can find every site by grep. */
export declare const KEY_CWD = "cwd";
export declare const KEY_ENV_JSON = "env";
export declare const KEY_HYDRATED_AT = "hydrated_at";
/** A snapshot of the persisted shell state, returned by loadShellState. */
export interface ShellStateSnapshot {
    cwd: string | null;
    env: Record<string, string> | null;
    hydratedAt: number | null;
    /** True iff at least one of cwd/env was present in SQL. The caller
     *  uses this to decide cold-start (no row) vs. rehydrate (row present),
     *  which gates one-shot UI like the MOTD. */
    hasPersistedState: boolean;
}
/**
 * Idempotent CREATE TABLE. Safe to call on every initSession; the
 * IF NOT EXISTS clause makes repeats free. Inlines all three Track
 * B' tables; B'.2 / B'.3 land their callers, not their schema.
 */
export declare function ensureSessionStateSchema(ctx: any): void;
/**
 * Load the persisted shell state. Returns a snapshot with `null`
 * fields when no row exists. Never throws — a corrupt env row
 * (failed JSON parse) returns null env and we treat it as cold;
 * better to start fresh than crash the rehydrate path.
 *
 * Auto-ensures the schema. Calling this from a route handler that
 * runs BEFORE any WS upgrade (e.g. /api/_diag/session on a freshly-
 * minted session) used to fail with SQLITE_ERROR because no prior
 * code path had run CREATE TABLE. The IF NOT EXISTS guarantees the
 * extra ensure is microseconds when tables already exist.
 */
export declare function loadShellState(ctx: any): ShellStateSnapshot;
/**
 * Atomically write the shell state. Called from the snapshot
 * mechanism (periodic + on wsClose). Uses INSERT-OR-REPLACE so
 * repeated writes are idempotent.
 *
 * `cwd` and `env` are both required parameters — the caller (the
 * snapshot loop in initSession) reads them from the live Shell
 * BEFORE calling. If either is null, the corresponding row is
 * REMOVED rather than re-written; this keeps the table clean if a
 * future code path explicitly clears state.
 *
 * Throws if the env JSON would exceed SESSION_ENV_MAX_BYTES — that's
 * a session-misuse signal worth surfacing rather than silently
 * truncating.
 */
export declare function persistShellState(ctx: any, state: {
    cwd: string | null;
    env: Record<string, string> | null;
}): void;
/**
 * Stamp the time of the most recent successful hydrate. Used by the
 * /api/_diag/session debug endpoint to show "the last cold-start
 * found a row at <ts>". Cheap; one row write per initSession call.
 */
export declare function stampHydratedAt(ctx: any, atMs: number): void;
/**
 * Drop ALL session-state rows. Used by /api/_test/session/reset for
 * test-only flows; never called from prod paths. Equivalent to
 * "this DO has never seen a session" — the next initSession runs
 * the cold-start path.
 */
export declare function clearSessionState(ctx: any): void;
/** Count rows in nimbus_session_kv — used by the recovery_event
 *  recorder to populate snapshotKeysRehydrated. Cheap; bounded by
 *  the small key set above. */
export declare function countSessionStateKeys(ctx: any): number;
/**
 * Load the persisted mount-point list. Returns a plain string[] of
 * mount point names (without leading slash — same shape as
 * DEFAULT_MOUNT_POINTS). Empty array when no rows exist.
 */
export declare function loadKernelMounts(ctx: any): string[];
/**
 * Persist a mount-point list. Idempotent — replaces the entire
 * nimbus_kernel_mounts contents in a single transaction. Caller
 * provides the full desired set; we don't merge with existing rows.
 *
 * `mounts` should be plain names without leading slash
 * ('bin', 'etc', ...) — same shape DEFAULT_MOUNT_POINTS uses.
 */
export declare function persistKernelMounts(ctx: any, mounts: string[]): void;
/**
 * Append one coalesced output frame. Inserts a row, then evicts the
 * oldest rows until total bytes ≤ SCROLLBACK_MAX_BYTES.
 *
 * `data` is the UTF-8 string written to the WS (typically including
 * ANSI escape codes); empty strings are no-ops.
 *
 * Frames larger than SCROLLBACK_MAX_BYTES are TRUNCATED to their
 * last cap bytes before insert. Reasoning: a single shell command
 * (eg `cat huge-file`) can produce ≫ cap bytes in one coalesced WS
 * frame; we want to preserve the most recent portion of that
 * output (the user's "what just happened") rather than dropping it
 * entirely. Truncation of UTF-8 at byte boundaries can split a
 * multi-byte sequence; we accept that minor cosmetic risk vs. the
 * complexity of a code-point-aware slice.
 *
 * Fail-soft: any thrown error is swallowed by the caller — losing
 * scrollback is annoying but not session-fatal.
 */
export declare function appendScrollback(ctx: any, data: string, atMs: number): void;
/**
 * Read all scrollback rows in seq (chronological) order and return
 * the concatenated payload. Used by the rehydrate path to emit a
 * single batched replay frame.
 *
 * Returns empty string when the table is empty (cold start, or
 * after explicit reset).
 */
export declare function loadScrollback(ctx: any): string;
/** Stats for /api/_diag/session: row count + total bytes + cap. */
export declare function getScrollbackStats(ctx: any): {
    rows: number;
    bytes: number;
    maxBytes: number;
};
//# sourceMappingURL=state-store.d.ts.map