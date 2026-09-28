/**
 * The tree a tool works on (a repository, a project, its node_modules), as
 * the calling principal. A tool reads and writes it through the principal's
 * view of the namespace, which routes a SQLite path to the engine and a
 * mounted one to its mount, awaited. Only the engine's own bulk paths
 * (batched writes, pre-bundling, the dev servers) address the engine
 * directly, at the key `engineKey` resolves.
 */
import { CRED_KERNEL } from '@nimbus-sh/core/runtime/os-contracts.js';
import { engineKey } from '@nimbus-sh/core/runtime/process-files.js';
import { VfsError } from '@nimbus-sh/core/vfs/vfs-error.js';
import { normalizeVfsPath } from '@nimbus-sh/core/vfs/path.js';
/** The principal's `view` in the engine's call shape. */
export function projectFs(view) {
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
/**
 * Hands an artifact a Nimbus tool made as the kernel in a user's project
 * to the owner of the directory that holds it, before the tool, which now
 * acts as its caller, replaces it. Releases before 0.13.2 wrote `dist/`
 * (vite build), `package.json` (npm init, npm-fast) and
 * `node_modules/.nimbus-synthetic` (pre-bundling) as root. The calling tool
 * names the one path it writes; only what is still root's there moves, and
 * only what the directory's owner could already read and replace: a world-
 * readable file with no other name (no hard link), or a world-searchable
 * directory, descending only through directories that move. Never through a
 * link, nothing on a mount, nothing for a root caller, and nothing in a
 * directory root owns.
 */
export async function handKernelArtifact(filesystem, view, cred, path) {
    if (cred.uid === 0)
        return;
    const at = '/' + normalizeVfsPath(path);
    const cut = at.lastIndexOf('/');
    if (cut <= 0)
        return;
    // The directory's links are followed, the artifact's own name never is.
    const dir = await engineKey(view, filesystem.engine, at.slice(0, cut));
    if (dir === null || dir === '')
        return;
    const kernel = filesystem.engine.as(CRED_KERNEL);
    let owner;
    try {
        owner = kernel.stat(dir);
    }
    catch {
        return;
    }
    if (owner.uid === 0 || owner.type !== 'directory')
        return;
    hand(kernel, `${dir}/${at.slice(cut + 1)}`, owner.uid, owner.gid);
}
function hand(kernel, key, uid, gid) {
    let st;
    try {
        st = kernel.lstat(key);
    }
    catch {
        return;
    }
    if (st.uid !== 0)
        return;
    if (st.type === 'file') {
        if (st.nlink === 1 && (st.mode & 0o004) !== 0)
            kernel.chown(key, uid, gid);
        return;
    }
    if (st.type !== 'directory' || (st.mode & 0o005) !== 0o005)
        return;
    kernel.chown(key, uid, gid);
    for (const entry of kernel.readdir(key))
        hand(kernel, `${key}/${entry.name}`, uid, gid);
}
