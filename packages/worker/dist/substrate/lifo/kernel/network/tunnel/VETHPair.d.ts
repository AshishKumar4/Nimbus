import type { Packet } from '../types.js';
import { NetworkInterface } from '../NetworkInterface.js';
import type { NetworkStack } from '../NetworkStack.js';
/**
 * VETH Pair - Virtual Ethernet Device Pair
 *
 * Creates two virtual network interfaces that are directly connected.
 * Packets sent to one end appear immediately on the other end.
 * Like a virtual Ethernet cable connecting two namespaces.
 *
 * Example:
 *   ip link add veth0 type veth peer name veth1
 *   ip link set veth1 netns container1
 */
export declare class VETHPair {
    id: string;
    veth0: NetworkInterface;
    veth1: NetworkInterface;
    state: 'up' | 'down';
    private networkStack;
    private queue0;
    private queue1;
    private waiters0;
    private waiters1;
    constructor(id: string, name0: string, name1: string, networkStack: NetworkStack, namespace0?: string, namespace1?: string);
    /**
     * Bring both interfaces up
     */
    up(): Promise<void>;
    /**
     * Bring both interfaces down
     */
    down(): Promise<void>;
    /**
     * Send packet from veth0 to veth1
     */
    send0to1(packet: Packet): Promise<void>;
    /**
     * Send packet from veth1 to veth0
     */
    send1to0(packet: Packet): Promise<void>;
    /**
     * Receive packet on veth0 (sent from veth1)
     */
    recv0(): Promise<Packet>;
    /**
     * Receive packet on veth1 (sent from veth0)
     */
    recv1(): Promise<Packet>;
    /**
     * Move one end of the VETH pair to a different namespace
     */
    moveToNamespace(which: 0 | 1, namespace: string): Promise<void>;
    /**
     * Generate MAC address for VETH interface
     */
    private generateMAC;
    /**
     * Get VETH pair status string
     */
    toString(): string;
    /**
     * Get interface by name
     */
    getInterface(name: string): NetworkInterface | null;
    /**
     * Get peer interface
     */
    getPeer(name: string): NetworkInterface | null;
}
//# sourceMappingURL=VETHPair.d.ts.map