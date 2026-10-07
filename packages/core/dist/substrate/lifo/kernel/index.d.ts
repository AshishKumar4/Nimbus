import { type WorkspaceNetwork } from '../../../_shared/workspace-network.js';
import { ProcessRegistry } from '../shell/ProcessRegistry.js';
import { DNSResolver } from './dns-resolver.js';
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
/** A resolver holding the default /etc/hosts: the one place `localhost` is named. */
export declare function createHostsResolver(): DNSResolver;
/**
 * What a session's processes share besides their filesystem (which is
 * ProcessFiles'): the process table, the virtual ports and the resolver,
 * which starts from the default /etc/hosts.
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
    processRegistry: ProcessRegistry;
    readonly dns: DNSResolver;
    constructor();
}
//# sourceMappingURL=index.d.ts.map