import type { MountProvider, Stat, Dirent } from '../types.js';
/**
 * Minimal interface for the subset of Node.js `fs` sync methods we need.
 * Consumers pass this in so we avoid a hard dependency on `node:fs`.
 */
export interface NativeFsModule {
    readFileSync(path: string): Uint8Array;
    writeFileSync(path: string, data: string | Uint8Array): void;
    existsSync(path: string): boolean;
    statSync(path: string): {
        isFile(): boolean;
        isDirectory(): boolean;
        size: number;
        mtimeMs: number;
        ctimeMs: number;
        mode: number;
    };
    readdirSync(path: string, options: {
        withFileTypes: true;
    }): Array<{
        name: string;
        isFile(): boolean;
        isDirectory(): boolean;
    }>;
    unlinkSync(path: string): void;
    mkdirSync(path: string, options?: {
        recursive?: boolean;
    }): void;
    rmdirSync(path: string): void;
    renameSync(oldPath: string, newPath: string): void;
    copyFileSync(src: string, dest: string): void;
}
/**
 * A MountProvider that delegates to a native filesystem via sync Node.js APIs.
 *
 * All subpaths are sandboxed to `rootPath` -- any attempt to escape via `..`
 * is rejected with EINVAL.
 */
export declare class NativeFsProvider implements MountProvider {
    private rootPath;
    private fs;
    private readOnly;
    constructor(rootPath: string, fsModule: NativeFsModule, options?: {
        readOnly?: boolean;
    });
    private resolveSafe;
    private assertWritable;
    readFile(subpath: string): Uint8Array;
    readFileString(subpath: string): string;
    exists(subpath: string): boolean;
    stat(subpath: string): Stat;
    readdir(subpath: string): Dirent[];
    writeFile(subpath: string, content: string | Uint8Array): void;
    unlink(subpath: string): void;
    mkdir(subpath: string, options?: {
        recursive?: boolean;
    }): void;
    rmdir(subpath: string): void;
    rename(oldSubpath: string, newSubpath: string): void;
    copyFile(srcSubpath: string, destSubpath: string): void;
    private wrapError;
}
//# sourceMappingURL=NativeFsProvider.d.ts.map