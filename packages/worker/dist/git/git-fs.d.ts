/** An inode as a backend reports it. */
export interface GitFsStat {
    type: 'file' | 'dir' | 'symlink';
    size: number;
    /** Permission bits. */
    mode: number;
    mtimeMs: number;
    ctimeMs: number;
    atimeMs: number;
    uid: number;
    gid: number;
    dev: number;
    ino: number;
    nlink: number;
}
/**
 * What the adapter asks of a backend, at a normalized path (`filepath` is
 * the caller's, for errors). Each keeps its own write rules: the session's
 * writes a worktree as git's checkout does; the facet's buffers waves.
 */
export interface GitFsBackend {
    /** `path`'s inode, through a final link when `follow`; null when there is none. */
    stat(path: string, follow: boolean): Promise<GitFsStat | null>;
    /** `path`'s bytes; null when there is no file. */
    readFile(path: string): Promise<Uint8Array | null>;
    /** `executable` when the caller's mode has an execute bit. */
    writeFile(path: string, data: Uint8Array | string, executable: boolean): Promise<void>;
    unlink(path: string, filepath: string): Promise<void>;
    readdir(path: string, filepath: string): Promise<string[]>;
    mkdir(path: string): Promise<void>;
    /** rmdir(2), or with `recursive` the whole subtree. */
    rmdir(path: string, filepath: string, recursive: boolean): Promise<void>;
    symlink(target: string, path: string): Promise<void>;
    readlink(path: string, filepath: string): Promise<string>;
}
type FsErrorCode = 'ENOENT' | 'ENOTDIR' | 'EISDIR' | 'ENOTEMPTY' | 'EINVAL' | 'EIO' | 'ELOOP';
/** Node's error for `code` at `filepath`, as `syscall` reports it. */
export declare function fsError(code: FsErrorCode, syscall: string, filepath: string, detail?: string): Error & {
    code: string;
    errno: number;
};
/** cf-git's `fs` over `backend`, with `packs` (pack/store.ts) its packs seam. */
export declare function createGitFs<P>(backend: GitFsBackend, packs: P): {
    packs: P;
    promises: {
        readFile(filepath: string, options?: unknown): Promise<Uint8Array | string>;
        writeFile(filepath: string, data: Uint8Array | ArrayBuffer | string, options?: {
            mode?: unknown;
        }): Promise<void>;
        unlink: (filepath: string) => Promise<void>;
        readdir: (filepath: string) => Promise<string[]>;
        mkdir: (filepath: string) => Promise<void>;
        rmdir: (filepath: string, options?: {
            recursive?: boolean;
        }) => Promise<void>;
        rm: (filepath: string) => Promise<void>;
        stat: (filepath: string) => Promise<{
            isFile: () => boolean;
            isDirectory: () => boolean;
            isSymbolicLink: () => boolean;
            size: number;
            mode: number;
            mtimeMs: number;
            mtime: Date;
            ctimeMs: number;
            ctime: Date;
            atimeMs: number;
            atime: Date;
            uid: number;
            gid: number;
            dev: number;
            ino: number;
            nlink: number;
            type: "symlink" | "file" | "dir";
        }>;
        lstat: (filepath: string) => Promise<{
            isFile: () => boolean;
            isDirectory: () => boolean;
            isSymbolicLink: () => boolean;
            size: number;
            mode: number;
            mtimeMs: number;
            mtime: Date;
            ctimeMs: number;
            ctime: Date;
            atimeMs: number;
            atime: Date;
            uid: number;
            gid: number;
            dev: number;
            ino: number;
            nlink: number;
            type: "symlink" | "file" | "dir";
        }>;
        chmod(): Promise<void>;
        symlink: (target: string, filepath: string) => Promise<void>;
        readlink: (filepath: string) => Promise<string>;
    };
};
export {};
//# sourceMappingURL=git-fs.d.ts.map