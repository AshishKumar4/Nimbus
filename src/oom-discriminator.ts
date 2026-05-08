/**
 * oom-discriminator.ts — singleton ring buffer for OOM / failure
 * forensics + last-known-RPC-frame + last-known-facet-id +
 * session-recovery-event ring, plus snapshot/rehydrate hooks for DO
 * storage persistence.
 *
 * W5 (Lever 5 / J.1.1) — original module. Pairs with oom-classify.ts.
 * C'.2 — added the recovery_event ring.
 *
 * Why singleton-per-isolate
 * ─────────────────────────
 * Same pattern as src/diag-counters.ts (q.v.). The supervisor bundle
 * is the consumer; all writers (sqlite-vfs, facet-pool, facet-manager,
 * supervisor-rpc, npm-installer, nimbus-session) live in the same
 * isolate. globalThis-keyed storage avoids threading a handle through
 * ~10 sites for what is essentially a process-local diagnostic.
 *
 * Two distinct rings
 * ──────────────────
 * - failures: things that failed (the original W5 ring).
 * - recoveryEvents: lifecycle transitions of the session (C'.2). Cold
 *   isolate boot → 'cold' → 'hydrated' → 'active' → 'drained'. Plan §3
 *   Track B' makes the transitions explicit; this ring records each
 *   one so probes can assert "session reached 'hydrated' from SQL with
 *   N keys, no data loss".
 *
 * Bounded-size guarantees
 * ───────────────────────
 *   - failures ring: 50 entries (RING_SIZE).
 *   - recoveryEvents ring: 50 entries (RECOVERY_RING_SIZE).
 *   - per-message cap: 200 chars (truncated at insert).
 *   - per-RPC-frame: single slot, one object.
 *   - per-facet-id: single slot, one object.
 *
 * Snapshot ≤40 KB even with both rings full. Verified by
 * audit/probes/w5/functional/ring-persistence.mjs (failures) and
 * audit/probes/c-prime/recovery-events/ (recovery — Phase 1 C'.2).
 */

import type { OomCause } from './oom-classify.js';

const KEY = '__NIMBUS_W5_OOM_DISC__';
const RING_SIZE = 50;
const RECOVERY_RING_SIZE = 50;
const MESSAGE_CAP = 200;

export interface RpcFrame {
  method: string;
  payloadBytes: number;
  atMs: number;
}

export interface FacetId {
  codeId: string;
  slotIndex: number;
  atMs: number;
}

export interface DiagFailure {
  /** ms epoch */
  at: number;
  /** Lifecycle stage (e.g. 'install', 'resolve', 'rpc', 'facet', 'ws'). */
  phase: string;
  /** Discriminated cause. See oom-classify.ts. */
  cause: OomCause;
  /** Best-effort RSS estimate in bytes (peak observed). */
  rssEstimateBytes: number;
  /** process.memoryUsage().heapUsed if available; 0 in DO contexts. */
  heapUsedBytes: number;
  /** SqliteVFS LRU hot bytes at time of failure. */
  lruBytes: number;
  /** Sum of in-flight RPC payload bytes (best-effort). */
  inFlightBytes: number;
  /** Snapshot of the most recent RPC frame, if any. */
  lastRpcFrame: RpcFrame | null;
  /** Snapshot of the most recent facet dispatch, if any. */
  lastFacetId: FacetId | null;
  /** Optional facet exit code (when failure represents a facet termination). */
  exitCode?: number;
  /** Optional facet pid. */
  pid?: number;
  /** Free-form message; truncated to MESSAGE_CAP characters. */
  message?: string;
}

/**
 * Session lifecycle states for the C'.2 recovery_event ring.
 *
 * The state machine is owned by Track B' (plan §3.3). This module
 * records transitions; it does not enforce them.
 *
 * State semantics:
 * - 'cold'      : fresh DO instance, no in-memory session state yet.
 * - 'hydrated'  : Phase R completed — SQL state read into in-memory cache.
 * - 'active'    : Phase B+W+O completed — kernel/shell/terminal wired.
 * - 'drained'   : webSocketError/Close fired; in-memory caches nulled,
 *                 SQL state freshly persisted; awaiting next reconnect.
 *
 * Trigger labels: human-readable event that caused the transition.
 * Examples: 'first-fetch', 'ws-upgrade', 'ws-close', 'ws-error',
 * 'isolate-evicted', 'manual-test'.
 */
/** Session state union.
 *
 * The original four are the high-level lifecycle markers:
 *   cold     — never inited
 *   hydrated — re-init complete (warm path; Phase O skipped)
 *   active   — live shell processing input
 *   drained  — webSocketError/Close fired; SQL freshly persisted
 *
 * The four [B'.4] additions are the fine-grained phases of
 * initSession itself, recorded as the function progresses:
 *   rehydrate — Phase R: loading state from DO SQLite
 *   build     — Phase B: constructing Kernel/Shell/registry
 *   wire      — Phase W: attaching terminal, replaying scrollback
 *   online    — Phase O: cold-start MOTD + starter hint (cold only;
 *               on warm re-init this phase is skipped and the
 *               initSession ends with 'hydrated' instead)
 *
 * The phase transitions are SUPPLEMENTAL to the high-level markers,
 * not a replacement. Probes that look for the legacy `'hydrated'`
 * marker continue to work; probes that want fine-grained debugging
 * can grep for the phase states.
 */
export type SessionState =
  | 'cold' | 'hydrated' | 'active' | 'drained'
  | 'rehydrate' | 'build' | 'wire' | 'online';

export interface DiagRecoveryEvent {
  /** ms epoch */
  at: number;
  /** Source state. */
  fromState: SessionState;
  /** Destination state. */
  toState: SessionState;
  /** Human-readable trigger ('ws-close', 'isolate-evicted', etc.). */
  trigger: string;
  /** _w9IsolateGen at the time of the event. Lets a probe detect the
   *  difference between an in-isolate transition and a cross-isolate one
   *  (the latter implies workerd recycled the DO). */
  isolateGen: number;
  /** True when the transition could not preserve state that should
   *  have survived (e.g. SQL persist threw, snapshot was missing on
   *  hydrate, etc.). Probes assert this stays false under non-OOM
   *  scenarios. */
  dataLoss: boolean;
  /** Number of SQL keys/rows rehydrated on a hydrated transition.
   *  Zero when the transition is one that doesn't read SQL. */
  snapshotKeysRehydrated: number;
  /** Optional free-form notes (200 char cap). */
  notes?: string;
}

interface RingState {
  failures: DiagFailure[];
  recoveryEvents: DiagRecoveryEvent[];
  lastRpcFrame: RpcFrame | null;
  lastFacetId: FacetId | null;
}

function getState(): RingState {
  const g = globalThis as any;
  if (!g[KEY]) {
    g[KEY] = {
      failures: [],
      recoveryEvents: [],
      lastRpcFrame: null,
      lastFacetId: null,
    } as RingState;
  }
  // Defensive: older snapshots predating C'.2 have no recoveryEvents
  // field. The rehydrate path adds the field on read; this guard is a
  // belt-and-braces second line so any legacy state object on
  // globalThis (e.g. from an in-process restart that beat the new
  // module load) doesn't make the ring methods crash.
  const s = g[KEY] as RingState;
  if (!Array.isArray(s.recoveryEvents)) s.recoveryEvents = [];
  return s;
}

/** Append a failure to the ring. Newest first. Capped at RING_SIZE. */
export function recordFailure(f: DiagFailure): void {
  const s = getState();
  // Defensive copy + message cap.
  const entry: DiagFailure = {
    at: Number(f.at) || Date.now(),
    phase: String(f.phase ?? 'unknown'),
    cause: (f.cause as OomCause) ?? 'unknown',
    rssEstimateBytes: Number(f.rssEstimateBytes) || 0,
    heapUsedBytes: Number(f.heapUsedBytes) || 0,
    lruBytes: Number(f.lruBytes) || 0,
    inFlightBytes: Number(f.inFlightBytes) || 0,
    lastRpcFrame: f.lastRpcFrame ?? s.lastRpcFrame,
    lastFacetId: f.lastFacetId ?? s.lastFacetId,
  };
  if (typeof f.exitCode === 'number') entry.exitCode = f.exitCode;
  if (typeof f.pid === 'number') entry.pid = f.pid;
  if (f.message) {
    const m = String(f.message);
    entry.message = m.length > MESSAGE_CAP ? m.slice(0, MESSAGE_CAP) : m;
  }
  s.failures.unshift(entry);
  if (s.failures.length > RING_SIZE) s.failures.length = RING_SIZE;
}

/** Read a snapshot of the ring. Newest first. Caller-side mutations
 *  do not affect the singleton. */
export function getFailures(): DiagFailure[] {
  return getState().failures.slice(0);
}

/** Reset everything. Used by tests; safe in production but typically
 *  unnecessary. */
export function resetFailures(): void {
  const s = getState();
  s.failures.length = 0;
  s.lastRpcFrame = null;
  s.lastFacetId = null;
}

/** Record the current RPC frame (called at every RPC entry). Bounded
 *  to a single slot — the LATEST frame wins. */
export function setLastRpcFrame(method: string, payloadBytes: number): void {
  const s = getState();
  s.lastRpcFrame = {
    method: String(method),
    payloadBytes: Number(payloadBytes) || 0,
    atMs: Date.now(),
  };
}

export function getLastRpcFrame(): RpcFrame | null {
  return getState().lastRpcFrame;
}

/** Record the most recent facet dispatch. */
export function setLastFacetId(codeId: string, slotIndex: number): void {
  const s = getState();
  s.lastFacetId = {
    codeId: String(codeId),
    slotIndex: Number(slotIndex) || 0,
    atMs: Date.now(),
  };
}

export function getLastFacetId(): FacetId | null {
  return getState().lastFacetId;
}

// ── C'.2 recovery_event ring ────────────────────────────────────────────
//
// Track B' transitions call recordRecoveryEvent() at every state change.
// The ring is bounded at RECOVERY_RING_SIZE; the diag endpoint reads via
// getRecoveryEvents() (newest first). Probes use this ring to assert
// that recoveries are actually transparent — a green run shows entries
// for every reconnection but every entry has dataLoss === false.

/** Append a recovery event to the ring. Newest first. Capped at
 *  RECOVERY_RING_SIZE. */
export function recordRecoveryEvent(e: DiagRecoveryEvent): void {
  const s = getState();
  // Defensive copy + notes cap. We intentionally do NOT validate the
  // state-machine direction here (e.g. that 'drained' only follows
  // 'active') — the state machine lives in Track B'; this ring is a
  // recorder, not an enforcer. If a probe sees an impossible
  // transition, that's a real bug in the state machine and the
  // probe must fail.
  const entry: DiagRecoveryEvent = {
    at: Number(e.at) || Date.now(),
    fromState: e.fromState,
    toState: e.toState,
    trigger: String(e.trigger ?? 'unknown'),
    isolateGen: Number(e.isolateGen) || 0,
    dataLoss: !!e.dataLoss,
    snapshotKeysRehydrated: Number(e.snapshotKeysRehydrated) || 0,
  };
  if (e.notes) {
    const n = String(e.notes);
    entry.notes = n.length > MESSAGE_CAP ? n.slice(0, MESSAGE_CAP) : n;
  }
  s.recoveryEvents.unshift(entry);
  if (s.recoveryEvents.length > RECOVERY_RING_SIZE) {
    s.recoveryEvents.length = RECOVERY_RING_SIZE;
  }
}

/** Read a snapshot of the recovery ring. Newest first. */
export function getRecoveryEvents(): DiagRecoveryEvent[] {
  return getState().recoveryEvents.slice(0);
}

/** Reset the recovery ring. Tests + manual operator use only. */
export function resetRecoveryEvents(): void {
  getState().recoveryEvents.length = 0;
}

/**
 * Build a JSON-serializable snapshot suitable for ctx.storage.put.
 * Bounded ≤ 40 KB even with both rings full of MESSAGE_CAP-truncated
 * messages. Schema version embedded so a future shape change can
 * cleanly reject old snapshots.
 *
 * Schema versions:
 *   v = 1  →  {failures, lastRpcFrame, lastFacetId} (pre-C'.2)
 *   v = 2  →  v1 + {recoveryEvents}                   (C'.2)
 *
 * Rehydrate accepts v=1 (treats recoveryEvents as empty) and v=2.
 */
export interface DiagSnapshot {
  /** Schema version. Bump when shape changes. */
  v: number;
  failures: DiagFailure[];
  recoveryEvents: DiagRecoveryEvent[];
  lastRpcFrame: RpcFrame | null;
  lastFacetId: FacetId | null;
}

export function snapshotForStorage(): DiagSnapshot {
  const s = getState();
  return {
    v: 2,
    failures: s.failures.slice(0),
    recoveryEvents: s.recoveryEvents.slice(0),
    lastRpcFrame: s.lastRpcFrame,
    lastFacetId: s.lastFacetId,
  };
}

/**
 * Restore from a snapshot. Garbage / null / wrong-shape input is
 * silently ignored. Does NOT throw — constructor-time rehydration must
 * never block DO startup.
 *
 * Accepts v=1 (pre-C'.2, no recoveryEvents field) and v=2. v=1
 * snapshots rehydrate failures only; recoveryEvents starts empty.
 */
export function rehydrateFromStorage(blob: unknown): void {
  if (!blob || typeof blob !== 'object') return;
  const b = blob as Partial<DiagSnapshot>;
  if (b.v !== 1 && b.v !== 2) return;
  if (!Array.isArray(b.failures)) return;

  const s = getState();
  s.failures.length = 0;
  for (const f of b.failures) {
    if (!f || typeof f !== 'object') continue;
    const entry = (f as DiagFailure);
    if (typeof entry.at !== 'number' || typeof entry.phase !== 'string') continue;
    s.failures.push(entry);
    if (s.failures.length >= RING_SIZE) break;
  }
  // v >= 2: recoveryEvents (skipped for v=1 by the shape-check below).
  s.recoveryEvents.length = 0;
  if (b.v === 2 && Array.isArray(b.recoveryEvents)) {
    for (const e of b.recoveryEvents) {
      if (!e || typeof e !== 'object') continue;
      const entry = (e as DiagRecoveryEvent);
      if (typeof entry.at !== 'number'
          || typeof entry.fromState !== 'string'
          || typeof entry.toState !== 'string') continue;
      s.recoveryEvents.push(entry);
      if (s.recoveryEvents.length >= RECOVERY_RING_SIZE) break;
    }
  }
  if (b.lastRpcFrame && typeof b.lastRpcFrame === 'object'
      && typeof (b.lastRpcFrame as RpcFrame).method === 'string') {
    s.lastRpcFrame = b.lastRpcFrame as RpcFrame;
  }
  if (b.lastFacetId && typeof b.lastFacetId === 'object'
      && typeof (b.lastFacetId as FacetId).codeId === 'string') {
    s.lastFacetId = b.lastFacetId as FacetId;
  }
}
