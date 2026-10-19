/**
 * Node's ESM resolver, for the process's `import()` (dynamic-import-rewrite.ts
 * turns each `import(x)` into a call of the shims' loader, which resolves
 * here). The algorithm, its conditions and its error codes and messages are
 * Node 22's (lib/internal/modules/esm/resolve.js, get_format.js), checked
 * against real node by tests/unit/esm-resolver-matches-node.mjs:
 *
 *   - relative and absolute specifiers resolve as URLs, with no extension or
 *     index probing; a directory is ERR_UNSUPPORTED_DIR_IMPORT, a miss
 *     ERR_MODULE_NOT_FOUND, each with the "Did you mean" hint Node derives
 *     from what `require` would have found;
 *   - `#name` resolves through the package scope's `imports`, a bare name
 *     through the package's own name (self-reference), then node_modules,
 *     then `exports` (conditions `node`, `import`, `module-sync`, `default`,
 *     and the program's own from `--conditions`, taken in the map's own key
 *     order) or the legacy main;
 *   - `file:`, `node:` and `data:` URLs; every other scheme is refused.
 *
 * The node shims embed it as source (scripts/bundle-facet-workers.mjs
 * compiles it into loaders/workers.generated.ts), so the resolver is one
 * self-contained function: nothing inside may refer to this module. A
 * program may have replaced built-ins by the time it resolves, so it calls
 * only those the launch captured (primordials.ts), as Node's loader calls
 * its primordials, and reads a parsed package.json's own fields alone, as
 * Node's reader does (tests/unit/primordials-audit.mjs); a URL's members
 * it reads live, as Node's does (package-map.ts urlPathname).
 */
type MaybePromise<T> = T | Promise<T>;
/**
 * What the resolver needs of a filesystem. Paths are absolute. Answers may be
 * promises: the process's loader asks its synchronous filesystem, the launch's
 * module-map walk the supervisor's.
 */
export interface EsmResolverHost {
    /** What is at `path`, following links, or null. */
    kind(path: string): MaybePromise<'file' | 'directory' | null>;
    /** Where `path` is with every link resolved (it exists). */
    realpath(path: string): MaybePromise<string>;
    /** A file's text, or null. */
    readText(path: string): MaybePromise<string | null>;
    /**
     * Node's `module.isBuiltin`: whether a specifier names a builtin, bare
     * (`fs`) or with its scheme (`node:fs`; some, like `node:test`, only so).
     */
    isBuiltin(specifier: string): boolean;
    /** What `require(specifier)` from `parentPath` would load, or null (for hints). */
    cjsResolve(specifier: string, parentPath: string): MaybePromise<string | null>;
}
/** `unknown`: an extension Node's loaders know no format of, which loading refuses (EsmResolver.assertLoadable). */
export type EsmFormat = 'builtin' | 'module' | 'commonjs' | 'json' | 'detect' | 'data' | 'unknown';
export interface EsmResolution {
    url: string;
    /** The file, for a `file:` URL. */
    path: string | undefined;
    /** The builtin's name, for a `node:` URL. */
    builtin: string | undefined;
    format: EsmFormat;
}
export interface EsmResolver {
    resolve(specifier: string, parentUrl: string): Promise<EsmResolution>;
    /** `resolve` over a host whose every answer is immediate. */
    resolveSync(specifier: string, parentUrl: string): EsmResolution;
    /** Node's `import.meta.resolve`, over a host whose every answer is immediate. */
    metaResolveSync(specifier: string, parentUrl: string): string;
    /** Node's import-attribute check, for the format a resolution loads as. */
    validateAttributes(url: string, format: EsmFormat, attributes: Record<string, unknown>): void;
    /** Node's defaultLoad: a resolution of an `unknown` format, which Node resolves, does not load. */
    assertLoadable(resolution: EsmResolution): void;
    /**
     * Node's getPackageScopeConfig for a file: URL, over a host whose every
     * answer is immediate: the package.json path its scope reads, and the
     * "type" it declares.
     */
    packageScopeSync(url: string): PackageScope;
    /** packageScopeSync over a host whose answers may be promises. */
    packageScope(url: string): Promise<PackageScope>;
}
/** Node's package scope of a file: whether a package.json governs it, its path, and the "type" it declares. */
export interface PackageScope {
    readonly exists: boolean;
    readonly pjsonPath: string;
    readonly type: 'module' | 'commonjs' | 'none';
}
/** Node's ERR_UNKNOWN_FILE_EXTENSION message for the file at `path`. */
export declare function unknownFileExtensionMessage(path: string): string;
/** What a resolver is created with beyond its host. */
export interface EsmResolverOptions {
    /** The program's own conditions (`node --conditions`, `-C`, NODE_OPTIONS'), beside Node's defaults. */
    conditions?: readonly string[];
    /** False under `--no-experimental-strip-types`: a TypeScript file has no format. */
    stripTypes?: boolean;
    /** The process's working directory, which a miss's CommonJS hint resolves a relative specifier from. */
    cwd?: () => string;
}
export declare function createEsmResolver(host: EsmResolverHost, options?: EsmResolverOptions): EsmResolver;
/**
 * Node's refusal of a relative or absolute specifier that is no URL against
 * its importer's (resolve.js moduleResolve): ERR_UNSUPPORTED_RESOLVE_REQUEST,
 * its own `cause` the URL parser's ERR_INVALID_URL, with the input and the
 * base (lib/internal/url.js), whatever the realm's parser said.
 */
export declare function unsupportedResolveRequest(specifier: string, parentUrl: string): Error;
export {};
//# sourceMappingURL=esm-resolver.d.ts.map