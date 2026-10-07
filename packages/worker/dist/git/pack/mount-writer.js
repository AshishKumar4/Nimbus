/** sqlite-vfs.ts ROUTED_FILE_MAX: the largest file a wave writes to a mount. */
export const MOUNT_WAVE_FILE_MAX = 4 * 1024 * 1024;
/** One write's bytes: well inside what one RPC carries. */
const WRITE_PIECE_BYTES = 1024 * 1024;
/**
 * A file written at `at` as a program writes one: its directory made
 * (`mkdir -p`), then opened, written in pieces and closed, at `written` (a
 * name beside it, renamed over it after, as git's lock files are) or at
 * `at` itself. Answers its stat.
 */
export async function writeInPlace(api, at, mode, bytes, written = at) {
    await api.mkdir(at.slice(0, at.lastIndexOf('/')), { recursive: true });
    const handle = await api.fsOpen(written, { write: true, create: true, truncate: true, mode });
    let stat;
    try {
        for (let offset = 0; offset < bytes.byteLength; offset += WRITE_PIECE_BYTES) {
            await api.fsWrite(handle.id, offset, bytes.subarray(offset, Math.min(bytes.byteLength, offset + WRITE_PIECE_BYTES)));
        }
        stat = await api.fsFstat(handle.id);
    }
    finally {
        await api.fsClose(handle.id);
    }
    if (written !== at)
        await api.rename(written, at);
    return stat;
}
/**
 * `writer` (rooted at `dir`, a namespace path on a mount), with each file
 * over a wave's mount limit written through `api` instead, its receipt to
 * `onReceipts`.
 */
export function mountWriter(writer, api, dir, onReceipts) {
    const root = dir.replace(/\/+$/, '');
    return {
        async file(path, mode, bytes) {
            if (bytes.byteLength <= MOUNT_WAVE_FILE_MAX)
                return await writer.file(path, mode, bytes);
            // What the waves hold before it (its directory among them) lands first.
            await writer.flush();
            const at = root + '/' + path;
            // git writes its index whole to index.lock, then renames it over the index.
            const stat = await writeInPlace(api, at, mode, bytes, path === '.git/index' ? at + '.lock' : at);
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
