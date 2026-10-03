import type { RuntimeFsBridge, RuntimeVfsDirEntry, RuntimeVfsStat } from '../../../runtime/os-contracts.js';
/** The synchronous filesystem the in-process Node interpreter's `fs` and `require` read. */
export interface NodeFilesystem {
    readFile(path: string): Uint8Array;
    readFileString(path: string): string;
    writeFile(path: string, data: string | Uint8Array): void;
    appendFile(path: string, data: string | Uint8Array): void;
    exists(path: string): boolean;
    isFile(path: string): boolean;
    isDirectory(path: string): boolean;
    stat(path: string): RuntimeVfsStat;
    /** stat(2) of `path` itself where it names a link (lstat); ENOENT when nothing is there. */
    lstat(path: string): RuntimeVfsStat;
    mkdir(path: string, options?: {
        recursive?: boolean;
        mode?: number;
    }): void;
    readdir(path: string): RuntimeVfsDirEntry[];
    unlink(path: string): void;
    rmdir(path: string): void;
    rmdirRecursive(path: string): void;
    rename(from: string, to: string): void;
    copyFile(from: string, to: string): void;
    chmod(path: string, mode: number): void;
    onChange: (() => void) | undefined;
}
/**
 * The in-process Node interpreter runs `require` synchronously, so it demands
 * the authority's synchronous capability. The demand is made on first use:
 * a program that never touches fs runs on a host without one.
 */
export declare function synchronousFilesystem(view: {
    process: RuntimeFsBridge;
}): () => NodeFilesystem;
//# sourceMappingURL=filesystem.d.ts.map