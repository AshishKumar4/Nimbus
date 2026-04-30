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

import type { SqliteVFS } from './sqlite-vfs.js';
import {
  resolveExports as sharedResolveExports,
  resolvePackageEntry as sharedResolvePackageEntry,
  DEFAULT_CJS_CONDITIONS,
} from './_shared/exports-resolver.js';

// Match literal-string require/require.resolve with single, double, or
// template-literal-no-interp specifier. The plain-string variant is by
// far the dominant npm pattern; the others catch a long tail of
// well-known cases (esbuild plugins, vite internals).
const REQUIRE_RE = /(?:require(?:\.resolve)?\s*\(\s*)(['"`])([^'"`]+?)\1\s*\)/g;

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
 */
function resolveFile(vfs: SqliteVFS, base: string): string | null {
  const exts = ['', '.js', '.mjs', '.cjs', '.json', '/index.js', '/index.cjs', '/index.mjs', '/index.json'];
  for (const ext of exts) {
    const p = normalizePath(base + ext);
    if (vfs.exists(p) && !vfs.isDirectory(p)) return p;
  }
  return null;
}

/**
 * Resolve a package's entry-point file via the SHARED resolver. The
 * pre-W2.6a implementation here had a hand-rolled `pkg.exports['.']`
 * lookup that ignored conditions, wildcards, and nested condition maps
 * — diverging from runtime semantics. Now both use the same impl.
 */
function resolvePkgSubpath(vfs: SqliteVFS, pkgDir: string, subpath: string): string | null {
  const pkgJsonPath = pkgDir + '/package.json';
  if (!vfs.exists(pkgJsonPath)) {
    // No package.json — direct probe (matches node-shims fallback).
    if (subpath === '.') return resolveFile(vfs, pkgDir + '/index');
    return resolveFile(vfs, pkgDir + '/' + subpath.replace(/^\.\//, ''));
  }
  let pkg: { exports?: any; module?: string; main?: string };
  try { pkg = JSON.parse(vfs.readFileString(pkgJsonPath)); }
  catch { return resolveFile(vfs, pkgDir + '/index'); }

  const entry = sharedResolvePackageEntry(pkg, subpath, DEFAULT_CJS_CONDITIONS);
  if (entry != null) {
    const resolved = resolveFile(vfs, pkgDir + '/' + entry.replace(/^\.\//, ''));
    if (resolved) return resolved;
    // W2.6a D2 (mirror of node-shims:__resolvePkgSubpath): exports/main
    // yielded a path that doesn't exist on disk. Fall through to the
    // direct-probe path so prefetch and runtime stay in lockstep on
    // packages whose declared entry is unfindable.
  }
  if (subpath === '.') {
    if (typeof pkg.main === 'string') {
      const r = resolveFile(vfs, pkgDir + '/' + pkg.main.replace(/^\.\//, ''));
      if (r) return r;
    }
    return resolveFile(vfs, pkgDir + '/index');
  }
  return resolveFile(vfs, pkgDir + '/' + subpath.replace(/^\.\//, ''));
}

function resolveNodeModule(vfs: SqliteVFS, name: string, fromDir: string): string | null {
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
      const resolved = resolvePkgSubpath(vfs, nmDir, subpath);
      if (resolved) return resolved;
    }
    if (!dir) break;
    const lastSlash = dir.lastIndexOf('/');
    dir = lastSlash > 0 ? dir.substring(0, lastSlash) : '';
  }
  return null;
}

function resolveRequire(vfs: SqliteVFS, id: string, fromDir: string): string | null {
  if (id.startsWith('./') || id.startsWith('../') || id.startsWith('/')) {
    const base = id.startsWith('/')
      ? strip(id)
      : normalizePath(strip(fromDir) + '/' + id);
    return resolveFile(vfs, base);
  }
  return resolveNodeModule(vfs, id, fromDir);
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
      const resolved = resolveRequire(vfs, specifier, fromDir);
      if (resolved) addFile(resolved);
    }
  }

  // Start from entry code
  const cwdStripped = strip(cwd);
  parseAndResolve(entryCode, cwdStripped);

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
