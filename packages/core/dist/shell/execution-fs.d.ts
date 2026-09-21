import type { NimbusFilesystemAuthority, NimbusFilesystemBinding, RuntimeFsBridge, RuntimeVfsStat, VfsCred } from '../runtime/os-contracts.js';
import { VFS } from '../substrate/lifo/kernel/vfs/index.js';
import type { Stat } from '../substrate/lifo/kernel/vfs/types.js';
export type ShellFilesystem = NimbusFilesystemAuthority | VFS;
export type ExecutionStat = Stat & Partial<Pick<RuntimeVfsStat, 'dev' | 'ino' | 'nlink' | 'atime' | 'uid' | 'gid'>>;
export declare function bindExecutionFs(filesystem: ShellFilesystem, binding: NimbusFilesystemBinding): ExecutionFs;
/** Host-side work over a credentialed lease that is released when the work settles. */
export declare function withHostFilesystem<T>(authority: NimbusFilesystemAuthority, cred: Readonly<VfsCred>, use: (fs: ExecutionFs) => Promise<T>): Promise<T>;
/** Normalizes command I/O without copying files or owning a mount table. */
export declare class ExecutionFs {
    readonly bridge: RuntimeFsBridge | VFS;
    constructor(bridge: RuntimeFsBridge | VFS);
    get local(): VFS | null;
    revision(path?: string): Promise<number>;
    /** Whole-file read that never pins the content in the session LRU. */
    readFileUncached(path: string): Promise<Uint8Array>;
    get authority(): RuntimeFsBridge;
    private probe;
    stat(path: string): Promise<ExecutionStat>;
    lstat(path: string): Promise<ExecutionStat>;
    exists(path: string): Promise<boolean>;
    isDirectory(path: string): Promise<boolean>;
    isFile(path: string): Promise<boolean>;
    isSymlink(path: string): Promise<boolean>;
    readFile(path: string): Promise<Uint8Array>;
    readFileString(path: string): Promise<string>;
    readRange(path: string, offset: number, length: number): Promise<Uint8Array>;
    writeFile(path: string, bytes: string | Uint8Array): Promise<void>;
    writeRange(path: string, offset: number, bytes: Uint8Array): Promise<number>;
    appendFile(path: string, content: string | Uint8Array): Promise<void>;
    readdir(path: string): Promise<import("../substrate/lifo/index.js").Dirent[] | import("../runtime/os-contracts.js").RuntimeVfsDirEntry[]>;
    readdirStat(path: string): Promise<{
        name: string;
        type: import("../substrate/lifo/index.js").FileType;
        size: number;
        ctime: number;
        mtime: number;
        mode: number;
        uid?: number;
        gid?: number;
        mime?: string;
        dev?: number | undefined;
        ino?: number | undefined;
        nlink?: number | undefined;
        atime?: number | undefined;
    }[]>;
    mkdir(path: string, options?: {
        recursive?: boolean;
        mode?: number;
    }): Promise<void>;
    unlink(path: string): Promise<void>;
    rmdir(path: string): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    copyFile(from: string, to: string): Promise<void>;
    remove(path: string, options?: {
        recursive?: boolean;
        force?: boolean;
    }): Promise<void>;
    rmdirRecursive(path: string): Promise<void>;
    realpath(path: string): Promise<string>;
    readlink(path: string): Promise<string>;
    symlink(target: string, path: string): Promise<void>;
    truncate(path: string, size: number): Promise<void>;
    chmod(path: string, mode: number): Promise<void>;
    chown(path: string, uid: number | null, gid: number | null): Promise<void>;
    access(path: string, mode: number): Promise<void>;
    utimes(path: string, atime: number, mtime: number): Promise<void>;
    touch(path: string): Promise<void>;
}
//# sourceMappingURL=execution-fs.d.ts.map