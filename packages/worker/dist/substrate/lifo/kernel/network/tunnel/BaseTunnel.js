import { NetworkInterface } from '../NetworkInterface.js';
/**
 * Base class for all tunnel implementations
 * Provides common functionality for tunnel management
 */
export class BaseTunnel {
    id;
    state = 'down';
    interface;
    config;
    networkStack;
    namespace;
    mtu;
    constructor(id, networkStack, namespace = 'default', mtu = 1500) {
        this.id = id;
        this.networkStack = networkStack;
        this.namespace = namespace;
        this.mtu = mtu;
        this.config = {};
        // Create tunnel interface
        this.interface = new NetworkInterface(`${this.getTunnelPrefix()}${id}`, 'tunnel', namespace);
        this.interface.setMTU(mtu);
    }
    /**
     * Bring tunnel up
     */
    async up() {
        if (this.state === 'up') {
            return;
        }
        this.interface.up();
        this.state = 'up';
        // Hook into NetworkStack routing
        await this.setupRouting();
    }
    /**
     * Bring tunnel down
     */
    async down() {
        if (this.state === 'down') {
            return;
        }
        this.interface.down();
        this.state = 'down';
        // Remove from NetworkStack routing
        await this.teardownRouting();
    }
    /**
     * Setup routing for tunnel (override if needed)
     */
    async setupRouting() {
        // Default: no special routing needed
    }
    /**
     * Teardown routing for tunnel (override if needed)
     */
    async teardownRouting() {
        // Default: no cleanup needed
    }
    /**
     * Update tunnel statistics
     */
    updateStats(bytes, direction, error = false) {
        const stats = this.interface.getStats();
        if (direction === 'tx') {
            stats.txPackets++;
            stats.txBytes += bytes;
            if (error)
                stats.txErrors++;
        }
        else {
            stats.rxPackets++;
            stats.rxBytes += bytes;
            if (error)
                stats.rxErrors++;
        }
    }
    /**
     * Get tunnel status string
     */
    toString() {
        const name = this.interface.name.padEnd(10);
        const type = this.type.toUpperCase().padEnd(8);
        const state = this.state.toUpperCase();
        const mtu = `MTU ${this.mtu}`;
        return `${name} ${type} ${state} ${mtu}`;
    }
}
