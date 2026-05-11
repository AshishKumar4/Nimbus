/**
 * require-resolver.ts — Server-side dependency graph resolver for Nimbus.
 *
 * Runs on the supervisor (which has synchronous VFS access) to trace
 * all require() calls and build a complete file bundle reachable from
 * the entry point. The output is consumed by `facet-manager.ts`'s
 * `buildPrefetchBundle` (W2.6a) to ship ONLY the reachable set into
 * the dynamic-worker module (rather than every file in node_modules
 * up to the legacy cap).
 *
 * Algorithm:
 *   1. Parse `require('xxx')` / `require("xxx")` / ``require(`xxx`)``
 *      and `require.resolve('xxx')` calls from entry code via regex.
 *   2. Resolve each via the SHARED `resolvePackageEntry` helper from
 *      src/_shared/exports-resolver.ts — same impl that node-shims
 *      and npm-resolver use, so prefetch and runtime always agree on
 *      which file `require('xyz')` means (W2.6a D6: no dual impls).
 *   3. Read the resolved file, recursively parse ITS requires.
 *   4. Return Record<string, string> of path → content.
 *
 * Limits (sub-agent §Q1 caveats — extended regex still misses dynamic
 * requires like `require(variable)` and ESM `import` statements; greedy
 * oversampling in facet-manager.ts:buildPrefetchBundle compensates).
 *
 * History: this file was ARC-A-P1 quarantined after W2 because the
 * legacy `buildVfsBundle` walked every file in node_modules. W2.6a
 * de-quarantines it as the primary content-bundle source.
 */

import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
import {
  resolvePackageEntry as sharedResolvePackageEntry,
  resolveExports as sharedResolveExports,
  DEFAULT_CJS_CONDITIONS,
} from '../_shared/exports-resolver.js';

// Match literal-string require/require.resolve with single, double, or
// template-literal-no-interp specifier. The plain-string variant is by
// far the dominant npm pattern; the others catch a long tail of
// well-known cases (esbuild plugins, vite internals).
const REQUIRE_RE = /(?:require(?:\.resolve)?\s*\(\s*)(['"`])([^'"`]+?)\1\s*\)/g;

// X.5-C Fix #1: match ESM `import` and `export … from` statements.
//
// Why a second regex (not a unified one): REQUIRE_RE matches require(…)
// CALL EXPRESSIONS — those can appear anywhere (inside function bodies,
// conditionals, etc.). ESM import/export are STATEMENTS — they can only
// appear at the top of a line (modulo whitespace). Anchoring at start-of-
// line `(^|\n)\s*` avoids matching the substring `import` inside string
// literals or identifiers like `obj.import`. Same anchor strategy that
// `looksLikeEsm` in facet-manager.ts uses (precedent set by W3.5 Fix B).
//
// Forms covered by IMPORT_RE:
//   import 'x';                          ← side-effect (no `from`)
//   import x from 'x';                   ← default
//   import * as x from 'x';              ← namespace
//   import {a, b as c} from 'x';         ← named
//   import x, {a} from 'x';              ← mixed default+named
//   export {a, b} from 'x';              ← re-export named
//   export * from 'x';                   ← re-export wildcard
//   export * as ns from 'x';             ← re-export wildcard with alias
//   export {default as x} from 'x';      ← named-as-default re-export
//
// NOT covered (deliberate):
//   import('x') / import.meta.<x>       ← dynamic — needs full parsing;
//                                          out of scope for prefetch.
//   `import type {…} from 'x'` (TypeScript) ← matched, but the resolver
//                                          returns null on .d.ts-only
//                                          specifiers and the walk no-ops.
//
// The middle group `[\w*${},\s{}]*` covers the practical identifier /
// destructuring shapes; alternation `(?:…)?` allows the `from` segment
// to be omitted (side-effect imports). String literal at the end is a
// single- or double-quoted spec.
//
// X.5-Z5 §3 (extended): leading anchor relaxed from (^|\n) to (^|[\n;}])
// AND the body widened to optionally allow no-whitespace `import{` /
// `export{` shapes. Same dual-relaxation as src/facet-manager.ts
// looksLikeEsm — minified ESM bundles (notably @tailwindcss/vite/dist/
// index.mjs) put the first `;import{...}from"..."` after a `;` on the
// same line, which the original anchor missed → prefetch walker silently
// failed to follow the transitive deps. See audit/sections/X5Z5-build-retro.md §3.
//
// Edge: a literal `\nimport x from 'y'` inside a multi-line string would
// false-positive. The walker no-ops on missed resolutions, so it's a
// minor wasted-work cost, not a correctness issue.
const IMPORT_RE = /(?:^|[\n;}])\s*(?:import|export)(?:[\s{][\w*${}\s,]*?\s*from)?\s*(['"])([^'"]+)\1/g;

const MAX_FILES = 4000;
const MAX_BYTES = 24 * 1024 * 1024; // 24 MiB raw — facet-manager re-caps on JSON-encoded size.

function strip(p: string): string { return p.replace(/^\/+/, ''); }

function normalizePath(p: string): string {
  const segments = p.split('/');
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === '..' && out.length > 0) out.pop();
    else if (seg !== '.' && seg !== '') out.push(seg);
  }
  return out.join('/');
}

/**
 * Extension-list probe; mirrors node-shims.ts:__resolveFile so prefetch
 * picks the same on-disk file the runtime require will pick.
 *
 * Mirrors Node's LOAD_AS_FILE + LOAD_AS_DIRECTORY (require_2 spec):
 *   1. LOAD_AS_FILE: base, base.js, base.mjs, base.cjs, base.json.
 *   2. LOAD_AS_DIRECTORY (if base resolves to a directory):
 *      a. <base>/package.json#main → recurse.
 *      b. <base>/index.{js,cjs,mjs,json}.
 *
 * Bug class C (audit 2026-05-11): step 2a was missing, so prefetch
 * silently dropped any file reachable only via package.json#main from
 * a directory-style require (e.g. `require('./mod')` where mod has
 * main='entry.js' and no index.js).
 */
function resolveFile(vfs: SqliteVFS, base: string): string | null {
  const fileExts = ['', '.js', '.mjs', '.cjs', '.json'];
  for (const ext of fileExts) {
    const p = normalizePath(base + ext);
    if (vfs.exists(p) && !vfs.isDirectory(p)) return p;
  }
  // LOAD_AS_DIRECTORY: prefer package.json#main over index.*
  const baseTrim = base.replace(/\/+$/, '');
  const pkgJsonPath = normalizePath(baseTrim + '/package.json');
  if (vfs.exists(pkgJsonPath) && !vfs.isDirectory(pkgJsonPath)) {
    let pkg: any = null;
    try { pkg = JSON.parse(vfs.readFileString(pkgJsonPath)); } catch { /* fall through */ }
    if (pkg && typeof pkg.main === 'string' && pkg.main.length > 0) {
      const mainStripped = pkg.main.replace(/^\.\/+/, '').replace(/^\/+/, '');
      const mainBase = baseTrim + '/' + mainStripped;
      // Guard against pkg.main === '.' or empty → would re-enter same base.
      if (mainBase !== base && mainBase !== baseTrim) {
        const resolved = resolveFile(vfs, mainBase);
        if (resolved) return resolved;
      }
    }
  }
  const indexExts = ['/index.js', '/index.cjs', '/index.mjs', '/index.json'];
  for (const ext of indexExts) {
    const p = normalizePath(base + ext);
    if (vfs.exists(p) && !vfs.isDirectory(p)) return p;
  }
  return null;
}

/**
 * X.5-L: result shape for `resolvePkgSubpathEx`. When a bare-spec
 * subpath resolves via the LEGACY directory-with-nested-package.json
 * pattern (e.g. `react-remove-scroll-bar/constants` where there's no
 * top-level `exports` field but `<pkgDir>/constants/package.json`
 * exists), we need to ship TWO bundle entries:
 *
 *   - the real resolved file at its canonical VFS path (so its own
 *     relative requires walk correctly), AND
 *   - a SYNTHETIC STUB at the path the runtime resolver probes for
 *     (`<pkgDir>/<subpath>.js`), since the runtime
 *     `__resolvePkgSubpath` mirror in node-shims.ts also misses the
 *     legacy directory pattern (X.5-M will fix runtime parity; until
 *     then, the stub bridges the gap).
 *
 * The stub is a minimal CJS re-export:
 *   `module.exports = require('./<rel-path-to-real-target>');`
 *
 * The relative path is computed from `<pkgDir>` (stub's modDir) to
 * the real resolved file. At runtime, the runtime resolver's
 * extension probe finds the stub at `<pkgDir>/<subpath>.js` (the
 * `.js` ext probe), loads it, the stub's relative require resolves
 * to the real file, and the load chain proceeds normally.
 */
interface ResolveSubpathResult {
  /** Canonical resolved path to the real file. */
  resolved: string;
  /**
   * Optional synthetic stub to inject into the bundle at this path
   * with this content, so the runtime resolver can find it via
   * extension-list probe.
   */
  stub?: { path: string; content: string };
}

/**
 * Resolve a package's entry-point file via the SHARED resolver. The
 * pre-W2.6a implementation here had a hand-rolled `pkg.exports['.']`
 * lookup that ignored conditions, wildcards, and nested condition maps
 * — diverging from runtime semantics. Now both use the same impl.
 *
 * Returns null when no resolution is possible.
 */

/**
 * X.5-L: extended resolver. Same semantics as the original
 * resolvePkgSubpath (pre-X.5-L) for the common-case paths, plus a
 * legacy-directory-subpath fallback that emits a synthetic stub.
 *
 * Resolution order:
 *   1. `package.json#exports[<subpath>]` via shared resolver, condition=require.
 *   2. For root subpath ('.'): `pkg.main` then `<pkgDir>/index.{js,…}`.
 *   3. For non-root subpath: extension-probe `<pkgDir>/<subpath>` directly.
 *   4. **NEW (X.5-L):** if `<pkgDir>/<subpath>` is a directory, look
 *      for a nested `package.json` and follow its `module`/`main`
 *      relative to the subpath dir. This is the legacy pre-`exports`
 *      convention used by react-remove-scroll-bar/constants and
 *      similar (verbatim shape: `<pkgDir>/<sub>/package.json` with
 *      `main: "../dist/sub.js"`). Emits a stub at `<pkgDir>/<subpath>.js`
 *      (and `<pkgDir>/<subpath>` no-ext) so the runtime resolver
 *      finds it through its extension-probe loop without needing
 *      a runtime-side fix.
 */
function resolvePkgSubpathEx(vfs: SqliteVFS, pkgDir: string, subpath: string): ResolveSubpathResult | null {
  const pkgJsonPath = pkgDir + '/package.json';
  if (!vfs.exists(pkgJsonPath)) {
    // No package.json — direct probe (matches node-shims fallback).
    if (subpath === '.') {
      const r = resolveFile(vfs, pkgDir + '/index');
      return r ? { resolved: r } : null;
    }
    const r = resolveFile(vfs, pkgDir + '/' + subpath.replace(/^\.\//, ''));
    if (r) return { resolved: r };
    // Even with no parent package.json, attempt the legacy nested-pkg
    // fallback (consistent behaviour across the no-pkgjson branch).
    return tryLegacyDirectorySubpath(vfs, pkgDir, subpath);
  }
  let pkg: { exports?: any; module?: string; main?: string };
  try { pkg = JSON.parse(vfs.readFileString(pkgJsonPath)); }
  catch {
    const r = resolveFile(vfs, pkgDir + '/index');
    return r ? { resolved: r } : null;
  }

  const entry = sharedResolvePackageEntry(pkg, subpath, DEFAULT_CJS_CONDITIONS);
  if (entry != null) {
    const resolved = resolveFile(vfs, pkgDir + '/' + entry.replace(/^\.\//, ''));
    if (resolved) return { resolved };
    // W2.6a D2 (mirror of node-shims:__resolvePkgSubpath): exports/main
    // yielded a path that doesn't exist on disk. Fall through to the
    // direct-probe path so prefetch and runtime stay in lockstep on
    // packages whose declared entry is unfindable.
  }
  if (subpath === '.') {
    if (typeof pkg.main === 'string') {
      const r = resolveFile(vfs, pkgDir + '/' + pkg.main.replace(/^\.\//, ''));
      if (r) return { resolved: r };
    }
    const idx = resolveFile(vfs, pkgDir + '/index');
    return idx ? { resolved: idx } : null;
  }
  // Non-root subpath: extension-probe first (most common path).
  const direct = resolveFile(vfs, pkgDir + '/' + subpath.replace(/^\.\//, ''));
  if (direct) return { resolved: direct };

  // X.5-L: legacy directory-with-nested-package.json fallback. Only
  // engaged when the standard probes have failed AND
  // `<pkgDir>/<subpath>` exists as a directory.
  return tryLegacyDirectorySubpath(vfs, pkgDir, subpath);
}

/**
 * X.5-L: legacy pre-`exports`-field subpath convention.
 *
 * If `<pkgDir>/<subpath>` is a directory containing its own
 * `package.json`, follow that nested package.json's `module`/`main`
 * (in CJS-condition order: main → module) as a path relative to the
 * **subpath directory** (so `main: "../dist/x.js"` resolves to
 * `<pkgDir>/dist/x.js`).
 *
 * Returns the real resolved file plus a synthetic stub to inject at
 * `<pkgDir>/<subpath>.js`. The stub is a CJS one-liner that
 * re-exports the real target via a relative require — chosen over
 * duplicating the file content so we don't double-apply the
 * ESM→CJS transform in facet-manager.
 *
 * Returns null if there's no directory match or no readable nested
 * package.json (caller falls through to its existing null return).
 */
function tryLegacyDirectorySubpath(vfs: SqliteVFS, pkgDir: string, subpath: string): ResolveSubpathResult | null {
  if (subpath === '.' || !subpath.startsWith('./')) return null;

  const subRelative = subpath.replace(/^\.\//, '');
  const subDir = normalizePath(pkgDir + '/' + subRelative);
  if (!vfs.exists(subDir) || !vfs.isDirectory(subDir)) return null;

  const nestedPkgJson = subDir + '/package.json';
  if (!vfs.exists(nestedPkgJson)) {
    // Last-resort: probe `<subDir>/index.{js,…}`. This is already
    // covered by `resolveFile(pkgDir + '/' + subRelative)`'s
    // `/index.js` suffix probe, so reaching here means everything
    // missed — return null.
    return null;
  }

  let nested: { module?: string; main?: string };
  try { nested = JSON.parse(vfs.readFileString(nestedPkgJson)); }
  catch { return null; }

  // Prefer `main` for CJS conditions; fall back to `module` if no main.
  // (resolvePackageEntry would do the same prioritisation, but nested
  // package.json files often only declare one of the two.)
  const nestedEntry =
    (typeof nested.main === 'string' && nested.main) ||
    (typeof nested.module === 'string' && nested.module) ||
    null;
  if (!nestedEntry) return null;

  // Resolve relative to the subpath dir; nestedEntry can be
  // up-pointing (`../dist/x.js`) or relative-down (`./dist/x.js`).
  const targetPath = normalizePath(subDir + '/' + nestedEntry.replace(/^\.\//, ''));
  const resolved = resolveFile(vfs, targetPath);
  if (!resolved) return null;

  // Build the stub. The stub lives at `<pkgDir>/<subRelative>.js`
  // (matches the runtime resolver's `.js` extension probe). Its
  // modDir is the directory of the stub path.
  const stubPath = normalizePath(pkgDir + '/' + subRelative + '.js');
  const stubDir = stubPath.includes('/') ? stubPath.substring(0, stubPath.lastIndexOf('/')) : '.';
  const stubRelTarget = relativeFrom(stubDir, resolved);
  const stubContent =
    `// X.5-L synthetic stub: re-export legacy directory-subpath target\n` +
    `module.exports = require(${JSON.stringify('./' + stubRelTarget)});\n`;

  return {
    resolved,
    stub: { path: stubPath, content: stubContent },
  };
}

/**
 * Compute a relative path from `fromDir` to `toPath`. Both are
 * expected as VFS-style slash-separated paths with no leading slash.
 * The result is a slash-separated relative path WITHOUT a leading
 * `./` (caller adds the prefix if needed for require()).
 *
 * Examples:
 *   relativeFrom('a/b', 'a/c/d.js')  → '../c/d.js'
 *   relativeFrom('a/b', 'a/b/c.js')  → 'c.js'
 *   relativeFrom('a',   'a/b/c.js')  → 'b/c.js'
 */
function relativeFrom(fromDir: string, toPath: string): string {
  const f = fromDir.split('/').filter(s => s.length > 0);
  const t = toPath.split('/').filter(s => s.length > 0);
  let i = 0;
  while (i < f.length && i < t.length && f[i] === t[i]) i++;
  const ups = f.length - i;
  const downs = t.slice(i);
  const parts: string[] = [];
  for (let k = 0; k < ups; k++) parts.push('..');
  for (const d of downs) parts.push(d);
  return parts.join('/') || '.';
}

/**
 * X.5-L: extended bare-spec resolver that also returns any synthetic
 * stub emitted by resolvePkgSubpathEx's legacy-directory branch.
 */
function resolveNodeModuleEx(vfs: SqliteVFS, name: string, fromDir: string): ResolveSubpathResult | null {
  let pkgName: string;
  let subpath: string;
  if (name.startsWith('@')) {
    const parts = name.split('/');
    if (parts.length < 2) return null;
    pkgName = parts.slice(0, 2).join('/');
    subpath = parts.length > 2 ? './' + parts.slice(2).join('/') : '.';
  } else {
    const slashIdx = name.indexOf('/');
    if (slashIdx > 0) {
      pkgName = name.substring(0, slashIdx);
      subpath = './' + name.substring(slashIdx + 1);
    } else {
      pkgName = name;
      subpath = '.';
    }
  }

  let dir = strip(fromDir);
  const visited = new Set<string>();
  while (true) {
    if (visited.has(dir)) break;
    visited.add(dir);
    const nmDir = (dir ? dir + '/' : '') + 'node_modules/' + pkgName;
    if (vfs.exists(nmDir)) {
      const r = resolvePkgSubpathEx(vfs, nmDir, subpath);
      if (r) return r;
    }
    if (!dir) break;
    const lastSlash = dir.lastIndexOf('/');
    dir = lastSlash > 0 ? dir.substring(0, lastSlash) : '';
  }
  return null;
}

/**
 * X.5-L: extended require-resolver that surfaces synthetic stubs.
 * Used by `prefetchForRequire` to inject runtime-side stubs for
 * the legacy directory-subpath pattern. Relative paths never need
 * stubs, so for those we just return `{ resolved }` with no stub.
 */
function resolveRequireEx(vfs: SqliteVFS, id: string, fromDir: string): ResolveSubpathResult | null {
  if (id.startsWith('./') || id.startsWith('../') || id.startsWith('/')) {
    const base = id.startsWith('/')
      ? strip(id)
      : normalizePath(strip(fromDir) + '/' + id);
    const r = resolveFile(vfs, base);
    return r ? { resolved: r } : null;
  }
  // package.json#imports field — `#name` specifiers resolved against
  // the nearest enclosing package.json's `imports` map. Mirrors the
  // runtime __resolveImportsField at node-shims.ts:2635. Without this
  // branch, prefetch would fall through to resolveNodeModuleEx (which
  // treats `#name` as a node_module name → never finds the file),
  // and the imports-field target would never be shipped into the
  // bundle. At runtime, __resolveImportsField would correctly compute
  // the target path, but __resolveFile would then return null because
  // the file wasn't bundled — surfacing as a misleading
  // "Cannot find module '#name' (from ...)" error.
  //
  // See .seal-internal/2026-05-11-chalk-imports-field/audit.md.
  if (id.startsWith('#')) {
    const r = resolveImportsField(vfs, id, fromDir);
    return r ? { resolved: r } : null;
  }
  return resolveNodeModuleEx(vfs, id, fromDir);
}

/**
 * Resolve an imports-field specifier `#name` against the nearest
 * enclosing package.json. Returns the resolved file path (or null
 * if not found). Mirrors node-shims.ts:__resolveImportsField.
 */
function resolveImportsField(
  vfs: SqliteVFS,
  name: string,
  fromDir: string,
): string | null {
  let dir = strip(fromDir);
  while (true) {
    const pkgJsonPath = (dir ? dir + '/' : '') + 'package.json';
    if (vfs.exists(pkgJsonPath) && !vfs.isDirectory(pkgJsonPath)) {
      let pkg: any = null;
      try { pkg = JSON.parse(vfs.readFileString(pkgJsonPath)); } catch { /* malformed */ }
      // First package.json wins (Node spec), even if no imports field.
      if (pkg && pkg.imports) {
        const target = sharedResolveExports(pkg.imports, name, DEFAULT_CJS_CONDITIONS);
        if (target && typeof target === 'string') {
          // imports targets are relative to the package root (`dir`).
          if (target.startsWith('./')) {
            const base = (dir ? dir + '/' : '') + target.slice(2);
            return resolveFile(vfs, normalizePath(base));
          }
          if (target.startsWith('/')) {
            return resolveFile(vfs, strip(target));
          }
          // Bare specifier — re-resolve as a node_module from `dir`.
          const r = resolveNodeModuleEx(vfs, target, dir);
          return r ? r.resolved : null;
        }
      }
      return null;
    }
    if (!dir) return null;
    const lastSlash = dir.lastIndexOf('/');
    dir = lastSlash > 0 ? dir.substring(0, lastSlash) : '';
  }
}

/**
 * Result of a prefetch walk.
 *   - bundle:  path → content for every reachable file.
 *   - visited: set of pkgDirs (e.g. 'home/user/app/node_modules/fastify')
 *              encountered during the walk. Caller uses this to drive
 *              greedy oversampling — every visited package gets its
 *              package.json + main file forced into the bundle, even
 *              if the dynamic-require they're behind wasn't caught by
 *              the regex.
 *   - truncated: true if MAX_FILES or MAX_BYTES fired.
 */
export interface PrefetchResult {
  bundle: Record<string, string>;
  visitedPkgDirs: Set<string>;
  truncated: boolean;
}

/**
 * Resolve the complete dependency graph starting from entry code.
 * Returns Record<path, content> + the set of package directories
 * referenced (for greedy oversampling).
 */
export function prefetchForRequire(
  vfs: SqliteVFS,
  entryCode: string,
  cwd: string,
  entryFile?: string,
): PrefetchResult {
  const bundle: Record<string, string> = {};
  const visitedPkgDirs = new Set<string>();
  let totalBytes = 0;
  let fileCount = 0;
  let truncated = false;
  const visited = new Set<string>();

  function trackPkgDir(vfsPath: string) {
    if (!vfsPath.includes('node_modules/')) return;
    const parts = vfsPath.split('/');
    const nmIdx = parts.lastIndexOf('node_modules');
    if (nmIdx < 0) return;
    const pkgEnd = parts[nmIdx + 1]?.startsWith('@') ? nmIdx + 3 : nmIdx + 2;
    if (pkgEnd > parts.length) return;
    visitedPkgDirs.add(parts.slice(0, pkgEnd).join('/'));
  }

  function addFile(vfsPath: string): void {
    if (visited.has(vfsPath)) return;
    if (fileCount >= MAX_FILES || totalBytes >= MAX_BYTES) {
      truncated = true;
      return;
    }
    visited.add(vfsPath);
    let content: string;
    try { content = vfs.readFileString(vfsPath); }
    catch { return; }
    if (totalBytes + content.length > MAX_BYTES) {
      truncated = true;
      return;
    }
    bundle[vfsPath] = content;
    totalBytes += content.length;
    fileCount++;
    trackPkgDir(vfsPath);

    // Also add the package.json for the enclosing node_modules package
    // so the runtime resolver can read the same exports/main field we
    // walked here.
    if (vfsPath.includes('node_modules/')) {
      const parts = vfsPath.split('/');
      const nmIdx = parts.lastIndexOf('node_modules');
      if (nmIdx >= 0) {
        const pkgEnd = parts[nmIdx + 1]?.startsWith('@') ? nmIdx + 3 : nmIdx + 2;
        const pkgJsonPath = parts.slice(0, pkgEnd).join('/') + '/package.json';
        if (!visited.has(pkgJsonPath) && vfs.exists(pkgJsonPath)) {
          visited.add(pkgJsonPath);
          try {
            const pkgContent = vfs.readFileString(pkgJsonPath);
            if (totalBytes + pkgContent.length <= MAX_BYTES) {
              bundle[pkgJsonPath] = pkgContent;
              totalBytes += pkgContent.length;
              fileCount++;
            }
          } catch { /* ignore */ }
        }
      }
    }
    // Bug class C (audit 2026-05-11): ship every ancestor package.json
    // up to a node_modules boundary so the runtime __resolveFile pkg.main
    // branch can read them. For a path like mod/lib/api.js (resolved
    // via mod/package.json#main='lib/api.js'), the runtime resolver
    // needs mod/package.json in the bundle even though api.js lives
    // one level deeper. Walking up covers nested-main cases.
    //
    // Bound: stops at node_modules boundary (existing block above
    // handles that case) or when we run out of parent dirs. Each step
    // costs one vfs.exists() — typical project depth is 3-5 dirs.
    if (!vfsPath.includes('node_modules/')) {
      let dir = vfsPath;
      while (true) {
        const sl = dir.lastIndexOf('/');
        if (sl <= 0) break;
        dir = dir.substring(0, sl);
        const dirPkgJson = dir + '/package.json';
        if (visited.has(dirPkgJson)) break; // already shipped, stop walking
        if (vfs.exists(dirPkgJson) && !vfs.isDirectory(dirPkgJson)) {
          visited.add(dirPkgJson);
          try {
            const pkgContent = vfs.readFileString(dirPkgJson);
            if (totalBytes + pkgContent.length <= MAX_BYTES) {
              bundle[dirPkgJson] = pkgContent;
              totalBytes += pkgContent.length;
              fileCount++;
            }
          } catch { /* ignore */ }
        }
      }
    }

    // Recursively resolve require() calls in this file
    if (vfsPath.endsWith('.js') || vfsPath.endsWith('.mjs') || vfsPath.endsWith('.cjs')) {
      const fromDir = vfsPath.includes('/') ? vfsPath.substring(0, vfsPath.lastIndexOf('/')) : '.';
      parseAndResolve(content, fromDir);
    }
  }

  function parseAndResolve(code: string, fromDir: string): void {
    REQUIRE_RE.lastIndex = 0;
    let match;
    while ((match = REQUIRE_RE.exec(code)) !== null) {
      const specifier = match[2];
      if (isBuiltin(specifier)) continue;
      const r = resolveRequireEx(vfs, specifier, fromDir);
      if (r) {
        addFile(r.resolved);
        if (r.stub) addStub(r.stub.path, r.stub.content);
      }
    }
    // X.5-C Fix #1: also follow ESM `import`/`export … from` statements.
    // Without this, packages whose `module` entry is ESM (react-remove-
    // scroll, pathe, ESM nuxt deps, etc.) have their entry file in the
    // bundle but none of the relative `import './x'` siblings — at
    // runtime W3.5 Fix B's CJS rewrite calls require('./x') which then
    // fails because `x` was never added.
    IMPORT_RE.lastIndex = 0;
    while ((match = IMPORT_RE.exec(code)) !== null) {
      const specifier = match[2];
      if (isBuiltin(specifier)) continue;
      const r = resolveRequireEx(vfs, specifier, fromDir);
      if (r) {
        addFile(r.resolved);
        if (r.stub) addStub(r.stub.path, r.stub.content);
      }
    }
  }

  /**
   * X.5-L: inject a synthetic stub into the bundle. Stubs are
   * produced by resolvePkgSubpathEx's legacy-directory branch — they
   * sit at the path the runtime resolver probes for (e.g.
   * `<pkgDir>/<subpath>.js`) and re-export the real resolved file.
   *
   * We deliberately skip the recursion + package.json piggyback that
   * `addFile` does: stubs are leaf one-liners with a single
   * relative require, and the *real* target is added separately by
   * `addFile(resolved)` with normal recursion.
   */
  function addStub(stubPath: string, content: string): void {
    if (visited.has(stubPath)) return;
    if (fileCount >= MAX_FILES || totalBytes >= MAX_BYTES) {
      truncated = true;
      return;
    }
    if (totalBytes + content.length > MAX_BYTES) {
      truncated = true;
      return;
    }
    // Don't shadow a real on-disk file: if VFS already has something
    // at this path, skip the stub. (Defence-in-depth — should never
    // happen because the legacy-directory branch only fires when all
    // extension probes missed.)
    if (vfs.exists(stubPath) && !vfs.isDirectory(stubPath)) return;
    visited.add(stubPath);
    bundle[stubPath] = content;
    totalBytes += content.length;
    fileCount++;
    trackPkgDir(stubPath);
  }

  // Start from entry code.
  //
  // Primitive #1 (primitives-extension wave): the relative-require
  // resolution base is the ENTRY FILE's directory when the caller
  // supplied one (bin shims under node_modules/.bin/, npx-launched
  // scripts, etc.), NOT cwd. Pre-fix, `require('../lib/tsc.js')` from
  // `node_modules/typescript/bin/tsc` resolved against the user's
  // cwd, finding `<cwd>/../lib/tsc.js` which doesn't exist.
  //
  // Falling back to cwd preserves the legacy behaviour for naked
  // entryCode (no file context) — covers the `node -e '<code>'`
  // path where opts.filename is '<eval>'.
  const cwdStripped = strip(cwd);
  let entryFromDir = cwdStripped;
  if (entryFile) {
    const stripped = strip(entryFile);
    const slash = stripped.lastIndexOf('/');
    if (slash > 0) entryFromDir = stripped.substring(0, slash);
  }
  parseAndResolve(entryCode, entryFromDir);

  // If there's an entry file, add it (and recurse)
  if (entryFile) {
    const stripped = strip(entryFile);
    addFile(stripped);
  }

  // Also add cwd package.json if it exists (for npm scripts, main field etc)
  const cwdPkg = cwdStripped + '/package.json';
  if (vfs.exists(cwdPkg) && !visited.has(cwdPkg)) {
    try {
      const c = vfs.readFileString(cwdPkg);
      if (totalBytes + c.length <= MAX_BYTES) {
        bundle[cwdPkg] = c;
        totalBytes += c.length;
        fileCount++;
        visited.add(cwdPkg);
      }
    } catch { /* ignore */ }
  }

  return { bundle, visitedPkgDirs, truncated };
}

const BUILTINS = new Set([
  'fs', 'path', 'os', 'events', 'stream', 'buffer', 'util', 'url', 'crypto',
  'assert', 'querystring', 'string_decoder', 'child_process', 'process',
  'console', 'http', 'https', 'http2', 'net', 'dns', 'tls', 'tty',
  'module', 'timers', 'zlib', 'readline', 'perf_hooks', 'worker_threads',
  'vm', 'v8', 'inspector', 'cluster', 'domain', 'punycode', 'wasi',
  'trace_events', 'dgram', 'sqlite', 'repl',
]);

function isBuiltin(id: string): boolean {
  if (id.startsWith('node:')) return true;
  return BUILTINS.has(id);
}

// Note: the shared resolver helpers are imported directly from
// src/_shared/exports-resolver.js by every caller (W2.6a D6 — single
// source of truth). No re-export needed here.
