import type { VfsCred } from '../../../../runtime/os-contracts.js';
/**
 * What a stat can report.
 *
 * `symlink` is here because a mounted provider can return one — the durable
 * filesystem models symlinks — and the in-memory tree simply never produces
 * it. Leaving it out did not make symlinks go away; it made the one mount
 * that has them require a cast at every call site.
 */
export type FileType = 'file' | 'directory' | 'symlink';
export type VFSEventType = 'create' | 'modify' | 'delete' | 'rename';
export interface VFSWatchEvent {
    type: VFSEventType;
    path: string;
    oldPath?: string;
    fileType: FileType;
}
export type VFSWatchListener = (event: VFSWatchEvent) => void;
export interface ChunkRef {
    hash: string;
    size: number;
}
export interface INode {
    type: FileType;
    name: string;
    data: Uint8Array;
    children: Map<string, INode>;
    ctime: number;
    mtime: number;
    mode: number;
    mime?: string;
    blobRef?: string;
    chunks?: ChunkRef[];
    storedSize?: number;
}
/**
 * `st_mode` file-type bits. `Stat.type` only distinguishes file from
 * directory, so anything finer — a character device, a symlink — is carried
 * in the mode, exactly as Unix does it. `ls -l` and `stat` read the leading
 * type character from here.
 */
export declare const S_IFMT = 61440;
export declare const S_IFREG = 32768;
export declare const S_IFDIR = 16384;
export declare const S_IFCHR = 8192;
export declare const S_IFLNK = 40960;
/** True for a character device such as `/dev/zero`, which streams rather than stores. */
export declare function isCharacterDevice(mode: number): boolean;
/** The `ls -l` type character for a mode, falling back to the coarse `Stat.type`. */
export declare function fileTypeChar(mode: number, type: FileType): string;
export interface Stat {
    type: FileType;
    size: number;
    ctime: number;
    mtime: number;
    mode: number;
    uid?: number;
    gid?: number;
    mime?: string;
}
export interface Dirent {
    name: string;
    type: FileType;
}
export declare const ErrorCode: {
    readonly ENOENT: "ENOENT";
    readonly EEXIST: "EEXIST";
    readonly ENOTDIR: "ENOTDIR";
    readonly EISDIR: "EISDIR";
    readonly ENOTEMPTY: "ENOTEMPTY";
    readonly EINVAL: "EINVAL";
    readonly EXDEV: "EXDEV";
};
export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];
export interface VirtualProvider {
    readFile(subpath: string): Uint8Array;
    readFileString(subpath: string): string;
    /**
     * Read at most `length` bytes at `offset` without materialising the whole
     * file. Short reads are legal (read(2) semantics) — callers must loop until
     * they get what they need or an empty result signals EOF. Providers that
     * cannot serve a slice cheaply omit this; `VFS.readRange` then slices a
     * whole-file read for them.
     */
    readRange?(subpath: string, offset: number, length: number): Uint8Array;
    writeFile?(subpath: string, content: string | Uint8Array): void;
    exists(subpath: string): boolean;
    stat(subpath: string): Stat;
    readdir(subpath: string): Dirent[];
    access?(subpath: string, mode: number): void;
    as?(cred: VfsCred): VirtualProvider;
}
export interface MountProvider extends VirtualProvider {
    writeFile(subpath: string, content: string | Uint8Array): void;
    /**
     * Write `bytes` at `offset`, growing the file as needed, without rewriting
     * the parts of it the range does not touch. Providers that cannot do this
     * omit it; `VFS.writeRange` then splices via a whole-file read/write.
     */
    writeRange?(subpath: string, offset: number, bytes: Uint8Array): void;
    truncate?(subpath: string, size: number): void;
    unlink(subpath: string): void;
    mkdir(subpath: string, options?: {
        recursive?: boolean;
    }): void;
    rmdir(subpath: string): void;
    rename(oldSubpath: string, newSubpath: string): void;
    copyFile(srcSubpath: string, destSubpath: string): void;
    /** Set permission bits. Providers without chmod reject it (read-only fs). */
    chmod?(subpath: string, mode: number): void;
    chown?(subpath: string, uid: number | null, gid: number | null): void;
}
export declare class VFSError extends Error {
    code: ErrorCodeType;
    constructor(code: ErrorCodeType, message: string);
}
//# sourceMappingURL=types.d.ts.map