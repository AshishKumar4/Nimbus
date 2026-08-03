import type { WasiFsDiff, WasiFsSnapshot } from './wasi-instance.js';
import type { VfsCred } from './os-contracts.js';
/**
 * Minimal VFS shape runtime bridges need. Kept separate from SqliteVFS's
 * concrete type so runtime helpers do not pull supervisor modules into facet
 * preambles or create import cycles.
 */
export interface VfsLike {
    readonly cred: VfsCred;
    exists(path: string): boolean;
    isDirectory(path: string): boolean;
    stat(path: string): {
        mode: number;
        uid: number;
        gid: number;
        size: number;
    };
    readFile(path: string): Uint8Array;
    writeFile(path: string, content: Uint8Array | string): void;
    readdir(path: string): {
        name: string;
        type: string;
    }[];
    mkdir(path: string, opts?: {
        recursive?: boolean;
    }): void;
    unlink(path: string): void;
    rmdir(path: string): void;
    chmod(path: string, mode: number): void;
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
/**
 * Describe a VFS subtree without copying it.
 *
 * Same walk as snapshotVfs, but it records each file's SIZE instead of its
 * bytes, so the result is a manifest the WASI layer treats as a cache index:
 * content is demand-loaded through the supervisor on first read, and a path
 * the manifest lacks is genuinely absent (the walk excludes nothing).
 *
 * That last property is why this cannot be a flag on snapshotVfs. snapshotVfs
 * skips node_modules/.cache/.npm/.nimbus and unreadable files, so its output
 * may not describe the subtree completely and must never claim to.
 */
export declare function manifestVfs(vfs: VfsLike, vfsRoot: string, opts?: {
    extraRoots?: Iterable<string>;
    revision?: number;
}): {
    snapshot: WasiFsSnapshot;
    files: number;
    bytes: number;
} | {
    error: string;
};
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
    timesTouched: number;
    symlinks: number;
    chmods: number;
};
//# sourceMappingURL=vfs-snapshot.d.ts.map