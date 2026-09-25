/**
 * The one filesystem error: a POSIX code callers switch on, the path, and
 * the message a person reads. Every backend throws it, so no caller matches
 * prose.
 */
export type VfsErrorCode = 'EPERM' | 'ENOENT' | 'EIO' | 'ENXIO' | 'EAGAIN' | 'EACCES' | 'EBUSY' | 'EEXIST' | 'EXDEV' | 'ENOTDIR' | 'EISDIR' | 'EINVAL' | 'ENOSPC' | 'EROFS' | 'ELOOP' | 'ENAMETOOLONG' | 'ENOTEMPTY' | 'ENOTSUP' | 'ESTALE';
/** Linux errno numbers, negative as libuv reports them. */
export declare const VFS_ERRNO: Readonly<Record<VfsErrorCode, number>>;
export declare class VfsError extends Error {
    readonly code: VfsErrorCode;
    readonly path?: string | undefined;
    readonly errno: number;
    constructor(code: VfsErrorCode, message: string, path?: string | undefined, options?: ErrorOptions);
}
/** Whether `error` is a filesystem error, and when `code` is given, that one. */
export declare function isVfsError(error: unknown, code?: VfsErrorCode): error is VfsError;
//# sourceMappingURL=vfs-error.d.ts.map