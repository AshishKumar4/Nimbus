import { ProcessRegistry } from '../shell/ProcessRegistry.js';
import { NetworkStack } from './network/NetworkStack.js';
import { PortBridge } from './network/PortBridge.js';
export interface VirtualRequest {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: string;
}
export interface VirtualResponse {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
}
export type VirtualRequestHandler = (req: VirtualRequest, res: VirtualResponse) => void;
export type LoopbackRouter = (port: number, request: Request) => Promise<Response | null>;
export { isLoopbackHost } from '../../../_shared/loopback.js';
/**
 * What a session's processes share besides their filesystem (which is
 * ProcessFiles'): the process table, the virtual ports and the network stack,
 * whose resolver starts from the default /etc/hosts.
 */
export declare class Kernel {
    portRegistry: Map<number, VirtualRequestHandler>;
    routeLoopback?: LoopbackRouter;
    portBridge: PortBridge;
    processRegistry: ProcessRegistry;
    networkStack: NetworkStack;
    constructor();
    getDefaultEnv(): Record<string, string>;
}
//# sourceMappingURL=index.d.ts.map