/**
 * `st_mode` file-type bits. `Stat.type` only distinguishes file from
 * directory, so anything finer — a character device, a symlink — is carried
 * in the mode, exactly as Unix does it. `ls -l` and `stat` read the leading
 * type character from here.
 */
export const S_IFMT = 0o170000;
export const S_IFREG = 0o100000;
export const S_IFDIR = 0o040000;
export const S_IFCHR = 0o020000;
export const S_IFLNK = 0o120000;
/** True for a character device such as `/dev/zero`, which streams rather than stores. */
export function isCharacterDevice(mode) {
    return (mode & S_IFMT) === S_IFCHR;
}
/** The `ls -l` type character for a mode, falling back to the coarse `Stat.type`. */
export function fileTypeChar(mode, type) {
    switch (mode & S_IFMT) {
        case S_IFCHR: return 'c';
        case S_IFLNK: return 'l';
        case S_IFDIR: return 'd';
        case S_IFREG: return '-';
        default: return type === 'directory' ? 'd' : '-';
    }
}
export const ErrorCode = {
    ENOENT: 'ENOENT',
    EEXIST: 'EEXIST',
    ENOTDIR: 'ENOTDIR',
    EISDIR: 'EISDIR',
    ENOTEMPTY: 'ENOTEMPTY',
    EINVAL: 'EINVAL',
    EXDEV: 'EXDEV',
};
export class VFSError extends Error {
    code;
    constructor(code, message) {
        super(`${code}: ${message}`);
        this.code = code;
        this.name = 'VFSError';
    }
}
