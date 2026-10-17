/**
 * package-map.ts — Node's package maps (package.json `exports` and
 * `imports`): their selection, their targets' validation, and the errors
 * of both, as lib/internal/modules/esm/resolve.js has them. The module
 * resolvers share it (esm-resolver.ts, runtime/require-resolution.ts), and
 * the build's resolution reaches it through exports-resolver.ts, which
 * re-exports it beside its own permissive policy.
 *
 * The guest's module loading runs it after a program may have replaced
 * built-ins, so it calls only those the launch captured (primordials.ts;
 * tests/unit/primordials-audit.mjs). `conditions` is the set of active
 * conditions, not an order: a condition map's own key order decides.
 */
/** Node 22.12+ defaults. `default` is always active, not a user condition. */
export declare const DEFAULT_ESM_CONDITIONS: string[];
/** Default conditions for CJS runtime resolution (user-shell node). */
export declare const DEFAULT_CJS_CONDITIONS: string[];
/** Host-independent package-map traversal; only leaves and errors are policy. */
export type PackageMapSteps<T> = Generator<unknown, T, unknown>;
export interface PackageTargetMatch {
    key: string;
    subpath: string;
    pattern: boolean;
    internal: boolean;
    isPathMap: boolean;
}
export interface PackageMapPolicy<T> {
    readonly name: string;
    readonly internal: boolean;
    /** Build/browser compatibility only: permissive leaves and historical fallbacks. */
    readonly permissive: boolean;
    target(value: string, match: PackageTargetMatch): PackageMapSteps<T>;
    invalidTarget(value: unknown, match: PackageTargetMatch): Error;
    invalidConfig(reason: 'mixed' | 'numeric'): Error;
}
export declare const urlHref: (url: URL) => string;
export declare const urlProtocol: (url: URL) => string;
export declare const urlPathname: (url: URL) => string;
export declare const urlSearch: (url: URL) => string;
export declare const urlHash: (url: URL) => string;
export declare const urlSetPathname: (url: URL, pathname: string) => void;
export declare const urlSetSearch: (url: URL, search: string) => void;
export declare const urlSetHash: (url: URL, hash: string) => void;
/** An error's `code`, as Node's resolver reads it. */
export declare function codeOf(error: unknown): unknown;
/**
 * A package.json's text as Node's reader parses it: a leading byte order
 * mark skipped (src/node_modules.cc, whose simdjson skips one). The file
 * itself keeps it: a copy of one, a module map's cell, is every byte.
 */
export declare function packageJsonText(text: string): string;
/** Node's PATTERN_KEY_COMPARE: prefix first, then trailer, not total length. */
export declare function patternKeyCompare(a: string, b: string): number;
/**
 * One exact/sugar/pattern selection and target traversal for exports/imports.
 * undefined is unmatched; null is blocked. A blocked condition or best pattern
 * never falls back to a sibling. Arrays retain Node's last-null/invalid-target
 * rule (a null array element is not a conditional fallback).
 */
export declare function selectPackageMap<T>(field: unknown, name: string, conditions: ReadonlySet<string> | readonly string[], policy: PackageMapPolicy<T>): PackageMapSteps<T | null | undefined>;
/** The package.json fields Node's self-reference rule reads. */
export interface SelfReferencingPackageJson {
    name?: string;
    exports?: unknown;
}
/**
 * Node's LOAD_PACKAGE_SELF: from inside a package, a bare specifier whose
 * package name is the enclosing package's own `name` resolves through that
 * package's `exports` map — and only then. A package without `exports` does
 * not self-reference (Node falls through to node_modules), and the scope is
 * the NEAREST enclosing package.json: the caller finds it by walking up
 * from the requiring file to the first package.json, and never past a
 * nearer package of a different name to a matching ancestor. The fields
 * read are the object's own, as Node's reader has them.
 *
 * Returns the exports subpath to resolve (`'.'` for the bare name,
 * `'./sub'` for `<name>/sub`), or null when the rule does not apply. The
 * caller resolves that subpath against `pkg.exports` with its conditions.
 */
export declare function packageSelfReferenceSubpath(pkg: SelfReferencingPackageJson | null | undefined, specifier: string): string | null;
/**
 * A package resolution error Node's JavaScript gives an `ERR_*` code: its
 * internal NodeError, `Name [CODE]: message` in its toString() and its stack
 * (lib/internal/errors.js). A module not found by require() is not one:
 * Node's CJS loader makes that a plain Error, its `code` MODULE_NOT_FOUND.
 */
export declare function resolutionError(code: string, message: string, Type?: ErrorConstructor | TypeErrorConstructor): Error;
/**
 * A package resolution error Node 22 throws from C++ (node_errors.h
 * THROW_ERR_*): a package.json it cannot parse (node_modules.cc), a package
 * main legacyMainResolve does not find (node_file.cc). A plain Error with its
 * code, `Error: message` in its toString() and its stack, as V8 makes it.
 */
export declare function nativeResolutionError(code: string, message: string): Error;
/**
 * Node's leaf validation and error construction, shared by CJS and ESM.
 * A bare imports target is delegated to the caller's package resolver; any
 * host questions it yields remain inside the same array traversal.
 */
export declare function createNodePackageMapPolicy(packageJsonUrl: URL, base: string, internal: boolean, resolveBare: (specifier: string) => PackageMapSteps<URL>): PackageMapPolicy<URL>;
//# sourceMappingURL=package-map.d.ts.map