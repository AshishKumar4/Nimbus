import { NetworkInterface } from './NetworkInterface.js';
import { NetworkNamespace } from './NetworkNamespace.js';
import { RoutingTable } from './RoutingTable.js';
import { DNSResolver } from './DNSResolver.js';
import { Socket } from './Socket.js';
/**
 * Virtual network stack
 * Provides Linux-like networking with interfaces, routing, sockets, DNS, and tunneling
 */
export class NetworkStack {
    namespaces = new Map();
    routingTable;
    dnsResolver;
    portBindings = new Map(); // "namespace:proto:ip:port" -> binding
    nextNamespaceId = 1;
    // Tunnel management
    tunnels = new Map(); // tunnel name -> tunnel
    vethPairs = new Map(); // veth pair id -> VETHPair
    bridges = new Map(); // bridge name -> Bridge
    nextTunnelId = 0;
    constructor() {
        this.routingTable = new RoutingTable();
        this.dnsResolver = new DNSResolver();
        // Create default namespace
        this.createNamespace('default');
        this.initDefaultNamespace();
    }
    /**
     * Initialize default namespace with loopback interface
     */
    initDefaultNamespace() {
        const ns = this.namespaces.get('default');
        // Create loopback interface
        const lo = new NetworkInterface('lo', 'loopback', 'default');
        lo.addAddress({ version: 4, address: '127.0.0.1', subnet: '8' });
        lo.addAddress({ version: 6, address: '::1', subnet: '128' });
        lo.up();
        ns.addInterface(lo);
        // Add loopback routes
        this.routingTable.addRoute({
            destination: '127.0.0.0/8',
            interface: 'lo',
            metric: 0,
            namespace: 'default',
        });
    }
    /**
     * Create new network namespace
     */
    createNamespace(name) {
        const id = name === 'default' ? 'default' : `ns${this.nextNamespaceId++}`;
        const ns = new NetworkNamespace(id, name);
        this.namespaces.set(id, ns);
        return id;
    }
    /**
     * Delete network namespace
     */
    deleteNamespace(id) {
        if (id === 'default') {
            throw new Error('Cannot delete default namespace');
        }
        const ns = this.namespaces.get(id);
        if (!ns) {
            return false;
        }
        // Close all sockets
        for (const socket of ns.getAllSockets()) {
            socket.close();
        }
        // Remove all routes
        this.routingTable.clear(id);
        // Remove namespace
        return this.namespaces.delete(id);
    }
    /**
     * Get namespace by ID
     */
    getNamespace(id) {
        return this.namespaces.get(id);
    }
    /**
     * Get all namespaces
     */
    getAllNamespaces() {
        return Array.from(this.namespaces.values());
    }
    /**
     * Create network interface
     */
    createInterface(name, type, namespace = 'default', options) {
        const ns = this.namespaces.get(namespace);
        if (!ns) {
            throw new Error(`Namespace not found: ${namespace}`);
        }
        const iface = new NetworkInterface(name, type, namespace, options);
        ns.addInterface(iface);
        return iface;
    }
    /**
     * Delete network interface
     */
    deleteInterface(name, namespace = 'default') {
        const ns = this.namespaces.get(namespace);
        if (!ns) {
            return false;
        }
        return ns.removeInterface(name);
    }
    /**
     * Get interface
     */
    getInterface(name, namespace = 'default') {
        const ns = this.namespaces.get(namespace);
        if (!ns) {
            return undefined;
        }
        return ns.getInterface(name);
    }
    /**
     * Get all interfaces in namespace
     */
    getAllInterfaces(namespace = 'default') {
        const ns = this.namespaces.get(namespace);
        if (!ns) {
            return [];
        }
        return ns.getAllInterfaces();
    }
    /**
     * Add route
     */
    addRoute(route) {
        this.routingTable.addRoute(route);
        // Also add to namespace
        const ns = this.namespaces.get(route.namespace);
        if (ns) {
            ns.addRoute(route);
        }
    }
    /**
     * Remove route
     */
    removeRoute(destination, iface, namespace = 'default') {
        const removed = this.routingTable.removeRoute(destination, iface, namespace);
        const ns = this.namespaces.get(namespace);
        if (ns) {
            ns.removeRoute(destination, iface);
        }
        return removed;
    }
    /**
     * Get routes
     */
    getRoutes(namespace = 'default') {
        return this.routingTable.getRoutes(namespace);
    }
    /**
     * Lookup route for destination
     */
    lookupRoute(ip, namespace = 'default') {
        return this.routingTable.lookup(ip, namespace);
    }
    /**
     * Create socket
     */
    createSocket(type, namespace = 'default') {
        const ns = this.namespaces.get(namespace);
        if (!ns) {
            throw new Error(`Namespace not found: ${namespace}`);
        }
        const fd = ns.allocateFd();
        const socket = new Socket(fd, type, namespace, () => {
            // Cleanup on close
            ns.removeSocket(fd);
            this.unbindSocket(socket);
        });
        ns.addSocket(socket);
        return socket;
    }
    /**
     * Bind socket to port
     */
    bindSocket(socket, address, handler) {
        const key = this.getBindingKey(socket.namespace, socket.type, address.ip, address.port);
        if (this.portBindings.has(key)) {
            throw new Error(`Address already in use: ${address.ip}:${address.port}`);
        }
        socket.bind(address);
        this.portBindings.set(key, {
            port: address.port,
            address: address.ip,
            protocol: socket.type,
            handler: handler || (() => { }),
            namespace: socket.namespace,
        });
    }
    /**
     * Unbind socket
     */
    unbindSocket(socket) {
        if (!socket.localAddress) {
            return;
        }
        const key = this.getBindingKey(socket.namespace, socket.type, socket.localAddress.ip, socket.localAddress.port);
        this.portBindings.delete(key);
    }
    /**
     * Get port binding key
     */
    getBindingKey(namespace, proto, ip, port) {
        return `${namespace}:${proto}:${ip}:${port}`;
    }
    /**
     * Send packet
     */
    async sendPacket(packet, namespace = 'default') {
        // Look up route
        const route = this.routingTable.lookup(packet.destination.ip, namespace);
        if (!route) {
            throw new Error(`No route to host: ${packet.destination.ip}`);
        }
        // Get interface
        const ns = this.namespaces.get(namespace);
        if (!ns) {
            throw new Error(`Namespace not found: ${namespace}`);
        }
        const iface = ns.getInterface(route.interface);
        if (!iface) {
            throw new Error(`Interface not found: ${route.interface}`);
        }
        // Send through interface
        iface.send(packet);
        // Check if there's a socket listening on destination
        await this.routeToSocket(packet, namespace);
    }
    /**
     * Route packet to listening socket
     */
    async routeToSocket(packet, namespace) {
        // Try exact match first
        let key = this.getBindingKey(namespace, packet.protocol, packet.destination.ip, packet.destination.port);
        let binding = this.portBindings.get(key);
        // Try wildcard address
        if (!binding) {
            key = this.getBindingKey(namespace, packet.protocol, '0.0.0.0', packet.destination.port);
            binding = this.portBindings.get(key);
        }
        if (binding) {
            const ns = this.namespaces.get(namespace);
            if (ns) {
                // Find socket and deliver packet
                for (const socket of ns.getAllSockets()) {
                    if (socket.localAddress &&
                        socket.localAddress.port === binding.port &&
                        (socket.localAddress.ip === binding.address || binding.address === '0.0.0.0')) {
                        socket.deliverPacket(packet);
                        break;
                    }
                }
            }
        }
    }
    /**
     * Get DNS resolver
     */
    getDNS() {
        return this.dnsResolver;
    }
    /**
     * Resolve hostname
     */
    async resolveHostname(hostname) {
        return this.dnsResolver.resolve(hostname);
    }
    /**
     * Get all sockets in namespace
     */
    getAllSockets(namespace = 'default') {
        const ns = this.namespaces.get(namespace);
        if (!ns) {
            return [];
        }
        return ns.getAllSockets();
    }
    /**
     * Get formatted routing table
     */
    getRoutingTableString(namespace = 'default') {
        return this.routingTable.toString(namespace);
    }
    // ═══════════════════════════════════════════════════════════════
    // Tunnel Management
    // ═══════════════════════════════════════════════════════════════
    /**
     * Add tunnel to network stack
     */
    addTunnel(name, tunnel) {
        if (this.tunnels.has(name)) {
            throw new Error(`Tunnel ${name} already exists`);
        }
        this.tunnels.set(name, tunnel);
        // Add tunnel interface to namespace
        // Cast to NetworkInterface class since tunnel.interface is the concrete class
        const ns = this.namespaces.get(tunnel.interface.namespace);
        if (ns) {
            ns.addInterface(tunnel.interface);
        }
    }
    /**
     * Remove tunnel from network stack
     */
    async removeTunnel(name) {
        const tunnel = this.tunnels.get(name);
        if (!tunnel) {
            return false;
        }
        // Bring tunnel down
        await tunnel.down();
        // Remove interface from namespace
        const ns = this.namespaces.get(tunnel.interface.namespace);
        if (ns) {
            ns.removeInterface(tunnel.interface.name);
        }
        return this.tunnels.delete(name);
    }
    /**
     * Get tunnel by name
     */
    getTunnel(name) {
        return this.tunnels.get(name);
    }
    /**
     * Get all tunnels
     */
    getAllTunnels() {
        return Array.from(this.tunnels.values());
    }
    /**
     * Get tunnels by namespace
     */
    getTunnelsByNamespace(namespace) {
        return this.getAllTunnels().filter((t) => t.interface.namespace === namespace);
    }
    /**
     * Add VETH pair
     */
    addVETHPair(id, vethPair) {
        if (this.vethPairs.has(id)) {
            throw new Error(`VETH pair ${id} already exists`);
        }
        this.vethPairs.set(id, vethPair);
        // Add both interfaces to their respective namespaces
        const ns0 = this.namespaces.get(vethPair.veth0.namespace);
        const ns1 = this.namespaces.get(vethPair.veth1.namespace);
        if (ns0)
            ns0.addInterface(vethPair.veth0);
        if (ns1)
            ns1.addInterface(vethPair.veth1);
    }
    /**
     * Remove VETH pair
     */
    async removeVETHPair(id) {
        const vethPair = this.vethPairs.get(id);
        if (!vethPair) {
            return false;
        }
        // Bring both interfaces down
        await vethPair.down();
        // Remove interfaces from namespaces
        const ns0 = this.namespaces.get(vethPair.veth0.namespace);
        const ns1 = this.namespaces.get(vethPair.veth1.namespace);
        if (ns0)
            ns0.removeInterface(vethPair.veth0.name);
        if (ns1)
            ns1.removeInterface(vethPair.veth1.name);
        return this.vethPairs.delete(id);
    }
    /**
     * Get VETH pair by ID or interface name
     */
    getVETHPair(idOrName) {
        // Try by ID first
        const byId = this.vethPairs.get(idOrName);
        if (byId)
            return byId;
        // Try by interface name
        for (const vethPair of this.vethPairs.values()) {
            if (vethPair.veth0.name === idOrName || vethPair.veth1.name === idOrName) {
                return vethPair;
            }
        }
        return undefined;
    }
    /**
     * Get all VETH pairs
     */
    getAllVETHPairs() {
        return Array.from(this.vethPairs.values());
    }
    /**
     * Generate next tunnel ID
     */
    getNextTunnelId() {
        return (this.nextTunnelId++).toString();
    }
    // ═══════════════════════════════════════════════════════════════
    // Bridge Management
    // ═══════════════════════════════════════════════════════════════
    /**
     * Add bridge to network stack
     */
    addBridge(name, bridge) {
        if (this.bridges.has(name)) {
            throw new Error(`Bridge ${name} already exists`);
        }
        this.bridges.set(name, bridge);
        // Add bridge interface to namespace
        const ns = this.namespaces.get(bridge.interface.namespace);
        if (ns) {
            ns.addInterface(bridge.interface);
        }
    }
    /**
     * Remove bridge from network stack
     */
    async removeBridge(name) {
        const bridge = this.bridges.get(name);
        if (!bridge) {
            return false;
        }
        // Bring bridge down
        await bridge.down();
        // Remove interface from namespace
        const ns = this.namespaces.get(bridge.interface.namespace);
        if (ns) {
            ns.removeInterface(bridge.interface.name);
        }
        return this.bridges.delete(name);
    }
    /**
     * Get bridge by name
     */
    getBridge(name) {
        return this.bridges.get(name);
    }
    /**
     * Get all bridges
     */
    getAllBridges() {
        return Array.from(this.bridges.values());
    }
    /**
     * Get bridges by namespace
     */
    getBridgesByNamespace(namespace) {
        return this.getAllBridges().filter((b) => b.interface.namespace === namespace);
    }
}
