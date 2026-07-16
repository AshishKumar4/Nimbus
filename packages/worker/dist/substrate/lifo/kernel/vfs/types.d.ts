export type FileType = 'file' | 'directory';
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
export interface Stat {
    type: FileType;
    size: number;
    ctime: number;
    mtime: number;
    mode: number;
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
};
export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];
export interface VirtualProvider {
    readFile(subpath: string): Uint8Array;
    readFileString(subpath: string): string;
    writeFile?(subpath: string, content: string | Uint8Array): void;
    exists(subpath: string): boolean;
    stat(subpath: string): Stat;
    readdir(subpath: string): Dirent[];
}
export interface MountProvider extends VirtualProvider {
    writeFile(subpath: string, content: string | Uint8Array): void;
    unlink(subpath: string): void;
    mkdir(subpath: string, options?: {
        recursive?: boolean;
    }): void;
    rmdir(subpath: string): void;
    rename(oldSubpath: string, newSubpath: string): void;
    copyFile(srcSubpath: string, destSubpath: string): void;
    /** Set permission bits. Providers without chmod reject it (read-only fs). */
    chmod?(subpath: string, mode: number): void;
}
export declare class VFSError extends Error {
    code: ErrorCodeType;
    constructor(code: ErrorCodeType, message: string);
}
//# sourceMappingURL=types.d.ts.map