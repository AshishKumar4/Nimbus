import type { RuntimeFsBridge, RuntimeOpenFlags, RuntimeVfsDirEntry, RuntimeVfsStat } from '../../../runtime/os-contracts.js';
import type { VfsEvent } from '../../../vfs/events.js';
export interface NodeWatch {
    close(): void;
    ref(): void;
    unref(): void;
}
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
    /** Canonical VFS path, following links; native module caches key by it. */
    realpath(path: string): string;
    /** symlink(2): a link at `path` whose text is `target`, as given (a relative one stays relative). */
    symlink(target: string, path: string): void;
    /** readlink(2): the text of the link at `path`; EINVAL where `path` is no link, ENOENT where nothing is there. */
    readlink(path: string): string;
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
    /** chown(2), or lchown(2) when not `follow`: a null side keeps the file's, in the same change. */
    chown(path: string, uid: number | null, gid: number | null, follow: boolean): void;
    /** open(2): the process's descriptor (its DescriptorScope's), whatever filesystem the file is on. */
    open(path: string, flags: RuntimeOpenFlags): number;
    /** read(2), at `position`, or at the descriptor's offset (null), which then moves. */
    read(fd: number, position: number | null, length: number): Uint8Array;
    /** write(2), at `position`, or at the descriptor's offset (null), which then moves; an O_APPEND descriptor's at the end. */
    write(fd: number, position: number | null, data: Uint8Array): number;
    fstat(fd: number): RuntimeVfsStat;
    /** fchown(2): a null side keeps the file's. */
    fchown(fd: number, uid: number | null, gid: number | null): void;
    ftruncate(fd: number, size: number): void;
    fsync(fd: number): void;
    close(fd: number): void;
    /**
     * Each change at `path` or under it the process's namespace shows
     * (RuntimeFsBridge.subscribe), its paths absolute. `persistent` (default
     * true): a guest stays while the watch is open and ref'd, as Node's does.
     */
    watch(path: string, listener: (event: VfsEvent) => void, options?: {
        persistent?: boolean;
    }): NodeWatch;
}
/**
 * The in-process Node interpreter runs `require` synchronously, so it demands
 * the authority's synchronous capability. The demand is made on first use:
 * a program that never touches fs runs on a host without one. What it
 * creates is made with `umask()`, the program's own mask (process.umask).
 */
export declare function synchronousFilesystem(view: {
    process: RuntimeFsBridge;
}, umask: () => number): () => NodeFilesystem;
//# sourceMappingURL=filesystem.d.ts.map