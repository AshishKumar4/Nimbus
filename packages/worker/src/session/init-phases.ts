/**
 * src/session/init-phases.ts — B'.4 R/B/W/O state machine for initSession.
 *
 * Track B' goal: make the implicit phases of initSession explicit and
 * observable. Each phase boundary calls `setPhase(self, phase, trigger)`
 * which:
 *   1. Updates `self._b4Phase` so /api/_diag/session.phase reflects it.
 *   2. Records a recovery_event entry capturing the transition. The
 *      ring is bounded to 50 events and is the C'.2 surface — phase
 *      transitions are SUPPLEMENTAL to the existing high-level
 *      cold/hydrated/active/drained markers, not a replacement.
 *
 * The phases:
 *   - rehydrate: Phase R — loading persisted values from DO SQLite
 *                (cwd, env, mounts, scrollback). Pure SQL reads;
 *                sets up locals consumed by later phases.
 *   - build:     Phase B — constructing Kernel + Shell + registry +
 *                installing 60+ commands + wiring SqliteVFSProvider
 *                mounts. Most CPU-intensive phase.
 *   - wire:      Phase W — attaching the WebSocketTerminal to the
 *                Shell, replaying persisted scrollback into the WS.
 *                This is the phase B'.5 will be able to re-run on
 *                an already-built session ("join existing").
 *   - online:    Phase O — cold-start UI: MOTD, starter-app hint,
 *                framework-detect line. ONLY runs on cold start
 *                (when persisted.hasPersistedState=false). On warm
 *                re-init this phase is skipped and initSession ends
 *                with the 'hydrated' marker instead of 'online'.
 *
 * The legacy single recordRecoveryEvent({fromState, toState:
 * 'hydrated', trigger:'init-session'}) call at end of initSession is
 * preserved — old probes still see it. New phase entries are
 * additional ring entries, not replacements.
 */

import { recordRecoveryEvent, type SessionState } from '../observability/oom-discriminator.js';

/**
 * Set the current phase + record a transition. Fail-soft on the
 * observability call; the phase update on `self` is direct and
 * cheap.
 */
export function setPhase(
  self: { _b4Phase: SessionState | null; _w9IsolateGen?: number },
  toState: SessionState,
  trigger: string,
): void {
  const fromState: SessionState = self._b4Phase ?? 'cold';
  self._b4Phase = toState;
  try {
    recordRecoveryEvent({
      at: Date.now(),
      fromState,
      toState,
      trigger,
      isolateGen: self._w9IsolateGen ?? 0,
      dataLoss: false,
      snapshotKeysRehydrated: 0,
    });
  } catch { /* observability is non-critical */ }
}

/**
 * [B'.5] Determine whether the next /ws upgrade should run the warm-
 * rejoin path (Phase R + Phase W only) or the full cold-init path
 * (R + B + W + O + hydrated).
 *
 * Conditions for warm rejoin:
 *   1. Phase = 'drained' (a wsClose / wsError fired since last init).
 *   2. Kernel + Shell + Terminal are still alive in-memory (the
 *      [B'.5] change to wsClose stopped nulling them).
 *   3. Same isolate (no DO eviction since the close).
 *
 * If ANY condition fails, the full cold-init path is the safe choice.
 */
export function isWarmRejoin(self: {
  _b4Phase: SessionState | null;
  shell: any; terminal: any; kernel: any;
}): boolean {
  return self._b4Phase === 'drained'
      && self.shell != null
      && self.terminal != null
      && self.kernel != null;
}

/**
 * [B'.5] Run the warm-rejoin path. Skips Phase B (kernel + shell are
 * already built and alive in-memory). Phase R loads any state that
 * may have changed since drained (none today — Phase R is no-op on
 * warm rejoin); Phase W swaps the WebSocketTerminal's underlying ws
 * to the new socket and replays scrollback so the user sees their
 * pre-close terminal contents above the live prompt.
 *
 * The `self` argument is intentionally minimal — only the fields
 * this function actually touches. The full SessionInternal isn't
 * needed here; init-phases.ts shouldn't grow a circular dep on
 * nimbus-session-internal.
 */
export function joinExistingSession(
  self: {
    ctx: any;
    terminal: { attach(ws: WebSocket, onFlush?: (data: string) => void): void; write(s: string): void };
    _b4Phase: SessionState | null;
    _w9IsolateGen?: number;
    _b4WarmJoinCount: number;
  },
  ws: WebSocket,
  appendScrollback: (ctx: any, data: string, atMs: number) => void,
  loadScrollback: (ctx: any) => string,
): void {
  // Phase R — pure SQL reads. No-op on warm rejoin (live state is
  // already correct in self.shell / self.terminal). Recorded in the
  // ring for symmetry with cold init.
  setPhase(self as any, 'rehydrate', 'warm-rejoin');

  // Phase W — re-attach the existing WebSocketTerminal to the new
  // ws and replay persisted scrollback. The Shell's reference to
  // the same WebSocketTerminal instance is preserved (we mutate
  // its internal ws ref via attach()).
  setPhase(self as any, 'wire', 'warm-rejoin');
  self.terminal.attach(ws, (frame: string) => {
    try { appendScrollback(self.ctx, frame, Date.now()); }
    catch (e: any) {
      try { console.warn("[B'.3] appendScrollback failed:", e?.message || e); } catch {}
    }
  });
  // Replay scrollback to the new ws so the user sees the prior
  // session's terminal contents. Same shape as cold-init's replay
  // when persisted state exists.
  try {
    const replay = loadScrollback(self.ctx);
    if (replay.length > 0) self.terminal.write(replay);
  } catch (e: any) {
    try { console.warn("[B'.3] scrollback replay failed:", e?.message || e); } catch {}
  }

  // Phase O is SKIPPED on warm rejoin (just like warm path of
  // initSession). The original cold-start banner is in the replay.
  // Settle to 'hydrated' as the terminal phase via setPhase so the
  // ring records the wire→hydrated transition for forensics.
  setPhase(self as any, 'hydrated', 'warm-rejoin');
  // Bump the warm-join counter; surfaced via /api/_diag/session.
  self._b4WarmJoinCount += 1;

  // ws.send({type:'ready'}) — the client expects this to know the
  // shell is live. Same as initSession's last line.
  try { ws.send(JSON.stringify({ type: 'ready' })); } catch {}
}
