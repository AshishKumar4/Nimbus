/**
 * The one filesystem error: a POSIX code callers switch on, the path, and
 * the message a person reads. Every backend throws it, so no caller matches
 * prose.
 */
/** Linux errno numbers, negative as libuv reports them. */
export const VFS_ERRNO = {
    EPERM: -1, ENOENT: -2, EIO: -5, ENXIO: -6, EAGAIN: -11, EACCES: -13, EBUSY: -16, EEXIST: -17,
    EXDEV: -18, ENOTDIR: -20, EISDIR: -21, EINVAL: -22, ENOSPC: -28, EROFS: -30, ELOOP: -40,
    ENAMETOOLONG: -36, ENOTEMPTY: -39, ENOTSUP: -95, ESTALE: -116,
};
export class VfsError extends Error {
    code;
    path;
    errno;
    constructor(code, message, path, options) {
        super(`${code}: ${message}${path !== undefined ? `, '${path}'` : ''}`, options);
        this.code = code;
        this.path = path;
        this.name = 'VfsError';
        this.errno = VFS_ERRNO[code];
    }
}
/** Whether `error` is a filesystem error, and when `code` is given, that one. */
export function isVfsError(error, code) {
    return error instanceof VfsError && (code === undefined || error.code === code);
}
