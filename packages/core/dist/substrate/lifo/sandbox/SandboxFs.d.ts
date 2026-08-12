import type { VFS } from '../kernel/vfs/index.js';
import type { SandboxFs as ISandboxFs } from './types.js';
import type { FileType } from '../kernel/vfs/types.js';
/**
 * Async wrapper around VFS that matches the industry-standard filesystem API.
 * Sync VFS behind async interface future-proofs for async persistence.
 */
export declare class SandboxFsImpl implements ISandboxFs {
    private vfs;
    private getCwd;
    constructor(vfs: VFS, getCwd: () => string);
    private resolvePath;
    readFile(path: string): Promise<string>;
    readFile(path: string, encoding: null): Promise<Uint8Array>;
    writeFile(path: string, content: string | Uint8Array): Promise<void>;
    readdir(path: string): Promise<Array<{
        name: string;
        type: FileType;
    }>>;
    stat(path: string): Promise<{
        type: FileType;
        size: number;
        mtime: number;
    }>;
    mkdir(path: string, options?: {
        recursive?: boolean;
    }): Promise<void>;
    rm(path: string, options?: {
        recursive?: boolean;
    }): Promise<void>;
    exists(path: string): Promise<boolean>;
    rename(oldPath: string, newPath: string): Promise<void>;
    cp(src: string, dest: string): Promise<void>;
    writeFiles(files: Array<{
        path: string;
        content: string | Uint8Array;
    }>): Promise<void>;
    /** Directories to skip during export (virtual providers) */
    private static SKIP_DIRS;
    exportSnapshot(): Promise<Uint8Array>;
    importSnapshot(data: Uint8Array): Promise<void>;
}
//# sourceMappingURL=SandboxFs.d.ts.map