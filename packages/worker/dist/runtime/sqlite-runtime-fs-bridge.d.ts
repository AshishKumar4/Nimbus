import type { CredentialedVfs, SqliteVFS } from '../vfs/sqlite-vfs.js';
import type { RuntimeFileHandle, RuntimeFsBridge, RuntimeOpenFlags, RuntimeVfsDirEntry, RuntimeVfsStat, VfsAcquireResult } from './os-contracts.js';
export declare class SqliteRuntimeFsBridge implements RuntimeFsBridge {
    private readonly rawVfs;
    private nextHandleId;
    private handles;
    private legacySymlinks;
    private vfs;
    constructor(vfs: CredentialedVfs, rawVfs: SqliteVFS);
    updateCredential(vfs: CredentialedVfs): void;
    stat(path: string, options?: {
        followSymlinks?: boolean;
    }): Promise<RuntimeVfsStat | null>;
    readFile(path: string, options?: {
        followSymlinks?: boolean;
    }): Promise<Uint8Array | null>;
    writeFile(path: string, bytes: string | Uint8Array, options?: {
        createParents?: boolean;
        expectedRevision?: number;
    }): Promise<number>;
    readRange(path: string, offset: number, length: number, options?: {
        followSymlinks?: boolean;
        cached?: boolean;
    }): Promise<Uint8Array | null>;
    writeRange(path: string, offset: number, bytes: Uint8Array, options?: {
        createParents?: boolean;
        expectedRevision?: number;
    }): Promise<number>;
    appendOnce(path: string, pid: number, writerId: string, moduleId: string, operationId: number, digest: string, bytes: Uint8Array): Promise<number>;
    acknowledgeAppend(pid: number, writerId: string, moduleId: string, operationId: number): Promise<void>;
    truncate(path: string, size: number, options?: {
        followSymlinks?: boolean;
    }): Promise<void>;
    utimes(path: string, atimeMs: number, mtimeMs: number, options?: {
        followSymlinks?: boolean;
    }): Promise<void>;
    chmod(path: string, mode: number): Promise<void>;
    access(path: string, mode: number): Promise<void>;
    chown(path: string, uid: number, gid: number, options?: {
        followSymlinks?: boolean;
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
    revision(path?: string): Promise<number>;
    acquire(epoch: string | null, cursor: number): Promise<VfsAcquireResult>;
    subscribe(path: string, listener: Parameters<NonNullable<RuntimeFsBridge['subscribe']>>[1]): () => void;
    private resolveDataPath;
    private resolveMutationPath;
    private ensureParent;
    private assertParentDirectory;
    private assertExpectedRevision;
    private getHandle;
}
//# sourceMappingURL=sqlite-runtime-fs-bridge.d.ts.map