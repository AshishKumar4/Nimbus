import type { ExecutionFs as VFS } from '../../../shell/execution-fs.js';
export interface PackageInfo {
    name: string;
    url: string;
    installedAt: number;
    size: number;
}
export declare class PackageManager {
    private vfs;
    constructor(vfs: VFS);
    private readMetadata;
    private writeMetadata;
    private ensureDirs;
    install(url: string, name?: string): Promise<PackageInfo>;
    remove(name: string): Promise<boolean>;
    list(): Promise<PackageInfo[]>;
    info(name: string): Promise<PackageInfo | null>;
}
//# sourceMappingURL=PackageManager.d.ts.map