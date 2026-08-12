/**
 * Network namespace implementation
 * Provides network isolation like Linux network namespaces
 */
export class NetworkNamespace {
    id;
    name;
    interfaces;
    routes;
    sockets;
    arpTable;
    nextFd = 3; // Start from 3 (0=stdin, 1=stdout, 2=stderr)
    constructor(id, name) {
        this.id = id;
        this.name = name;
        this.interfaces = new Map();
        this.routes = [];
        this.sockets = new Map();
        this.arpTable = new Map();
    }
    /**
     * Add interface to namespace
     */
    addInterface(iface) {
        this.interfaces.set(iface.name, iface);
    }
    /**
     * Remove interface from namespace
     */
    removeInterface(name) {
        return this.interfaces.delete(name);
    }
    /**
     * Get interface by name
     */
    getInterface(name) {
        return this.interfaces.get(name);
    }
    /**
     * Get all interfaces
     */
    getAllInterfaces() {
        return Array.from(this.interfaces.values());
    }
    /**
     * Add route
     */
    addRoute(route) {
        // Update namespace to match this namespace
        route.namespace = this.id;
        this.routes.push(route);
    }
    /**
     * Remove route
     */
    removeRoute(destination, iface) {
        const initialLength = this.routes.length;
        this.routes = this.routes.filter((r) => !(r.destination === destination && r.interface === iface));
        return this.routes.length < initialLength;
    }
    /**
     * Get all routes
     */
    getRoutes() {
        return [...this.routes];
    }
    /**
     * Add socket to namespace
     */
    addSocket(socket) {
        this.sockets.set(socket.fd, socket);
    }
    /**
     * Remove socket from namespace
     */
    removeSocket(fd) {
        return this.sockets.delete(fd);
    }
    /**
     * Get socket by file descriptor
     */
    getSocket(fd) {
        return this.sockets.get(fd);
    }
    /**
     * Get all sockets
     */
    getAllSockets() {
        return Array.from(this.sockets.values());
    }
    /**
     * Allocate file descriptor for new socket
     */
    allocateFd() {
        return this.nextFd++;
    }
    /**
     * Add ARP entry (IP -> MAC mapping)
     */
    addArpEntry(ip, mac) {
        this.arpTable.set(ip, mac);
    }
    /**
     * Remove ARP entry
     */
    removeArpEntry(ip) {
        return this.arpTable.delete(ip);
    }
    /**
     * Lookup MAC address for IP
     */
    arpLookup(ip) {
        return this.arpTable.get(ip);
    }
    /**
     * Get all ARP entries
     */
    getArpTable() {
        return new Map(this.arpTable);
    }
    /**
     * Clear all ARP entries
     */
    clearArpTable() {
        this.arpTable.clear();
    }
    /**
     * Clone namespace (for creating new network namespace)
     */
    clone(newId, newName) {
        const ns = new NetworkNamespace(newId, newName);
        // Copy routes (interfaces are not cloned, must be moved/created separately)
        for (const route of this.routes) {
            ns.addRoute({ ...route });
        }
        return ns;
    }
    /**
     * Get namespace statistics
     */
    getStats() {
        return {
            interfaces: this.interfaces.size,
            routes: this.routes.length,
            sockets: this.sockets.size,
            arpEntries: this.arpTable.size,
        };
    }
}
