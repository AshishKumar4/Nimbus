/**
 * The tree a tool works on (a repository, a project, its node_modules), as
 * the calling principal. The namespace decides where it is: a tree on the
 * SQLite engine is read and written through the engine's own credentialed
 * view, whose calls answer at once and whose bulk paths the tool may take;
 * any other tree (a mount, often asynchronous) through the principal's
 * view of the namespace, awaited. Never the engine for a mounted path, and
 * never the kernel for the principal.
 */
import { onEngine } from '@nimbus-sh/core/runtime/process-files.js';
import { VfsError } from '@nimbus-sh/core/vfs/vfs-error.js';
import { normalizeVfsPath } from '@nimbus-sh/core/vfs/path.js';
/**
 * The tree at `dir` as `cred`: the engine's view when the namespace, seen
 * through `view` (the principal's own), puts `dir` on SQLite; otherwise
 * `view` itself in the engine's call shape.
 */
export async function projectTree(filesystem, view, cred, dir) {
    if (await onEngine(view, filesystem.engine, dir))
        return { fs: filesystem.engine.as(cred), onEngine: true };
    return { fs: viewProjectFs(view), onEngine: false };
}
/** `view` in the engine's call shape. */
export function viewProjectFs(view) {
    const at = (key) => '/' + normalizeVfsPath(key);
    const statOf = async (key, follow) => {
        const st = await view.stat(at(key), { follow });
        if (st === null)
            throw new VfsError('ENOENT', 'no such file or directory', at(key));
        return {
            dev: st.dev, ino: st.ino, nlink: st.nlink, type: st.type, size: st.size,
            atime: st.atimeMs, ctime: st.ctimeMs, mtime: st.mtimeMs, mode: st.mode, uid: st.uid, gid: st.gid,
        };
    };
    return {
        exists: (key) => view.exists(at(key)),
        isFile: (key) => view.isFile(at(key)),
        isDirectory: (key) => view.isDirectory(at(key)),
        stat: (key) => statOf(key, true),
        lstat: (key) => statOf(key, false),
        readFile: (key) => view.readFile(at(key)),
        readFileString: (key) => view.readFileString(at(key)),
        readdir: (key) => view.readdir(at(key)),
        writeFile: (key, content, options) => view.writeFile(at(key), content, options),
        mkdir: (key, options) => view.mkdir(at(key), options),
        unlink: (key) => view.unlink(at(key)),
        rmdir: (key) => view.rmdir(at(key)),
        // As the engine's: the whole tree goes, or the call fails.
        removeRecursive: async (key) => {
            await view.remove(at(key), { recursive: true });
            return 1;
        },
        symlink: (target, key) => view.symlink(target, at(key)),
        readlink: (key) => view.readlink(at(key)),
        chmod: (key, mode) => view.chmod(at(key), mode),
    };
}
