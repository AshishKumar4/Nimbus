/**
 * exports-resolver.ts — Single source of truth for `package.json#exports` /
 * `package.json#imports` resolution per the Node.js spec.
 *
 * Used in three contexts:
 *
 *   1. Install-time supervisor (TS) — `src/npm-resolver.ts` re-exports the
 *      typed functions for tree resolution.
 *
 *   2. NimbusLoaderPool isolates (JS string) — `src/parallel/pre-bundle-preamble.ts`
 *      embeds `getExportsResolverJS()` as part of the pool preamble so the
 *      pre-bundle facet uses identical resolution semantics to the supervisor.
 *
 *   3. User-shell `node` runtime (JS string) — `src/node-shims.ts` embeds
 *      the same JS source so `require()` from inside a user's `node` script
 *      sees the same exports map as the install pipeline.
 *
 * Audit reference: audit/sections/03-resolver-gaps.md §3.1, §3.2.
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
 * Resolve `package.json#exports` (or `#imports`) per Node spec.
 *
 * @param exportsField  Raw value from package.json#exports or #imports
 * @param subpath       '.' for root, './foo' for subpath, '#name' for imports
 * @param conditions    Active conditions, in priority order
 * @returns             Relative path target string, or null if not found / forbidden
 */
export function resolveExports(
  exportsField: any,
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
  target: any,
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
 * Priority: exports → module → main → null.
 * For non-root subpaths without an `exports` field, returns the subpath
 * itself (caller probes filesystem with extension-list).
 */
export function resolvePackageEntry(
  pkg: { exports?: any; module?: string; main?: string },
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
  }

  // 2. Root entry: module → main
  if (subpath === '.') {
    if (pkg.module) return pkg.module;
    if (pkg.main) return pkg.main;
    return null;
  }

  // 3. Non-root subpath without exports — caller probes raw subpath
  return subpath;
}

// ─── JS-source emission for embedding into facet preambles ───────────────

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
 * verification probe in audit/probes that compares parity.
 */
export function getExportsResolverJS(): string {
  return `
// ── exports-resolver.js (auto-generated; keep in sync with src/_shared/exports-resolver.ts) ──
const DEFAULT_ESM_CONDITIONS = ['import', 'module', 'browser', 'default'];
const DEFAULT_CJS_CONDITIONS = ['require', 'node', 'default'];

function resolveExports(exportsField, subpath, conditions) {
  if (subpath === undefined) subpath = '.';
  if (!conditions) conditions = DEFAULT_ESM_CONDITIONS;
  if (exportsField === undefined || exportsField === null) return null;
  if (typeof exportsField === 'string') {
    return subpath === '.' ? exportsField : null;
  }
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
  const isSubpathMap = keys[0].startsWith('.') || keys[0].startsWith('#');
  if (isSubpathMap) {
    if (subpath in exportsField) {
      const target = exportsField[subpath];
      if (target === null) return null;
      return resolveConditionValue(target, conditions);
    }
    const wildcardKeys = keys
      .filter(k => k.includes('*'))
      .sort((a, b) => b.length - a.length);
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
  if (subpath !== '.') return null;
  return resolveConditionValue(exportsField, conditions);
}

function resolveConditionValue(target, conditions) {
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
  for (const cond of conditions) {
    if (cond in target) {
      const r = resolveConditionValue(target[cond], conditions);
      if (r) return r;
    }
  }
  if (!conditions.includes('default') && 'default' in target) {
    return resolveConditionValue(target.default, conditions);
  }
  return null;
}

function resolvePackageEntry(pkg, subpath, conditions) {
  if (subpath === undefined) subpath = '.';
  if (!conditions) conditions = DEFAULT_ESM_CONDITIONS;
  if (pkg.exports !== undefined && pkg.exports !== null) {
    const entry = resolveExports(pkg.exports, subpath, conditions);
    if (entry) return entry;
  }
  if (subpath === '.') {
    if (pkg.module) return pkg.module;
    if (pkg.main) return pkg.main;
    return null;
  }
  return subpath;
}
// ── end exports-resolver.js ────────────────────────────────────────────
`;
}
