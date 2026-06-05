/**
 * real-vite-hmr.ts — Phase 2 HMR bridge for the real-vite facet.
 *
 * The browser's `@vite/client` script (served as-is by Vite) opens a
 * WebSocket to Vite's HMR path. In local dev that's a raw TCP socket;
 * under workerd we don't have one, so we:
 *
 *   1. Route the browser's upgrade request to a new DO endpoint
 *      `/s/<id>/preview/__nimbus_hmr` (picked as an unusual path that
 *      won't collide with user code). The DO accepts the WebSocket.
 *   2. On the facet side, we shim `ws.WebSocketServer` — the npm
 *      module Vite bundles for HMR. The shim registers itself in a
 *      facet-local "pending connections" table; when a connection
 *      arrives via RPC, the shim delivers an "on('connection')" event
 *      to Vite.
 *   3. Messages from Vite (server → client, e.g. HMR update) are
 *      pushed back to the supervisor via `SUPERVISOR.hmrSend(clientId,
 *      msg)`, which the supervisor forwards to the right WebSocket.
 *   4. Messages from the browser (client → server, e.g. ping/pong,
 *      custom events) are ferried via a long-poll
 *      `SUPERVISOR.hmrNextEvent(serverId)` that returns the queued
 *      batch.
 *
 * Phase 1's VFS-backed fs shim is the prerequisite: chokidar's watch
 * events drive Vite's HMR, so we need real file change notifications
 * plumbed to the facet. Those come via the SAME long-poll loop as
 * client-side WS messages — both are just "events from the
 * supervisor", multiplexed.
 *
 * Scope note: Phase 2 implements the minimum viable path —
 * connection + server→client messages — enough for the
 * "[vite] connected" handshake + full-reload triggers on file save.
 * True module-level `import.meta.hot.accept()` needs chokidar events
 * to fire Vite's `moduleGraph.invalidate`; wire that up once Phase 1's
 * fs shim is streaming VFS events.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
/**
 * Supervisor-side registry of active HMR connections for a single
 * real-vite session. One instance lives on each NimbusSession that has
 * real-vite running. The instance is bound to a specific facet via
 * its `facetStub` (a ctx.exports wrapper around the facet's
 * WorkerEntrypoint).
 *
 * Lifecycle:
 *   - On browser WS upgrade (/preview/__nimbus_hmr), the DO calls
 *     bridge.attachClient(ws) → HMR connection id is generated, ws
 *     is stored, and a one-shot RPC to the facet tells it "new
 *     connection".
 *   - The facet's ws shim emits a 'connection' event to Vite. Vite
 *     starts sending handshake messages via the shim's .send() →
 *     those come back to the supervisor via SUPERVISOR.hmrSend →
 *     HmrBridge.relayToBrowser(clientId, msg).
 *   - Browser WS messages arrive at the DO's webSocketMessage
 *     handler, which calls bridge.deliverClientMessage(clientId, msg)
 *     → enqueued for the next hmrNextEvent long-poll.
 *   - Same long-poll returns VFS change events so chokidar can fire.
 */
export declare class HmrBridge {
    /** clientId → WebSocket */
    private clients;
    /** Pending events awaiting the next long-poll. */
    private pending;
    /** Resolver for the currently-suspended long-poll, if any. */
    private resolver;
    /** Has the facet ever called hmrNextEvent? Used for diagnostics. */
    _everAwaitedEvents: boolean;
    private _nextId;
    /** Register a new browser WebSocket. Returns the assigned client id. */
    attachClient(ws: WebSocket): string;
    detachClient(id: string): void;
    /** Called by the DO webSocketMessage handler. Forwards to the facet. */
    deliverClientMessage(id: string, msg: string): void;
    /** Called by the facet via SUPERVISOR.hmrSend to push a msg to a browser. */
    relayToBrowser(id: string | null, msg: string): void;
    /**
     * Push a synthetic VFS event into the event queue. Called by
     * NimbusSession's VFS-events listener so the facet's chokidar shim
     * fires file-change callbacks.
     */
    pushVfsEvent(event: string, path: string, oldPath?: string): void;
    private push;
    /**
     * Called by the facet via SUPERVISOR.hmrNextEvent. Long-polls up to
     * `timeoutMs` for the next batch of events. Returns an empty array
     * on timeout so the facet can loop without leaking a promise.
     */
    nextEvents(timeoutMs?: number): Promise<any[]>;
    /** Active client count. */
    get size(): number;
    /** Drop all clients (facet restart, session close). */
    closeAll(): void;
}
export declare function registerHmrBridge(doId: string, holder: {
    hmr: HmrBridge;
}): void;
/**
 * WorkerEntrypoint the facet talks to via `env.CIRRUS_HMR`.
 *
 * hmrSend CANNOT write to browser WSs directly (workerd forbids
 * cross-request I/O on objects owned by a different request's
 * context — even hibernatable WSs owned by the DO can't be written
 * to from a sibling WorkerEntrypoint isolate). Instead, hmrSend
 * routes through the DO stub's _rpcHmrRelay method, where the
 * ws.send() happens in the DO's own request context.
 *
 * Props: { doId: string }
 *   doId — the supervisor DO's id, used to find the right stub +
 *          HmrBridge.
 */
export declare class CirrusHmrRPC extends WorkerEntrypoint {
    private _bridge;
    private _stub;
    hmrSend(clientId: string | null, msg: string): Promise<void>;
    hmrNextEvent(timeoutMs?: number): Promise<any[]>;
}
/**
 * ESM source for the `ws` npm module shim. Vite's bundle still
 * statically imports things like `WebSocketServer` from `ws`; we
 * externalize that specifier and provide this module at LOADER.load
 * time.
 *
 * `new WebSocketServer({ noServer: true })` gives Vite back an object
 * that:
 *   - emits 'connection' events whenever the supervisor reports a
 *     new client via the long-poll,
 *   - exposes .handleUpgrade (stubbed since we don't have raw sockets).
 *
 * The returned client has `.on('message', cb)`, `.send(msg)`, `.close()`
 * — enough for Vite's hot.ts handshake.
 */
export declare function generateWsShimModuleCode(): string;
/**
 * ESM source for the chokidar shim. Vite's bundle imports chokidar's
 * `watch()` function; we reroute that to this module. Our watcher
 * listens on the facet-global event dispatcher (fed by the long-poll
 * loop) and translates VFS events to chokidar-shaped callbacks.
 *
 * Supported events: add, change, unlink, addDir, unlinkDir, ready, all.
 */
export declare function generateChokidarShimModuleCode(): string;
//# sourceMappingURL=real-vite-hmr.d.ts.map