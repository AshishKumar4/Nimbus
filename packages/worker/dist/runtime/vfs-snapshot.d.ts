/**
 * vfs-snapshot.ts — the by-value filesystem bridge for the runtimes that still
 * carry a private one.
 *
 * bash and python each implement their own filesystem inside their facet, so
 * neither can demand-load or write through: they take a whole copy of the
 * subtree at spawn and hand back a diff when they exit. That is the failure
 * mode the shared WASI layer exists to remove — a resident process that never
 * exits never persists anything — and this file is scheduled to die with the
 * last of those two private implementations. Nothing new may be built on it.
 */
import type { WasiFsSnapshot } from './wasi-instance.js';
import type { VfsLike } from './vfs-manifest.js';
/**
 * Mutations a private-filesystem runtime made, reported once at exit.
 */
export interface WasiFsDiff {
    /** New or modified files, base64-encoded. */
    filesWritten: Record<string, string>;
    /** Unlinked files. */
    filesDeleted: string[];
    /** Created directories. */
    dirsCreated: string[];
    /** Removed directories, deepest first. */
    dirsDeleted: string[];
    /**
     * vfsPath → permission bits requested via an in-facet chmod (busybox chmod
     * through the nimbus_proc.chmod import). Applied durably by flushVfsDiff via
     * vfs.chmod, where S2a ownership enforcement decides.
     */
    modesChanged?: Record<string, number>;
    /**
     * vfsPath → target string for symlinks created during the run. Stored
     * verbatim: a symlink target is a string, not a resolved path, and is
     * allowed to dangle. Without this channel a link created in-facet resolves
     * for the rest of the run and then silently disappears at exit.
     */
    symlinksCreated?: Record<string, string>;
}
export interface VfsSnapshotCaps {
    maxBytes?: number;
    maxFiles?: number;
    skipSubdirs?: Iterable<string>;
    extraRoots?: Iterable<string>;
}
export interface VfsSnapshotResult {
    snapshot: WasiFsSnapshot;
    bytes: number;
    files: number;
}
export declare function bytesToB64(bytes: Uint8Array): string;
export declare function b64ToBytes(b64: string): Uint8Array;
/**
 * Snapshot a VFS subtree into a JSON-serializable WASI-shaped filesystem.
 *
 * The snapshot is intentionally bounded. Runtimes that need incremental or
 * lazy file IO should add a streaming bridge; a single request payload is the
 * right primitive only for normal source trees and small app state.
 */
export declare function snapshotVfs(vfs: VfsLike, vfsRoot: string, caps?: VfsSnapshotCaps): VfsSnapshotResult | {
    error: string;
};
/**
 * Apply a runtime-produced filesystem diff back into the supervisor VFS.
 * Operations are independent so one bad path never loses the rest of a run.
 */
export declare function flushVfsDiff(vfs: VfsLike, diff: WasiFsDiff): {
    written: number;
    deleted: number;
    mkdirs: number;
    rmdirs: number;
    chmods: number;
    symlinks: number;
};
//# sourceMappingURL=vfs-snapshot.d.ts.map