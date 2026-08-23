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
import { recordRecoveryEvent } from '@nimbus-sh/platform/oom-discriminator.js';
import { generation } from '@nimbus-sh/fabric/generation.js';
import { hasLiveShellOwner } from './shell-socket.js';
/**
 * Set the current phase + record a transition. Fail-soft on the
 * observability call; the phase update on `self` is direct and
 * cheap.
 */
export function setPhase(self, toState, trigger) {
    const fromState = self._b4Phase ?? 'cold';
    self._b4Phase = toState;
    try {
        recordRecoveryEvent({
            at: Date.now(),
            fromState,
            toState,
            trigger,
            isolateGen: generation(self.ctx),
            dataLoss: false,
            snapshotKeysRehydrated: 0,
        });
    }
    catch { /* observability is non-critical */ }
}
/**
 * Decide what a /ws upgrade should do with the session it lands on.
 *
 *   - cold:      no session to join. Either nothing was ever built, or a
 *                previous teardown left the object half-built. A Shell
 *                without its Kernel or its Terminal serves nobody, and
 *                nothing else rebuilds one, so the upgrade does.
 *   - conflict:  another browser terminal holds this session. The caller
 *                answers 409, which is what stops two tabs from driving
 *                one shell. See `shell-socket.ts` for what proves that a
 *                socket still has a peer on it.
 *   - warm-join: the session is built and unattended. Skip the rebuild
 *                and hand the live Shell to the incoming socket.
 *
 * The caller classifies BEFORE it accepts the incoming socket, so the
 * upgrade cannot count itself as the incumbent.
 */
export function classifyWsUpgrade(self, sockets, now = Date.now()) {
    if (self.shell == null || self.terminal == null || self.kernel == null)
        return 'cold';
    return hasLiveShellOwner(self.ctx, sockets, now) ? 'conflict' : 'warm-join';
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
export function joinExistingSession(self, ws, appendScrollback, loadScrollback) {
    // Phase R — pure SQL reads. No-op on warm rejoin (live state is
    // already correct in self.shell / self.terminal). Recorded in the
    // ring for symmetry with cold init.
    setPhase(self, 'rehydrate', 'warm-rejoin');
    // Phase W — re-attach the existing WebSocketTerminal to the new
    // ws and replay persisted scrollback. The Shell's reference to
    // the same WebSocketTerminal instance is preserved (we mutate
    // its internal ws ref via attach()).
    setPhase(self, 'wire', 'warm-rejoin');
    self.terminal.attach(ws, (frame) => {
        try {
            appendScrollback(self.ctx, frame, Date.now());
        }
        catch (e) {
            try {
                console.warn("[B'.3] appendScrollback failed:", e?.message || e);
            }
            catch { }
        }
    });
    // Replay scrollback to the new ws so the user sees the prior
    // session's terminal contents. Same shape as cold-init's replay
    // when persisted state exists.
    try {
        const replay = loadScrollback(self.ctx);
        if (replay.length > 0)
            self.terminal.write(replay);
    }
    catch (e) {
        try {
            console.warn("[B'.3] scrollback replay failed:", e?.message || e);
        }
        catch { }
    }
    // Phase O is SKIPPED on warm rejoin (just like warm path of
    // initSession). The original cold-start banner is in the replay.
    // Settle to 'hydrated' as the terminal phase via setPhase so the
    // ring records the wire→hydrated transition for forensics.
    setPhase(self, 'hydrated', 'warm-rejoin');
    // Bump the warm-join counter; surfaced via /api/_diag/session.
    self._b4WarmJoinCount += 1;
    // ws.send({type:'ready'}) — the client expects this to know the
    // shell is live. Same as initSession's last line.
    try {
        ws.send(JSON.stringify({ type: 'ready' }));
    }
    catch { }
}
