/**
 * The filesystem interface: one small required core, and optional
 * capabilities a caller probes for.
 *
 * A backend implements `VFS` over whatever it stores (SQLite, memory, a
 * container, a device). `CompositeVFS` mounts backends into one namespace.
 * Paths are absolute and normalized; a mounted backend sees paths relative
 * to its own root ('/' is the mount point itself).
 *
 * An optional capability is either there or absent, never emulated where the
 * emulation would change its meaning: a compare-and-write done as read,
 * compare, write is not atomic, and a ranged read done as a whole read of a
 * 4 GB file is not a ranged read. A caller without the capability learns
 * that (ENOTSUP) and decides.
 */
import { VfsError } from './vfs-error.js';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
/** Whether anything is at `path`. */
export async function exists(vfs, path) {
    return (await vfs.stat(path)) !== null;
}
/** The file as UTF-8 text. */
export async function readText(vfs, path) {
    return decoder.decode(await vfs.readFile(path));
}
/** Write `text` as UTF-8. */
export async function writeText(vfs, path, text, options) {
    await vfs.writeFile(path, encoder.encode(text), options);
}
/** File type bits of a mode (st_mode & S_IFMT). */
export const S_IFMT = 0o170000;
export const S_IFREG = 0o100000;
export const S_IFDIR = 0o040000;
export const S_IFCHR = 0o020000;
export const S_IFLNK = 0o120000;
/** True for a character device such as `/dev/zero`, which streams rather than stores. */
export function isCharacterDevice(mode) {
    return mode !== undefined && (mode & S_IFMT) === S_IFCHR;
}
/** The `ls -l` type character for a mode, falling back to the entry's type. */
export function fileTypeChar(mode, type) {
    switch ((mode ?? 0) & S_IFMT) {
        case S_IFCHR: return 'c';
        case S_IFLNK: return 'l';
        case S_IFDIR: return 'd';
        case S_IFREG: return '-';
        default: return type === 'directory' ? 'd' : type === 'symlink' ? 'l' : '-';
    }
}
/** The entry at `path`; ENOENT when nothing is there (for callers that treat absence as an error). */
export async function statOrThrow(vfs, path, options) {
    const stat = await vfs.stat(path, options);
    if (stat === null)
        throw new VfsError('ENOENT', path);
    return stat;
}
/** The entry at `path` itself, a link not followed (lstat); ENOENT when nothing is there. */
export async function lstatOrThrow(vfs, path) {
    return await statOrThrow(vfs, path, { follow: false });
}
/** Whether `path` is a directory (links followed). */
export async function isDirectory(vfs, path) {
    return (await vfs.stat(path))?.type === 'directory';
}
/** Whether `path` is a regular file (links followed). */
export async function isFile(vfs, path) {
    return (await vfs.stat(path))?.type === 'file';
}
/** Whether `path` itself is a symbolic link. */
export async function isSymlink(vfs, path) {
    return (await vfs.stat(path, { follow: false }))?.type === 'symlink';
}
