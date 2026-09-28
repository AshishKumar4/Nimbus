/**
 * The tree a tool works on (a repository, a project, its node_modules), as
 * the calling principal. The namespace decides where it is: a tree on the
 * SQLite engine is read and written through the engine's own credentialed
 * view, whose calls answer at once and whose bulk paths the tool may take;
 * any other tree (a mount, often asynchronous) through the principal's
 * view of the namespace, awaited. Never the engine for a mounted path, and
 * never the kernel for the principal.
 */
import { type ProcessFiles, type ProcessView } from '@nimbus-sh/core/runtime/process-files.js';
import type { VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { CredentialedVfs } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
type ProjectFsOp = 'exists' | 'isFile' | 'isDirectory' | 'stat' | 'lstat' | 'readFile' | 'readFileString' | 'readdir' | 'writeFile' | 'mkdir' | 'unlink' | 'rmdir' | 'removeRecursive' | 'symlink' | 'readlink' | 'chmod';
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
export declare function projectTree(filesystem: ProcessFiles, view: ProcessView, cred: VfsCred, dir: string): Promise<ProjectTree>;
/** `view` in the engine's call shape. */
export declare function viewProjectFs(view: ProcessView): ProjectFs;
export {};
//# sourceMappingURL=project-fs.d.ts.map