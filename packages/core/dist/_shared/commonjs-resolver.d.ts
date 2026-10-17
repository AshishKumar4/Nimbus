type Awaitable<T> = T | Promise<T>;
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
/** A package scope's "type" (runtime/module-format.ts PackageType). */
export type PackageType = 'module' | 'commonjs' | null;
/** A package.json's fields resolution reads, each the file's own. */
export interface PackageConfig {
    name: string | undefined;
    main: string | undefined;
    exports: unknown;
    imports: unknown;
    type: unknown;
}
export interface RequirePackageScope {
    dir: string;
    packageJsonPath: string;
    pkg: PackageConfig;
    type: PackageType;
}
/** Every field its own: a loader that reads one finds no inherited value. */
export interface CommonJsResolution {
    path: string | undefined;
    builtin: string | undefined;
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
/**
 * `path` as an absolute VFS path: empty and `.` segments dropped, `..`
 * popping one (never past the root), no trailing slash (vfs/path.ts
 * normalizeVfsPath's rule, on the captures).
 */
export declare function absolute(path: string): string;
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
export {};
//# sourceMappingURL=commonjs-resolver.d.ts.map