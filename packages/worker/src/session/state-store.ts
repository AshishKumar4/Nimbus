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
 *  Per docs/research/cf-internal-dossier.md §9 the per-row cap is
 *  2 MB; we set a much tighter 256 KiB ceiling so a misbehaving
 *  session can't approach the platform limit. */
export const SESSION_ENV_MAX_BYTES = 256 * 1024;

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
export const SCROLLBACK_MAX_BYTES = 1024 * 1024;
/** Per-row cap. A single coalesced WS frame larger than this is
 *  trimmed to its trailing MAX_FRAME_BYTES bytes before insert. Set
 *  smaller than SCROLLBACK_MAX_BYTES so a single huge frame can't
 *  consume the whole budget; with this gap, the eviction loop never
 *  has to delete the just-inserted row to fit a subsequent small
 *  one. 256 KiB per frame is generous (a screenful of dense text +
 *  ANSI). */
export const SCROLLBACK_MAX_FRAME_BYTES = 256 * 1024;

/** Storage key names. Module-scope constants so a future migration
 *  can find every site by grep. */
export const KEY_CWD = 'cwd';
export const KEY_ENV_JSON = 'env';
export const KEY_HYDRATED_AT = 'hydrated_at';

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
export function ensureSessionStateSchema(ctx: any): void {
  const sql = ctx?.storage?.sql;
  if (!sql) return;
  sql.exec(
    'CREATE TABLE IF NOT EXISTS nimbus_session_kv (' +
    'k TEXT PRIMARY KEY, ' +
    'v TEXT NOT NULL)',
  );
  sql.exec(
    'CREATE TABLE IF NOT EXISTS nimbus_kernel_mounts (' +
    'mount_point TEXT PRIMARY KEY)',
  );
  sql.exec(
    'CREATE TABLE IF NOT EXISTS nimbus_terminal_scrollback (' +
    'seq INTEGER PRIMARY KEY AUTOINCREMENT, ' +
    'ts INTEGER NOT NULL, ' +
    'data TEXT NOT NULL, ' +
    'bytes INTEGER NOT NULL DEFAULT 0)',
  );
  // [B'.3] Migration guard: B'.1 created the table without a `bytes`
  // column. If a DO already ran B'.1/B'.2 with that schema, the
  // CREATE TABLE IF NOT EXISTS above is a no-op and we'd hit
  // 'no such column: bytes' on the first INSERT. Detect via
  // PRAGMA table_info and ALTER if the column is missing.
  let hasBytes = false;
  for (const row of sql.exec('PRAGMA table_info(nimbus_terminal_scrollback)') as Iterable<any>) {
    if (String((row as any).name) === 'bytes') { hasBytes = true; break; }
  }
  if (!hasBytes) {
    try {
      sql.exec('ALTER TABLE nimbus_terminal_scrollback ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0');
    } catch { /* race: concurrent ensure already added it */ }
  }
}

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
export function loadShellState(ctx: any): ShellStateSnapshot {
  const sql = ctx?.storage?.sql;
  const empty: ShellStateSnapshot = {
    cwd: null, env: null, hydratedAt: null, hasPersistedState: false,
  };
  if (!sql) return empty;
  ensureSessionStateSchema(ctx);

  // Single row per key — the table is intentionally tiny so we read
  // all interesting keys in one query.
  let cwd: string | null = null;
  let env: Record<string, string> | null = null;
  let hydratedAt: number | null = null;
  let any = false;
  for (const row of sql.exec(
    'SELECT k, v FROM nimbus_session_kv WHERE k IN (?, ?, ?)',
    KEY_CWD, KEY_ENV_JSON, KEY_HYDRATED_AT,
  ) as Iterable<{ k: string; v: string }>) {
    any = true;
    if (row.k === KEY_CWD) {
      cwd = String(row.v);
    } else if (row.k === KEY_ENV_JSON) {
      try {
        const parsed = JSON.parse(String(row.v));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          env = parsed as Record<string, string>;
        }
      } catch {
        // Corrupt env JSON → treat as no env (still rehydrates cwd
        // from the cwd row above). Don't throw.
      }
    } else if (row.k === KEY_HYDRATED_AT) {
      const n = Number(row.v);
      hydratedAt = Number.isFinite(n) ? n : null;
    }
  }
  return { cwd, env, hydratedAt, hasPersistedState: any };
}

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
export function persistShellState(
  ctx: any,
  state: { cwd: string | null; env: Record<string, string> | null },
): void {
  const sql = ctx?.storage?.sql;
  if (!sql) return;
  ensureSessionStateSchema(ctx);

  if (state.cwd !== null) {
    sql.exec(
      'INSERT OR REPLACE INTO nimbus_session_kv (k, v) VALUES (?, ?)',
      KEY_CWD, state.cwd,
    );
  } else {
    sql.exec('DELETE FROM nimbus_session_kv WHERE k = ?', KEY_CWD);
  }

  if (state.env !== null) {
    const json = JSON.stringify(state.env);
    if (json.length > SESSION_ENV_MAX_BYTES) {
      throw new Error(
        `[state-store] env JSON exceeds ${SESSION_ENV_MAX_BYTES} bytes ` +
        `(got ${json.length}); refusing to persist`,
      );
    }
    sql.exec(
      'INSERT OR REPLACE INTO nimbus_session_kv (k, v) VALUES (?, ?)',
      KEY_ENV_JSON, json,
    );
  } else {
    sql.exec('DELETE FROM nimbus_session_kv WHERE k = ?', KEY_ENV_JSON);
  }
}

/**
 * Stamp the time of the most recent successful hydrate. Used by the
 * /api/_diag/session debug endpoint to show "the last cold-start
 * found a row at <ts>". Cheap; one row write per initSession call.
 */
export function stampHydratedAt(ctx: any, atMs: number): void {
  const sql = ctx?.storage?.sql;
  if (!sql) return;
  ensureSessionStateSchema(ctx);
  sql.exec(
    'INSERT OR REPLACE INTO nimbus_session_kv (k, v) VALUES (?, ?)',
    KEY_HYDRATED_AT, String(atMs),
  );
}

/**
 * Drop ALL session-state rows. Used by /api/_test/session/reset for
 * test-only flows; never called from prod paths. Equivalent to
 * "this DO has never seen a session" — the next initSession runs
 * the cold-start path.
 */
export function clearSessionState(ctx: any): void {
  const sql = ctx?.storage?.sql;
  if (!sql) return;
  ensureSessionStateSchema(ctx);
  sql.exec('DELETE FROM nimbus_session_kv');
  sql.exec('DELETE FROM nimbus_kernel_mounts');
  sql.exec('DELETE FROM nimbus_terminal_scrollback');
}

/** Count rows in nimbus_session_kv — used by the recovery_event
 *  recorder to populate snapshotKeysRehydrated. Cheap; bounded by
 *  the small key set above. */
export function countSessionStateKeys(ctx: any): number {
  const sql = ctx?.storage?.sql;
  if (!sql) return 0;
  ensureSessionStateSchema(ctx);
  for (const row of sql.exec('SELECT COUNT(*) AS n FROM nimbus_session_kv')) {
    return Number((row as any).n) || 0;
  }
  return 0;
}

// ── Kernel mount tree [B'.2] ───────────────────────────────────────────
//
// The kernel mount list lives in nimbus_kernel_mounts. Today the list
// is exactly DEFAULT_MOUNT_POINTS (a static constant in src/constants.ts),
// so persistence is functionally redundant — every initSession would
// rebuild the same list from the constant. The architectural reason to
// route mount-list reads through SQL anyway is to give a future
// custom-mount feature a stable storage surface: when `mount /r2-cache`
// is added later, it just inserts a row, and the rehydrate path picks
// it up without any further refactor.

/**
 * Load the persisted mount-point list. Returns a plain string[] of
 * mount point names (without leading slash — same shape as
 * DEFAULT_MOUNT_POINTS). Empty array when no rows exist.
 */
export function loadKernelMounts(ctx: any): string[] {
  const sql = ctx?.storage?.sql;
  if (!sql) return [];
  ensureSessionStateSchema(ctx);
  const out: string[] = [];
  for (const row of sql.exec(
    'SELECT mount_point FROM nimbus_kernel_mounts ORDER BY mount_point ASC',
  ) as Iterable<{ mount_point: string }>) {
    out.push(String(row.mount_point));
  }
  return out;
}

/**
 * Persist a mount-point list. Idempotent — replaces the entire
 * nimbus_kernel_mounts contents in a single transaction. Caller
 * provides the full desired set; we don't merge with existing rows.
 *
 * `mounts` should be plain names without leading slash
 * ('bin', 'etc', ...) — same shape DEFAULT_MOUNT_POINTS uses.
 */
export function persistKernelMounts(ctx: any, mounts: string[]): void {
  const sql = ctx?.storage?.sql;
  if (!sql) return;
  ensureSessionStateSchema(ctx);
  // Replace-all semantics: clear, then insert. The whole table is
  // bounded by O(10) rows so a full rewrite per persist is cheap.
  sql.exec('DELETE FROM nimbus_kernel_mounts');
  for (const mp of mounts) {
    if (typeof mp !== 'string' || mp.length === 0) continue;
    sql.exec(
      'INSERT OR REPLACE INTO nimbus_kernel_mounts (mount_point) VALUES (?)',
      mp,
    );
  }
}

// ── Terminal scrollback [B'.3] ─────────────────────────────────────────
//
// Every coalesced WS `output` frame (post-flush) is appended as one
// row in nimbus_terminal_scrollback. On reconnect, the rehydrate path
// reads all rows in seq order, concatenates the data column, and
// emits a single replay frame so the user sees their pre-close
// terminal contents above the fresh prompt.
//
// Cap policy: byte-budget eviction. After every append, if total
// bytes > SCROLLBACK_MAX_BYTES, delete oldest-seq rows until the
// total fits. Per-row count is unbounded — frames are coalesced at
// the WebSocketTerminal flush layer (5 ms timer) so a chatty shell
// produces O(N_frames) rows, not O(N_writes).
//
// The byte length of each frame is computed by the caller (cheap
// TextEncoder().encode().length) and stored in the `bytes` column.
// Computing per-row length on the read side would also work
// (length(CAST(data AS BLOB))) but storing it makes the eviction
// query trivial.

const _scrollbackEnc = new TextEncoder();

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
export function appendScrollback(ctx: any, data: string, atMs: number): void {
  if (!data || data.length === 0) return;
  const sql = ctx?.storage?.sql;
  if (!sql) return;
  ensureSessionStateSchema(ctx);

  // Per-frame truncation: oversized single frames keep only the
  // trailing MAX_FRAME_BYTES bytes. The "trailing" choice matches
  // user intuition — when scrollback shows a big cat output, the
  // user cares about the END of that output (where the prompt is)
  // not the beginning.
  let payload = data;
  let bytes = _scrollbackEnc.encode(payload).length;
  if (bytes > SCROLLBACK_MAX_FRAME_BYTES) {
    const buf = _scrollbackEnc.encode(payload);
    const start = buf.length - SCROLLBACK_MAX_FRAME_BYTES;
    payload = new TextDecoder().decode(buf.subarray(start));
    bytes = _scrollbackEnc.encode(payload).length;
  }

  let insertedSeq: number | null = null;
  try {
    sql.exec(
      'INSERT INTO nimbus_terminal_scrollback (ts, data, bytes) VALUES (?, ?, ?)',
      atMs, payload, bytes,
    );
    // Capture the seq we just wrote so the eviction loop can avoid
    // deleting it. SQLite's last_insert_rowid() returns the row id of
    // the most recent insert on this connection.
    for (const row of sql.exec('SELECT last_insert_rowid() AS id') as Iterable<any>) {
      insertedSeq = Number((row as any).id);
      break;
    }
  } catch (e: any) {
    try { console.warn('[B\'.3] scrollback INSERT failed bytes=' + bytes + ' err=' + (e?.message || e)); } catch {}
    return;
  }

  // Eviction. Read total bytes; if over cap, delete oldest-seq rows
  // in a loop. The table is bounded so a select-min/delete loop is
  // O(rows-evicted) and runs only when needed.
  //
  // Invariant: we never delete the row we JUST inserted. With a
  // sensibly-sized MAX_FRAME_BYTES (256 KiB) << MAX_BYTES (1 MiB),
  // a single insert can never single-handedly violate the cap by
  // more than MAX_FRAME_BYTES, and the eviction loop always has
  // older rows to delete first. The "never the new row" guard is
  // a belt-and-suspenders defence against future mis-tuning of the
  // two constants.
  let total = 0;
  for (const row of sql.exec('SELECT COALESCE(SUM(bytes), 0) AS n FROM nimbus_terminal_scrollback') as Iterable<any>) {
    total = Number((row as any).n) || 0;
    break;
  }
  if (total <= SCROLLBACK_MAX_BYTES) return;

  for (;;) {
    let oldestSeq: number | null = null;
    let oldestBytes = 0;
    for (const row of sql.exec(
      'SELECT seq, bytes FROM nimbus_terminal_scrollback ORDER BY seq ASC LIMIT 1',
    ) as Iterable<any>) {
      oldestSeq = Number((row as any).seq);
      oldestBytes = Number((row as any).bytes) || 0;
      break;
    }
    if (oldestSeq === null) break;
    if (insertedSeq !== null && oldestSeq === insertedSeq) {
      // The row we just inserted is now the only row → can't evict
      // it; cap is briefly exceeded, accept it. With MAX_FRAME_BYTES
      // ≤ MAX_BYTES the over-by amount is bounded.
      break;
    }
    sql.exec('DELETE FROM nimbus_terminal_scrollback WHERE seq = ?', oldestSeq);
    total -= oldestBytes;
    if (total <= SCROLLBACK_MAX_BYTES) break;
  }
}

/**
 * Read all scrollback rows in seq (chronological) order and return
 * the concatenated payload. Used by the rehydrate path to emit a
 * single batched replay frame.
 *
 * Returns empty string when the table is empty (cold start, or
 * after explicit reset).
 */
export function loadScrollback(ctx: any): string {
  const sql = ctx?.storage?.sql;
  if (!sql) return '';
  ensureSessionStateSchema(ctx);
  const parts: string[] = [];
  for (const row of sql.exec(
    'SELECT data FROM nimbus_terminal_scrollback ORDER BY seq ASC',
  ) as Iterable<{ data: string }>) {
    parts.push(String(row.data));
  }
  return parts.join('');
}

/** Stats for /api/_diag/session: row count + total bytes + cap. */
export function getScrollbackStats(ctx: any): {
  rows: number; bytes: number; maxBytes: number;
} {
  const sql = ctx?.storage?.sql;
  if (!sql) return { rows: 0, bytes: 0, maxBytes: SCROLLBACK_MAX_BYTES };
  ensureSessionStateSchema(ctx);
  let rows = 0; let bytes = 0;
  for (const row of sql.exec(
    'SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM nimbus_terminal_scrollback',
  ) as Iterable<any>) {
    rows = Number((row as any).n) || 0;
    bytes = Number((row as any).b) || 0;
    break;
  }
  return { rows, bytes, maxBytes: SCROLLBACK_MAX_BYTES };
}
