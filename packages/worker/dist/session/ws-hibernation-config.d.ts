/**
 * ws-hibernation-config.ts — W9 (CF research §C.3 + §C.4) configuration
 * for setWebSocketAutoResponse + setHibernatableWebSocketEventTimeout.
 *
 * Why a dedicated module:
 *   - NimbusSession's constructor is already crowded; the calls have
 *     specific failure modes (workerd version dependence, optional
 *     globals) that deserve isolation.
 *   - Unit-testable in Node by passing a mock ctx — the constructor
 *     itself can't be (it pulls cloudflare:workers).
 *
 * What this does, in order:
 *   1. setWebSocketAutoResponse(WebSocketRequestResponsePair('ping','pong'))
 *      — vite HMR clients ping every 30s and idle xterm tabs ping per
 *      minute. Without auto-response, every ping wakes the actor from
 *      hibernation: ~2880 wakes/day per idle tab. After this, zero
 *      billable wakes for matched ping/pong frames. Auto-response config
 *      survives hibernation per the STOR/Durable Objects WebSocket
 *      Primer (wiki page id 1372566651).
 *   2. setHibernatableWebSocketEventTimeout(5000) — bound a single
 *      hibernation message handler. Long-running work runs in facets
 *      with their own CPU budget; the supervisor's WS handlers should
 *      enqueue then return. 5 s recommended in CF research §C.3.
 *
 * Both calls are gated on try/catch:
 *   - workerd builds before mid-2024 don't expose either method.
 *   - WebSocketRequestResponsePair is a workerd global; absent in Node.
 * Failure is reported honestly via the return value so /api/_diag/memory
 * can show whether the runtime supported the configuration.
 */
/**
 * Recommended hibernation event timeout (ms). 5 s per CF research §C.3
 * — long enough for the heaviest non-facet WS message handler observed
 * in W5 telemetry (~120 ms p99 for a heavy autocomplete request), short
 * enough to bound a runaway handler before it pins the actor.
 */
export declare const NIMBUS_HIBERNATION_EVENT_TIMEOUT_MS = 5000;
/** Public ping/pong contract — clients send `ping`, receive `pong`. */
export declare const WS_AUTO_RESPONSE_REQUEST = "ping";
export declare const WS_AUTO_RESPONSE_RESPONSE = "pong";
export interface WsHibernationConfigResult {
    /** True iff `setWebSocketAutoResponse` ran without throwing. */
    autoResponseConfigured: boolean;
    /**
     * The timeout (in ms) we successfully set, or null if the call wasn't
     * available / threw. Reported separately from autoResponseConfigured
     * so a partial-support workerd shows the partial truth.
     */
    timeoutSetMs: number | null;
    /** Optional error message — human-readable, never thrown. */
    autoResponseError?: string;
    timeoutError?: string;
}
/**
 * Configure WS hibernation behaviours on a DurableObjectState. Idempotent
 * — safe to call multiple times. Returns a result that NimbusSession
 * surfaces via /api/_diag/memory under the `hib` key.
 *
 * The `ctx` parameter is structurally typed (anything with the right
 * methods works) so this module stays Node-testable. In production the
 * caller passes the real `this.ctx` from NimbusSession's constructor.
 */
export declare function configureWsHibernation(ctx: any): WsHibernationConfigResult;
//# sourceMappingURL=ws-hibernation-config.d.ts.map