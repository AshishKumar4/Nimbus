export { VFS } from './VFS.js';
export { VFSError, ErrorCode } from './types.js';
export { S_IFMT, S_IFREG, S_IFDIR, S_IFCHR, S_IFLNK, isCharacterDevice, fileTypeChar, } from './types.js';
export { NativeFsProvider } from './providers/NativeFsProvider.js';
export { getMimeType, getFileCategory, isBinaryMime } from '../../utils/mime.js';
