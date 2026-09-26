/**
 * The one filesystem error: a POSIX code callers switch on, the path, and
 * the message a person reads. Every backend throws it, so no caller matches
 * prose.
 */

export type VfsErrorCode =
  | 'EPERM'
  | 'ENOENT'
  | 'EIO'
  | 'ENXIO'
  | 'EAGAIN'
  | 'EACCES'
  | 'EBUSY'
  | 'EEXIST'
  | 'EXDEV'
  | 'ENOTDIR'
  | 'EISDIR'
  | 'EINVAL'
  | 'ENOSPC'
  | 'EROFS'
  | 'ELOOP'
  | 'ENAMETOOLONG'
  | 'ENOTEMPTY'
  | 'ENOTSUP'
  | 'ESTALE';

/** Linux errno numbers, negative as libuv reports them. */
export const VFS_ERRNO: Readonly<Record<VfsErrorCode, number>> = {
  EPERM: -1, ENOENT: -2, EIO: -5, ENXIO: -6, EAGAIN: -11, EACCES: -13, EBUSY: -16, EEXIST: -17,
  EXDEV: -18, ENOTDIR: -20, EISDIR: -21, EINVAL: -22, ENOSPC: -28, EROFS: -30, ELOOP: -40,
  ENAMETOOLONG: -36, ENOTEMPTY: -39, ENOTSUP: -95, ESTALE: -116,
};

export class VfsError extends Error {
  readonly errno: number;

  constructor(readonly code: VfsErrorCode, message: string, readonly path?: string, options?: ErrorOptions) {
    super(`${code}: ${message}${path !== undefined ? `, '${path}'` : ''}`, options);
    this.name = 'VfsError';
    this.errno = VFS_ERRNO[code];
  }
}

/** Whether `error` is a filesystem error, and when `code` is given, that one. */
export function isVfsError(error: unknown, code?: VfsErrorCode): error is VfsError {
  return error instanceof VfsError && (code === undefined || error.code === code);
}

/**
 * An error from a layer that throws `{ code }` errors (the SQLite engine, a
 * process bridge), as a VfsError on `path`; anything without a known code is
 * returned as it is.
 */
export function toVfsError(error: unknown, path: string): unknown {
  if (error instanceof VfsError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code in VFS_ERRNO) {
    // The layer's message already names what failed: keep it as it is.
    const message = error instanceof Error ? error.message.replace(new RegExp(`^${code}: `), '') : String(error);
    return new VfsError(code as VfsErrorCode, message, undefined, { cause: error });
  }
  return error;
}

/** strerror(3) for a code: the text GNU coreutils print. */
export const VFS_STRERROR: Readonly<Record<VfsErrorCode, string>> = {
  EPERM: 'Operation not permitted', ENOENT: 'No such file or directory', EIO: 'Input/output error',
  ENXIO: 'No such device or address', EAGAIN: 'Resource temporarily unavailable', EACCES: 'Permission denied',
  EBUSY: 'Device or resource busy', EEXIST: 'File exists', EXDEV: 'Invalid cross-device link',
  ENOTDIR: 'Not a directory', EISDIR: 'Is a directory', EINVAL: 'Invalid argument',
  ENOSPC: 'No space left on device', EROFS: 'Read-only file system', ELOOP: 'Too many levels of symbolic links',
  ENAMETOOLONG: 'File name too long', ENOTEMPTY: 'Directory not empty', ENOTSUP: 'Operation not supported',
  ESTALE: 'Stale file handle',
};
