import { type WebSocketGuestEvent } from './realm-websocket.js';
/** A WebSocket's native event surface, with its transport owned by the host. */
export declare function routeWebSocketsThroughHost(post: (event: WebSocketGuestEvent) => void, waiting: () => void, nextId: () => number): {
    answer(event: unknown): void;
    readonly awaited: number;
};
//# sourceMappingURL=realm-websocket-guest.d.ts.map