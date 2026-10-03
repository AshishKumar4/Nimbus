/**
 * The tree a tool works on (a repository, a project, its node_modules), as
 * the calling principal. A tool reads and writes it through the principal's
 * view of the namespace, which routes a SQLite path to the engine and a
 * mounted one to its mount, awaited. Only the engine's own bulk paths
 * (batched writes, pre-bundling, the dev servers) address the engine
 * directly, at the key `engineKey` resolves.
 */
import { type VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import { type ProcessFiles, type ProcessView } from '@nimbus-sh/core/runtime/process-files.js';
import type { CredentialedVfs } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import type { Awaitable, VfsDirent } from '@nimbus-sh/core/vfs/vfs.js';
type ProjectFsOp = 'exists' | 'isFile' | 'isDirectory' | 'stat' | 'lstat' | 'readFile' | 'readFileString' | 'writeFile' | 'mkdir' | 'unlink' | 'rmdir' | 'removeRecursive' | 'symlink' | 'readlink' | 'chmod';
/**
 * A tool's calls on its tree in the engine's call shape (keys with or
 * without the leading slash, a stat that throws when absent, failures
 * thrown), each answered at once (the engine, for a system path the tool
 * writes as the kernel) or awaited (a principal's view, see projectFs).
 */
export type ProjectFs = {
    [K in ProjectFsOp]: (...args: Parameters<CredentialedVfs[K]>) => ReturnType<CredentialedVfs[K]> | Promise<ReturnType<CredentialedVfs[K]>>;
} & {
    /** A directory's entries, typed as the namespace types them: a mount's may name a device, or say it cannot tell. */
    readdir(key: string): Awaitable<Array<Pick<VfsDirent, 'name' | 'type'>>>;
};
/** The principal's `view` in the engine's call shape. */
export declare function projectFs(view: ProcessView): ProjectFs;
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
export declare function handKernelArtifact(filesystem: ProcessFiles, view: ProcessView, cred: VfsCred, path: string): Promise<void>;
export {};
//# sourceMappingURL=project-fs.d.ts.map