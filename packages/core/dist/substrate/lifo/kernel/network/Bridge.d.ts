import type { Packet } from './types.js';
import { NetworkInterface } from './NetworkInterface.js';
import type { NetworkStack } from './NetworkStack.js';
/**
 * Bridge Device - Virtual Network Switch (like Linux bridge)
 *
 * Acts as a Layer 2 switch, forwarding packets between connected interfaces.
 * Similar to Linux 'ip link add br0 type bridge' or Docker's docker0 bridge.
 *
 * Example:
 *   ip link add br0 type bridge
 *   ip link set veth0 master br0
 *   ip link set veth1 master br0
 */
export declare class Bridge {
    name: string;
    interface: NetworkInterface;
    state: 'up' | 'down';
    private ports;
    private macTable;
    private ageingTime;
    private lastSeen;
    constructor(name: string, _networkStack: NetworkStack, namespace?: string);
    /**
     * Bring bridge up
     */
    up(): Promise<void>;
    /**
     * Bring bridge down
     */
    down(): Promise<void>;
    /**
     * Add interface to bridge (make it a bridge port)
     */
    addPort(iface: NetworkInterface): void;
    /**
     * Remove interface from bridge
     */
    removePort(ifaceName: string): boolean;
    /**
     * Get all bridge ports
     */
    getPorts(): NetworkInterface[];
    /**
     * Check if interface is a bridge port
     */
    hasPort(ifaceName: string): boolean;
    /**
     * Forward packet through bridge (like a network switch)
     *
     * This is the core bridge logic:
     * 1. Learn source MAC address
     * 2. Look up destination MAC in forwarding table
     * 3. Forward to specific port or flood to all ports
     */
    forward(packet: Packet, ingressPort: string): Promise<void>;
    /**
     * Learn MAC address -> port mapping
     */
    private learn;
    /**
     * Forward packet to specific port
     */
    private forwardToPort;
    /**
     * Flood packet to all ports except ingress
     */
    private flood;
    /**
     * Age out old MAC table entries
     */
    private ageEntries;
    /**
     * Get source MAC from packet (simplified)
     */
    private getSourceMAC;
    /**
     * Get destination MAC from packet (simplified)
     */
    private getDestMAC;
    /**
     * Show bridge MAC address table
     */
    showFdb(): string[];
    /**
     * Get bridge status string
     */
    toString(): string;
    /**
     * Get detailed bridge info
     */
    getInfo(): string[];
    /**
     * Set ageing time
     */
    setAgeingTime(seconds: number): void;
    /**
     * Clear MAC table
     */
    clearFdb(): void;
    /**
     * Generate MAC address for bridge
     */
    private generateBridgeMAC;
    /**
     * Get statistics
     */
    getStats(): import("./types.js").InterfaceStats;
}
//# sourceMappingURL=Bridge.d.ts.map