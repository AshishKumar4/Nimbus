import type { RouteEntry } from './types.js';
/**
 * Routing table for IP packet routing
 * Implements longest prefix matching
 */
export declare class RoutingTable {
    private routes;
    /**
     * Add route to table
     */
    addRoute(route: RouteEntry): void;
    /**
     * Remove route from table
     */
    removeRoute(destination: string, iface: string, namespace: string): boolean;
    /**
     * Lookup route for destination IP
     * Uses longest prefix matching
     */
    lookup(ip: string, namespace: string): RouteEntry | null;
    /**
     * Get all routes for namespace
     */
    getRoutes(namespace?: string): RouteEntry[];
    /**
     * Clear all routes
     */
    clear(namespace?: string): void;
    /**
     * Check if IP matches route destination
     * Returns prefix length if match, null otherwise
     */
    private matchesRoute;
    /**
     * Convert IPv4 address to bit array
     */
    private ipToBits;
    /**
     * Sort routes by prefix length (longest first) then metric
     */
    private sortRoutes;
    /**
     * Get prefix length from CIDR notation
     */
    private getPrefixLength;
    /**
     * Format routing table for display
     */
    toString(namespace?: string): string;
    /**
     * Convert CIDR to netmask
     */
    private cidrToNetmask;
}
//# sourceMappingURL=RoutingTable.d.ts.map