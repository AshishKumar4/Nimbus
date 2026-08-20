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
/**
 * Set the current phase + record a transition. Fail-soft on the
 * observability call; the phase update on `self` is direct and
 * cheap.
 */
export declare function setPhase(self: {
    _b4Phase: SessionState | null;
    _isolateGen?: number;
}, toState: SessionState, trigger: string): void;
/**
 * [B'.5] Identify the original phase-based warm-rejoin case. The /ws
 * upgrade classifier below also recognizes headless sessions whose
 * lifecycle phase does not describe a real terminal attachment.
 *
 * Conditions for warm rejoin:
 *   1. Phase = 'drained' (a wsClose / wsError fired since last init).
 *   2. Kernel + Shell + Terminal are still alive in-memory (the
 *      [B'.5] change to wsClose stopped nulling them).
 *   3. Same isolate (no DO eviction since the close).
 *
 */
export declare function isWarmRejoin(self: {
    _b4Phase: SessionState | null;
    shell: any;
    terminal: any;
    kernel: any;
}): boolean;
type WsUpgradeDecision = 'warm-join' | 'conflict' | 'cold';
/**
 * Classify a shell WebSocket upgrade from the actual attachment state.
 * A non-null Shell can belong to a headless programmatic boot, so only an
 * open socket tagged as `shell` proves that another browser terminal is
 * currently attached.
 */
export declare function classifyWsUpgrade(self: {
    _b4Phase: SessionState | null;
    shell: unknown;
    terminal: unknown;
    kernel: unknown;
}, sockets: readonly WebSocket[]): WsUpgradeDecision;
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
    _isolateGen?: number;
    _b4WarmJoinCount: number;
}, ws: WebSocket, appendScrollback: (ctx: any, data: string, atMs: number) => void, loadScrollback: (ctx: any) => string): void;
export {};
//# sourceMappingURL=init-phases.d.ts.map