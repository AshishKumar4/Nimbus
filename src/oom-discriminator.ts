/**
 * oom-discriminator.ts — singleton ring buffer for OOM / failure
 * forensics + last-known-RPC-frame + last-known-facet-id, plus
 * snapshot/rehydrate hooks for DO storage persistence.
 *
 * W5 (Lever 5 / J.1.1). Pairs with oom-classify.ts.
 *
 * Why singleton-per-isolate
 * ─────────────────────────
 * Same pattern as src/diag-counters.ts (q.v.). The supervisor bundle
 * is the consumer; all writers (sqlite-vfs, facet-pool, facet-manager,
 * supervisor-rpc, npm-installer, nimbus-session) live in the same
 * isolate. globalThis-keyed storage avoids threading a handle through
 * ~10 sites for what is essentially a process-local diagnostic.
 *
 * Bounded-size guarantees
 * ───────────────────────
 *   - failures ring: 50 entries (RING_SIZE).
 *   - per-message cap: 200 chars (truncated at insert).
 *   - per-RPC-frame: single slot, one object.
 *   - per-facet-id: single slot, one object.
 *
 * Snapshot ≤20 KB even with all 50 entries full. Verified by
 * audit/probes/w5/functional/ring-persistence.mjs.
 */

import type { OomCause } from './oom-classify.js';

const KEY = '__NIMBUS_W5_OOM_DISC__';
const RING_SIZE = 50;
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

interface RingState {
  failures: DiagFailure[];
  lastRpcFrame: RpcFrame | null;
  lastFacetId: FacetId | null;
}

function getState(): RingState {
  const g = globalThis as any;
  if (!g[KEY]) {
    g[KEY] = {
      failures: [],
      lastRpcFrame: null,
      lastFacetId: null,
    } as RingState;
  }
  return g[KEY] as RingState;
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

/**
 * Build a JSON-serializable snapshot suitable for ctx.storage.put.
 * Bounded ≤ 20 KB even with the ring full of MESSAGE_CAP-truncated
 * messages. Schema version embedded so a future shape change can
 * cleanly reject old snapshots.
 */
export interface DiagSnapshot {
  /** Schema version. Bump when shape changes. */
  v: number;
  failures: DiagFailure[];
  lastRpcFrame: RpcFrame | null;
  lastFacetId: FacetId | null;
}

export function snapshotForStorage(): DiagSnapshot {
  const s = getState();
  return {
    v: 1,
    failures: s.failures.slice(0),
    lastRpcFrame: s.lastRpcFrame,
    lastFacetId: s.lastFacetId,
  };
}

/**
 * Restore from a snapshot. Fail-soft: garbage / null / wrong-shape
 * input is silently ignored (logged at console.warn level). Does NOT
 * throw — constructor-time rehydration must never block DO startup.
 */
export function rehydrateFromStorage(blob: unknown): void {
  if (!blob || typeof blob !== 'object') return;
  const b = blob as Partial<DiagSnapshot>;
  if (b.v !== 1) return;
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
  if (b.lastRpcFrame && typeof b.lastRpcFrame === 'object'
      && typeof (b.lastRpcFrame as RpcFrame).method === 'string') {
    s.lastRpcFrame = b.lastRpcFrame as RpcFrame;
  }
  if (b.lastFacetId && typeof b.lastFacetId === 'object'
      && typeof (b.lastFacetId as FacetId).codeId === 'string') {
    s.lastFacetId = b.lastFacetId as FacetId;
  }
}
