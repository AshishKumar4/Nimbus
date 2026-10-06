import { z } from 'zod/v4';

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
export const DEFAULT_ESM_CONDITIONS = ['import', 'module', 'browser', 'default'];

/** Default conditions for CJS runtime resolution (user-shell node). */
export const DEFAULT_CJS_CONDITIONS = ['require', 'node', 'default'];

/**
 * A `package.json#exports` / `#imports` value: a target path, an ordered list
 * of fallbacks to try in turn, or a map keyed by subpath (`"./client"`) or by
 * condition (`"import"`) whose values are the same shape again. `null` is the
 * spec's "this subpath is not exported" marker, and blocks fallback.
 */
export type ExportsField =
  | string
  | null
  | ExportsField[]
  | { [key: string]: ExportsField };

/** The package.json fields entry-point resolution reads. */
export interface ResolvablePackageJson {
  exports?: ExportsField;
  imports?: ExportsField;
  main?: string;
  module?: string;
}

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
let packageJsonSchema: z.ZodType<ResolvablePackageJson> | null = null;
function resolvablePackageJsonSchema(): z.ZodType<ResolvablePackageJson> {
  if (packageJsonSchema) return packageJsonSchema;
  const exportsField: z.ZodType<ExportsField> = z.lazy(() => z.union([
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
export function parseResolvablePackageJson(text: string): ResolvablePackageJson | null {
  try {
    const result = resolvablePackageJsonSchema().safeParse(JSON.parse(text));
    return result.success ? result.data : null;
  } catch { return null; }
}

/**
 * Resolve `package.json#exports` (or `#imports`) per Node spec.
 *
 * @param exportsField  Raw value from package.json#exports or #imports
 * @param subpath       '.' for root, './foo' for subpath, '#name' for imports
 * @param conditions    Active conditions, in priority order
 * @returns             Relative path target string, or null if not found / forbidden
 */
export function resolveExports(
  exportsField: ExportsField | undefined,
  subpath: string = '.',
  conditions: string[] = DEFAULT_ESM_CONDITIONS,
): string | null {
  if (exportsField === undefined || exportsField === null) return null;

  // String shorthand — only valid for root entry
  if (typeof exportsField === 'string') {
    return subpath === '.' ? exportsField : null;
  }

  // Array fallback — try each in order
  if (Array.isArray(exportsField)) {
    for (const item of exportsField) {
      const r = resolveExports(item, subpath, conditions);
      if (r) return r;
    }
    return null;
  }

  if (typeof exportsField !== 'object') return null;

  const keys = Object.keys(exportsField);
  if (keys.length === 0) return null;

  // Subpath-map detection: keys begin with "." (exports) or "#" (imports)
  const isSubpathMap = keys[0].startsWith('.') || keys[0].startsWith('#');

  if (isSubpathMap) {
    // Exact match first
    if (subpath in exportsField) {
      const target = exportsField[subpath];
      // Null target — forbidden subpath, returns null and BLOCKS fallback
      if (target === null) return null;
      return resolveConditionValue(target, conditions);
    }

    // Wildcard pattern match — try most-specific (longest prefix) first
    const wildcardKeys = keys
      .filter(k => k.includes('*'))
      .sort((a, b) => b.length - a.length); // longest pattern wins

    for (const pattern of wildcardKeys) {
      const target = exportsField[pattern];
      const starIdx = pattern.indexOf('*');
      const prefix = pattern.slice(0, starIdx);
      const suffix = pattern.slice(starIdx + 1);
      if (
        subpath.startsWith(prefix) &&
        (suffix ? subpath.endsWith(suffix) : true) &&
        subpath.length >= prefix.length + suffix.length
      ) {
        // Null target on wildcard — forbidden, BLOCK fallback
        if (target === null) return null;
        const matched = subpath.slice(
          prefix.length,
          suffix ? subpath.length - suffix.length : undefined,
        );
        const resolved = resolveConditionValue(target, conditions);
        if (resolved) return resolved.split('*').join(matched);
      }
    }

    return null;
  }

  // Condition map (no subpath map keys) — only valid for root entry
  if (subpath !== '.') return null;
  return resolveConditionValue(exportsField, conditions);
}

/**
 * Resolve a condition target. Recurses through nested condition objects
 * and array fallbacks. Honours `default` even if not in the conditions
 * array (Node spec).
 */
function resolveConditionValue(
  target: ExportsField | undefined,
  conditions: string[],
): string | null {
  if (target === null || target === undefined) return null;
  if (typeof target === 'string') return target;

  if (Array.isArray(target)) {
    for (const item of target) {
      const r = resolveConditionValue(item, conditions);
      if (r) return r;
    }
    return null;
  }

  if (typeof target !== 'object') return null;

  // Try each requested condition in priority order
  for (const cond of conditions) {
    if (cond in target) {
      const r = resolveConditionValue(target[cond], conditions);
      if (r) return r;
    }
  }

  // Spec: `default` is always a valid fallback
  if (!conditions.includes('default') && 'default' in target) {
    return resolveConditionValue(target.default, conditions);
  }

  return null;
}

/**
 * Resolve a package's entry-point file relative to its directory.
 * Priority: exports → module (only under the `module` condition) → main → null.
 * For non-root subpaths without an `exports` field, returns the subpath
 * itself (caller probes filesystem with extension-list).
 */
export function resolvePackageEntry(
  pkg: ResolvablePackageJson,
  subpath: string = '.',
  conditions: string[] = DEFAULT_ESM_CONDITIONS,
): string | null {
  // 1. exports field
  if (pkg.exports !== undefined && pkg.exports !== null) {
    const entry = resolveExports(pkg.exports, subpath, conditions);
    if (entry) return entry;
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
    if (conditions.includes('module') && pkg.module) return pkg.module;
    if (pkg.main) return pkg.main;
    return null;
  }

  // 3. Non-root subpath without exports — caller probes raw subpath
  return subpath;
}

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
export function packageSelfReferenceSubpath(
  pkg: SelfReferencingPackageJson | null | undefined,
  specifier: string,
): string | null {
  if (!pkg || typeof pkg.name !== 'string' || pkg.name.length === 0) return null;
  if (pkg.exports === undefined || pkg.exports === null) return null;
  if (specifier === pkg.name) return '.';
  if (!specifier.startsWith(`${pkg.name}/`)) return null;
  return `.${specifier.slice(pkg.name.length)}`;
}

// ─── JS-source emission for embedding into facet preambles ───────────────

/**
 * The resolver as plain JavaScript, for the node facet's shim string, which
 * cannot import: the functions above by their own `toString()`, so the shim
 * resolves by this module's code and no second copy exists. It declares, at
 * top level, DEFAULT_ESM_CONDITIONS, DEFAULT_CJS_CONDITIONS, resolveExports,
 * resolveConditionValue (their helper), resolvePackageEntry and
 * packageSelfReferenceSubpath. Each function calls only the others by name.
 *
 * Read when the shim string is generated (bundle-node-shims.mjs, from dist,
 * and tests, from source), never in a minified bundle, where a renamed
 * declaration would break those names. package-self-reference.mjs and
 * typescript-specifier-resolution.mjs evaluate the emitted source.
 */
export function getExportsResolverJS(): string {
  return [
    '// ── exports-resolver (generated from src/_shared/exports-resolver.ts) ──',
    `const DEFAULT_ESM_CONDITIONS = ${JSON.stringify(DEFAULT_ESM_CONDITIONS)};`,
    `const DEFAULT_CJS_CONDITIONS = ${JSON.stringify(DEFAULT_CJS_CONDITIONS)};`,
    resolveExports.toString(),
    resolveConditionValue.toString(),
    resolvePackageEntry.toString(),
    packageSelfReferenceSubpath.toString(),
  ].join('\n');
}
