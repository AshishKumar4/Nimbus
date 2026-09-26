import type { ProcessView } from '../../../runtime/process-files.js';
import type { SandboxFs as ISandboxFs, SandboxFsReader } from './types.js';
import type { VfsCred } from '../../../runtime/os-contracts.js';
import type { SnapshotInfo, SqliteVFS, VfsExportChunk, VfsExportPage } from '../../../vfs/sqlite-vfs.js';
import type { VfsFileType as FileType } from '../../../vfs/vfs.js';
/**
 * Async wrapper around VFS that matches the industry-standard filesystem API.
 * Sync VFS behind async interface future-proofs for async persistence.
 */
export declare class SandboxFsImpl implements ISandboxFs {
    private vfs;
    private getCwd;
    /** The SQLite filesystem the namespace is rooted at: what snapshots pin. */
    private store;
    /** Who this handle acts as (a snapshot view and restore's check use it). */
    private cred;
    constructor(vfs: ProcessView, getCwd: () => string, 
    /** The SQLite filesystem the namespace is rooted at: what snapshots pin. */
    store: SqliteVFS, 
    /** Who this handle acts as (a snapshot view and restore's check use it). */
    cred: VfsCred);
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
    snapshot(name: string, options?: {
        quiesce?: boolean;
    }): Promise<SnapshotInfo>;
    snapshots(): Promise<SnapshotInfo[]>;
    dropSnapshot(name: string): Promise<{
        dropped: number;
    }>;
    diff(from: string | null, to: string | null, options?: {
        after?: string;
        limit?: number;
    }): Promise<{
        entries: import("../../../vfs/sqlite-vfs.js").VfsDiffEntry[];
        next: string | null;
    }>;
    at(name: string): SandboxFsReader;
    restore(name: string, options?: {
        subtree?: string;
    }): Promise<{
        restored: number;
    }>;
    /**
     * Whether the session user may write every path `restore(name)` would
     * change: the file itself for a rewrite, its parent for a name that
     * appears or goes. The first it may not is EACCES, before any change.
     */
    private assertRestorable;
    exportPage(options: {
        at: string;
        root?: string;
        after?: string | null;
        limit?: number;
    }): Promise<VfsExportPage>;
    exportChunks(hashes: readonly string[]): Promise<{
        chunks: VfsExportChunk[];
        rest: string[];
    }>;
    importPage(dst: string, page: VfsExportPage, chunks?: Iterable<VfsExportChunk>): Promise<{
        imported: number;
        want: string[];
        done: boolean;
    }>;
    pageDigest(options: {
        at: string;
        root?: string;
        after?: string | null;
        limit?: number;
    }): Promise<{
        digest: string;
        next: string | null;
    }>;
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