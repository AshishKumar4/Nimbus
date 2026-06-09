import type { VFS } from './vfs/index.js';
import type { CommandRegistry } from '../commands/registry.js';
export interface ServiceInfo {
    name: string;
    description: string;
    loaded: boolean;
    active: 'active' | 'inactive' | 'failed' | 'activating';
    sub: 'running' | 'dead' | 'exited' | 'start-pre' | 'auto-restart';
    enabled: boolean;
    pid: number | null;
    startedAt: number | null;
    exitCode: number | null;
}
export declare class ServiceManager {
    private vfs;
    private registry;
    private defaultEnv;
    private services;
    private unitCache;
    constructor(vfs: VFS, registry: CommandRegistry, defaultEnv: Record<string, string>);
    /** Reload unit files from disk */
    daemonReload(): void;
    private resolveUnit;
    private baseName;
    start(name: string): Promise<{
        ok: boolean;
        message: string;
    }>;
    private handleServiceExit;
    stop(name: string): Promise<{
        ok: boolean;
        message: string;
    }>;
    restart(name: string): Promise<{
        ok: boolean;
        message: string;
    }>;
    status(name: string): ServiceInfo;
    enable(name: string): {
        ok: boolean;
        message: string;
    };
    disable(name: string): {
        ok: boolean;
        message: string;
    };
    private isEnabled;
    listUnits(): ServiceInfo[];
    bootEnabledServices(): Promise<void>;
}
//# sourceMappingURL=ServiceManager.d.ts.map