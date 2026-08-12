import type { Packet } from '../types.js';
import type { NetworkStack } from '../NetworkStack.js';
import { BaseTunnel } from './BaseTunnel.js';
/**
 * WebSocket Tunnel - Bridge virtual network to external WebSocket server
 *
 * This tunnel connects Lifo's virtual network stack to an external WebSocket
 * tunnel server, enabling host machine access to virtual servers.
 *
 * Example:
 *   tunnel --server=ws://localhost:3005
 *
 * Access from host:
 *   http://localhost:3005/3000/ → Port 3000 in virtual network
 */
export declare class WebSocketTunnel extends BaseTunnel {
    type: 'ssh';
    private wsUrl;
    private ws;
    private portRegistry?;
    private defaultPort;
    private reconnectTimer?;
    private isReconnecting;
    private packetQueue;
    private waitingResolvers;
    constructor(id: string, wsUrl: string, networkStack: NetworkStack, portRegistry?: Map<number, any>, namespace?: string, defaultPort?: number | null);
    protected getTunnelPrefix(): string;
    /**
     * Bring tunnel up - connect to WebSocket server
     */
    up(): Promise<void>;
    /**
     * Bring tunnel down - disconnect from WebSocket server
     */
    down(): Promise<void>;
    /**
     * Send packet through WebSocket tunnel
     */
    send(packet: Packet): Promise<void>;
    /**
     * Receive packet from WebSocket tunnel
     */
    recv(): Promise<Packet>;
    /**
     * Connect to WebSocket server
     */
    private connect;
    /**
     * Schedule reconnection attempt
     */
    private scheduleReconnect;
    /**
     * Handle incoming WebSocket message
     */
    private handleMessage;
    /**
     * Handle HTTP request from tunnel server
     */
    private handleHttpRequest;
    /**
     * Handle HTTP response (for client-side requests)
     */
    private handleHttpResponse;
    /**
     * Send HTTP response through WebSocket
     */
    private sendResponse;
    /**
     * Send error response through WebSocket
     */
    private sendError;
    /**
     * Serialize packet to bytes
     */
    private serializePacket;
    /**
     * Get tunnel status string
     */
    toString(): string;
    /**
     * Get connection status
     */
    isConnected(): boolean;
    /**
     * Get active ports
     */
    getActivePorts(): number[];
}
//# sourceMappingURL=WebSocketTunnel.d.ts.map