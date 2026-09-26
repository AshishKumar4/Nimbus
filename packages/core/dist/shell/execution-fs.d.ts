import type { RuntimeFsBridge, RuntimeVfsStat } from '../runtime/os-contracts.js';
export type ExecutionStat = RuntimeVfsStat;
/**
 * The facet manager's view of a process's bridge (slice N of the cutover
 * moves it to the bridge itself; commands use ProcessFiles' view).
 */
export declare class ExecutionFs {
    readonly bridge: RuntimeFsBridge;
    constructor(bridge: RuntimeFsBridge);
    revision(path?: string): Promise<number>;
    /** Whole-file read that never pins the content in the session LRU. */
    readFileUncached(path: string): Promise<Uint8Array>;
    /** {@link readFileUncached} as the ArrayBuffer a wasm module map takes, so
     *  a runtime image is held once rather than copied into one. */
    readArrayBufferUncached(path: string): Promise<ArrayBuffer>;
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
    /** Ranged read that neither consults nor fills the session's content cache. */
    readRangeUncached(path: string, offset: number, length: number): Promise<Uint8Array>;
    readRange(path: string, offset: number, length: number): Promise<Uint8Array>;
    writeFile(path: string, bytes: string | Uint8Array): Promise<void>;
    writeRange(path: string, offset: number, bytes: Uint8Array): Promise<number>;
    appendFile(path: string, content: string | Uint8Array): Promise<void>;
    readdir(path: string): Promise<import("../runtime/os-contracts.js").RuntimeVfsDirEntry[]>;
    readdirStat(path: string): Promise<{
        name: string;
        dev: number;
        ino: number;
        nlink: number;
        type: import("../runtime/os-contracts.js").RuntimeFileType;
        size: number;
        ctime: number;
        atime: number;
        mtime: number;
        mode: number;
        uid: number;
        gid: number;
        revision: number;
    }[]>;
    mkdir(path: string, options?: {
        recursive?: boolean;
        mode?: number;
    }): Promise<void>;
    unlink(path: string): Promise<void>;
    rmdir(path: string): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    copyFile(from: string, to: string): Promise<void>;
    /** Copy a tree by reference; EXDEV when the bridge cannot (a mount). */
    copyTree(from: string, to: string, options?: {
        preserve?: boolean;
    }): Promise<number>;
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