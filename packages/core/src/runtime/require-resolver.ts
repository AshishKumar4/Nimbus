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
 * Static analysis still misses dynamic requires like `require(variable)`;
 * bounded greedy oversampling in facet-manager.ts:buildPrefetchBundle
 * compensates without limiting the statically-proven require closure.
 *
 * History: this file was ARC-A-P1 quarantined after W2 because the
 * legacy `buildVfsBundle` walked every file in node_modules. W2.6a
 * de-quarantines it as the primary content-bundle source.
 */

import type { ExecutionFs as CredentialedVfs } from '../shell/execution-fs.js';
import {
  resolvePackageEntry as sharedResolvePackageEntry,
  resolveExports as sharedResolveExports,
  packageSelfReferenceSubpath,
  DEFAULT_CJS_CONDITIONS,
  DEFAULT_ESM_CONDITIONS,
  type ResolvablePackageJson,
  type SelfReferencingPackageJson,
} from '../_shared/exports-resolver.js';
import {
  TYPESCRIPT_INDEX_CANDIDATES,
  typescriptFallbackCandidates,
} from '../_shared/typescript-specifiers.js';
import { FACET_PROVIDED_PACKAGES, VFS_BUNDLE_MAX_BYTES } from '../constants.js';
import { normalizeVfsPath } from '../vfs/path.js';
import { isNativeBinPath } from './os-contracts.js';
import { stripCommentsForImports } from './comment-strip.js';

// Match literal-string require/require.resolve with single, double, or
// template-literal-no-interp specifier. The plain-string variant is by
// far the dominant npm pattern; the others catch a long tail of
// well-known cases (esbuild plugins, vite internals).
const REQUIRE_RE = /(?:require(?:\.resolve)?\s*\(\s*)(['"`])([^'"`]+?)\1\s*\)/g;

// Static-string dynamic import: `import('literal')`. CLI entrypoints often
// defer their real implementation through one (e.g. create-astro's
// create-astro.mjs does `import('./dist/index.js').then(({main}) => main())`).
// Without following it, the target file's content is excluded from the
// bounded snapshot, so the runtime dynamic import resolves the path but
// can't read it — the scaffolder exits silently. Only literal specifiers
// are followed; computed `import(expr)` remains out of scope.
const DYNIMPORT_RE = /\bimport\s*\(\s*(['"`])([^'"`]+?)\1\s*\)/g;

// Immediately-invoked `createRequire(<expr>)('literal')`. pi-coding-agent's
// bin (dist/bundle/cli.js) is exactly:
//   import { createRequire, enableCompileCache } from "node:module";
//   enableCompileCache();
//   createRequire(import.meta.url)("./cli-runtime.js");
// None of REQUIRE_RE / IMPORT_RE / DYNIMPORT_RE match that call, so the
// walker staged nothing beyond cli.js and the whole graph loaded lazily at
// runtime, failing at the first `exports`-map subpath it met
// (`@earendil-works/chord/context`) because chord's manifest was never
// staged. `createRequire(import.meta.url)` resolves relative to the
// current file, which is what `fromDir` already is. Deliberately narrow:
// the argument may not contain `)` and only the immediately-invoked form is
// matched; a bound `const require = createRequire(...)` is left alone
// because its later `require('x')` calls already match REQUIRE_RE.
const CREATE_REQUIRE_CALL_RE = /\bcreateRequire\s*\([^)]*\)\s*\(\s*(['"`])([^'"`]+?)\1\s*\)/g;

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
//
// Edge: a literal `\nimport x from 'y'` inside a multi-line string would
// false-positive. The walker no-ops on missed resolutions, so it's a
// minor wasted-work cost, not a correctness issue.
const IMPORT_RE = /(?:^|[\n;}])\s*(?:import|export)(?:[\s{][\w*${}\s,]*?\s*from)?\s*(['"])([^'"]+)\1/g;

function strip(p: string): string { return p.replace(/^\/+/, ''); }

const normalizePath = normalizeVfsPath;

/**
 * Sink for package.json files consulted during LOAD_AS_DIRECTORY
 * resolution. The runtime resolver (`__resolveFile` in node-shims.ts)
 * re-derives a directory require's target by reading that directory's
 * package.json#main; if prefetch resolves a subpath through a nested
 * package.json (e.g. web-streams-polyfill's `ponyfill/package.json`
 * declaring `main: "../dist/ponyfill"`), only the FINAL file gets
 * added to the bundle — the runtime then can't repeat the resolution
 * because the intermediate package.json's content was never shipped
 * (and, for npx-cache trees outside cwd, isn't in the manifest either).
 * Recording every consulted package.json lets the prefetch walker add
 * its content so prefetch and runtime agree.
 */
type PkgJsonSink = (pkgJsonPath: string) => void;

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
async function resolveFile(vfs: CredentialedVfs, base: string, sink?: PkgJsonSink): Promise<string | null> {
  const fileExts = ['', '.js', '.mjs', '.cjs', '.json'];
  for (const ext of fileExts) {
    const p = normalizePath(base + ext);
    if ((await vfs.exists(p)) && !(await vfs.isDirectory(p))) return p;
  }
  // LOAD_AS_DIRECTORY: prefer package.json#main over index.*
  const baseTrim = base.replace(/\/+$/, '');
  const pkgJsonPath = normalizePath(baseTrim + '/package.json');
  if ((await vfs.exists(pkgJsonPath)) && !(await vfs.isDirectory(pkgJsonPath))) {
    let pkg: ResolvablePackageJson | null = null;
    try { pkg = JSON.parse((await vfs.readFileString(pkgJsonPath))); } catch { /* fall through */ }
    if (pkg && typeof pkg.main === 'string' && pkg.main.length > 0) {
      // Record this package.json so the bundle carries the content the
      // runtime resolver needs to repeat this directory resolution.
      sink?.(pkgJsonPath);
      const mainStripped = pkg.main.replace(/^\.\/+/, '').replace(/^\/+/, '');
      const mainBase = baseTrim + '/' + mainStripped;
      // Guard against pkg.main === '.' or empty → would re-enter same base.
      if (mainBase !== base && mainBase !== baseTrim) {
        const resolved = (await resolveFile(vfs, mainBase, sink));
        if (resolved) return resolved;
      }
    }
  }
  const indexExts = ['/index.js', '/index.cjs', '/index.mjs', '/index.json'];
  for (const ext of indexExts) {
    const p = normalizePath(base + ext);
    if ((await vfs.exists(p)) && !(await vfs.isDirectory(p))) return p;
  }
  // TypeScript sources, probed only once every candidate above has missed —
  // so the specifiers whose resolution changes are exactly those that resolve
  // to nothing today. See _shared/typescript-specifiers.ts for the scope.
  for (const candidate of typescriptFallbackCandidates(baseTrim)) {
    const p = normalizePath(candidate);
    if ((await vfs.exists(p)) && !(await vfs.isDirectory(p))) return p;
  }
  for (const ext of TYPESCRIPT_INDEX_CANDIDATES) {
    const p = normalizePath(baseTrim + ext);
    if ((await vfs.exists(p)) && !(await vfs.isDirectory(p))) return p;
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
async function resolvePkgSubpathEx(vfs: CredentialedVfs, pkgDir: string, subpath: string, sink?: PkgJsonSink): Promise<ResolveSubpathResult | null> {
  const pkgJsonPath = pkgDir + '/package.json';
  if (!(await vfs.exists(pkgJsonPath))) {
    // No package.json — direct probe (matches node-shims fallback).
    if (subpath === '.') {
      const r = (await resolveFile(vfs, pkgDir + '/index', sink));
      return r ? { resolved: r } : null;
    }
    const r = (await resolveFile(vfs, pkgDir + '/' + subpath.replace(/^\.\//, ''), sink));
    if (r) return { resolved: r };
    // Even with no parent package.json, attempt the legacy nested-pkg
    // fallback (consistent behaviour across the no-pkgjson branch).
    return (await tryLegacyDirectorySubpath(vfs, pkgDir, subpath, sink));
  }
  let pkg: ResolvablePackageJson;
  try { pkg = JSON.parse((await vfs.readFileString(pkgJsonPath))); }
  catch {
    const r = (await resolveFile(vfs, pkgDir + '/index', sink));
    return r ? { resolved: r } : null;
  }
  // The runtime resolver reads this package.json unconditionally to walk
  // exports/main; record it so its content ships in the bundle.
  sink?.(pkgJsonPath);

  let entry = sharedResolvePackageEntry(pkg, subpath, DEFAULT_CJS_CONDITIONS);
  if (entry == null && pkg.exports != null) {
    entry = sharedResolvePackageEntry(pkg, subpath, DEFAULT_ESM_CONDITIONS);
  }
  if (entry != null) {
    const resolved = (await resolveFile(vfs, pkgDir + '/' + entry.replace(/^\.\//, ''), sink));
    if (resolved) return { resolved };
    // W2.6a D2 (mirror of node-shims:__resolvePkgSubpath): exports/main
    // yielded a path that doesn't exist on disk. Fall through to the
    // direct-probe path so prefetch and runtime stay in lockstep on
    // packages whose declared entry is unfindable.
  }
  if (subpath === '.') {
    if (typeof pkg.main === 'string') {
      const r = (await resolveFile(vfs, pkgDir + '/' + pkg.main.replace(/^\.\//, ''), sink));
      if (r) return { resolved: r };
    }
    const idx = (await resolveFile(vfs, pkgDir + '/index', sink));
    return idx ? { resolved: idx } : null;
  }
  // Non-root subpath: extension-probe first (most common path).
  const direct = (await resolveFile(vfs, pkgDir + '/' + subpath.replace(/^\.\//, ''), sink));
  if (direct) return { resolved: direct };

  // X.5-L: legacy directory-with-nested-package.json fallback. Only
  // engaged when the standard probes have failed AND
  // `<pkgDir>/<subpath>` exists as a directory.
  return (await tryLegacyDirectorySubpath(vfs, pkgDir, subpath, sink));
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
async function tryLegacyDirectorySubpath(vfs: CredentialedVfs, pkgDir: string, subpath: string, sink?: PkgJsonSink): Promise<ResolveSubpathResult | null> {
  if (subpath === '.' || !subpath.startsWith('./')) return null;

  const subRelative = subpath.replace(/^\.\//, '');
  const subDir = normalizePath(pkgDir + '/' + subRelative);
  if (!(await vfs.exists(subDir)) || !(await vfs.isDirectory(subDir))) return null;

  const nestedPkgJson = subDir + '/package.json';
  if (!(await vfs.exists(nestedPkgJson))) {
    // Last-resort: probe `<subDir>/index.{js,…}`. This is already
    // covered by `resolveFile(pkgDir + '/' + subRelative)`'s
    // `/index.js` suffix probe, so reaching here means everything
    // missed — return null.
    return null;
  }

  let nested: { module?: string; main?: string };
  try { nested = JSON.parse((await vfs.readFileString(nestedPkgJson))); }
  catch { return null; }
  // The runtime resolver reads this nested package.json to repeat the
  // resolution; record it so its content ships in the bundle.
  sink?.(nestedPkgJson);

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
  const resolved = (await resolveFile(vfs, targetPath, sink));
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
async function resolveNodeModuleEx(vfs: CredentialedVfs, name: string, fromDir: string, sink?: PkgJsonSink): Promise<ResolveSubpathResult | null> {
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
    if ((await vfs.exists(nmDir))) {
      const r = (await resolvePkgSubpathEx(vfs, nmDir, subpath, sink));
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
async function resolveRequireEx(vfs: CredentialedVfs, id: string, fromDir: string, sink?: PkgJsonSink): Promise<ResolveSubpathResult | null> {
  if (id.startsWith('./') || id.startsWith('../') || id.startsWith('/')) {
    const base = id.startsWith('/')
      ? strip(id)
      : normalizePath(strip(fromDir) + '/' + id);
    const r = (await resolveFile(vfs, base, sink));
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
  if (id.startsWith('#')) {
    const r = (await resolveImportsField(vfs, id, fromDir, sink));
    return r ? { resolved: r } : null;
  }
  // The enclosing package's own name resolves through its exports map
  // (Node's LOAD_PACKAGE_SELF), before the node_modules walk. Once the
  // enclosing package claims the name, its map is the whole answer: a
  // subpath it does not expose is not found, never a node_modules copy's.
  // Mirrors node-shims.ts:__resolvePackageSelf.
  const self = await resolvePackageSelf(vfs, id, fromDir, sink);
  if (self) return self.resolved ? { resolved: self.resolved } : null;
  return (await resolveNodeModuleEx(vfs, id, fromDir, sink));
}

/**
 * Node's "package scope" of a directory (`readPackageScope`): the nearest
 * enclosing package.json walking up from `fromDir`. The FIRST one found is
 * the scope, even when it lacks the field the caller wants — the imports
 * field and the self-reference rule both belong to the importing module's
 * own package, never to an ancestor past it. The walk never crosses a
 * `node_modules` directory: a file that sits directly under one belongs to
 * no package, not to the project above it. Mirrors
 * node-shims.ts:__nearestPackageScope. The package.json is recorded with
 * `sink` so the runtime can repeat the same lookup from the bundle.
 */
async function nearestPackageScope(
  vfs: CredentialedVfs,
  fromDir: string,
  sink?: PkgJsonSink,
): Promise<{ dir: string; pkg: (ResolvablePackageJson & SelfReferencingPackageJson) | null } | null> {
  let dir = strip(fromDir);
  while (true) {
    if (dir === 'node_modules' || dir.endsWith('/node_modules')) return null;
    const pkgJsonPath = (dir ? dir + '/' : '') + 'package.json';
    if ((await vfs.exists(pkgJsonPath)) && !(await vfs.isDirectory(pkgJsonPath))) {
      sink?.(pkgJsonPath);
      let pkg: (ResolvablePackageJson & SelfReferencingPackageJson) | null = null;
      try { pkg = JSON.parse((await vfs.readFileString(pkgJsonPath))); } catch { /* malformed */ }
      return { dir, pkg };
    }
    if (!dir) return null;
    const lastSlash = dir.lastIndexOf('/');
    dir = lastSlash > 0 ? dir.substring(0, lastSlash) : '';
  }
}

/**
 * Resolve an imports-field specifier `#name` against the nearest
 * enclosing package.json. Returns the resolved file path (or null
 * if not found). Mirrors node-shims.ts:__resolveImportsField.
 */
async function resolveImportsField(
  vfs: CredentialedVfs,
  name: string,
  fromDir: string,
  sink?: PkgJsonSink,
): Promise<string | null> {
  // First package.json wins (Node spec), even if no imports field.
  const scope = await nearestPackageScope(vfs, fromDir, sink);
  if (!scope || !scope.pkg || !scope.pkg.imports) return null;
  const dir = scope.dir;
  const target = sharedResolveExports(scope.pkg.imports, name, DEFAULT_CJS_CONDITIONS);
  if (!target || typeof target !== 'string') return null;
  // imports targets are relative to the package root (`dir`).
  if (target.startsWith('./')) {
    const base = (dir ? dir + '/' : '') + target.slice(2);
    return (await resolveFile(vfs, normalizePath(base), sink));
  }
  if (target.startsWith('/')) {
    return (await resolveFile(vfs, strip(target), sink));
  }
  // Bare specifier — re-resolve as a node_module from `dir`.
  const r = (await resolveNodeModuleEx(vfs, target, dir, sink));
  return r ? r.resolved : null;
}

/**
 * Node's LOAD_PACKAGE_SELF: a bare specifier naming the enclosing package
 * itself resolves through that package's own `exports` map — only when the
 * nearest package.json has `exports` AND its `name` matches, and only
 * through `exports` (no main/index probing). Same condition order as the
 * node_modules walk: CJS first, ESM when the map exposes the subpath only
 * under `import`. Mirrors node-shims.ts:__resolvePackageSelf.
 *
 * Tri-state, as in Node: `null` when the rule does not apply (the caller
 * walks node_modules); `{ resolved: null }` when the enclosing package
 * claims the name but its map does not expose the subpath or the target
 * is missing — Node throws ERR_PACKAGE_PATH_NOT_EXPORTED / MODULE_NOT_FOUND
 * there and never consults node_modules, so neither does the caller.
 */
async function resolvePackageSelf(
  vfs: CredentialedVfs,
  name: string,
  fromDir: string,
  sink?: PkgJsonSink,
): Promise<{ resolved: string | null } | null> {
  const scope = await nearestPackageScope(vfs, fromDir, sink);
  if (!scope || !scope.pkg) return null;
  const subpath = packageSelfReferenceSubpath(scope.pkg, name);
  if (subpath === null) return null;
  let entry = sharedResolveExports(scope.pkg.exports, subpath, DEFAULT_CJS_CONDITIONS);
  if (entry == null) entry = sharedResolveExports(scope.pkg.exports, subpath, DEFAULT_ESM_CONDITIONS);
  if (entry == null) return { resolved: null };
  const resolved = await resolveFile(vfs, normalizePath(`${scope.dir ? `${scope.dir}/` : ''}${entry.replace(/^\.\//, '')}`), sink);
  return { resolved };
}

/**
 * Result of a prefetch walk: path → content for every reachable file.
 *
 * The walk is bounded at `VFS_BUNDLE_MAX_BYTES` of staged content. A
 * facet has no synchronous I/O primitive, so `require()` cannot fetch a
 * file it was not shipped — a closure that does not fit the bound can
 * never launch as a snapshot, and reading it in full is memory the
 * isolate may not survive. The walk therefore stats each required file
 * before reading and stops, without reading, on the file that would
 * cross the bound; the result is the typed `closure-exceeds-bound`
 * outcome below, never a partial closure passed off as complete.
 * Bounds for the optional enrichment passes live in facet-manager.ts,
 * which has a live async read path behind it.
 */
export interface PrefetchResult {
  bundle: Record<string, string>;
  /** Reached only via dynamic `import()`: staged after the static closure, evictable, never a refusal. */
  speculative: Set<string>;
}

/**
 * The walk stopped at the snapshot bound. `bytesSeen` is content
 * already staged when the bound tripped; `lastPath` is the file whose
 * stat crossed it — it was never read.
 */
export interface ClosureBoundExceeded {
  kind: 'closure-exceeds-bound';
  entry: string;
  bytesSeen: number;
  bound: number;
  lastPath: string;
}

export type PrefetchOutcome = PrefetchResult | ClosureBoundExceeded;

/** Error form of `ClosureBoundExceeded` for callers that cannot return it. */
export class ClosureBoundExceededError extends Error {
  constructor(public readonly outcome: ClosureBoundExceeded) {
    super(
      `require closure for ${outcome.entry} exceeds the ${outcome.bound}-byte ` +
      `snapshot bound (${outcome.bytesSeen} bytes staged, stopped at ${outcome.lastPath})`,
    );
    this.name = 'ClosureBoundExceededError';
  }
}

/** Resolve the complete dependency graph starting from entry code. */
export async function prefetchForRequire(
  vfs: CredentialedVfs,
  entryCode: string,
  cwd: string,
  entryFile?: string,
  maxBundleBytes: number = VFS_BUNDLE_MAX_BYTES,
): Promise<PrefetchOutcome> {
  const bundle: Record<string, string> = {};
  const speculative = new Set<string>();
  const visited = new Set<string>();
  let bytesSeen = 0;
  let closureExceeded: ClosureBoundExceeded | null = null;
  // Followed after the static closure so a lazy subtree never spends its bound.
  const deferredDynamic: Array<{ specifier: string; fromDir: string }> = [];
  let lazy = false;

  // `entry`: the entry file itself, whose own `import()` is a deferral of its
  // main module, not an optional feature, and is followed as required.
  async function addFile(vfsPath: string, entry = false): Promise<void> {
    if (closureExceeded || visited.has(vfsPath)) return;
    visited.add(vfsPath);
    // A native binary is answered by the ABI policy, never loaded from the map.
    if (isNativeBinPath(vfsPath)) return;
    // Stat before read: a required file is not optional, so if its size
    // would carry the bundle past the bound the closure cannot launch —
    // stop here rather than buy the read that resets the isolate. A stat
    // failure means the size is unknown; the read attempt decides, as it
    // did before this gate existed.
    let size = 0;
    try { size = (await vfs.stat(vfsPath)).size; } catch { /* size unknown */ }
    if (bytesSeen + size > maxBundleBytes) {
      if (lazy) return;
      closureExceeded = {
        kind: 'closure-exceeds-bound',
        entry: entryFile ?? 'entry code',
        bytesSeen,
        bound: maxBundleBytes,
        lastPath: vfsPath,
      };
      return;
    }
    let content: string;
    try { content = (await vfs.readFileString(vfsPath)); }
    catch { return; }
    bytesSeen += size;
    bundle[vfsPath] = content;
    if (lazy) speculative.add(vfsPath);

    // Also add the package.json for the enclosing node_modules package
    // so the runtime resolver can read the same exports/main field we
    // walked here.
    if (vfsPath.includes('node_modules/')) {
      const parts = vfsPath.split('/');
      const nmIdx = parts.lastIndexOf('node_modules');
      if (nmIdx >= 0) {
        const pkgEnd = parts[nmIdx + 1]?.startsWith('@') ? nmIdx + 3 : nmIdx + 2;
        const pkgJsonPath = parts.slice(0, pkgEnd).join('/') + '/package.json';
        if (!visited.has(pkgJsonPath) && (await vfs.exists(pkgJsonPath))) {
          visited.add(pkgJsonPath);
          try {
            const pkgContent = (await vfs.readFileString(pkgJsonPath));
            bundle[pkgJsonPath] = pkgContent;
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
        if ((await vfs.exists(dirPkgJson)) && !(await vfs.isDirectory(dirPkgJson))) {
          visited.add(dirPkgJson);
          try {
            const pkgContent = (await vfs.readFileString(dirPkgJson));
            bundle[dirPkgJson] = pkgContent;
          } catch { /* ignore */ }
        }
      }
    }

    // Recursively resolve require() calls in this file. Bin scripts and
    // shims are commonly extensionless (e.g. node_modules/<pkg>/bin/<cli>
    // with a `#!/usr/bin/env node` shebang), so an extension allowlist
    // would drop their require chain. Treat .json as data (no requires);
    // walk everything else as CJS/ESM.
    if (!vfsPath.endsWith('.json')) {
      const fromDir = vfsPath.includes('/') ? vfsPath.substring(0, vfsPath.lastIndexOf('/')) : '.';
      (await parseAndResolve(content, fromDir, entry));
    }
  }

  async function parseAndResolve(code: string, fromDir: string, entry = false): Promise<void> {
    // esbuild-ast-rewrite (P3 decision: Option D): strip `//` and
    // `/* */` comments before running IMPORT_RE / REQUIRE_RE so the
    // regexes don't break on embedded comments. Real-world bite:
    // chalk's `import { // eslint-disable-line\n a, b\n} from
    // './utilities.js';` (lines 3-6 of chalk@5.x source/index.js)
    // and its multi-line `export { ... // TODO ... } from
    // './vendor/ansi-styles/index.js';` (lines 196-209) both fail
    // IMPORT_RE's lazy character class because comment characters
    // are not in `[\w*${}\s,]*?`. Stripping comments to whitespace
    // (newline-preserved) makes the rest of the regex match
    // correctly.
    //
    // Why Option D (regex + comment-strip) over Option A (full
    // structured AST extraction via esbuild metafile):
    //   - Empirical 100-file session bootstrap with AST: ~553 ms
    //     esbuild-ast-rewrite/measure-result.txt). Over the 500 ms
    //     decision gate, and that's local Node — workerd-wasm cost
    //     is 2-3× higher.
    //   - Regex (this preprocessor) per file: ~0.1 ms
    //   - Correctness gap closed: chalk's bug case now matches both
    //     specifiers AST found but regex missed.
    // See `comment-strip.ts` header + the wave's verdict.md.
    const stripped = stripCommentsForImports(code);

    REQUIRE_RE.lastIndex = 0;
    for (let match = REQUIRE_RE.exec(stripped); match !== null; match = REQUIRE_RE.exec(stripped)) {
      const specifier = match[2];
      if (isFacetProvided(specifier)) continue;
      if (closureExceeded) break;
      const r = (await resolveRequireEx(vfs, specifier, fromDir, addPkgJson));
      if (r) {
        (await addFile(r.resolved));
        if (r.stub) (await addStub(r.stub.path, r.stub.content));
      }
    }
    // Immediately-invoked `createRequire(import.meta.url)('./x')` is a
    // require of './x' from this file's directory (pi-coding-agent's bin).
    CREATE_REQUIRE_CALL_RE.lastIndex = 0;
    for (let match = CREATE_REQUIRE_CALL_RE.exec(stripped); match !== null; match = CREATE_REQUIRE_CALL_RE.exec(stripped)) {
      const specifier = match[2];
      if (isFacetProvided(specifier)) continue;
      if (closureExceeded) break;
      const r = (await resolveRequireEx(vfs, specifier, fromDir, addPkgJson));
      if (r) {
        (await addFile(r.resolved));
        if (r.stub) (await addStub(r.stub.path, r.stub.content));
      }
    }
    // X.5-C Fix #1: also follow ESM `import`/`export … from` statements.
    // Without this, packages whose `module` entry is ESM (react-remove-
    // scroll, pathe, ESM nuxt deps, etc.) have their entry file in the
    // bundle but none of the relative `import './x'` siblings — at
    // runtime W3.5 Fix B's CJS rewrite calls require('./x') which then
    // fails because `x` was never added.
    IMPORT_RE.lastIndex = 0;
    for (let match = IMPORT_RE.exec(stripped); match !== null; match = IMPORT_RE.exec(stripped)) {
      const specifier = match[2];
      if (isFacetProvided(specifier)) continue;
      if (closureExceeded) break;
      const r = (await resolveRequireEx(vfs, specifier, fromDir, addPkgJson));
      if (r) {
        (await addFile(r.resolved));
        if (r.stub) (await addStub(r.stub.path, r.stub.content));
      }
    }
    // Entry deferrals are required; the rest wait for phase 2 (PrefetchResult.speculative).
    DYNIMPORT_RE.lastIndex = 0;
    for (let match = DYNIMPORT_RE.exec(stripped); match !== null; match = DYNIMPORT_RE.exec(stripped)) {
      const specifier = match[2];
      if (isFacetProvided(specifier)) continue;
      if (!entry) { deferredDynamic.push({ specifier, fromDir }); continue; }
      const r = (await resolveRequireEx(vfs, specifier, fromDir, addPkgJson));
      if (closureExceeded) break;
      if (r) {
        (await addFile(r.resolved));
        if (r.stub) (await addStub(r.stub.path, r.stub.content));
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
  async function addStub(stubPath: string, content: string): Promise<void> {
    if (visited.has(stubPath)) return;
    // Don't shadow a real on-disk file: if VFS already has something
    // at this path, skip the stub. (Defence-in-depth — should never
    // happen because the legacy-directory branch only fires when all
    // extension probes missed.)
    if ((await vfs.exists(stubPath)) && !(await vfs.isDirectory(stubPath))) return;
    visited.add(stubPath);
    bundle[stubPath] = content;
  }

  /**
   * Sink for intermediate package.json files consulted during
   * LOAD_AS_DIRECTORY resolution (see PkgJsonSink). Adds the content
   * verbatim — package.json carries no requires, so no recursion and no
   * enclosing-package piggyback is needed.
   */
  async function addPkgJson(pkgJsonPath: string): Promise<void> {
    const k = strip(pkgJsonPath);
    if (visited.has(k) || k in bundle) return;
    let content: string;
    try { content = (await vfs.readFileString(k)); } catch { return; }
    visited.add(k);
    bundle[k] = content;
  }

  // Start from entry code.
  //
  // Primitive #1 (runtime primitive support): the relative-require
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
  (await parseAndResolve(entryCode, entryFromDir, true));

  // If there's an entry file, add it (and recurse)
  if (entryFile) {
    const stripped = strip(entryFile);
    (await addFile(stripped, true));
  }

  // Also add cwd package.json if it exists (for npm scripts, main field etc)
  const cwdPkg = cwdStripped + '/package.json';
  if ((await vfs.exists(cwdPkg)) && !visited.has(cwdPkg)) {
    try {
      const c = (await vfs.readFileString(cwdPkg));
      bundle[cwdPkg] = c;
      visited.add(cwdPkg);
    } catch { /* ignore */ }
  }

  if (closureExceeded) return closureExceeded;

  // Phase 2: dynamic-import subtrees in discovery order; the queue grows as they are walked.
  lazy = true;
  for (let i = 0; i < deferredDynamic.length && bytesSeen < maxBundleBytes; i++) {
    const { specifier, fromDir } = deferredDynamic[i];
    const r = (await resolveRequireEx(vfs, specifier, fromDir, addPkgJson));
    if (r) {
      (await addFile(r.resolved));
      if (r.stub) (await addStub(r.stub.path, r.stub.content));
    }
  }

  return { bundle, speculative };
}

const BUILTINS = new Set([
  'fs', 'path', 'os', 'events', 'stream', 'buffer', 'util', 'url', 'crypto',
  'assert', 'querystring', 'string_decoder', 'child_process', 'process',
  'console', 'http', 'https', 'http2', 'net', 'dns', 'tls', 'tty',
  'module', 'timers', 'zlib', 'readline', 'perf_hooks', 'worker_threads',
  'vm', 'v8', 'inspector', 'cluster', 'domain', 'punycode', 'wasi',
  'trace_events', 'dgram', 'sqlite', 'repl',
]);

/**
 * Specifiers the walker must not follow: the facet resolves them from its own
 * `builtins` table, never from the bundle. That is node core plus the npm
 * packages the facet provides itself — walking those would spend the bundle's
 * file and byte budget shipping sources that `require()` can never reach.
 */
function isFacetProvided(id: string): boolean {
  if (id.startsWith('node:')) return true;
  return BUILTINS.has(id) || FACET_PROVIDED_PACKAGES.includes(id);
}

// Note: the shared resolver helpers are imported directly from
// src/_shared/exports-resolver.js by every caller (W2.6a D6 — single
// source of truth). No re-export needed here.
