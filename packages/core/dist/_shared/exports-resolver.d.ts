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
 *   - runtime CJS          →  ['require', 'node', 'default'], and the
 *     program's own (`node --conditions`), as Node adds them
 *
 * `conditions` is the set of active conditions, not an order: a condition
 * map's own key order decides, the first key that is active (or
 * `default`) whose target resolves wins, as Node's PACKAGE_TARGET_RESOLVE
 * (and every bundler's) takes it.
 */
/** Default conditions for ESM/install/browser resolution. */
export declare const DEFAULT_ESM_CONDITIONS: string[];
/** Default conditions for CJS runtime resolution (user-shell node). */
export declare const DEFAULT_CJS_CONDITIONS: string[];
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
/**
 * Resolve `package.json#exports` (or `#imports`) per Node spec.
 *
 * @param exportsField  Raw value from package.json#exports or #imports
 * @param subpath       '.' for root, './foo' for subpath, '#name' for imports
 * @param conditions    The active conditions (the map's key order decides among them)
 * @returns             Relative path target string, or null if not found / forbidden
 */
export declare function resolveExports(exportsField: ExportsField | undefined, subpath?: string, conditions?: string[]): string | null;
/**
 * Resolve a package's entry-point file relative to its directory.
 * Priority: exports → module (only under the `module` condition) → main → null.
 * For non-root subpaths without an `exports` field, returns the subpath
 * itself (caller probes filesystem with extension-list).
 */
export declare function resolvePackageEntry(pkg: ResolvablePackageJson, subpath?: string, conditions?: string[]): string | null;
/** The package.json fields Node's self-reference rule reads. */
export interface SelfReferencingPackageJson {
    name?: string;
    exports?: ExportsField;
}
/**
 * Node's LOAD_PACKAGE_SELF: from inside a package, a bare specifier whose
 * package name is the enclosing package's own `name` resolves through that
 * package's `exports` map — and only then. A package without `exports` does
 * not self-reference (Node falls through to node_modules), and the scope is
 * the NEAREST enclosing package.json: the caller finds it by walking up
 * from the requiring file to the first package.json, and never past a
 * nearer package of a different name to a matching ancestor.
 *
 * Returns the exports subpath to resolve (`'.'` for the bare name,
 * `'./sub'` for `<name>/sub`), or null when the rule does not apply. The
 * caller resolves that subpath against `pkg.exports` with its conditions.
 */
export declare function packageSelfReferenceSubpath(pkg: SelfReferencingPackageJson | null | undefined, specifier: string): string | null;
//# sourceMappingURL=exports-resolver.d.ts.map