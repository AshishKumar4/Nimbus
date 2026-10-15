/**
 * One Node CommonJS resolution algorithm. Generators yield metadata questions;
 * sync guests/lifo and the async launch walker drive exactly the same steps.
 * Filesystem access, module loading, builtins and require-stack assembly remain
 * host/loader policy. NODE_PATH and Node's global folders are not discovered.
 */
import type { Awaitable, RuntimeFsBridge, RuntimeVfsStat } from './os-contracts.js';
import { type PackageMapPolicy, type ResolvablePackageJson, type SelfReferencingPackageJson } from '../_shared/exports-resolver.js';
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
    /** Staged guests already carry format facts; only loaders needing type rediscovery collect it. */
    collectPackageScope?: boolean;
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
    /**
     * The requiring module's filename, which an imports ("#name") refusal says
     * it is imported from, as Node's Module._resolveFilename passes the
     * parent's path; the directory resolved from where there is none.
     */
    parent?: string;
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
/** The launch names reachable files; runtime resolution still reports refusals. */
export declare function isRequireResolutionError(err: unknown): boolean;
export declare function resolveRequireEx(vfs: RequireFs, id: string, fromDir: string, sink?: PkgJsonSink, progress?: WalkProgress, conditions?: readonly string[], policy?: RequireResolutionPolicy): Promise<ResolveSubpathResult | null>;
export declare function resolveFile(vfs: RequireFs, base: string, sink?: PkgJsonSink, progress?: WalkProgress): Promise<string | null>;
export declare function packageScopeType(vfs: RequireFs, dir: string, progress?: WalkProgress): Promise<PackageType>;
export declare function packageJsonVisible(vfs: RequireFs, path: string): Promise<boolean>;
/** Node selection by default; speculative builds opt into their named map policy. */
export declare function requirePackageEntry(pkg: ResolvablePackageJson, subpath: string, conditions: readonly string[], buildPolicy?: PackageMapPolicy<string>): string | null;
export {};
//# sourceMappingURL=require-resolution.d.ts.map