export const ErrorCode = {
    ENOENT: 'ENOENT',
    EEXIST: 'EEXIST',
    ENOTDIR: 'ENOTDIR',
    EISDIR: 'EISDIR',
    ENOTEMPTY: 'ENOTEMPTY',
    EINVAL: 'EINVAL',
};
export class VFSError extends Error {
    code;
    constructor(code, message) {
        super(`${code}: ${message}`);
        this.code = code;
        this.name = 'VFSError';
    }
}
