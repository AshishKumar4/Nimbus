/**
 * vfs-manifest.ts — describe a VFS subtree to the WASI layer without copying it.
 *
 * This is the seed producer for the one filesystem: a manifest of sizes and
 * modes that wasi-instance.ts treats as a cache index over the live session
 * VFS. Content arrives on demand and mutations write back as they happen.
 */
import type { WasiFsSnapshot } from './wasi-instance.js';
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
export declare function effectiveMode(mode: number, uid: number, gid: number, cred: VfsCred): number;
export declare function hasErrorCode(error: unknown, code: string): boolean;
//# sourceMappingURL=vfs-manifest.d.ts.map