/**
 * One Node CommonJS resolution algorithm. Generators yield metadata questions;
 * sync guests/lifo and the async launch walker drive exactly the same steps.
 * Filesystem access, module loading, builtins and require-stack assembly remain
 * host/loader policy. NODE_PATH and Node's global folders are not discovered.
 */
import type { Awaitable, RuntimeFsBridge, RuntimeVfsStat } from './os-contracts.js';
import { type ResolvablePackageJson, type SelfReferencingPackageJson } from '../_shared/exports-resolver.js';
import type { PackageType } from './module-format.js';
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
export interface BridgeRequireFs extends RequireFs {
    stat(path: string): Promise<RuntimeVfsStat | null>;
    lstat(path: string): Promise<RuntimeVfsStat | null>;
    readBytes(path: string): Promise<Uint8Array | null>;
}
export type PkgJsonSink = (pkgJsonPath: string) => Awaitable<string | null>;
export type WalkProgress = (work: number) => Promise<void>;
export declare const METADATA_CANDIDATE_WORK = 256;
export interface RequireResolverHost {
    /** Absolute paths, following links. */
    kind(path: string): Awaitable<'file' | 'directory' | null>;
    readText(path: string): Awaitable<string | null>;
    realpath(path: string): Awaitable<string>;
    isBuiltin?(specifier: string): boolean;
}
export interface RequireResolutionPolicy {
    readonly name: string;
    readonly typescriptFallback?: boolean;
    /** Lifo's explicitly supported product-global package directories, not NODE_PATH. */
    readonly globalFolders?: readonly string[];
}
export declare const NODE_REQUIRE_POLICY: RequireResolutionPolicy;
/**
 * Nimbus source execution accepts Bun/NodeNext .js -> .ts and index.ts only
 * after Node's ordinary candidates miss. Package-map targets remain exact.
 */
export declare const NIMBUS_TYPESCRIPT_REQUIRE_POLICY: RequireResolutionPolicy;
export interface RequireResolverOptions {
    conditions?: readonly string[];
    policy?: RequireResolutionPolicy;
    progress?: WalkProgress;
}
type PackageConfig = ResolvablePackageJson & SelfReferencingPackageJson & {
    type?: unknown;
};
export interface RequirePackageScope {
    dir: string;
    packageJsonPath: string;
    pkg: PackageConfig;
    type: PackageType;
}
export interface CommonJsResolution {
    path?: string;
    builtin?: string;
    /** The final real file's classified scope, not the requesting module's. */
    scope: RequirePackageScope | null;
    packageType: PackageType;
}
export interface RequireResolveOptions {
    /** Already absolute. Undefined is the parent lookup, [] is no lookup. */
    paths?: readonly string[];
}
/** Node's node_modules lookup paths, with no node_modules/node_modules. */
export declare function requireNodeModulePaths(fromDir: string): string[];
export declare function createRequireResolver(host: RequireResolverHost, options?: RequireResolverOptions): {
    resolve: (id: string, dir: string, request?: RequireResolveOptions) => Promise<CommonJsResolution | null>;
    resolveSync: (id: string, dir: string, request?: RequireResolveOptions) => CommonJsResolution | null;
    resolveFile: (path: string) => Promise<string | null>;
    resolveFileSync: (path: string) => string | null;
    packageScope: (dir: string) => Promise<RequirePackageScope | null>;
    packageScopeSync: (dir: string) => RequirePackageScope | null;
};
/**
 * The text RequireFs.readFileString answers for a file whose content is
 * `cell`, a cell a module map already holds: a text cell is that text; a
 * byte cell (a file that is not valid UTF-8, facets/manager.ts
 * _readBundleCell) is decoded as readFileString decodes it. A walk reuses
 * and compares a held cell through this, in the one representation it reads.
 */
export declare function heldCellText(cell: string | Uint8Array): string;
export declare function requireFsOverBridge(bridge: RuntimeFsBridge): BridgeRequireFs;
/** Adapt VFS-relative launch metadata to the algorithm's absolute questions. */
export declare function requireResolverOverFs(vfs: RequireFs, sink?: PkgJsonSink, progress?: WalkProgress, conditions?: readonly string[], policy?: RequireResolutionPolicy): {
    resolve: (id: string, dir: string, request?: RequireResolveOptions) => Promise<CommonJsResolution | null>;
    resolveSync: (id: string, dir: string, request?: RequireResolveOptions) => CommonJsResolution | null;
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
export declare function resolveRequireEx(vfs: RequireFs, id: string, fromDir: string, sink?: PkgJsonSink, progress?: WalkProgress, conditions?: readonly string[], policy?: RequireResolutionPolicy): Promise<ResolveSubpathResult | null>;
export declare function resolveFile(vfs: RequireFs, base: string, sink?: PkgJsonSink, progress?: WalkProgress): Promise<string | null>;
export declare function packageScopeType(vfs: RequireFs, dir: string, progress?: WalkProgress): Promise<PackageType>;
export declare function packageJsonVisible(vfs: RequireFs, path: string): Promise<boolean>;
/** Speculative entry selection reads the same Node map, never import/browser fallbacks. */
export declare function requirePackageEntry(pkg: ResolvablePackageJson, subpath: string, conditions: readonly string[]): string | null;
export {};
//# sourceMappingURL=require-resolution.d.ts.map