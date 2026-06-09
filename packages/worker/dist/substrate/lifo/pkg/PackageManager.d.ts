import type { VFS } from '../kernel/vfs/index.js';
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
    remove(name: string): boolean;
    list(): PackageInfo[];
    info(name: string): PackageInfo | null;
}
//# sourceMappingURL=PackageManager.d.ts.map