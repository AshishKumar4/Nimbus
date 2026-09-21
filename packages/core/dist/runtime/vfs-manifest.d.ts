/**
 * vfs-manifest.ts — describe a filesystem subtree to the WASI layer without copying it.
 *
 * This is the seed producer for the one filesystem: a manifest of sizes and
 * modes that wasi-instance.ts treats as a cache index over the live session
 * filesystem. Content arrives on demand and mutations write back as they
 * happen, both through the same credential-bound authority the walk used.
 */
import type { WasiFsSnapshot } from './wasi-instance.js';
import type { RuntimeFsBridge, VfsCred } from './os-contracts.js';
export interface VfsManifest {
    snapshot: WasiFsSnapshot;
    files: number;
    bytes: number;
}
/**
 * Describe a filesystem subtree without copying it.
 *
 * Records each file's SIZE instead of its bytes, so the result is a manifest
 * the WASI layer treats as a cache index: content is demand-loaded through the
 * authority on first read, and a path the manifest lacks is genuinely absent
 * (the walk excludes nothing, so every root is claimed as enumerated).
 *
 * Modes are the caller's effective bits, computed from the inode the authority
 * reports and the credential the bridge is bound to. Traversal is enforced by
 * the walk itself: a directory the credential cannot read is listed but never
 * entered, so nothing below it reaches the manifest.
 */
export declare function manifestVfs(fs: RuntimeFsBridge, cred: Readonly<VfsCred>, vfsRoot: string, opts?: {
    extraRoots?: Iterable<string>;
    revision?: number;
}): Promise<VfsManifest | {
    error: string;
}>;
export declare function effectiveMode(mode: number, uid: number, gid: number, cred: Readonly<VfsCred>): number;
export declare function hasErrorCode(error: unknown, code: string): boolean;
//# sourceMappingURL=vfs-manifest.d.ts.map