/**
 * EsbuildService — TypeScript/JSX transform + bundling via esbuild-wasm.
 *
 * Architecture:
 *   - esbuild-wasm is imported directly in the supervisor bundle
 *   - WASM is compiled during module evaluation (startup phase) — allowed
 *   - transform() runs in the supervisor's isolate (fast, no facet needed)
 *   - build() also runs in supervisor with a VFS resolver plugin
 *
 * Why not a facet? The esbuild-wasm WASM binary needs to be compiled
 * during module startup (not request time). Dynamic workers created via
 * LOADER.load() have the same restriction. Since esbuild-wasm is bundled
 * into the supervisor, it initializes once at startup and stays warm.
 *
 * Memory: esbuild-wasm uses ~15-20MB heap. Within the DO's 128MB budget
 * this is acceptable for Phase 3. Phase 4+ can move it to a dedicated
 * facet once wasm module passing to dynamic workers is stable.
 */

import type { SqliteVFS } from './sqlite-vfs.js';
import { resolvePackageEntry, resolveExports } from './_shared/exports-resolver.js';
import { normalizeVfsPath, stripLeadingSlashes } from './vfs-path.js';

/**
 * Bundler version tag. BUMP THIS whenever bundling semantics change —
 * the esbuild plugin's resolver logic, the shared-externals rules, the
 * post-processing pipeline, or anything that would invalidate cached
 * pre-bundles. The version is stored in pkg_esm_bundles.bundle_hash and
 * checked on read; cache entries with a different version are treated
 * as missing and rebuilt from scratch.
 *
 * History:
 *   v1 — initial pre-bundling
 *   v2 — shared React externals, CJS named exports
 *   v3 — Node subpath imports (#foo) support for vfile/unified ecosystem
 *   v4 — legacy flat-subpath resolution (pkg/sub without exports field);
 *        CDN fallback wrapper no longer crashes on modules without default
 *   v5 — normalize `../` segments in joined entry paths (react-remove-scroll-bar
 *        style: nested package.json with "module": "../dist/es2015/foo.js")
 *   v6 — externals enforced via plugin onResolve only (top-level `external:`
 *        dropped). Fixes dual-React-instance bug where jsx-runtime and
 *        react-dom/client were inlining their own copy of react because
 *        esbuild's entry-point external check rejected the externals when
 *        passed at the top level. v5 cache entries are wrong (contain
 *        embedded react copies) and must be invalidated.
 */
export const BUNDLER_VERSION = 'v6';

// ── Shared-runtime externals ────────────────────────────────────────────

/**
 * Returns the list of specifiers that must be marked `external` when bundling
 * `specifier` so that React / React-DOM / Scheduler share a single instance
 * across all /@modules/ bundles.
 *
 * Why: React uses an internal module-scoped singleton
 * (`__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED`) for current dispatcher,
 * owner, etc. If two bundles each contain their own embedded React, they each
 * have their own singleton, and `createRoot` from one bundle sees JSX elements
 * created by the other as "alien" — silent render failure (root stays empty).
 *
 * The fix: when bundling react-dom/*, mark react/* and scheduler as external.
 * The bundler leaves `import {...} from "react"` in the output; the browser
 * then fetches /preview/@modules/react, which is the SAME URL the jsx-runtime
 * bundle imports — so both react-dom and jsx-runtime share ONE React instance.
 *
 * Similarly for react/jsx-runtime and react/jsx-dev-runtime (they must share
 * react's internals), we externalize `react` (but not `scheduler` — jsx-runtime
 * doesn't need it).
 */
export function getSharedRuntimeExternals(specifier: string): string[] {
  // react: the canonical bundle. No externals — it's the source of truth.
  if (specifier === 'react') return [];

  // react/jsx-runtime, react/jsx-dev-runtime: import from react's
  // ReactSharedInternals to use the dispatcher. Externalize `react` so
  // the jsx-runtime bundle is just the JSX helpers (~5 KiB) sharing
  // ONE React instance via the browser's module loader.
  if (specifier === 'react/jsx-runtime' || specifier === 'react/jsx-dev-runtime') {
    return ['react'];
  }
  // Other react/* subpaths (e.g., react/server) — externalize react.
  if (specifier.startsWith('react/')) {
    return ['react'];
  }

  // EVERYTHING ELSE — react-dom, framer-motion, lucide-react, zustand,
  // @radix-ui/*, react-router, etc. — must share react's singleton. If any
  // of these embeds its own React copy, elements tagged by that copy get
  // rejected as "alien" by the createRoot from the OTHER React copy
  // (silent render fail / "Objects are not valid as a React child" with
  // $$typeof spelled out). Externalize the entire React runtime.
  //
  // We DO NOT use `react/*` glob here because that has historically tripped
  // esbuild's entry-point check. Instead we list the specific subpath
  // imports React's ecosystem actually emits: jsx-runtime + jsx-dev-runtime.
  // (react-dom subpaths are handled below by 'react-dom/*'.)
  //
  // Filter out patterns that match the spec being bundled — when
  // bundling 'react-dom', drop 'react-dom' / 'react-dom/*' from the list
  // so the entry can be bundled.
  const all = [
    'react',
    'react/jsx-runtime',
    'react/jsx-dev-runtime',
    'react-dom',
    'react-dom/*',
    'scheduler',
  ];
  // Determine the package name for the spec being bundled (handles
  // scoped packages and subpaths: 'react-dom/client' → 'react-dom').
  const specPkg = specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0];

  return all.filter((pat) => {
    if (pat === specifier) return false;
    if (pat.endsWith('/*')) {
      const prefix = pat.slice(0, -1); // e.g. 'react-dom/'
      const pkgName = pat.slice(0, -2); // e.g. 'react-dom'
      if (specifier.startsWith(prefix)) return false;
      if (specifier === pkgName) return false;
      if (specPkg === pkgName) return false;
    } else {
      // Plain (non-glob) external. Drop if the spec being bundled is
      // a subpath of this external's package.
      if (specPkg === pat) return false;
    }
    return true;
  });
}

// ── esbuild-wasm imports ────────────────────────────────────────────────
//
// We must NOT eagerly import('esbuild-wasm') at module evaluation.
// esbuild-wasm's CJS `lib/main.js` runs `createRequire(import.meta.url)('fs')`
// at module-init, which workerd rejects with:
//     "Dynamic require of \"fs\" is not supported"
// on dynamic-worker instances (nodejs_compat only satisfies static
// `import 'node:fs'`, NOT runtime __require2-style CJS requires).
//
// Types are imported type-only so TypeScript sees `esbuild.Plugin` /
// `esbuild.Loader` without emitting a runtime require. The actual
// namespace is loaded lazily by `loadEsbuild()` below, triggered on
// the first transform/build/initialize call. If no caller ever runs
// esbuild (e.g. an inner Nimbus that only serves its shell), the
// module never loads and `__require2('fs')` is never hit.
//
// The .wasm import is a compile-time asset binding (wrangler resolves
// it to a WebAssembly.Module) — it does NOT execute esbuild-wasm's
// main.js, so it's safe to keep at the top level.
import type * as esbuild from 'esbuild-wasm';
import esbuildWasmUrl from 'esbuild-wasm/esbuild.wasm';

/**
 * Cached reference to the esbuild namespace. Populated on first
 * `loadEsbuild()` call; nullable until then so module-load code paths
 * that never touch bundling can complete without ever evaluating
 * `esbuild-wasm/lib/main.js`.
 */
let _esbuildMod: typeof esbuild | null = null;
let _esbuildLoadPromise: Promise<typeof esbuild> | null = null;

/**
 * Lazily load the esbuild-wasm namespace. Safe to call many times;
 * concurrent callers share a single in-flight Promise. Throws if the
 * CJS main module itself can't run (i.e. the runtime doesn't support
 * the require('fs') pattern esbuild-wasm uses) — callers should catch
 * and surface a helpful error rather than crash the Worker.
 */
async function loadEsbuild(): Promise<typeof esbuild> {
  if (_esbuildMod) return _esbuildMod;
  if (_esbuildLoadPromise) return _esbuildLoadPromise;
  _esbuildLoadPromise = (async () => {
    const mod = await import('esbuild-wasm');
    _esbuildMod = mod as unknown as typeof esbuild;
    return _esbuildMod;
  })();
  try {
    return await _esbuildLoadPromise;
  } catch (e) {
    // Reset so a future call can retry (e.g., after the caller has done
    // environment setup we didn't anticipate).
    _esbuildLoadPromise = null;
    throw e;
  }
}

// ── Types ───────────────────────────────────────────────────────────────

export interface TransformResult {
  code: string;
  map: string;
  warnings: { text: string; location?: any }[];
}

export interface BuildOutputFile {
  path: string;
  contents: string;
}

export interface BuildResult {
  outputFiles: BuildOutputFile[];
  errors: { text: string; location?: any }[];
  warnings: { text: string; location?: any }[];
}

// ── EsbuildService ──────────────────────────────────────────────────────

export class EsbuildService {
  private vfs: SqliteVFS;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  /** Resolved esbuild namespace — populated by ensureInit() after loadEsbuild(). */
  private _esbuild: typeof esbuild | null = null;

  constructor(vfs: SqliteVFS) {
    this.vfs = vfs;
  }

  /**
   * Initialize esbuild-wasm (lazy, on first use). Loads the namespace
   * via `loadEsbuild()` (which itself is deferred) and caches it on
   * `this._esbuild` so subsequent calls don't pay the dynamic-import
   * overhead. All call sites that previously used the top-level
   * `esbuild` namespace now use `this._esbuild!` after `await this.ensureInit()`.
   */
  private async ensureInit(): Promise<void> {
    if (this.initialized && this._esbuild) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        const esb = await loadEsbuild();
        this._esbuild = esb;
        // The supervisor loads esbuild-wasm via wrangler's static-import
        // resolution (`import esbuildWasmUrl from 'esbuild-wasm/esbuild.wasm'`
        // at the top of this file). At deploy time wrangler bundles the
        // .wasm bytes INTO the worker and resolves the import to a
        // WebAssembly.Module value. If the import didn't resolve to a
        // module — for example, a future bundler regression — we used
        // to silently fall back to fetching from cdn.jsdelivr.net. That
        // fallback violated the 100% edge contract: the supervisor
        // would issue a third-party CDN request mid-request to bring
        // up its bundler. Removed.
        //
        // If the bundled import is missing, fail loud with a clear
        // remediation (rebuild the worker with the wasm asset). The
        // supervisor's pre-bundle path also embeds esbuild-wasm via
        // src/esbuild-wasm-bundle.generated.ts, so a complete loss of
        // wasm support would surface there too.
        if (!esbuildWasmUrl || typeof esbuildWasmUrl !== 'object') {
          throw new Error(
            'esbuild-wasm bundled import is not a WebAssembly.Module. ' +
              'Rebuild the worker so wrangler resolves ' +
              '`esbuild-wasm/esbuild.wasm` at bundle time. ' +
              'NO CDN fallback (100% edge contract).',
          );
        }
        await esb.initialize({
          wasmModule: esbuildWasmUrl as any,
          worker: false,
        });
        this.initialized = true;
      } catch (e: any) {
        // "Cannot call initialize more than once" means it's already ready
        if (e?.message?.includes('more than once')) {
          this.initialized = true;
          return;
        }
        this.initPromise = null;
        throw new Error('esbuild init failed: ' + (e?.message || e));
      }
    })();

    return this.initPromise;
  }

  /**
   * Transform a single code string (TS→JS, JSX→JS, minify, etc.)
   */
  async transform(
    code: string,
    options?: {
      loader?: 'ts' | 'tsx' | 'jsx' | 'js' | 'css' | 'json';
      format?: 'esm' | 'cjs' | 'iife';
      target?: string;
      sourcemap?: boolean | 'inline' | 'external';
      minify?: boolean;
      jsx?: 'transform' | 'preserve' | 'automatic';
      jsxFactory?: string;
      jsxFragment?: string;
      tsconfigRaw?: string;
      define?: Record<string, string>;
    },
  ): Promise<TransformResult> {
    await this.ensureInit();

    const result = await this._esbuild!.transform(code, {
      loader: options?.loader || 'ts',
      format: options?.format || 'esm',
      target: options?.target || 'esnext',
      sourcemap: options?.sourcemap ?? false,
      minify: options?.minify ?? false,
      jsx: options?.jsx,
      jsxFactory: options?.jsxFactory,
      jsxFragment: options?.jsxFragment,
      tsconfigRaw: options?.tsconfigRaw,
      define: options?.define,
    });

    return {
      code: result.code,
      map: result.map || '',
      warnings: result.warnings?.map(w => ({
        text: w.text,
        location: w.location,
      })) || [],
    };
  }

  /**
   * Bundle entry points from the VFS.
   */
  async build(
    entryPoints: string[],
    options?: {
      bundle?: boolean;
      format?: 'esm' | 'cjs' | 'iife';
      target?: string;
      platform?: 'browser' | 'node' | 'neutral';
      outdir?: string;
      outfile?: string;
      sourcemap?: boolean | 'inline' | 'external';
      minify?: boolean;
      external?: string[];
      define?: Record<string, string>;
      globalName?: string;
      tsconfigRaw?: string;
      alias?: Record<string, string>;
      keepNames?: boolean;
    },
  ): Promise<BuildResult> {
    await this.ensureInit();

    // VFS plugin reads directly from VFS (synchronous, co-located)
    const vfsPlugin = this.makeVfsPlugin();

    const result = await this._esbuild!.build({
      entryPoints: entryPoints.map(ep => ep.startsWith('/') ? ep : '/' + ep),
      bundle: options?.bundle ?? true,
      write: false,
      format: options?.format || 'esm',
      target: options?.target || 'esnext',
      platform: options?.platform || 'browser',
      outdir: options?.outdir || (options?.outfile ? undefined : '/dist'),
      outfile: options?.outfile,
      sourcemap: options?.sourcemap ?? false,
      minify: options?.minify ?? false,
      external: options?.external,
      define: options?.define,
      globalName: options?.globalName,
      tsconfigRaw: options?.tsconfigRaw,
      alias: options?.alias,
      keepNames: options?.keepNames,
      // Prefer ESM builds and modern module fields. This matters for packages
      // like zustand that ship both CJS (main) and ESM (module / exports.import).
      // Without these, esbuild falls back to CJS which wraps everything in
      // __commonJS and only emits `export default`, losing named exports.
      conditions: ['import', 'module', 'browser', 'default'],
      mainFields: ['module', 'browser', 'main'],
      plugins: [vfsPlugin],
    });

    return {
      outputFiles: (result.outputFiles || []).map(f => ({
        path: f.path,
        contents: f.text,
      })),
      errors: result.errors?.map(e => ({ text: e.text, location: e.location })) || [],
      warnings: result.warnings?.map(w => ({ text: w.text, location: w.location })) || [],
    };
  }

  /**
   * VFS resolver plugin for esbuild.
   * Reads directly from the SqliteVFS (synchronous, co-located — no snapshot needed).
   * Handles: absolute paths, relative paths, bare specifiers (node_modules).
   */
  private makeVfsPlugin(): esbuild.Plugin {
    const vfs = this.vfs;
    const EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cjs', '.json', '.css'];
    const INDEX_FILES = ['index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.mjs'];

    // Path helpers shared with git-commands via ./vfs-path.ts.
    // Local aliases preserve the existing call-site readability inside this
    // closure; behavior is identical (the canonical normalizeVfsPath has a
    // bounds check on `..` that the previous local `normalize` lacked, but
    // for the well-formed paths esbuild produces this is a no-op).
    const strip = stripLeadingSlashes;
    const normalize = normalizeVfsPath;

    /**
     * Try to resolve a VFS path with extension/index fallbacks.
     *
     * Resolution order (first match wins):
     *   1. Exact path as given (covers `.ts`, `.js`, `.json`, `.css`, and
     *      any extension on disk) — via `''` being first in EXTS.
     *   2. Append-extension candidates from EXTS (`.ts`, `.tsx`, `.js`, …)
     *      for extensionless imports like `./foo`.
     *   3. TypeScript/ESM `moduleResolution: "bundler"` compatibility:
     *      if the input ends in `.js` / `.mjs` / `.cjs` / `.jsx` and
     *      NO file matched above, swap the extension to the TS
     *      equivalent and try those. This is the idiomatic
     *      `import {X} from './y.js'` pattern where on-disk it's `y.ts`.
     *      Order (TS spec): `.ts` → `.tsx` for `.js`/`.jsx`;
     *                        `.mts`       for `.mjs`;
     *                        `.cts`       for `.cjs`.
     *      Exact-match (step 1) happens first so a real `.js` on disk
     *      takes precedence over a co-located `.ts` — we never pretend
     *      a `.ts` is canonical when a `.js` actually exists.
     *   4. Directory index files (e.g. `./foo/index.ts`) as a last step.
     */
    function tryResolve(base: string): string | null {
      const norm = normalize(base);
      for (const ext of EXTS) {
        const candidate = norm + ext;
        if (vfs.exists(strip(candidate)) && !vfs.isDirectory(strip(candidate))) {
          return '/' + strip(candidate);
        }
      }
      // Step 3: TypeScript-bundler extension swap. Only runs when no
      // exact / extension-append match succeeded above — so real `.js`
      // files on disk always win.
      const jsExtMatch = norm.match(/\.(js|mjs|cjs|jsx)$/);
      if (jsExtMatch) {
        const withoutExt = norm.slice(0, norm.length - jsExtMatch[0].length);
        const swapMap: Record<string, string[]> = {
          js:  ['.ts', '.tsx'],
          jsx: ['.tsx', '.ts'],
          mjs: ['.mts', '.ts'],
          cjs: ['.cts', '.ts'],
        };
        const swaps = swapMap[jsExtMatch[1]] || [];
        for (const tsExt of swaps) {
          const candidate = withoutExt + tsExt;
          if (vfs.exists(strip(candidate)) && !vfs.isDirectory(strip(candidate))) {
            return '/' + strip(candidate);
          }
        }
      }
      // Step 4: directory index fallback.
      if (vfs.exists(strip(norm)) && vfs.isDirectory(strip(norm))) {
        for (const idx of INDEX_FILES) {
          const candidate = norm + '/' + idx;
          if (vfs.exists(strip(candidate))) return '/' + strip(candidate);
        }
      }
      return null;
    }

    /**
     * Resolve a Node.js subpath import (`#foo`).
     *
     * Per https://nodejs.org/api/packages.html#subpath-imports, a specifier
     * starting with `#` is looked up in the closest ancestor package.json's
     * `imports` field (not `exports`). This is used by packages like `vfile`
     * to switch between node and browser implementations:
     *
     *   "imports": {
     *     "#minpath": {
     *       "node": "./lib/minpath.js",
     *       "default": "./lib/minpath.browser.js"
     *     }
     *   }
     *
     * We walk up from the importer's directory looking for package.json.
     * Once found, we resolve the subpath using the same condition algorithm
     * as `exports` (with `import`, `module`, `browser`, `default` — skipping
     * `node` since we're bundling for the browser).
     *
     * The resolved value is a path relative to the owning package root, which
     * we turn back into a VFS path for esbuild to load.
     */
    function resolvePackageImport(specifier: string, fromDir: string): string | null {
      let dir = strip(fromDir);
      const visited = new Set<string>();
      while (dir && !visited.has(dir)) {
        visited.add(dir);

        const pkgJsonPath = dir + '/package.json';
        if (vfs.exists(strip(pkgJsonPath))) {
          try {
            const pkgJson = JSON.parse(vfs.readFileString(strip(pkgJsonPath)));
            if (pkgJson.imports) {
              // resolveExports happens to work for the imports field too —
              // both are subpath→condition maps using the same format. We
              // reuse it. The specifier (`#minpath`) IS the subpath key.
              const resolved = resolveExports(pkgJson.imports, specifier);
              if (resolved) {
                // Resolved value is relative to the owning package root
                const pkgRoot = dir;
                const absPath = pkgRoot + '/' + resolved.replace(/^\.\//, '');
                const finalPath = tryResolve(absPath);
                if (finalPath) return finalPath;
              }
            }
          } catch { /* malformed package.json — try parent */ }
        }

        // Stop at node_modules boundary — subpath imports only resolve against
        // the consuming package's own package.json, not its dependencies'.
        // But DO go up through node_modules/<pkg>/ to find <pkg>/package.json.
        if (dir.endsWith('/node_modules') || dir === 'node_modules') break;

        const lastSlash = dir.lastIndexOf('/');
        if (lastSlash <= 0) break;
        dir = dir.substring(0, lastSlash);
      }
      return null;
    }

    /**
     * Resolve bare specifier (npm package) by walking up node_modules.
     * Uses the full Node.js exports-field algorithm with ESM conditions so
     * packages like zustand correctly resolve to their ESM entry (./esm/index.mjs)
     * instead of the CJS main (./index.js).
     */
    function resolveBarePkg(specifier: string, fromDir: string): string | null {
      // Split scoped packages: @scope/pkg → ["@scope/pkg"]
      // Split subpath imports: pkg/sub/path → pkg, sub/path
      let pkgName: string;
      let subpath: string;
      if (specifier.startsWith('@')) {
        const parts = specifier.split('/');
        pkgName = parts.slice(0, 2).join('/');
        subpath = parts.slice(2).join('/');
      } else {
        const parts = specifier.split('/');
        pkgName = parts[0];
        subpath = parts.slice(1).join('/');
      }

      // Walk up directories looking for node_modules/<pkg>
      let dir = strip(fromDir);
      const visited = new Set<string>();
      while (dir && !visited.has(dir)) {
        visited.add(dir);
        const nmDir = dir + '/node_modules/' + pkgName;
        if (vfs.exists(strip(nmDir)) && vfs.isDirectory(strip(nmDir))) {
          // Read package.json so we can consult the exports field.
          const pkgJsonPath = nmDir + '/package.json';
          let pkgJson: any = null;
          if (vfs.exists(strip(pkgJsonPath))) {
            try { pkgJson = JSON.parse(vfs.readFileString(strip(pkgJsonPath))); } catch {}
          }

          if (pkgJson) {
            // Use the full exports-field resolution with ESM browser conditions.
            // This picks "./esm/index.mjs" over "./index.js" for packages like
            // zustand that expose both CJS and ESM builds.
            const subpathKey = subpath ? './' + subpath : '.';
            const entry = resolvePackageEntry(pkgJson, subpathKey);
            if (entry) {
              const resolved = tryResolve(nmDir + '/' + entry.replace(/^\.\//, ''));
              if (resolved) return resolved;
            }
          }

          // Fallback for subpath: try direct file resolution (e.g. pkg/lib/foo).
          if (subpath) {
            const resolved = tryResolve(nmDir + '/' + subpath);
            if (resolved) return resolved;
          }

          // Fallback for root: try index files directly
          const resolved = tryResolve(nmDir + '/index');
          if (resolved) return resolved;
        }
        // Move up one directory
        const lastSlash = dir.lastIndexOf('/');
        if (lastSlash <= 0) break;
        dir = dir.substring(0, lastSlash);
      }
      return null;
    }

    function inferLoader(path: string): esbuild.Loader {
      if (path.endsWith('.ts') || path.endsWith('.mts') || path.endsWith('.cts')) return 'ts';
      if (path.endsWith('.tsx')) return 'tsx';
      if (path.endsWith('.jsx')) return 'jsx';
      if (path.endsWith('.json')) return 'json';
      if (path.endsWith('.css')) return 'css';
      // Native binaries — load as base64 blobs instead of parsing as JS.
      // Defense-in-depth: the npm-installer pre-bundler also skips these,
      // but on-demand bundling or direct `import 'foo.wasm'` could still
      // hand us a raw WASM/native-addon path.
      if (path.endsWith('.wasm')) return 'binary';
      if (path.endsWith('.node')) return 'binary';
      return 'js';
    }

    return {
      name: 'nimbus-vfs',
      setup(build) {
        // Pre-compile the external list into exact matches and prefix patterns.
        // esbuild's `external` supports glob-like patterns (`react/*`) — we
        // reproduce that here so our plugin doesn't override the user's
        // external directive by resolving packages that should stay external.
        const externalList = build.initialOptions.external || [];
        const externalExact = new Set<string>();
        const externalPrefixes: string[] = [];
        for (const pat of externalList) {
          if (pat.endsWith('/*')) {
            externalPrefixes.push(pat.slice(0, -1)); // "react/" prefix (for "react/*")
          } else {
            externalExact.add(pat);
          }
        }
        const isExternal = (spec: string): boolean => {
          if (externalExact.has(spec)) return true;
          for (const pre of externalPrefixes) {
            if (spec.startsWith(pre)) return true;
          }
          return false;
        };

        build.onResolve({ filter: /.*/ }, (args) => {
          // 1. Subpath imports (#foo) — Node.js package.json `imports` field.
          // These MUST be resolved against the owning package's package.json,
          // not node_modules. Used by vfile, unified, and others to switch
          // between node/browser implementations.
          if (args.path.startsWith('#') && args.resolveDir) {
            const resolved = resolvePackageImport(args.path, strip(args.resolveDir));
            if (resolved) return { path: resolved, namespace: 'nimbus-vfs' };
            // If we can't resolve it, fall through — better to leak a bare
            // import that fails loudly than to pretend it's external.
          }

          // 2. Bare specifier + external → leave as-is so the browser resolves
          // via its own module resolver (which hits /preview/@modules/...).
          // This MUST come before any vfs resolution, otherwise we'd embed
          // the package into the bundle and break single-instance invariants
          // for react/react-dom.
          if (!args.path.startsWith('/') && !args.path.startsWith('.') && !args.path.startsWith('#')) {
            if (isExternal(args.path)) return { external: true };
          }
          // 3. Absolute paths
          if (args.path.startsWith('/')) {
            const resolved = tryResolve(args.path);
            if (resolved) return { path: resolved, namespace: 'nimbus-vfs' };
          }
          // 4. Relative paths
          if (args.path.startsWith('.') && args.resolveDir) {
            const dir = strip(args.resolveDir);
            const resolved = tryResolve(dir + '/' + args.path);
            if (resolved) return { path: resolved, namespace: 'nimbus-vfs' };
          }
          // 5. Bare specifier (npm package)
          if (!args.path.startsWith('/') && !args.path.startsWith('.') && !args.path.startsWith('#')) {
            const fromDir = args.resolveDir || '/home/user';
            const resolved = resolveBarePkg(args.path, fromDir);
            if (resolved) return { path: resolved, namespace: 'nimbus-vfs' };
            // Mark as external if not found (common for Node built-ins)
            return { external: true };
          }
          return { external: true };
        });

        build.onLoad({ filter: /.*/, namespace: 'nimbus-vfs' }, (args) => {
          const stripped = strip(args.path);
          try {
            const loader = inferLoader(args.path);
            const lastSlash = stripped.lastIndexOf('/');
            const resolveDir = lastSlash > 0 ? '/' + stripped.substring(0, lastSlash) : '/';
            // Binary loaders (wasm, native addons) must receive raw bytes.
            // TextDecoder would corrupt them with U+FFFD replacement chars.
            if (loader === 'binary') {
              const bytes = vfs.readFile(stripped);
              return { contents: bytes, loader, resolveDir };
            }
            const contents = vfs.readFileString(stripped);
            return { contents, loader, resolveDir };
          } catch {
            return { errors: [{ text: 'File not found in VFS: ' + args.path }] };
          }
        });
      },
    };
  }

  get isInitialized() { return this.initialized; }
}
