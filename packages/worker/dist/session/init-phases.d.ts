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
import { type SessionState } from '@nimbus-sh/platform/oom-discriminator.js';
import { type AutoResponseHost } from './shell-socket.js';
/**
 * Set the current phase + record a transition. Fail-soft on the
 * observability call; the phase update on `self` is direct and
 * cheap.
 */
export declare function setPhase(self: {
    _b4Phase: SessionState | null;
    ctx?: unknown;
}, toState: SessionState, trigger: string): void;
type WsUpgradeDecision = 'warm-join' | 'conflict' | 'cold';
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
export declare function classifyWsUpgrade(self: {
    shell: unknown;
    terminal: unknown;
    kernel: unknown;
    ctx?: AutoResponseHost;
}, sockets: readonly WebSocket[], now?: number): WsUpgradeDecision;
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
export declare function joinExistingSession(self: {
    ctx: any;
    terminal: {
        attach(ws: WebSocket, onFlush?: (data: string) => void): void;
        write(s: string): void;
    };
    _b4Phase: SessionState | null;
    _b4WarmJoinCount: number;
}, ws: WebSocket, appendScrollback: (ctx: any, data: string, atMs: number) => void, loadScrollback: (ctx: any) => string): void;
export {};
//# sourceMappingURL=init-phases.d.ts.map