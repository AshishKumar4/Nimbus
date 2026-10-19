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

import { nodeError } from './node-error.js';
import {
  arrayIsArray, arraySort, dataDescriptor, decodeURIComponentOf, Error, JSONStringify, newURL, NumberOf, objectGetOwnPropertyNames,
  objectHasOwn, ownField, reflectDefineProperty, reflectGet, SafeList, SafeSet, safeGenerator, setForEach, stringCharCodeAt, stringEndsWith,
  stringIncludes, stringIndexOf, stringLastIndexOf, stringOf, stringSlice, stringStartsWith, stringToLowerCase, TypeError,
} from './primordials.js';

/** Node 22.12+ defaults. `default` is always active, not a user condition. */
export const DEFAULT_ESM_CONDITIONS = ['import', 'node', 'node-addons', 'module-sync'];

/** Default conditions for CJS runtime resolution (user-shell node). */
export const DEFAULT_CJS_CONDITIONS = ['require', 'node', 'node-addons', 'module-sync'];

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

// A URL's members, read as Node's resolver reads them: live, through the
// realm's URL.prototype accessors (lib/internal/url.js's own), so a program
// that replaced one breaks module resolution as it breaks Node's. The URL
// itself is made with the constructor captured at the launch (newURL), as
// Node's internal URL class is its own.
export const urlHref = (url: URL): string => url.href; // as Node's, live: URL.prototype.href
export const urlProtocol = (url: URL): string => url.protocol; // as Node's, live: URL.prototype.protocol
export const urlPathname = (url: URL): string => url.pathname; // as Node's, live: URL.prototype.pathname
export const urlSearch = (url: URL): string => url.search; // as Node's, live: URL.prototype.search
export const urlHash = (url: URL): string => url.hash; // as Node's, live: URL.prototype.hash
export const urlSetPathname = (url: URL, pathname: string): void => { url.pathname = pathname; }; // as Node's, live: URL.prototype.pathname
export const urlSetSearch = (url: URL, search: string): void => { url.search = search; }; // as Node's, live: URL.prototype.search
export const urlSetHash = (url: URL, hash: string): void => { url.hash = hash; }; // as Node's, live: URL.prototype.hash

/** An error's `code`, as Node's resolver reads it. */
export function codeOf(error: unknown): unknown {
  return error !== null && typeof error === 'object' ? reflectGet(error, 'code') : undefined;
}

/**
 * A package.json's text as Node's reader parses it: a leading byte order
 * mark skipped (src/node_modules.cc, whose simdjson skips one). The file
 * itself keeps it: a copy of one, a module map's cell, is every byte.
 */
export function packageJsonText(text: string): string {
  return stringCharCodeAt(text, 0) === 0xfeff ? stringSlice(text, 1) : text;
}

/** Node's PATTERN_KEY_COMPARE: prefix first, then trailer, not total length. */
export function patternKeyCompare(a: string, b: string): number {
  const aStar = stringIndexOf(a, '*');
  const bStar = stringIndexOf(b, '*');
  const baseA = aStar === -1 ? a.length : aStar + 1;
  const baseB = bStar === -1 ? b.length : bStar + 1;
  if (baseA > baseB) return -1;
  if (baseB > baseA) return 1;
  if (aStar === -1) return 1;
  if (bStar === -1) return -1;
  return b.length - a.length;
}

/** A key that is an array index (`/^\d+$/`, canonical, below 2 ** 32 - 1): Node refuses one in `exports`. */
function isArrayIndexKey(key: string): boolean {
  if (key.length === 0) return false;
  for (let i = 0; i < key.length; i++) {
    const code = stringCharCodeAt(key, i);
    if (code < 48 || code > 57) return false;
  }
  return stringOf(NumberOf(key)) === key && NumberOf(key) < 4294967295;
}

/** `text` with every `*` replaced by `subpath` (Node's RegExpPrototypeSymbolReplace(/\*\/g, ...)). */
function replaceStars(text: string, subpath: string): string {
  let out = '';
  let from = 0;
  for (let star = stringIndexOf(text, '*'); star !== -1; star = stringIndexOf(text, '*', from)) {
    out += stringSlice(text, from, star) + subpath;
    from = star + 1;
  }
  return out + stringSlice(text, from);
}

/** Whether `conditions` are a list (Array.isArray, which narrows no readonly array in TypeScript's types). */
function isConditionList(conditions: ReadonlySet<string> | readonly string[]): conditions is readonly string[] {
  return arrayIsArray(conditions);
}

/** `conditions` as a set whose methods a program cannot replace: a SafeSet as it is, an array's or a Set's members copied. */
function activeConditions(conditions: ReadonlySet<string> | readonly string[]): SafeSet<string> {
  if (conditions instanceof SafeSet) return conditions;
  const active = new SafeSet<string>();
  if (isConditionList(conditions)) {
    for (let i = 0; i < conditions.length; i++) active.add(conditions[i]);
  } else {
    setForEach(conditions, (condition) => { active.add(condition); });
  }
  return active;
}

/**
 * One exact/sugar/pattern selection and target traversal for exports/imports.
 * undefined is unmatched; null is blocked. A blocked condition or best pattern
 * never falls back to a sibling. Arrays retain Node's last-null/invalid-target
 * rule (a null array element is not a conditional fallback).
 */
export function selectPackageMap<T>(
  field: unknown, name: string, conditions: ReadonlySet<string> | readonly string[], policy: PackageMapPolicy<T>,
): PackageMapSteps<T | null | undefined> {
  return selectSteps(field, name, activeConditions(conditions), policy);
}

/** A package map's target `value`, selected by `active` conditions under `policy` (PACKAGE_TARGET_RESOLVE). */
const selectTarget = safeGenerator(function* <T>(
  value: unknown, match: PackageTargetMatch, active: SafeSet<string>, policy: PackageMapPolicy<T>,
): PackageMapSteps<T | null | undefined> {
  if (typeof value === 'string') return yield* policy.target(value, match);
  if (arrayIsArray(value)) {
    const items: readonly unknown[] = value;
    if (items.length === 0) return null;
    let last: unknown;
    for (let i = 0; i < items.length; i++) {
      let result: T | null | undefined;
      try { result = yield* selectTarget(items[i], match, active, policy); }
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
  if (typeof value === 'object') {
    const keys = objectGetOwnPropertyNames(value);
    if (!policy.permissive) {
      for (let i = 0; i < keys.length; i++) if (isArrayIndexKey(keys[i])) throw policy.invalidConfig('numeric');
    }
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (key !== 'default' && !active.has(key)) continue;
      const result = yield* selectTarget(reflectGet(value, key), match, active, policy);
      if (result === undefined || (policy.permissive && (result === null || result === ''))) continue;
      return result;
    }
    return undefined;
  }
  if (policy.permissive) return undefined;
  throw policy.invalidTarget(value, match);
});

const selectSteps = safeGenerator(function* <T>(
  field: unknown, name: string, active: SafeSet<string>, policy: PackageMapPolicy<T>,
): PackageMapSteps<T | null | undefined> {
  const target = (value: unknown, match: PackageTargetMatch): PackageMapSteps<T | null | undefined> => selectTarget(value, match, active, policy);

  if (field === undefined) return undefined;
  if (field === null) return null;
  let map: object;
  if (!policy.internal) {
    if (typeof field === 'object' && !arrayIsArray(field)) {
      const keys = objectGetOwnPropertyNames(field);
      const sugar = keys.length > 0 && !stringStartsWith(keys[0], '.');
      if (!policy.permissive) {
        for (let i = 0; i < keys.length; i++) if (!stringStartsWith(keys[i], '.') !== sugar) throw policy.invalidConfig('mixed');
      }
      map = sugar ? { '.': field } : field;
    } else {
      map = { '.': field };
    }
  } else {
    if (typeof field !== 'object' || arrayIsArray(field)) return undefined;
    map = field;
  }
  const match = (key: string, subpath: string, pattern: boolean): PackageTargetMatch =>
    ({ key, subpath, pattern, internal: policy.internal, isPathMap: !policy.internal && stringEndsWith(name, '/') });
  if (objectHasOwn(map, name) && (policy.permissive || (!stringIncludes(name, '*') && !stringEndsWith(name, '/')))) {
    return yield* target(reflectGet(map, name), match(name, '', false));
  }
  const keys = objectGetOwnPropertyNames(map);
  const candidates = new SafeList<string>();
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const star = stringIndexOf(key, '*');
    if (star === -1 || (!policy.permissive && stringLastIndexOf(key, '*') !== star)) continue;
    const trailer = stringSlice(key, star + 1);
    if (stringStartsWith(name, stringSlice(key, 0, star)) && stringEndsWith(name, trailer)
      && name.length >= (policy.permissive ? key.length - 1 : key.length)) candidates[candidates.length] = key;
  }
  arraySort(candidates, policy.permissive ? (a, b) => b.length - a.length : patternKeyCompare);
  for (let i = 0; i < candidates.length; i++) {
    const key = candidates[i];
    const star = stringIndexOf(key, '*');
    const subpath = stringSlice(name, star, name.length - (key.length - star - 1));
    const value = reflectGet(map, key);
    const result = yield* target(value, match(key, subpath, true));
    if (!policy.permissive || (result != null && result !== '') || value === null) return result;
  }
  return undefined;
});

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
export function packageSelfReferenceSubpath(pkg: SelfReferencingPackageJson | null | undefined, specifier: string): string | null {
  if (!pkg) return null;
  const name = ownField(pkg, 'name');
  const exportsField = ownField(pkg, 'exports');
  if (typeof name !== 'string' || name.length === 0) return null;
  if (exportsField === undefined || exportsField === null) return null;
  if (specifier === name) return '.';
  if (!stringStartsWith(specifier, `${name}/`)) return null;
  return `.${stringSlice(specifier, name.length)}`;
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
  const error = new Error(message);
  reflectDefineProperty(error, 'code', dataDescriptor(code, true, true, true));
  return error;
}

/** What a Node package map's target is checked against (createNodePackageMapPolicy). */
interface NodeMapState {
  readonly packageJsonUrl: URL;
  readonly pjsonPath: string;
  readonly root: URL;
  readonly base: string;
  readonly internal: boolean;
  readonly resolveBare: (specifier: string) => PackageMapSteps<URL>;
}

/** decodeURIComponent of a URL's path. */
function urlFilePath(url: URL): string {
  return decodeURIComponentOf(urlPathname(url));
}

/** Node's ERR_INVALID_PACKAGE_TARGET for `value` at `match`. */
function invalidNodeTarget(state: NodeMapState, value: unknown, match: PackageTargetMatch): Error {
  const text = typeof value === 'object' && value !== null ? JSONStringify(value) : stringOf(value);
  const related = !state.internal && text.length > 0 && !stringStartsWith(text, './');
  const tail = `in the package config ${urlFilePath(state.root)}package.json imported from ${state.base}${related ? '; targets must start with "./"' : ''}`;
  return resolutionError('ERR_INVALID_PACKAGE_TARGET', match.key === '.'
    ? `Invalid "exports" main target ${JSONStringify(text)} defined ${tail}`
    : `Invalid "${state.internal ? 'imports' : 'exports'}" target ${JSONStringify(text)} defined for '${match.key}' ${tail}`);
}

/**
 * Whether `text` has a dot, dotdot or node_modules segment (including
 * percent-encoded spellings), which Node refuses; empty segments it only
 * deprecates.
 */
function invalidSegments(text: string): boolean {
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i < text.length && text[i] !== '/' && text[i] !== '\\') continue;
    const segment = stringSlice(text, start, i);
    start = i + 1;
    let decoded: string;
    try { decoded = decodeURIComponentOf(segment); } catch { decoded = segment; }
    if (decoded === '.' || decoded === '..' || stringToLowerCase(decoded) === 'node_modules') return true;
  }
  return false;
}

/** A Node package map's string target (PACKAGE_TARGET_RESOLVE's leaf). */
const nodeMapTarget = safeGenerator(function* (state: NodeMapState, value: string, match: PackageTargetMatch): PackageMapSteps<URL> {
  if (!stringStartsWith(value, './')) {
    if (state.internal && !stringStartsWith(value, '../') && !stringStartsWith(value, '/')) {
      let isUrl = false;
      try { newURL(value); isUrl = true; } catch { /* a bare package */ }
      if (!isUrl) return yield* state.resolveBare(match.pattern ? replaceStars(value, match.subpath) : value);
    }
    throw invalidNodeTarget(state, value, match);
  }
  if (invalidSegments(stringSlice(value, 2))) throw invalidNodeTarget(state, value, match);
  const resolved = newURL(value, state.packageJsonUrl);
  if (!stringStartsWith(urlPathname(resolved), urlPathname(state.root))) throw invalidNodeTarget(state, value, match);
  if (!match.subpath) return resolved;
  if (invalidSegments(match.subpath) && !match.isPathMap) {
    const star = stringIndexOf(match.key, '*');
    const request = !match.pattern ? match.key + match.subpath
      : star === -1 ? match.key : stringSlice(match.key, 0, star) + match.subpath + stringSlice(match.key, star + 1);
    throw resolutionError('ERR_INVALID_MODULE_SPECIFIER',
      `Invalid module "${request}" request is not a valid match in pattern "${match.key}" for the "${state.internal ? 'imports' : 'exports'}" resolution of ${state.pjsonPath} imported from ${state.base}`, TypeError);
  }
  return newURL(replaceStars(urlHref(resolved), match.subpath));
});

/**
 * Node's leaf validation and error construction, shared by CJS and ESM.
 * A bare imports target is delegated to the caller's package resolver; any
 * host questions it yields remain inside the same array traversal.
 */
export function createNodePackageMapPolicy(
  packageJsonUrl: URL, base: string, internal: boolean,
  resolveBare: (specifier: string) => PackageMapSteps<URL>,
): PackageMapPolicy<URL> {
  const state: NodeMapState = { packageJsonUrl, pjsonPath: urlFilePath(packageJsonUrl), root: newURL('.', packageJsonUrl), base, internal, resolveBare };
  return {
    name: 'node-package-map',
    internal,
    permissive: false,
    invalidTarget: (value, match) => invalidNodeTarget(state, value, match),
    invalidConfig(reason) {
      const baseUrl = newURL('file://');
      urlSetPathname(baseUrl, base);
      const detail = reason === 'numeric'
        ? '"exports" cannot contain numeric property keys.'
        : '"exports" cannot contain some keys starting with \'.\' and some not. The exports object must either be an object of package subpath keys or an object of main entry condition name keys only.';
      return resolutionError('ERR_INVALID_PACKAGE_CONFIG', `Invalid package config ${state.pjsonPath} while importing ${urlHref(baseUrl)}. ${detail}`);
    },
    target: (value, match) => nodeMapTarget(state, value, match),
  };
}
