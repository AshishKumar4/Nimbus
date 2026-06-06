import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
import type { RuntimeFileHandle, RuntimeFsBridge, RuntimeOpenFlags, RuntimeVfsDirEntry, RuntimeVfsStat } from './os-contracts.js';
export declare class SqliteRuntimeFsBridge implements RuntimeFsBridge {
    private readonly vfs;
    private nextHandleId;
    private handles;
    private symlinks;
    constructor(vfs: SqliteVFS);
    stat(path: string, options?: {
        followSymlinks?: boolean;
    }): Promise<RuntimeVfsStat | null>;
    readFile(path: string, options?: {
        followSymlinks?: boolean;
    }): Promise<Uint8Array | null>;
    writeFile(path: string, bytes: string | Uint8Array, options?: {
        createParents?: boolean;
        expectedRevision?: number;
    }): Promise<void>;
    open(path: string, flags: RuntimeOpenFlags): Promise<RuntimeFileHandle>;
    read(handleId: number, offset: number | null, length: number): Promise<Uint8Array>;
    write(handleId: number, offset: number | null, bytes: Uint8Array): Promise<number>;
    close(handleId: number): Promise<void>;
    readdir(path: string, options?: {
        followSymlinks?: boolean;
    }): Promise<RuntimeVfsDirEntry[]>;
    mkdir(path: string, options?: {
        recursive?: boolean;
        mode?: number;
    }): Promise<void>;
    unlink(path: string): Promise<void>;
    rmdir(path: string): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    readlink(path: string): Promise<string | null>;
    symlink(target: string, path: string): Promise<void>;
    fsync(): Promise<void>;
    revision(): Promise<number>;
    subscribe(path: string, listener: Parameters<NonNullable<RuntimeFsBridge['subscribe']>>[1]): () => void;
    private resolveDataPath;
    private ensureParent;
    private assertExpectedRevision;
    private getHandle;
}
//# sourceMappingURL=sqlite-runtime-fs-bridge.d.ts.map