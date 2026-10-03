/**
 * prebundle-slice.ts — one npm specifier bundled to one browser ES module
 * from a slice of its package files, by any engine with esbuild's build
 * contract (EsbuildBuildHost's shape: esbuild options and a resolve/load
 * plugin). The build facet runs it on rolldown (rolldown-build.ts).
 *
 * The supervisor walks the specifier's transitive, non-external package
 * files once and ships them with the spec (worker npm/pre-bundle-facet.ts,
 * buildSliceForSpecifierWithCap): every resolve and load is answered from
 * that slice, so a pre-bundle makes no call back to the supervisor. Bare
 * specifiers resolve by Node's rules (package.json `exports` with
 * `require` or `import` conditions by the import's kind, `imports` for
 * `#name`, `module`/`main` otherwise); the shared runtime externals
 * (React and its kin) and anything the slice cannot answer stay external,
 * the latter with a warning.
 *
 * Self-contained but for the exports resolver: the build facet's runtime
 * bundles it (scripts/rolldown-facet/entry.mjs).
 */

import type * as esbuild from 'esbuild-wasm';
import { resolveExports, resolvePackageEntry, type ResolvablePackageJson } from '../_shared/exports-resolver.js';
import type { EsbuildBuildOutcome, EsbuildHostBuildOptions, EsbuildRemotePlugin } from './esbuild-service.js';

/**
 * One file inside a spec's slice: raw bytes, which a binary module keeps
 * whole and source code decodes losslessly.
 */
export interface SlicedFile {
  path: string;       // canonical VFS path, leading '/'
  bytes: Uint8Array;  // file contents
  isDir: false;
}
export interface SlicedDir {
  path: string;
  isDir: true;
}
export type SliceEntry = SlicedFile | SlicedDir;

/** The files a slice holds: everything a bundle built from it can have read. */
export function sliceSources(slice: readonly SliceEntry[]): string[] {
  return slice.flatMap((entry) => (entry.isDir ? [] : [entry.path]));
}

/** What the supervisor sends per pre-bundle. */
export interface PrebundleSpec {
  /** Bare specifier being bundled, e.g. "framer-motion" or "react/jsx-runtime". */
  specifier: string;
  /** VFS path of the entry point, e.g. "/home/user/example-app/node_modules/framer-motion/dist/es/index.mjs". */
  entryPath: string;
  /** External specifiers (from getSharedRuntimeExternals). */
  externals: string[];
  /**
   * Slice: every file/dir the bundler may need for this spec. Computed
   * supervisor-side via a transitive-dependency walk. Includes:
   *   - Every file under node_modules/<spec-pkg>/
   *   - Every file under node_modules/<dep>/ for each transitive dep
   *     NOT marked external by `externals`.
   */
  slice: SliceEntry[];
  /** Stamp written into pkg_esm_bundles.bundle_hash; matches BUNDLER_VERSION. */
  bundlerVersion: string;
  /** Optional `define` map. Used by the on-demand bundler path
   *  (vite-dev-server) to inject process.env.NODE_ENV, import.meta.env.*,
   *  global → globalThis, etc. The pre-bundle path leaves this undefined
   *  (browser-target build needs no define replacement). */
  define?: Record<string, string>;
}

/** What a pre-bundle returns. */
export interface PrebundleResult {
  specifier: string;
  ok: boolean;
  /** ESM bundle output as a UTF-8 string. Empty when ok=false. */
  esmCode: string;
  /** First error message; populated when ok=false. */
  errorText?: string;
  /** Wall-clock ms of the pre-bundle (bundling only, excludes the RPC roundtrip). */
  elapsed: number;
  /** Non-fatal warnings the supervisor should surface. */
  warnings: string[];
}

/** One build with esbuild's contract: options and a resolve/load plugin. */
export type PrebundleBuild = (options: EsbuildHostBuildOptions, plugin: EsbuildRemotePlugin) => Promise<EsbuildBuildOutcome>;

const EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cjs', '.json', '.css'];
const INDEX_FILES = ['index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.mjs'];
// Bundler-style swap: import './x.js' → ./x.ts on disk.
const SWAPS: Record<string, string[]> = { js: ['.ts', '.tsx'], jsx: ['.tsx', '.ts'], mjs: ['.mts', '.ts'], cjs: ['.cts', '.ts'] };

// Conditions per resolution. CJS `require('X')` callers need the `require`
// condition so packages that ship a dual-export CJS trick (e.g.
// @babel/runtime/helpers/X — `module.exports = fn; module.exports.default =
// module.exports;`) resolve to the CJS file: the ESM helper declares only
// `export { fn as default }`, which a CommonJS require would see as
// `{ default: fn }`, and a caller that calls what it required crashes.
// Node selects by the same rule: `require()` triggers `require`, `import`
// triggers `import`. Affects every CJS package compiled with
// @babel/preset-env's transform-runtime (react-textarea-autosize, the
// @emotion/* CJS bundles, ...).
const ESM_CONDITIONS = ['import', 'module', 'browser', 'default'];
const CJS_CONDITIONS = ['require', 'node', 'browser', 'default'];

function loaderOf(path: string): esbuild.Loader {
  if (path.endsWith('.ts') || path.endsWith('.mts') || path.endsWith('.cts')) return 'ts';
  if (path.endsWith('.tsx')) return 'tsx';
  if (path.endsWith('.jsx')) return 'jsx';
  if (path.endsWith('.json')) return 'json';
  if (path.endsWith('.css')) return 'css';
  if (path.endsWith('.wasm') || path.endsWith('.node')) return 'binary';
  return 'js';
}

/** `p` with `.` and `..` segments resolved, its leading `/` kept. */
function normalizePath(p: string): string {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(seg);
  }
  return (p.startsWith('/') ? '/' : '') + out.join('/');
}

const bare = (path: string) => !path.startsWith('/') && !path.startsWith('.') && !path.startsWith('#');

/** Bundle `spec.specifier` from its slice with `build`. Never throws: a failure is a result. */
export async function prebundleSlice(spec: PrebundleSpec, build: PrebundleBuild): Promise<PrebundleResult> {
  const t0 = Date.now();
  const warnings: string[] = [];
  const failed = (errorText: string): PrebundleResult => ({ specifier: spec.specifier, ok: false, esmCode: '', errorText, elapsed: Date.now() - t0, warnings });
  if (!spec || typeof spec !== 'object' || !Array.isArray(spec.slice)) throw new Error('prebundleSlice: the spec has no slice');

  // The slice's files and directories; every file implies its ancestors.
  const norm = (p: string): string => (p.startsWith('/') ? p : '/' + p);
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>();
  for (const entry of spec.slice) {
    if (entry.isDir) dirs.add(norm(entry.path));
    else files.set(norm(entry.path), entry.bytes);
  }
  for (const p of files.keys()) {
    for (let slash = p.lastIndexOf('/'); slash > 0; slash = p.lastIndexOf('/', slash - 1)) dirs.add(p.slice(0, slash));
  }
  const fileExists = (p: string) => files.has(norm(p));
  const dirExists = (p: string) => dirs.has(norm(p));
  const packageJson = (path: string): ResolvablePackageJson | null => {
    try {
      return JSON.parse(new TextDecoder().decode(files.get(norm(path))!));
    } catch {
      return null;
    }
  };

  const tryResolve = (base: string): string | null => {
    const n = normalizePath(base);
    for (const ext of EXTS) if (fileExists(n + ext)) return n + ext;
    const swap = /\.(js|mjs|cjs|jsx)$/.exec(n);
    if (swap) {
      const without = n.slice(0, n.length - swap[0].length);
      for (const ext of SWAPS[swap[1]] ?? []) if (fileExists(without + ext)) return without + ext;
    }
    if (dirExists(n)) {
      for (const index of INDEX_FILES) if (fileExists(n + '/' + index)) return n + '/' + index;
    }
    return null;
  };

  // `#name` against the `imports` of the importing module's own package:
  // the first package.json up from it decides, as Node's spec says.
  const resolvePackageImport = (specifier: string, fromDir: string): string | null => {
    for (let dir = fromDir.replace(/^\/+/, ''); dir; dir = dir.slice(0, Math.max(0, dir.lastIndexOf('/')))) {
      const pkgJsonPath = '/' + dir + '/package.json';
      if (!fileExists(pkgJsonPath)) continue;
      const pkg = packageJson(pkgJsonPath) as (ResolvablePackageJson & { imports?: ResolvablePackageJson['exports'] }) | null;
      const target = pkg?.imports ? resolveExports(pkg.imports, specifier) : null;
      return target ? tryResolve('/' + dir + '/' + target.replace(/^\.\//, '')) : null;
    }
    return null;
  };

  const resolveBarePkg = (specifier: string, fromDir: string, conditions: string[]): string | null => {
    const parts = specifier.split('/');
    const scoped = specifier.startsWith('@');
    const pkgName = parts.slice(0, scoped ? 2 : 1).join('/');
    const subpath = parts.slice(scoped ? 2 : 1).join('/');
    for (let dir = fromDir.replace(/^\/+/, ''); dir; dir = dir.slice(0, Math.max(0, dir.lastIndexOf('/')))) {
      const nm = '/' + dir + '/node_modules/' + pkgName;
      if (!dirExists(nm)) continue;
      const pkg = fileExists(nm + '/package.json') ? packageJson(nm + '/package.json') : null;
      const entry = pkg ? resolvePackageEntry(pkg, subpath ? './' + subpath : '.', conditions) : null;
      const resolved = (entry && tryResolve(nm + '/' + entry.replace(/^\.\//, '')))
        || (subpath && tryResolve(nm + '/' + subpath))
        || tryResolve(nm + '/index');
      if (resolved) return resolved;
    }
    return null;
  };

  const externalExact = new Set<string>();
  const externalPrefixes: string[] = [];
  for (const pattern of spec.externals) {
    if (pattern.endsWith('/*')) externalPrefixes.push(pattern.slice(0, -1));
    else externalExact.add(pattern);
  }
  const isExternal = (s: string) => externalExact.has(s) || externalPrefixes.some((prefix) => s.startsWith(prefix));

  const plugin: EsbuildRemotePlugin = {
    name: 'nimbus-pre-bundle-slice',
    async resolve(args) {
      const at = (path: string | null) => (path ? { path, namespace: 'nimbus-slice' } : null);
      // `#name` first, so it never falls through to external and reaches the browser.
      if (args.path.startsWith('#') && args.resolveDir) {
        const resolved = at(resolvePackageImport(args.path, args.resolveDir));
        if (resolved) return resolved;
        warnings.push(`unresolved subpath import "${args.path}" from ${args.importer || '?'} (no owning package.json#imports entry); marked external`);
        return { external: true };
      }
      // Externals are matched here, on bare specifiers only, never on the
      // entry's path: `react/jsx-runtime` externalizes `react` and still
      // bundles its own entry, which esbuild's top-level `external` refused.
      if (bare(args.path) && isExternal(args.path)) return { external: true };
      if (args.path.startsWith('/')) {
        const resolved = at(tryResolve(args.path));
        if (resolved) return resolved;
      }
      if (args.path.startsWith('.') && args.resolveDir) {
        const resolved = at(tryResolve(args.resolveDir + '/' + args.path));
        if (resolved) return resolved;
      }
      if (bare(args.path)) {
        const conditions = args.kind === 'require-call' || args.kind === 'require-resolve' ? CJS_CONDITIONS : ESM_CONDITIONS;
        const resolved = at(resolveBarePkg(args.path, args.resolveDir || '/home/user', conditions));
        if (resolved) return resolved;
        warnings.push(`unresolved bare import "${args.path}" from ${args.importer || '?'} → marked external`);
      }
      return { external: true };
    },
    async load(args) {
      const bytes = files.get(norm(args.path));
      if (!bytes) return { errors: [{ text: 'pre-bundle slice miss: ' + args.path }] };
      const loader = loaderOf(args.path);
      const lastSlash = args.path.lastIndexOf('/');
      const resolveDir = lastSlash > 0 ? args.path.slice(0, lastSlash) : '/';
      return { contents: loader === 'binary' ? bytes : new TextDecoder().decode(bytes), loader, resolveDir };
    },
  };

  const outcome = await build({
    entryPoints: [norm(spec.entryPath)],
    bundle: true,
    format: 'esm',
    target: 'esnext',
    platform: 'browser',
    conditions: ESM_CONDITIONS,
    mainFields: ['module', 'browser', 'main'],
    define: spec.define && Object.keys(spec.define).length > 0 ? spec.define : undefined,
  }, plugin);
  if (outcome.failure) return failed(outcome.errors[0]?.text || outcome.failure);
  const script = outcome.outputFiles.find((file) => !file.path.endsWith('.css')) ?? outcome.outputFiles[0];
  if (!script) return failed('no output produced');
  return { specifier: spec.specifier, ok: true, esmCode: new TextDecoder().decode(script.contents), elapsed: Date.now() - t0, warnings };
}
