import { DIRENT_TYPES } from './dirent-type.js';
import { S_IFMT } from './vfs.js';
/**
 * A namespace entry's stat in the runtime contract's shape: its identity
 * (dev, ino) is the namespace's, and a mounted backend's entries carry no
 * SQLite revision.
 */
export function runtimeStatOf(stat) {
    // Format bits the backend's mode leaves out are its coarse type's (dirent-type.ts).
    const typeBits = DIRENT_TYPES[stat.type].format;
    const mode = stat.mode === undefined ? typeBits | (stat.type === 'directory' ? 0o755 : 0o644) : (stat.mode & S_IFMT ? stat.mode : typeBits | stat.mode);
    return {
        dev: stat.dev ?? 0, ino: stat.ino ?? 0, nlink: stat.nlink ?? 1, type: stat.type, size: stat.size,
        ctime: stat.ctimeMs ?? stat.mtimeMs, atime: stat.atimeMs ?? stat.mtimeMs, mtime: stat.mtimeMs,
        mode, uid: stat.uid ?? 0, gid: stat.gid ?? 0, revision: typeof stat.revision === 'number' ? stat.revision : 0,
    };
}
