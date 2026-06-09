import type { NetworkTunnel, Packet, TunnelType } from '../types.js';
import { NetworkInterface } from '../NetworkInterface.js';
import type { NetworkStack } from '../NetworkStack.js';
/**
 * Base class for all tunnel implementations
 * Provides common functionality for tunnel management
 */
export declare abstract class BaseTunnel implements Omit<NetworkTunnel, 'interface'> {
    id: string;
    abstract type: TunnelType;
    state: 'up' | 'down';
    interface: NetworkInterface;
    config: Record<string, unknown>;
    protected networkStack: NetworkStack;
    protected namespace: string;
    protected mtu: number;
    constructor(id: string, networkStack: NetworkStack, namespace?: string, mtu?: number);
    /**
     * Get tunnel interface name prefix (tun, gre, etc.)
     */
    protected abstract getTunnelPrefix(): string;
    /**
     * Bring tunnel up
     */
    up(): Promise<void>;
    /**
     * Bring tunnel down
     */
    down(): Promise<void>;
    /**
     * Setup routing for tunnel (override if needed)
     */
    protected setupRouting(): Promise<void>;
    /**
     * Teardown routing for tunnel (override if needed)
     */
    protected teardownRouting(): Promise<void>;
    /**
     * Send packet through tunnel (must be implemented by subclass)
     */
    abstract send(packet: Packet): Promise<void>;
    /**
     * Receive packet from tunnel (must be implemented by subclass)
     */
    abstract recv(): Promise<Packet>;
    /**
     * Update tunnel statistics
     */
    protected updateStats(bytes: number, direction: 'tx' | 'rx', error?: boolean): void;
    /**
     * Get tunnel status string
     */
    toString(): string;
}
//# sourceMappingURL=BaseTunnel.d.ts.map