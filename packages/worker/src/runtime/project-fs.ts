/**
 * The tree a tool works on (a repository, a project, its node_modules), as
 * the calling principal. The namespace decides where it is: a tree on the
 * SQLite engine is read and written through the engine's own credentialed
 * view, whose calls answer at once and whose bulk paths the tool may take;
 * any other tree (a mount, often asynchronous) through the principal's
 * view of the namespace, awaited. Never the engine for a mounted path, and
 * never the kernel for the principal.
 */

import { onEngine, type ProcessFiles, type ProcessView } from '@nimbus-sh/core/runtime/process-files.js';
import type { VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { CredentialedVfs, VfsStat } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import { VfsError } from '@nimbus-sh/core/vfs/vfs-error.js';
import { normalizeVfsPath } from '@nimbus-sh/core/vfs/path.js';

type ProjectFsOp = 'exists' | 'isFile' | 'isDirectory' | 'stat' | 'lstat' | 'readFile' | 'readFileString' | 'readdir'
  | 'writeFile' | 'mkdir' | 'unlink' | 'rmdir' | 'removeRecursive' | 'symlink' | 'readlink' | 'chmod';

/**
 * A tool's calls on its tree in the engine's call shape (keys with or
 * without the leading slash, a stat that throws when absent, failures
 * thrown), each answered at once or awaited.
 */
export type ProjectFs = {
  [K in ProjectFsOp]: (...args: Parameters<CredentialedVfs[K]>) => ReturnType<CredentialedVfs[K]> | Promise<ReturnType<CredentialedVfs[K]>>;
};

export interface ProjectTree {
  fs: ProjectFs;
  /** Whether the tree is on the engine: the engine's bulk paths serve it. */
  onEngine: boolean;
}

/**
 * The tree at `dir` as `cred`: the engine's view when the namespace, seen
 * through `view` (the principal's own), puts `dir` on SQLite; otherwise
 * `view` itself in the engine's call shape.
 */
export async function projectTree(filesystem: ProcessFiles, view: ProcessView, cred: VfsCred, dir: string): Promise<ProjectTree> {
  if (await onEngine(view, filesystem.engine, dir)) return { fs: filesystem.engine.as(cred), onEngine: true };
  return { fs: viewProjectFs(view), onEngine: false };
}

/** `view` in the engine's call shape. */
export function viewProjectFs(view: ProcessView): ProjectFs {
  const at = (key: string) => '/' + normalizeVfsPath(key);
  const statOf = async (key: string, follow: boolean): Promise<VfsStat> => {
    const st = await view.stat(at(key), { follow });
    if (st === null) throw new VfsError('ENOENT', 'no such file or directory', at(key));
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
