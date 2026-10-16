import { z } from 'zod/v4';
import { nodeError } from './node-error.js';

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
 */

/** Node 22.12+ defaults. `default` is always active, not a user condition. */
export const DEFAULT_ESM_CONDITIONS = ['import', 'node', 'node-addons', 'module-sync'];

/** Default conditions for CJS runtime resolution (user-shell node). */
export const DEFAULT_CJS_CONDITIONS = ['require', 'node', 'node-addons', 'module-sync'];

/** The install/bundler/browser policy, deliberately not Node's conditions. */
export const DEFAULT_BUILD_CONDITIONS = ['import', 'module', 'browser', 'default'];

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
 * A package.json's text as Node's reader parses it: a leading byte order
 * mark skipped (src/node_modules.cc, whose simdjson skips one). The file
 * itself keeps it: a copy of one, a module map's cell, is every byte.
 */
export function packageJsonText(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * The entry-point fields of a package.json read off disk, or null when the
 * text is not JSON or not an object. A caller narrows through this rather
 * than annotating `JSON.parse`, so a malformed package resolves as "no
 * declared entry" instead of throwing inside the resolver.
 */
export function parseResolvablePackageJson(text: string): ResolvablePackageJson | null {
  try {
    const result = resolvablePackageJsonSchema().safeParse(JSON.parse(packageJsonText(text)));
    return result.success ? result.data : null;
  } catch { return null; }
}

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
  readonly permissive?: boolean;
  target(value: string, match: PackageTargetMatch): PackageMapSteps<T>;
  invalidTarget(value: unknown, match: PackageTargetMatch): Error;
  invalidConfig(reason: 'mixed' | 'numeric'): Error;
}

const codeOf = (error: unknown): unknown =>
  error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;

/** Node's PATTERN_KEY_COMPARE: prefix first, then trailer, not total length. */
export function patternKeyCompare(a: string, b: string): number {
  const aStar = a.indexOf('*');
  const bStar = b.indexOf('*');
  const baseA = aStar === -1 ? a.length : aStar + 1;
  const baseB = bStar === -1 ? b.length : bStar + 1;
  if (baseA > baseB) return -1;
  if (baseB > baseA) return 1;
  if (aStar === -1) return 1;
  if (bStar === -1) return -1;
  return b.length - a.length;
}

/**
 * One exact/sugar/pattern selection and target traversal for exports/imports.
 * undefined is unmatched; null is blocked. A blocked condition or best pattern
 * never falls back to a sibling. Arrays retain Node's last-null/invalid-target
 * rule (a null array element is not a conditional fallback).
 */
export function* selectPackageMap<T>(
  field: unknown, name: string, conditions: ReadonlySet<string> | readonly string[], policy: PackageMapPolicy<T>,
): PackageMapSteps<T | null | undefined> {
  const active = conditions instanceof Set ? conditions : new Set(conditions);
  function* target(value: unknown, match: PackageTargetMatch): PackageMapSteps<T | null | undefined> {
    if (typeof value === 'string') return yield* policy.target(value, match);
    if (Array.isArray(value)) {
      if (value.length === 0) return null;
      let last: unknown;
      for (const item of value) {
        let result: T | null | undefined;
        try { result = yield* target(item, match); }
        catch (error) {
          if (codeOf(error) !== 'ERR_INVALID_PACKAGE_TARGET') throw error;
          last = error;
          continue;
        }
        if (result === undefined || (policy.permissive && result === '')) continue;
        if (result === null) { last = null; continue; }
        return result;
      }
      if (last === undefined || last === null) return last;
      throw last;
    }
    if (value === null) return null;
    if (typeof value === 'object' && value !== null) {
      const keys = Object.getOwnPropertyNames(value);
      if (!policy.permissive && keys.some((key) => /^\d+$/.test(key) && String(Number(key)) === key && Number(key) < 4294967295)) {
        throw policy.invalidConfig('numeric');
      }
      for (const key of keys) {
        if (key !== 'default' && !active.has(key)) continue;
        const result = yield* target(Reflect.get(value, key), match);
        if (result === undefined || (policy.permissive && (result === null || result === ''))) continue;
        return result;
      }
      return undefined;
    }
    if (policy.permissive) return undefined;
    throw policy.invalidTarget(value, match);
  }

  if (field === undefined) return undefined;
  if (field === null) return null;
  let map: Record<string, unknown>;
  if (!policy.internal) {
    let sugar = typeof field !== 'object' || Array.isArray(field);
    if (typeof field === 'object' && !Array.isArray(field)) {
      const keys = Object.getOwnPropertyNames(field);
      sugar = keys.length > 0 && !keys[0].startsWith('.');
      if (!policy.permissive && keys.some((key) => !key.startsWith('.') !== sugar)) throw policy.invalidConfig('mixed');
    }
    map = sugar ? { '.': field } : field as Record<string, unknown>;
  } else {
    if (typeof field !== 'object' || Array.isArray(field)) return undefined;
    map = field as Record<string, unknown>;
  }
  const match = (key: string, subpath: string, pattern: boolean): PackageTargetMatch =>
    ({ key, subpath, pattern, internal: policy.internal, isPathMap: !policy.internal && name.endsWith('/') });
  if (Object.prototype.hasOwnProperty.call(map, name) && (policy.permissive || (!name.includes('*') && !name.endsWith('/')))) {
    return yield* target(map[name], match(name, '', false));
  }
  const candidates = Object.getOwnPropertyNames(map).filter((key) => {
    const star = key.indexOf('*');
    if (star === -1 || (!policy.permissive && key.lastIndexOf('*') !== star)) return false;
    const trailer = key.slice(star + 1);
    return name.startsWith(key.slice(0, star)) && name.endsWith(trailer)
      && name.length >= (policy.permissive ? key.length - 1 : key.length);
  }).sort(policy.permissive ? (a, b) => b.length - a.length : patternKeyCompare);
  for (const key of candidates) {
    const star = key.indexOf('*');
    const subpath = name.slice(star, name.length - (key.length - star - 1));
    const result = yield* target(map[key], match(key, subpath, true));
    if (!policy.permissive || (result != null && result !== '') || map[key] === null) return result;
  }
  return undefined;
}

/** Old build/browser tolerance is explicit, and never used by Node resolution. */
export const BUILD_BROWSER_PACKAGE_MAP_POLICY: PackageMapPolicy<string> = {
  name: 'build-browser-permissive',
  internal: false,
  permissive: true,
  *target(value, match) { return match.pattern ? value.split('*').join(match.subpath) : value; },
  invalidTarget: () => new Error('Invalid build/browser package target'),
  invalidConfig: () => new Error('Invalid build/browser package map'),
};

/** Compatibility surface for install/bundler/browser callers. */
export function resolveExports(
  exportsField: ExportsField | undefined,
  subpath: string = '.',
  conditions: string[] = DEFAULT_BUILD_CONDITIONS,
  policy: PackageMapPolicy<string> = BUILD_BROWSER_PACKAGE_MAP_POLICY,
): string | null {
  const steps = selectPackageMap(exportsField, subpath, conditions, {
    ...policy, internal: subpath.startsWith('#'),
  });
  const next = steps.next();
  if (!next.done) throw new Error('The build/browser package-map policy must be synchronous');
  return next.value ?? null;
}

/**
 * A package resolution error Node's JavaScript gives an `ERR_*` code: its
 * internal NodeError, `Name [CODE]: message` in its toString() and its stack
 * (lib/internal/errors.js). A module not found by require() is not one:
 * Node's CJS loader makes that a plain Error, its `code` MODULE_NOT_FOUND.
 */
export function resolutionError(code: string, message: string, Type: ErrorConstructor | TypeErrorConstructor = Error): Error {
  return nodeError(Type, code, message, undefined, resolutionError);
}

/**
 * A package resolution error Node 22 throws from C++ (node_errors.h
 * THROW_ERR_*): a package.json it cannot parse (node_modules.cc), a package
 * main legacyMainResolve does not find (node_file.cc). A plain Error with its
 * code, `Error: message` in its toString() and its stack, as V8 makes it.
 */
export function nativeResolutionError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * Node's leaf validation and error construction, shared by CJS and ESM.
 * A bare imports target is delegated to the caller's package resolver; any
 * host questions it yields remain inside the same array traversal.
 */
export function createNodePackageMapPolicy(
  packageJsonUrl: URL, base: string, internal: boolean,
  resolveBare: (specifier: string) => PackageMapSteps<URL>,
): PackageMapPolicy<URL> {
  const path = (url: URL): string => decodeURIComponent(url.pathname);
  const pjsonPath = path(packageJsonUrl);
  const root = new URL('.', packageJsonUrl);
  const error = resolutionError;
  function invalidTarget(value: unknown, match: PackageTargetMatch): Error {
    const text = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
    const related = !internal && text.length > 0 && !text.startsWith('./');
    const tail = `in the package config ${path(root)}package.json imported from ${base}${related ? '; targets must start with "./"' : ''}`;
    return error('ERR_INVALID_PACKAGE_TARGET', match.key === '.'
      ? `Invalid "exports" main target ${JSON.stringify(text)} defined ${tail}`
      : `Invalid "${internal ? 'imports' : 'exports'}" target ${JSON.stringify(text)} defined for '${match.key}' ${tail}`);
  }
  // Empty segments are deprecated by Node, but dot/dotdot/node_modules
  // segments (including percent-encoded spellings) are invalid.
  const invalidSegments = (text: string): boolean => text.split(/[\\/]/).some((segment) => {
    let decoded: string;
    try { decoded = decodeURIComponent(segment); } catch { decoded = segment; }
    return decoded === '.' || decoded === '..' || decoded.toLowerCase() === 'node_modules';
  });
  return {
    name: 'node-package-map',
    internal,
    invalidTarget,
    invalidConfig(reason) {
      const baseUrl = new URL('file://');
      baseUrl.pathname = base;
      const detail = reason === 'numeric'
        ? '"exports" cannot contain numeric property keys.'
        : '"exports" cannot contain some keys starting with \'.\' and some not. The exports object must either be an object of package subpath keys or an object of main entry condition name keys only.';
      return error('ERR_INVALID_PACKAGE_CONFIG', `Invalid package config ${pjsonPath} while importing ${baseUrl.href}. ${detail}`);
    },
    *target(value, match) {
      if (!value.startsWith('./')) {
        if (internal && !value.startsWith('../') && !value.startsWith('/')) {
          let isUrl = false;
          try { new URL(value); isUrl = true; } catch { /* a bare package */ }
          if (!isUrl) return yield* resolveBare(match.pattern ? value.replace(/\*/g, () => match.subpath) : value);
        }
        throw invalidTarget(value, match);
      }
      if (invalidSegments(value.slice(2))) throw invalidTarget(value, match);
      const resolved = new URL(value, packageJsonUrl);
      if (!resolved.pathname.startsWith(root.pathname)) throw invalidTarget(value, match);
      if (!match.subpath) return resolved;
      if (invalidSegments(match.subpath) && !match.isPathMap) {
        const request = match.pattern ? match.key.replace('*', () => match.subpath) : match.key + match.subpath;
        throw error('ERR_INVALID_MODULE_SPECIFIER',
          `Invalid module "${request}" request is not a valid match in pattern "${match.key}" for the "${internal ? 'imports' : 'exports'}" resolution of ${pjsonPath} imported from ${base}`, TypeError);
      }
      return new URL(resolved.href.replace(/\*/g, () => match.subpath));
    },
  };
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
  conditions: string[] = DEFAULT_BUILD_CONDITIONS,
  policy: PackageMapPolicy<string> = BUILD_BROWSER_PACKAGE_MAP_POLICY,
): string | null {
  // 1. exports field
  if (pkg.exports !== undefined && pkg.exports !== null) {
    const entry = resolveExports(pkg.exports, subpath, conditions, policy);
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
