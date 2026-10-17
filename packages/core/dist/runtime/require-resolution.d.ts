/**
 * The launch's adapters over Node's CommonJS resolution algorithm
 * (_shared/commonjs-resolver.ts, which the guest's require() runs too):
 * VFS-relative questions, staged cells' text, and the build's entry
 * selection.
 */
import type { Awaitable, RuntimeFsBridge, RuntimeVfsStat } from './os-contracts.js';
import { type PackageMapPolicy, type ResolvablePackageJson } from '../_shared/exports-resolver.js';
import { type RequirePackageScope, type RequireResolutionPolicy, type WalkProgress } from '../_shared/commonjs-resolver.js';
import type { PackageType } from './module-format.js';
export { createRequireResolver, METADATA_CANDIDATE_WORK, NIMBUS_TYPESCRIPT_REQUIRE_POLICY, NODE_REQUIRE_POLICY, requireNodeModulePaths, type CommonJsResolution, type RequirePackageScope, type RequireResolutionPolicy, type RequireResolveOptions, type RequireResolverHost, type RequireResolverOptions, type WalkProgress, } from '../_shared/commonjs-resolver.js';
/** Launch/filesystem adapter surface, kept for dependency-collector callers. */
export interface RequireFs {
    exists(path: string): Awaitable<boolean>;
    isDirectory(path: string): Awaitable<boolean>;
    readFileString(path: string): Awaitable<string>;
    stat(path: string): Awaitable<{
        size: number;
    } | null>;
    assertReadable?(path: string): Awaitable<void>;
    /** Hosts with links must supply this; immutable link-free maps may omit it. */
    realpath?(path: string): Awaitable<string>;
}
/**
 * The filesystem a module map is staged from: its cells copy each file's
 * bytes (fileCell), which readFileString's text (fileText) may not, where
 * the file is not UTF-8.
 */
export interface StagingRequireFs extends RequireFs {
    /** A file's bytes, or null when it does not exist. */
    readBytes(path: string): Awaitable<Uint8Array | null>;
}
export interface BridgeRequireFs extends StagingRequireFs {
    stat(path: string): Promise<RuntimeVfsStat | null>;
    lstat(path: string): Promise<RuntimeVfsStat | null>;
    readBytes(path: string): Promise<Uint8Array | null>;
}
export type PkgJsonSink = (pkgJsonPath: string) => Awaitable<string | null>;
/**
 * A file's bytes as text, as Node's readFileSync(path, 'utf8') answers them:
 * every byte decoded, a leading byte order mark kept. What
 * RequireFs.readFileString answers, and what a resolver parses.
 */
export declare function fileText(bytes: Uint8Array): string;
/**
 * A file's bytes as a module map's cell carries them: its text when the
 * bytes are UTF-8, every byte kept, else the bytes.
 */
export declare function fileCell(bytes: Uint8Array): string | Uint8Array;
/**
 * The text a module walk reads a cell as, or a file's bytes it stages: a
 * text cell is that text; bytes are the file's text (fileText), which is the
 * cell's text when the file is UTF-8 (fileCell). A walk stages, reuses and
 * compares cells through this, in the one representation it reads.
 */
export declare function heldCellText(cell: string | Uint8Array): string;
export declare function requireFsOverBridge(bridge: RuntimeFsBridge): BridgeRequireFs;
/** Adapt VFS-relative launch metadata to the algorithm's absolute questions. */
export declare function requireResolverOverFs(vfs: RequireFs, sink?: PkgJsonSink, progress?: WalkProgress, conditions?: readonly string[], policy?: RequireResolutionPolicy): {
    resolve: (id: string, dir: string, request?: import("./require-resolution.js").RequireResolveOptions) => Promise<import("./require-resolution.js").CommonJsResolution | null>;
    resolveSync: (id: string, dir: string, request?: import("./require-resolution.js").RequireResolveOptions) => import("./require-resolution.js").CommonJsResolution | null;
    resolveFile: (path: string) => Promise<string | null>;
    resolveFileSync: (path: string) => string | null;
    packageScope: (dir: string) => Promise<RequirePackageScope | null>;
    packageScopeSync: (dir: string) => RequirePackageScope | null;
};
/** Public launch signatures stay VFS-relative; scope travels with the result. */
export interface ResolveSubpathResult {
    resolved: string;
    scope?: RequirePackageScope | null;
    packageType?: PackageType;
}
/** The launch names reachable files; runtime resolution still reports refusals. */
export declare function isRequireResolutionError(err: unknown): boolean;
export declare function resolveRequireEx(vfs: RequireFs, id: string, fromDir: string, sink?: PkgJsonSink, progress?: WalkProgress, conditions?: readonly string[], policy?: RequireResolutionPolicy): Promise<ResolveSubpathResult | null>;
export declare function resolveFile(vfs: RequireFs, base: string, sink?: PkgJsonSink, progress?: WalkProgress): Promise<string | null>;
export declare function packageScopeType(vfs: RequireFs, dir: string, progress?: WalkProgress): Promise<PackageType>;
export declare function packageJsonVisible(vfs: RequireFs, path: string): Promise<boolean>;
/** Node selection by default; speculative builds opt into their named map policy. */
export declare function requirePackageEntry(pkg: ResolvablePackageJson, subpath: string, conditions: readonly string[], buildPolicy?: PackageMapPolicy<string>): string | null;
//# sourceMappingURL=require-resolution.d.ts.map