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
import { isVfsError, syscallError } from './vfs-error.js';
export function isPromise(value) {
    return typeof value === 'object' && value !== null && 'then' in value && typeof value.then === 'function';
}
/** `value`, which a synchronous face answers at once: one that would wait is its caller's fault, never a value. */
export function syncValue(value) {
    if (isPromise(value))
        throw new Error('synchronous filesystem operation returned a promise');
    return value;
}
/** `file`, opened for no one any more: closed, its answer unheard (nothing was written through it). */
export function abandon(file) {
    try {
        const closed = file.close();
        if (isPromise(closed))
            closed.catch(() => { });
    }
    catch {
        // Nothing was written through it.
    }
}
/**
 * Apply `next` to a value that may or may not be a promise, staying
 * synchronous when it is not. (Not `then`: a module exporting `then` is a
 * thenable to `await import()`.)
 */
export function andThen(value, next) {
    return isPromise(value) ? value.then(next) : next(value);
}
const encoder = new TextEncoder();
const decoder = new TextDecoder();
/**
 * What a probe sees at `path`: null when nothing is there, including a path
 * that runs through a file (ENOTDIR is a structural miss, as `test -e`
 * answers it); a denial or any other failure still throws.
 */
async function probe(vfs, path, follow) {
    try {
        return await vfs.stat(path, { follow });
    }
    catch (error) {
        if (isVfsError(error, 'ENOTDIR'))
            return null;
        throw error;
    }
}
/** Whether anything is at `path`. */
export async function exists(vfs, path) {
    return (await probe(vfs, path, true)) !== null;
}
export function readRangeOrWhole(vfs, path, offset, length) {
    const whole = () => {
        const bytes = vfs.readFile(path);
        return 'then' in bytes ? bytes.then((all) => all.slice(offset, offset + length)) : bytes.slice(offset, offset + length);
    };
    if (typeof vfs.readRange !== 'function')
        return whole();
    // By its code: a backend across RPC answers a plain `{ code }` error.
    const unsupported = (error) => {
        if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'ENOTSUP')
            throw error;
        return whole();
    };
    try {
        const range = vfs.readRange(path, offset, length);
        return 'then' in range ? range.catch(unsupported) : range;
    }
    catch (error) {
        return unsupported(error);
    }
}
/** The file as UTF-8 text. */
export async function readText(vfs, path) {
    return decoder.decode(await vfs.readFile(path));
}
/**
 * Exactly `size` bytes from `source`, in one array. `mismatch` is the error
 * for a source that runs past the size or ends short, given how many bytes it
 * had produced.
 */
export async function readDeclaredSource(source, size, mismatch) {
    const data = new Uint8Array(size);
    let received = 0;
    for await (const piece of source) {
        if (received + piece.byteLength > size)
            throw mismatch(received + piece.byteLength);
        data.set(piece, received);
        received += piece.byteLength;
    }
    if (received !== size)
        throw mismatch(received);
    return data;
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
/**
 * The permission bits a copy without preserve asks to make an entry with:
 * the source's, never its set-user-ID or set-group-ID (cp makes a new file,
 * not the source's owner's); a directory keeps its sticky bit. The
 * filesystem it lands on applies its creation policy (umask, a default ACL,
 * a setgid parent's group) as to any entry made there.
 */
export function copiedPermissions(mode, directory) {
    return mode & (directory ? 0o1777 : 0o777);
}
/**
 * The mode copyfile leaves its copy with (keepMode; libuv's fchmod to the
 * source's mode, then the data written): the source's permission bits
 * exactly, but the write of a non-empty copy by a non-root copier clears
 * set-user-ID, and set-group-ID where group-execute is set, as Linux clears
 * them on a write without CAP_FSETID. Whether the copier may set it is
 * chmod's question, asked where the copy lands.
 */
export function copyfileMode(mode, size, uid) {
    const bits = mode & 0o7777;
    if (uid === 0 || size === 0)
        return bits;
    return bits & ~(0o4000 | (bits & 0o010 ? 0o2000 : 0));
}
/**
 * The mode a copy sets once its content is in, from the source's: cp -p's
 * (`preserve`), the source's permission bits, before copyfile's
 * (`keepMode`); null for neither, the mode a creation there makes. One
 * rule for the engine's copy (SqliteVFS copyFile) and the copy between
 * backends (CompositeVFS copyBytes).
 */
export function copySetsMode(mode, size, uid, options) {
    if (options.preserve)
        return mode & 0o7777;
    if (options.keepMode)
        return copyfileMode(mode, size, uid);
    return null;
}
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
        throw syscallError('ENOENT', options?.follow === false ? 'lstat' : 'stat', path);
    return stat;
}
/** The entry at `path` itself, a link not followed (lstat); ENOENT when nothing is there. */
export async function lstatOrThrow(vfs, path) {
    return await statOrThrow(vfs, path, { follow: false });
}
/** Whether `path` is a directory (links followed). */
export async function isDirectory(vfs, path) {
    return (await probe(vfs, path, true))?.type === 'directory';
}
/** Whether `path` is a regular file (links followed). */
export async function isFile(vfs, path) {
    return (await probe(vfs, path, true))?.type === 'file';
}
/** Whether `path` itself is a symbolic link. */
export async function isSymlink(vfs, path) {
    return (await probe(vfs, path, false))?.type === 'symlink';
}
