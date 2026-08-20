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
 * Same pattern as src/observability/diag-counters.ts. The supervisor bundle
 * is the consumer; all writers (sqlite-vfs, facet-pool, facet-manager,
 * supervisor-rpc, npm-installer, nimbus-session) live in the same
 * isolate. Module scope provides one process-local diagnostic without
 * threading a handle through each writer.
 *
 * Two distinct rings
 * ──────────────────
 * - failures: things that failed (the original W5 ring).
 * - recoveryEvents: lifecycle transitions of the session. Cold isolate
 *   boot → 'cold' → 'hydrated' → 'active' → 'drained'.
 *
 * Bounded-size guarantees
 * ───────────────────────
 *   - failures ring: 50 entries (RING_SIZE).
 *   - recoveryEvents ring: 50 entries (RECOVERY_RING_SIZE).
 *   - per-message cap: 200 chars (truncated at insert).
 *   - per-RPC-frame: single slot, one object.
 *   - per-facet-id: single slot, one object.
 *
 * Snapshot size stays bounded even with both rings full.
 */
import { isOomCause } from './oom-classify.js';
const RING_SIZE = 50;
const RECOVERY_RING_SIZE = 50;
const MESSAGE_CAP = 200;
const state = {
    failures: [],
    recoveryEvents: [],
    lastRpcFrame: null,
    lastFacetId: null,
};
function getState() {
    return state;
}
/** Append a failure to the ring. Newest first. Capped at RING_SIZE. */
export function recordFailure(f) {
    const s = getState();
    // Defensive copy + message cap.
    const entry = {
        at: Number(f.at) || Date.now(),
        phase: String(f.phase ?? 'unknown'),
        cause: f.cause,
        rssEstimateBytes: Number(f.rssEstimateBytes) || 0,
        heapUsedBytes: Number(f.heapUsedBytes) || 0,
        lruBytes: Number(f.lruBytes) || 0,
        inFlightBytes: Number(f.inFlightBytes) || 0,
        lastRpcFrame: f.lastRpcFrame ?? s.lastRpcFrame,
        lastFacetId: f.lastFacetId ?? s.lastFacetId,
    };
    if (typeof f.exitCode === 'number')
        entry.exitCode = f.exitCode;
    if (typeof f.pid === 'number')
        entry.pid = f.pid;
    if (f.message) {
        const m = String(f.message);
        entry.message = m.length > MESSAGE_CAP ? m.slice(0, MESSAGE_CAP) : m;
    }
    s.failures.unshift(entry);
    if (s.failures.length > RING_SIZE)
        s.failures.length = RING_SIZE;
}
/** Read a snapshot of the ring. Newest first. Caller-side mutations
 *  do not affect the singleton. */
export function getFailures() {
    return getState().failures.slice(0);
}
/** Record the current RPC frame (called at every RPC entry). Bounded
 *  to a single slot — the LATEST frame wins. */
export function setLastRpcFrame(method, payloadBytes) {
    const s = getState();
    s.lastRpcFrame = {
        method: String(method),
        payloadBytes: Number(payloadBytes) || 0,
        atMs: Date.now(),
    };
}
export function getLastRpcFrame() {
    return getState().lastRpcFrame;
}
/** Record the most recent facet dispatch. */
export function setLastFacetId(codeId, slotIndex) {
    const s = getState();
    s.lastFacetId = {
        codeId: String(codeId),
        slotIndex: Number(slotIndex) || 0,
        atMs: Date.now(),
    };
}
export function getLastFacetId() {
    return getState().lastFacetId;
}
// ── C'.2 recovery_event ring ────────────────────────────────────────────
//
// The ring is bounded at RECOVERY_RING_SIZE; the diag endpoint reads via
// getRecoveryEvents() (newest first).
/** Append a recovery event to the ring. Newest first. Capped at
 *  RECOVERY_RING_SIZE. */
export function recordRecoveryEvent(e) {
    const s = getState();
    // Defensive copy + notes cap. We intentionally do NOT validate the
    // state-machine direction here (e.g. that 'drained' only follows
    // 'active') — the state machine lives elsewhere; this ring is a
    // recorder, not an enforcer. If a probe sees an impossible
    // transition, that's a real bug in the state machine and the
    // probe must fail.
    const entry = {
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
export function getRecoveryEvents() {
    return getState().recoveryEvents.slice(0);
}
/** Reset the recovery ring. Tests + manual operator use only. */
export function resetRecoveryEvents() {
    getState().recoveryEvents.length = 0;
}
export function snapshotForStorage() {
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
 * Only the current v2 schema is accepted.
 */
export function rehydrateFromStorage(blob) {
    if (!isRecord(blob) || blob.v !== 2)
        return;
    const b = blob;
    if (!Array.isArray(b.failures))
        return;
    const s = getState();
    s.failures.length = 0;
    for (const f of b.failures) {
        const entry = parseFailure(f);
        if (!entry)
            continue;
        s.failures.push(entry);
        if (s.failures.length >= RING_SIZE)
            break;
    }
    s.recoveryEvents.length = 0;
    if (Array.isArray(b.recoveryEvents)) {
        for (const e of b.recoveryEvents) {
            const entry = parseRecoveryEvent(e);
            if (!entry)
                continue;
            s.recoveryEvents.push(entry);
            if (s.recoveryEvents.length >= RECOVERY_RING_SIZE)
                break;
        }
    }
    const lastRpcFrame = parseRpcFrame(b.lastRpcFrame);
    if (lastRpcFrame)
        s.lastRpcFrame = lastRpcFrame;
    const lastFacetId = parseFacetId(b.lastFacetId);
    if (lastFacetId)
        s.lastFacetId = lastFacetId;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
function parseRpcFrame(value) {
    if (!isRecord(value)
        || typeof value.method !== 'string'
        || typeof value.payloadBytes !== 'number'
        || typeof value.atMs !== 'number')
        return null;
    return { method: value.method, payloadBytes: value.payloadBytes, atMs: value.atMs };
}
function parseFacetId(value) {
    if (!isRecord(value)
        || typeof value.codeId !== 'string'
        || typeof value.slotIndex !== 'number'
        || typeof value.atMs !== 'number')
        return null;
    return { codeId: value.codeId, slotIndex: value.slotIndex, atMs: value.atMs };
}
function parseFailure(value) {
    if (!isRecord(value)
        || typeof value.at !== 'number'
        || typeof value.phase !== 'string'
        || !isOomCause(value.cause)
        || typeof value.rssEstimateBytes !== 'number'
        || typeof value.heapUsedBytes !== 'number'
        || typeof value.lruBytes !== 'number'
        || typeof value.inFlightBytes !== 'number')
        return null;
    const entry = {
        at: value.at,
        phase: value.phase,
        cause: value.cause,
        rssEstimateBytes: value.rssEstimateBytes,
        heapUsedBytes: value.heapUsedBytes,
        lruBytes: value.lruBytes,
        inFlightBytes: value.inFlightBytes,
        lastRpcFrame: parseRpcFrame(value.lastRpcFrame),
        lastFacetId: parseFacetId(value.lastFacetId),
    };
    if (typeof value.exitCode === 'number')
        entry.exitCode = value.exitCode;
    if (typeof value.pid === 'number')
        entry.pid = value.pid;
    if (typeof value.message === 'string')
        entry.message = value.message.slice(0, MESSAGE_CAP);
    return entry;
}
const SESSION_STATES = [
    'cold', 'hydrated', 'active', 'drained',
    'rehydrate', 'build', 'wire', 'online',
];
function isSessionState(value) {
    return SESSION_STATES.some((state) => state === value);
}
function parseRecoveryEvent(value) {
    if (!isRecord(value)
        || typeof value.at !== 'number'
        || !isSessionState(value.fromState)
        || !isSessionState(value.toState)
        || typeof value.trigger !== 'string'
        || typeof value.isolateGen !== 'number'
        || typeof value.dataLoss !== 'boolean'
        || typeof value.snapshotKeysRehydrated !== 'number')
        return null;
    const entry = {
        at: value.at,
        fromState: value.fromState,
        toState: value.toState,
        trigger: value.trigger,
        isolateGen: value.isolateGen,
        dataLoss: value.dataLoss,
        snapshotKeysRehydrated: value.snapshotKeysRehydrated,
    };
    if (typeof value.notes === 'string')
        entry.notes = value.notes.slice(0, MESSAGE_CAP);
    return entry;
}
