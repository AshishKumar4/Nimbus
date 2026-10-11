import type { WorkspaceNetwork } from '../_shared/workspace-network.js';
import type { HeaderPairs } from './realm-egress.js';
export type WebSocketGuestEvent = {
    readonly type: 'egress-ws';
    readonly id: number;
    readonly url: string;
    readonly headers: HeaderPairs;
} | {
    readonly type: 'egress-ws-send';
    readonly id: number;
    readonly data: string | Uint8Array;
} | {
    readonly type: 'egress-ws-close';
    readonly id: number;
    readonly code?: number;
    readonly reason: string;
};
export type WebSocketHostEvent = {
    readonly type: 'egress-ws-open';
    readonly id: number;
    readonly protocol: string;
    readonly extensions: string;
} | {
    readonly type: 'egress-ws-message';
    readonly id: number;
    readonly data: string | Uint8Array;
} | {
    readonly type: 'egress-ws-closed';
    readonly id: number;
    readonly code: number;
    readonly reason: string;
    readonly clean: boolean;
} | {
    readonly type: 'egress-ws-error';
    readonly id: number;
    readonly message: string;
};
export declare function isWebSocketGuestEvent(value: unknown): value is WebSocketGuestEvent;
export declare function isWebSocketHostEvent(value: unknown): value is WebSocketHostEvent;
/** The socket stays with the egress's caller; only frames and close cross the realm. */
export declare class RealmWebSockets {
    private readonly network;
    private readonly post;
    private readonly sockets;
    constructor(network: WorkspaceNetwork, post: (event: WebSocketHostEvent) => void);
    handle(event: WebSocketGuestEvent): void;
    private open;
    private failed;
    private closeSocket;
    close(): void;
}
//# sourceMappingURL=realm-websocket.d.ts.map