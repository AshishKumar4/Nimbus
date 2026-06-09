import type { VirtualRequestHandler } from '../index.js';
/**
 * Port Bridge - Bridges virtual ports to real host network
 * Allows accessing virtual HTTP servers from the host machine
 */
export declare class PortBridge {
    private portRegistry;
    private forwardedPorts;
    constructor(portRegistry: Map<number, VirtualRequestHandler>);
    /**
     * Forward a virtual port to the real host network
     * Returns a URL that can be accessed from the host browser
     */
    forward(virtualPort: number): string;
    /**
     * Stop forwarding a port
     */
    unforward(virtualPort: number): boolean;
    /**
     * Handle a real HTTP request and forward to virtual port
     */
    handleRequest(realPort: number, method: string, path: string, headers: Record<string, string>, body: string): Promise<{
        statusCode: number;
        headers: Record<string, string>;
        body: string;
    }>;
    /**
     * Get all forwarded ports
     */
    getForwardedPorts(): Array<{
        virtual: number;
        real: number;
    }>;
    /**
     * Create a simple browser-accessible proxy endpoint
     * Returns HTML with a link to access the virtual server
     */
    createAccessPage(virtualPort: number): string;
    /**
     * Find an available real port number
     */
    private findAvailablePort;
}
//# sourceMappingURL=PortBridge.d.ts.map