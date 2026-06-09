import { NetworkInterface } from './NetworkInterface.js';
import { NetworkNamespace } from './NetworkNamespace.js';
import { DNSResolver } from './DNSResolver.js';
import { Socket } from './Socket.js';
import type { IPAddress, SocketType, SocketAddress, Packet, RouteEntry, NetworkTunnel } from './types.js';
/**
 * Virtual network stack
 * Provides Linux-like networking with interfaces, routing, sockets, DNS, and tunneling
 */
export declare class NetworkStack {
    private namespaces;
    private routingTable;
    private dnsResolver;
    private portBindings;
    private nextNamespaceId;
    private tunnels;
    private vethPairs;
    private bridges;
    private nextTunnelId;
    constructor();
    /**
     * Initialize default namespace with loopback interface
     */
    private initDefaultNamespace;
    /**
     * Create new network namespace
     */
    createNamespace(name: string): string;
    /**
     * Delete network namespace
     */
    deleteNamespace(id: string): boolean;
    /**
     * Get namespace by ID
     */
    getNamespace(id: string): NetworkNamespace | undefined;
    /**
     * Get all namespaces
     */
    getAllNamespaces(): NetworkNamespace[];
    /**
     * Create network interface
     */
    createInterface(name: string, type: 'loopback' | 'ethernet' | 'tunnel', namespace?: string, options?: {
        mtu?: number;
        mac?: string;
        addresses?: IPAddress[];
    }): NetworkInterface;
    /**
     * Delete network interface
     */
    deleteInterface(name: string, namespace?: string): boolean;
    /**
     * Get interface
     */
    getInterface(name: string, namespace?: string): NetworkInterface | undefined;
    /**
     * Get all interfaces in namespace
     */
    getAllInterfaces(namespace?: string): NetworkInterface[];
    /**
     * Add route
     */
    addRoute(route: RouteEntry): void;
    /**
     * Remove route
     */
    removeRoute(destination: string, iface: string, namespace?: string): boolean;
    /**
     * Get routes
     */
    getRoutes(namespace?: string): RouteEntry[];
    /**
     * Lookup route for destination
     */
    lookupRoute(ip: string, namespace?: string): RouteEntry | null;
    /**
     * Create socket
     */
    createSocket(type: SocketType, namespace?: string): Socket;
    /**
     * Bind socket to port
     */
    bindSocket(socket: Socket, address: SocketAddress, handler?: (socket: Socket) => void | Promise<void>): void;
    /**
     * Unbind socket
     */
    private unbindSocket;
    /**
     * Get port binding key
     */
    private getBindingKey;
    /**
     * Send packet
     */
    sendPacket(packet: Packet, namespace?: string): Promise<void>;
    /**
     * Route packet to listening socket
     */
    private routeToSocket;
    /**
     * Get DNS resolver
     */
    getDNS(): DNSResolver;
    /**
     * Resolve hostname
     */
    resolveHostname(hostname: string): Promise<string>;
    /**
     * Get all sockets in namespace
     */
    getAllSockets(namespace?: string): Socket[];
    /**
     * Get formatted routing table
     */
    getRoutingTableString(namespace?: string): string;
    /**
     * Add tunnel to network stack
     */
    addTunnel(name: string, tunnel: NetworkTunnel): void;
    /**
     * Remove tunnel from network stack
     */
    removeTunnel(name: string): Promise<boolean>;
    /**
     * Get tunnel by name
     */
    getTunnel(name: string): NetworkTunnel | undefined;
    /**
     * Get all tunnels
     */
    getAllTunnels(): NetworkTunnel[];
    /**
     * Get tunnels by namespace
     */
    getTunnelsByNamespace(namespace: string): NetworkTunnel[];
    /**
     * Add VETH pair
     */
    addVETHPair(id: string, vethPair: any): void;
    /**
     * Remove VETH pair
     */
    removeVETHPair(id: string): Promise<boolean>;
    /**
     * Get VETH pair by ID or interface name
     */
    getVETHPair(idOrName: string): any | undefined;
    /**
     * Get all VETH pairs
     */
    getAllVETHPairs(): any[];
    /**
     * Generate next tunnel ID
     */
    getNextTunnelId(): string;
    /**
     * Add bridge to network stack
     */
    addBridge(name: string, bridge: any): void;
    /**
     * Remove bridge from network stack
     */
    removeBridge(name: string): Promise<boolean>;
    /**
     * Get bridge by name
     */
    getBridge(name: string): any | undefined;
    /**
     * Get all bridges
     */
    getAllBridges(): any[];
    /**
     * Get bridges by namespace
     */
    getBridgesByNamespace(namespace: string): any[];
}
//# sourceMappingURL=NetworkStack.d.ts.map