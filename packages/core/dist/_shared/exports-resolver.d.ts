import { type PackageMapPolicy } from './package-map.js';
export { codeOf, createNodePackageMapPolicy, DEFAULT_CJS_CONDITIONS, DEFAULT_ESM_CONDITIONS, nativeResolutionError, packageJsonText, packageSelfReferenceSubpath, patternKeyCompare, resolutionError, selectPackageMap, type PackageMapPolicy, type PackageMapSteps, type PackageTargetMatch, type SelfReferencingPackageJson, } from './package-map.js';
/**
 * exports-resolver.ts — Single source of truth for `package.json#exports` /
 * `package.json#imports` resolution per the Node.js spec.
 *
 * Used in three contexts:
 *
 *   1. Supervisor (TS) — package and require resolution import the typed
 *      functions directly.
 *
 *   2. The build facet's pre-bundles (runtime/prebundle-slice.ts, bundled
 *      into the facet's runtime) import the typed functions too, so a
 *      pre-bundle resolves exactly as the supervisor does.
 *
 *   3. User-shell `node` runtime (JS string) — the node shims embed this
 *      code, compiled once from node-shim-resolution.ts, so `require()`
 *      from inside a user's `node` script sees the same exports map as the
 *      install pipeline.
 *
 *
 * Spec features supported:
 *   - String shorthand:                "exports": "./dist/index.mjs"
 *   - Subpath maps:                    { ".": "...", "./client": "..." }
 *   - Conditional maps (top-level):    { "import": "...", "require": "..." }
 *   - Nested conditions:               { ".": { "node": { "default": "..." } } }
 *   - Subpath wildcards:               { "./*": "./dist/*.js" }
 *   - Array fallbacks:                 [ "./esm.js", "./cjs.js" ]
 *   - `imports` field (`#name`):       same shape, same impl (re-uses resolveExports)
 *   - Null-target enforcement:         { "./private/*": null } — returns null, blocks fallback
 *
 * Caller-controlled `conditions` lets the same impl serve:
 *   - install/ESM/browser  →  ['import', 'module', 'browser', 'default']
 *   - runtime CJS          →  ['require', 'node', 'module-sync'], and the
 *     program's own (`node --conditions`), as Node adds them
 *
 * `conditions` is the set of active conditions, not an order: a condition
 * map's own key order decides, the first key that is active (or
 * `default`) whose target resolves wins, as Node's PACKAGE_TARGET_RESOLVE
 * (and every bundler's) takes it.
 *
 * Node's maps and their errors are package-map.ts's, which the guest's
 * module loading calls after a program may have replaced built-ins; this
 * module adds the build's tolerant policy and package.json reading.
 */
/** The install/bundler/browser policy, deliberately not Node's conditions. */
export declare const DEFAULT_BUILD_CONDITIONS: string[];
/**
 * A `package.json#exports` / `#imports` value: a target path, an ordered list
 * of fallbacks to try in turn, or a map keyed by subpath (`"./client"`) or by
 * condition (`"import"`) whose values are the same shape again. `null` is the
 * spec's "this subpath is not exported" marker, and blocks fallback.
 */
export type ExportsField = string | null | ExportsField[] | {
    [key: string]: ExportsField;
};
/** The package.json fields entry-point resolution reads. */
export interface ResolvablePackageJson {
    exports?: ExportsField;
    imports?: ExportsField;
    main?: string;
    module?: string;
}
/**
 * The entry-point fields of a package.json read off disk, or null when the
 * text is not JSON or not an object. A caller narrows through this rather
 * than annotating `JSON.parse`, so a malformed package resolves as "no
 * declared entry" instead of throwing inside the resolver.
 */
export declare function parseResolvablePackageJson(text: string): ResolvablePackageJson | null;
/** Old build/browser tolerance is explicit, and never used by Node resolution. */
export declare const BUILD_BROWSER_PACKAGE_MAP_POLICY: PackageMapPolicy<string>;
/** Compatibility surface for install/bundler/browser callers. */
export declare function resolveExports(exportsField: ExportsField | undefined, subpath?: string, conditions?: string[], policy?: PackageMapPolicy<string>): string | null;
/**
 * Resolve a package's entry-point file relative to its directory.
 * Priority: exports → module (only under the `module` condition) → main → null.
 * For non-root subpaths without an `exports` field, returns the subpath
 * itself (caller probes filesystem with extension-list).
 */
export declare function resolvePackageEntry(pkg: ResolvablePackageJson, subpath?: string, conditions?: string[], policy?: PackageMapPolicy<string>): string | null;
//# sourceMappingURL=exports-resolver.d.ts.map