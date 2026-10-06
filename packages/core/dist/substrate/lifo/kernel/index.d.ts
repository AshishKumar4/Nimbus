import { type WorkspaceNetwork } from '../../../_shared/workspace-network.js';
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
export declare function isLoopbackHost(host: string): boolean;
/**
 * What a session's processes share besides their filesystem (which is
 * ProcessFiles'): the process table, the virtual ports and the network stack,
 * whose resolver starts from the default /etc/hosts.
 */
export declare class Kernel {
    portRegistry: Map<number, VirtualRequestHandler>;
    /**
     * The network its commands reach off the box through: the workspace's
     * egress when its host supplied one (NimbusWorkspaceOptions.egress), else
     * the isolate's own. Loopback never goes here: the port registry and
     * `routeLoopback` answer it.
     */
    network: WorkspaceNetwork;
    routeLoopback?: LoopbackRouter;
    portBridge: PortBridge;
    processRegistry: ProcessRegistry;
    networkStack: NetworkStack;
    constructor();
    getDefaultEnv(): Record<string, string>;
}
//# sourceMappingURL=index.d.ts.map