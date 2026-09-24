import { VFS } from './vfs/index.js';
import { ProcProvider } from './vfs/providers/ProcProvider.js';
import type { PersistenceBackend } from './persistence/backends.js';
import { ProcessRegistry } from '../shell/ProcessRegistry.js';
import { NetworkStack } from './network/NetworkStack.js';
import { PortBridge } from './network/PortBridge.js';
import { ServiceManager } from './ServiceManager.js';
import type { CommandRegistry } from '../commands/registry.js';
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
export declare class Kernel {
    vfs: VFS;
    portRegistry: Map<number, VirtualRequestHandler>;
    routeLoopback?: LoopbackRouter;
    portBridge: PortBridge;
    processRegistry: ProcessRegistry;
    networkStack: NetworkStack;
    serviceManager: ServiceManager | null;
    private persistence;
    /** The /proc provider; a host adds files with `proc.register`. */
    readonly proc: ProcProvider;
    constructor(backend?: PersistenceBackend);
    boot(options?: {
        persist?: boolean;
    }): Promise<void>;
    initFilesystem(): void;
    initServiceManager(registry: CommandRegistry, defaultEnv: Record<string, string>): void;
    bootServices(): Promise<void>;
    getDefaultEnv(): Record<string, string>;
}
//# sourceMappingURL=index.d.ts.map