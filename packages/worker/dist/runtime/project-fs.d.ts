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
import type { CredentialedVfs, VfsStat } from '@nimbus-sh/core/vfs/sqlite-vfs.js';
import type { Awaitable, VfsDirent } from '@nimbus-sh/core/vfs/vfs.js';
import { type KnownDirentType } from '@nimbus-sh/core/vfs/dirent-type.js';
type ProjectFsOp = 'exists' | 'isFile' | 'isDirectory' | 'stat' | 'lstat' | 'readFile' | 'readFileString' | 'readFileUncached' | 'readRangeUncached' | 'writeFile' | 'mkdir' | 'unlink' | 'rename' | 'rmdir' | 'removeRecursive' | 'symlink' | 'readlink' | 'chmod';
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
    /**
     * Every entry under directory `key` with its lstat, in path order, from one
     * paged scan (ProcessView.scan): `path` is under `key`, and `byName` marks
     * a directory whose entries must be asked by name.
     */
    scan(key: string): AsyncIterable<ProjectScanned>;
};
/** An entry of ProjectFs.scan. */
export interface ProjectScanned {
    path: string;
    stat: VfsStat;
    byName: boolean;
}
/** The exact type of `entry` in `dir`, lstat'ing it where its listing could not type it; null when it has gone. */
export declare function projectEntryType(fs: Pick<ProjectFs, 'lstat'>, dir: string, entry: Pick<VfsDirent, 'name' | 'type'>): Promise<KnownDirentType | null>;
/** The principal's `view` in the engine's call shape. */
export declare function projectFs(view: ProcessView): ProjectFs;
/**
 * Hands an artifact a Nimbus tool made as the kernel in a user's project
 * to the owner of the directory that holds it, before the tool, which now
 * acts as its caller, replaces it. Releases before 0.13.2 wrote `dist/`
 * (vite build), `package.json` (npm init, npm-fast) and
 * `node_modules/.nimbus-synthetic` (pre-bundling) as root; releases through
 * worker 0.17.0, `npm install -g`'s bin shims and `wrangler dev`'s KV and R2
 * stores (`.nimbus/kv`, `.nimbus/r2`). The calling tool
 * names the one path it writes; only what is still root's there moves, and
 * only what the directory's owner could already read and replace: a world-
 * readable file with no other name (no hard link), or a world-searchable
 * directory, descending only through directories that move. Never through a
 * link, nothing on a mount, nothing for a root caller, and nothing in a
 * directory root owns. `descend: false` hands a directory without what is
 * in it: a directory other state shares.
 */
export declare function handKernelArtifact(filesystem: ProcessFiles, view: ProcessView, cred: VfsCred, path: string, { descend }?: {
    descend?: boolean;
}): Promise<void>;
export {};
//# sourceMappingURL=project-fs.d.ts.map