import type { ProcessView } from '../../../runtime/process-files.js';
import type { SandboxFs as ISandboxFs } from './types.js';
import type { SqliteVFS } from '../../../vfs/sqlite-vfs.js';
import type { VfsFileType as FileType } from '../../../vfs/vfs.js';
/**
 * Async wrapper around VFS that matches the industry-standard filesystem API.
 * Sync VFS behind async interface future-proofs for async persistence.
 */
export declare class SandboxFsImpl implements ISandboxFs {
    private vfs;
    private getCwd;
    /** The SQLite filesystem the namespace is rooted at, for storeStats. */
    private store;
    constructor(vfs: ProcessView, getCwd: () => string, 
    /** The SQLite filesystem the namespace is rooted at, for storeStats. */
    store: SqliteVFS);
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
    /** How the session's content store is doing (its diagnostic; nothing in it is per-user). */
    storeStats(): Promise<{
        chunks: number;
        chunkBytes: number;
        contents: number;
        historyRows: number;
        gcQueued: number;
        snapshots: number;
        jobs: number;
        databaseBytes: number;
    }>;
}
//# sourceMappingURL=SandboxFs.d.ts.map