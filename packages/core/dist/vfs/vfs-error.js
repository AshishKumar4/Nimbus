/**
 * The one filesystem error: a POSIX code callers switch on, the path, and
 * the message a person reads. Every backend throws it, so no caller matches
 * prose.
 */
/** Linux errno numbers, negative as libuv reports them. */
export const VFS_ERRNO = {
    E2BIG: -7, EPERM: -1, ENOENT: -2, EIO: -5, ENXIO: -6, EAGAIN: -11, EACCES: -13, EBUSY: -16, EEXIST: -17,
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
/**
 * An error from a layer that throws `{ code }` errors (the SQLite engine, a
 * process bridge), as a VfsError on `path`; anything without a known code is
 * returned as it is.
 */
export function toVfsError(error, path) {
    if (error instanceof VfsError)
        return error;
    const code = error?.code;
    if (typeof code === 'string' && code in VFS_ERRNO) {
        // The layer's message already names what failed: keep it as it is.
        const message = error instanceof Error ? error.message.replace(new RegExp(`^${code}: `), '') : String(error);
        return new VfsError(code, message, undefined, { cause: error });
    }
    return error;
}
/** strerror(3) for a code: the text GNU coreutils print. */
export const VFS_STRERROR = {
    EPERM: 'Operation not permitted', ENOENT: 'No such file or directory', EIO: 'Input/output error',
    ENXIO: 'No such device or address', EAGAIN: 'Resource temporarily unavailable', EACCES: 'Permission denied',
    EBUSY: 'Device or resource busy', EEXIST: 'File exists', EXDEV: 'Invalid cross-device link',
    ENOTDIR: 'Not a directory', EISDIR: 'Is a directory', EINVAL: 'Invalid argument',
    ENOSPC: 'No space left on device', EROFS: 'Read-only file system', ELOOP: 'Too many levels of symbolic links',
    E2BIG: 'Argument list too long', ENAMETOOLONG: 'File name too long', ENOTEMPTY: 'Directory not empty', ENOTSUP: 'Operation not supported',
    ESTALE: 'Stale file handle',
};
