import type { Socket as ISocket, SocketType, SocketState, SocketAddress, Packet } from './types.js';
/**
 * Virtual socket implementation
 * Mimics POSIX socket API
 */
export declare class Socket implements ISocket {
    fd: number;
    type: SocketType;
    state: SocketState;
    localAddress?: SocketAddress;
    remoteAddress?: SocketAddress;
    namespace: string;
    private receiveQueue;
    private acceptQueue;
    private backlog;
    private receiveWaiters;
    private acceptWaiters;
    private closeCallback?;
    constructor(fd: number, type: SocketType, namespace: string, closeCallback?: () => void);
    /**
     * Bind socket to address
     */
    bind(address: SocketAddress): void;
    /**
     * Connect to remote address
     */
    connect(address: SocketAddress): Promise<void>;
    /**
     * Listen for connections
     */
    listen(backlog?: number): void;
    /**
     * Accept incoming connection
     */
    accept(): Promise<Socket>;
    /**
     * Send data through socket
     */
    send(data: Uint8Array): Promise<number>;
    /**
     * Receive data from socket
     */
    recv(maxBytes: number): Promise<Uint8Array>;
    /**
     * Close socket
     */
    close(): void;
    /**
     * Deliver packet to socket (called by NetworkStack)
     */
    deliverPacket(packet: Packet): void;
    /**
     * Allocate ephemeral port (49152-65535)
     */
    private allocateEphemeralPort;
    /**
     * Allocate ephemeral file descriptor
     */
    private allocateEphemeralFd;
    /**
     * Get socket info string (for netstat)
     */
    toString(): string;
}
//# sourceMappingURL=Socket.d.ts.map