/**
 * exports-resolver.ts — Single source of truth for `package.json#exports` /
 * `package.json#imports` resolution per the Node.js spec.
 *
 * Used in three contexts:
 *
 *   1. Install-time supervisor (TS) — `src/npm-resolver.ts` re-exports the
 *      typed functions for tree resolution.
 *
 *   2. NimbusLoaderPool isolates (JS string) — `src/loaders/pre-bundle-preamble.ts`
 *      embeds `getExportsResolverJS()` as part of the pool preamble so the
 *      pre-bundle facet uses identical resolution semantics to the supervisor.
 *
 *   3. User-shell `node` runtime (JS string) — `src/node-shims.ts` embeds
 *      the same JS source so `require()` from inside a user's `node` script
 *      sees the same exports map as the install pipeline.
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
 *   - runtime CJS          →  ['require', 'node', 'default']
 */
/** Default conditions for ESM/install/browser resolution. */
export declare const DEFAULT_ESM_CONDITIONS: string[];
/** Default conditions for CJS runtime resolution (user-shell node). */
export declare const DEFAULT_CJS_CONDITIONS: string[];
/**
 * Resolve `package.json#exports` (or `#imports`) per Node spec.
 *
 * @param exportsField  Raw value from package.json#exports or #imports
 * @param subpath       '.' for root, './foo' for subpath, '#name' for imports
 * @param conditions    Active conditions, in priority order
 * @returns             Relative path target string, or null if not found / forbidden
 */
export declare function resolveExports(exportsField: any, subpath?: string, conditions?: string[]): string | null;
/**
 * Resolve a package's entry-point file relative to its directory.
 * Priority: exports → module → main → null.
 * For non-root subpaths without an `exports` field, returns the subpath
 * itself (caller probes filesystem with extension-list).
 */
export declare function resolvePackageEntry(pkg: {
    exports?: any;
    module?: string;
    main?: string;
}, subpath?: string, conditions?: string[]): string | null;
/**
 * Returns the resolver source as plain JavaScript (no TypeScript syntax),
 * suitable for embedding into a generated worker preamble or shim string.
 *
 * The emitted source declares three top-level functions in scope:
 *   - resolveExports(exports, subpath, conditions)
 *   - resolveConditionValue(target, conditions)        (helper)
 *   - resolvePackageEntry(pkg, subpath, conditions)
 *
 * It also declares two arrays:
 *   - DEFAULT_ESM_CONDITIONS
 *   - DEFAULT_CJS_CONDITIONS
 *
 * This source must be byte-equivalent to the TS impl above (modulo type
 * annotations and `export` keywords). Keep them in sync — there is one
 */
export declare function getExportsResolverJS(): string;
//# sourceMappingURL=exports-resolver.d.ts.map