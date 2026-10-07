/** sqlite-vfs.ts ROUTED_FILE_MAX: the largest file a wave writes to a mount. */
export const MOUNT_WAVE_FILE_MAX = 4 * 1024 * 1024;
/** One write's bytes: well inside what one RPC carries. */
const WRITE_PIECE_BYTES = 1024 * 1024;
/**
 * A write git would have failed, and what git says (its lines, `error:` and
 * `fatal:` alike): the clone fails with them.
 */
export class GitWriteFailure extends Error {
    lines;
    constructor(lines) {
        super(lines.trimEnd());
        this.lines = lines;
        this.name = 'GitWriteFailure';
    }
}
/** strerror's words for the codes a write here can fail with (glibc's). */
const STRERROR = {
    EEXIST: 'File exists', EACCES: 'Permission denied', EPERM: 'Operation not permitted', ENOSPC: 'No space left on device',
    EFBIG: 'File too large', ENOENT: 'No such file or directory', EROFS: 'Read-only file system', EISDIR: 'Is a directory',
    ENOTDIR: 'Not a directory', EBUSY: 'Device or resource busy', ENOTSUP: 'Operation not supported', EIO: 'Input/output error',
    EXDEV: 'Invalid cross-device link', ENAMETOOLONG: 'File name too long', ELOOP: 'Too many levels of symbolic links',
};
/** A failure's errno code: its `code`, or the "CODE:" its message starts with (what crosses an RPC). */
function errnoCode(error) {
    const code = error && typeof error === 'object' ? error.code : undefined;
    if (typeof code === 'string')
        return code;
    const message = error instanceof Error ? error.message : String(error);
    const colon = message.indexOf(':');
    const head = colon < 0 ? '' : message.slice(0, colon);
    return head.length > 1 && head.length < 16 && head[0] === 'E' && head.toUpperCase() === head ? head : undefined;
}
/** strerror of `error`'s code, or its own message. */
function strerror(error) {
    const code = errnoCode(error);
    return (code !== undefined ? STRERROR[code] : undefined) ?? (error instanceof Error ? error.message : String(error));
}
/**
 * `api` within a phase's `deadline` (ms since the epoch; null for none): a
 * call past it is refused, but a close or an unlink, which clean up what a
 * call before it started.
 */
export function withinDeadline(api, deadline) {
    if (deadline === null)
        return api;
    const admit = (call) => Date.now() >= deadline ? Promise.reject(new Error('git passed its phase deadline')) : call();
    return {
        mkdir: (path, options) => admit(() => api.mkdir(path, options)),
        unlink: (path) => api.unlink(path),
        fsOpen: (path, flags) => admit(() => api.fsOpen(path, flags)),
        fsWrite: (id, offset, bytes) => admit(() => api.fsWrite(id, offset, bytes)),
        fsFstat: (id) => admit(() => api.fsFstat(id)),
        fsClose: (id) => api.fsClose(id),
        rename: (from, to) => admit(() => api.rename(from, to)),
    };
}
/** `bytes` written whole through the open file `id`, then its stat; the file closed whatever happens. */
async function writeWhole(api, id, bytes) {
    try {
        for (let offset = 0; offset < bytes.byteLength; offset += WRITE_PIECE_BYTES) {
            await api.fsWrite(id, offset, bytes.subarray(offset, Math.min(bytes.byteLength, offset + WRITE_PIECE_BYTES)));
        }
        return await api.fsFstat(id);
    }
    finally {
        await api.fsClose(id);
    }
}
/**
 * entry.c write_entry of a file at `at` (the worktree's `name`, as git names
 * it): its directory made, the old entry unlinked, then created exclusively
 * with `mode`, written whole, closed. Answers its stat.
 */
export async function writeEntry(api, at, name, mode, bytes) {
    await api.mkdir(at.slice(0, at.lastIndexOf('/')), { recursive: true });
    try {
        await api.unlink(at);
    }
    catch (error) {
        if (errnoCode(error) !== 'ENOENT')
            throw new GitWriteFailure(`error: unable to unlink old '${name}': ${strerror(error)}\nfatal: unable to checkout working tree\n`);
    }
    let handle;
    try {
        handle = await api.fsOpen(at, { write: true, create: true, exclusive: true, mode });
    }
    catch (error) {
        throw new GitWriteFailure(`error: unable to create file ${name}: ${strerror(error)}\nfatal: unable to checkout working tree\n`);
    }
    try {
        return await writeWhole(api, handle.id, bytes);
    }
    catch {
        throw new GitWriteFailure(`error: unable to write file ${name}\nfatal: unable to checkout working tree\n`);
    }
}
/**
 * A file at `at` replaced as a program replaces one (fetch's packs on a
 * mount): its directory made, the old one unlinked, then created
 * exclusively with `mode`, written whole, closed. Its failures are the
 * file API's. Answers its stat.
 */
export async function replaceFile(api, at, mode, bytes) {
    await api.mkdir(at.slice(0, at.lastIndexOf('/')), { recursive: true });
    try {
        await api.unlink(at);
    }
    catch (error) {
        if (errnoCode(error) !== 'ENOENT')
            throw error;
    }
    const handle = await api.fsOpen(at, { write: true, create: true, exclusive: true, mode });
    return await writeWhole(api, handle.id, bytes);
}
/**
 * lockfile.c's write of the index at `at`: index.lock created exclusively
 * (one there already is git's "Unable to create"), written whole, closed,
 * renamed over the index; our own lock removed if any of that fails.
 * Answers the index's stat.
 */
export async function writeLockedIndex(api, at, bytes) {
    const lock = at + '.lock';
    let handle;
    try {
        handle = await api.fsOpen(lock, { write: true, create: true, exclusive: true, mode: 0o644 });
    }
    catch (error) {
        const code = errnoCode(error);
        throw new GitWriteFailure(code === 'EEXIST'
            ? `fatal: Unable to create '${lock}': ${strerror(error)}.\n\n`
                + 'Another git process seems to be running in this repository, e.g.\n'
                + "an editor opened by 'git commit'. Please make sure all processes\n"
                + 'are terminated then try again. If it still fails, a git process\n'
                + 'may have crashed in this repository earlier:\n'
                + 'remove the file manually to continue.\n'
            : `fatal: Unable to create '${lock}': ${strerror(error)}\n`);
    }
    try {
        const stat = await writeWhole(api, handle.id, bytes);
        await api.rename(lock, at);
        return stat;
    }
    catch {
        // Ours alone: it was created exclusively.
        try {
            await api.unlink(lock);
        }
        catch { /* gone already */ }
        throw new GitWriteFailure('fatal: unable to write new index file\n');
    }
}
/**
 * `writer` (rooted at `dir`, a namespace path on a mount), with each file
 * over a wave's mount limit, and the index of any size, written through
 * `api` instead, its receipt to `onReceipts`.
 */
export function mountWriter(writer, api, dir, onReceipts) {
    const root = dir.replace(/\/+$/, '');
    return {
        async file(path, mode, bytes) {
            const index = path === '.git/index';
            if (!index && bytes.byteLength <= MOUNT_WAVE_FILE_MAX)
                return await writer.file(path, mode, bytes);
            // What the waves hold before it (its directory among them) lands first.
            await writer.flush();
            const at = root + '/' + path;
            const stat = index ? await writeLockedIndex(api, at, bytes) : await writeEntry(api, at, path, mode, bytes);
            onReceipts?.([{
                    path: at.replace(/^\/+/, ''),
                    ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, uid: stat.uid, gid: stat.gid, dev: stat.dev,
                }]);
        },
        symlink: (path, target) => writer.symlink(path, target),
        directory: (path) => writer.directory(path),
        remove: (path, directory) => writer.remove(path, directory),
        setPin: (path, text, durable) => writer.setPin(path, text, durable),
        flush: () => writer.flush(),
    };
}
