import { z } from 'zod/v4';
import { packageJsonText, selectPackageMap } from './package-map.js';
export { codeOf, createNodePackageMapPolicy, DEFAULT_CJS_CONDITIONS, DEFAULT_ESM_CONDITIONS, nativeResolutionError, packageJsonText, packageSelfReferenceSubpath, patternKeyCompare, resolutionError, selectPackageMap, } from './package-map.js';
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
export const DEFAULT_BUILD_CONDITIONS = ['import', 'module', 'browser', 'default'];
// An invalid leaf (`require: 7`) becomes `null`, the spec's "no target", so
// resolveConditionValue skips it and a valid sibling (`default`) still
// resolves. Rejecting the whole field would lose that sibling, which the
// hand-rolled walk this replaced did not.
//
// Each entry field validates on its own: a field the resolver cannot read
// (`main: 7`) is dropped, the others stay. Whole-object rejection would lose
// a valid `main` next to a bad `module`, which the runtime resolver tolerates.
//
// Built on first use, so a bundle that needs only the resolver (the build
// facet's runtime) leaves zod out.
let packageJsonSchema = null;
function resolvablePackageJsonSchema() {
    if (packageJsonSchema)
        return packageJsonSchema;
    const exportsField = z.lazy(() => z.union([
        z.string(),
        z.null(),
        z.array(exportsField),
        z.record(z.string(), exportsField),
    ]).catch(null));
    packageJsonSchema = z.object({
        exports: exportsField.optional(),
        imports: exportsField.optional(),
        main: z.string().optional().catch(undefined),
        module: z.string().optional().catch(undefined),
    });
    return packageJsonSchema;
}
/**
 * The entry-point fields of a package.json read off disk, or null when the
 * text is not JSON or not an object. A caller narrows through this rather
 * than annotating `JSON.parse`, so a malformed package resolves as "no
 * declared entry" instead of throwing inside the resolver.
 */
export function parseResolvablePackageJson(text) {
    try {
        const result = resolvablePackageJsonSchema().safeParse(JSON.parse(packageJsonText(text)));
        return result.success ? result.data : null;
    }
    catch {
        return null;
    }
}
/** Old build/browser tolerance is explicit, and never used by Node resolution. */
export const BUILD_BROWSER_PACKAGE_MAP_POLICY = {
    name: 'build-browser-permissive',
    internal: false,
    permissive: true,
    *target(value, match) { return match.pattern ? value.split('*').join(match.subpath) : value; },
    invalidTarget: () => new Error('Invalid build/browser package target'),
    invalidConfig: () => new Error('Invalid build/browser package map'),
};
/** Compatibility surface for install/bundler/browser callers. */
export function resolveExports(exportsField, subpath = '.', conditions = DEFAULT_BUILD_CONDITIONS, policy = BUILD_BROWSER_PACKAGE_MAP_POLICY) {
    const steps = selectPackageMap(exportsField, subpath, conditions, {
        ...policy, internal: subpath.startsWith('#'),
    });
    const next = steps.next();
    if (!next.done)
        throw new Error('The build/browser package-map policy must be synchronous');
    return next.value ?? null;
}
/**
 * Resolve a package's entry-point file relative to its directory.
 * Priority: exports → module (only under the `module` condition) → main → null.
 * For non-root subpaths without an `exports` field, returns the subpath
 * itself (caller probes filesystem with extension-list).
 */
export function resolvePackageEntry(pkg, subpath = '.', conditions = DEFAULT_BUILD_CONDITIONS, policy = BUILD_BROWSER_PACKAGE_MAP_POLICY) {
    // 1. exports field
    if (pkg.exports !== undefined && pkg.exports !== null) {
        const entry = resolveExports(pkg.exports, subpath, conditions, policy);
        if (entry)
            return entry;
        // If exports is defined but yields nothing for this subpath,
        // Node spec is: this is an error (subpath isn't exposed).
        // We return null to let caller decide (some callers fall back to
        // direct filesystem probing for compatibility with packages that
        // mis-declare exports).
        return null;
    }
    // 2. Root entry. `module` is the bundlers' field, the legacy spelling of
    // the `module` condition; Node's require never reads it
    // (https://nodejs.org/api/modules.html#all-together, LOAD_NODE_MODULES →
    // LOAD_AS_DIRECTORY reads "main"). tinydate@1: main is CommonJS
    // `module.exports = fn`, module is `export default fn`, and sirv-cli's
    // require('tinydate') must get the function.
    if (subpath === '.') {
        if (conditions.includes('module') && pkg.module)
            return pkg.module;
        if (pkg.main)
            return pkg.main;
        return null;
    }
    // 3. Non-root subpath without exports — caller probes raw subpath
    return subpath;
}
