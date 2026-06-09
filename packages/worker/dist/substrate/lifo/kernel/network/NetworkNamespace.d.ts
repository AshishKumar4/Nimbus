import type { NetworkNamespace as INetworkNamespace, RouteEntry, Socket } from './types.js';
import type { NetworkInterface } from './NetworkInterface.js';
/**
 * Network namespace implementation
 * Provides network isolation like Linux network namespaces
 */
export declare class NetworkNamespace implements INetworkNamespace {
    id: string;
    name: string;
    interfaces: Map<string, NetworkInterface>;
    routes: RouteEntry[];
    sockets: Map<number, Socket>;
    arpTable: Map<string, string>;
    private nextFd;
    constructor(id: string, name: string);
    /**
     * Add interface to namespace
     */
    addInterface(iface: NetworkInterface): void;
    /**
     * Remove interface from namespace
     */
    removeInterface(name: string): boolean;
    /**
     * Get interface by name
     */
    getInterface(name: string): NetworkInterface | undefined;
    /**
     * Get all interfaces
     */
    getAllInterfaces(): NetworkInterface[];
    /**
     * Add route
     */
    addRoute(route: RouteEntry): void;
    /**
     * Remove route
     */
    removeRoute(destination: string, iface: string): boolean;
    /**
     * Get all routes
     */
    getRoutes(): RouteEntry[];
    /**
     * Add socket to namespace
     */
    addSocket(socket: Socket): void;
    /**
     * Remove socket from namespace
     */
    removeSocket(fd: number): boolean;
    /**
     * Get socket by file descriptor
     */
    getSocket(fd: number): Socket | undefined;
    /**
     * Get all sockets
     */
    getAllSockets(): Socket[];
    /**
     * Allocate file descriptor for new socket
     */
    allocateFd(): number;
    /**
     * Add ARP entry (IP -> MAC mapping)
     */
    addArpEntry(ip: string, mac: string): void;
    /**
     * Remove ARP entry
     */
    removeArpEntry(ip: string): boolean;
    /**
     * Lookup MAC address for IP
     */
    arpLookup(ip: string): string | undefined;
    /**
     * Get all ARP entries
     */
    getArpTable(): Map<string, string>;
    /**
     * Clear all ARP entries
     */
    clearArpTable(): void;
    /**
     * Clone namespace (for creating new network namespace)
     */
    clone(newId: string, newName: string): NetworkNamespace;
    /**
     * Get namespace statistics
     */
    getStats(): {
        interfaces: number;
        routes: number;
        sockets: number;
        arpEntries: number;
    };
}
//# sourceMappingURL=NetworkNamespace.d.ts.map