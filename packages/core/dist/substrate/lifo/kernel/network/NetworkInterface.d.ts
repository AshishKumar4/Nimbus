import type { NetworkInterface as INetworkInterface, InterfaceState, InterfaceStats, IPAddress, Packet } from './types.js';
/**
 * Virtual network interface implementation
 * Represents a network device like eth0, lo, tun0, etc.
 */
export declare class NetworkInterface implements INetworkInterface {
    name: string;
    type: 'loopback' | 'ethernet' | 'tunnel';
    state: InterfaceState;
    mtu: number;
    addresses: IPAddress[];
    mac?: string;
    stats: InterfaceStats;
    namespace: string;
    private packetQueue;
    private listeners;
    constructor(name: string, type: 'loopback' | 'ethernet' | 'tunnel', namespace: string, options?: {
        mtu?: number;
        mac?: string;
        addresses?: IPAddress[];
    });
    /**
     * Bring interface up
     */
    up(): void;
    /**
     * Bring interface down
     */
    down(): void;
    /**
     * Add IP address to interface
     */
    addAddress(address: IPAddress): void;
    /**
     * Remove IP address from interface
     */
    removeAddress(address: string): void;
    /**
     * Check if interface has address
     */
    hasAddress(address: string): boolean;
    /**
     * Send packet through interface
     */
    send(packet: Packet): void;
    /**
     * Receive packet on interface
     */
    receive(packet: Packet): void;
    /**
     * Register packet listener
     */
    onPacket(listener: (packet: Packet) => void): void;
    /**
     * Emit packet to all listeners
     */
    private emit;
    /**
     * Get next packet from queue
     */
    nextPacket(): Packet | undefined;
    /**
     * Generate random MAC address
     */
    private generateMAC;
    /**
     * Get interface info as string (for ifconfig)
     */
    toString(): string;
    /**
     * Format bytes for display
     */
    private formatBytes;
    /**
     * Set MTU (Maximum Transmission Unit)
     */
    setMTU(mtu: number): void;
    /**
     * Get interface statistics
     */
    getStats(): InterfaceStats;
}
//# sourceMappingURL=NetworkInterface.d.ts.map