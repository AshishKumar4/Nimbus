#!/usr/bin/env node
/**
 * bundle-plugin-react.mjs — Pre-bundle @vitejs/plugin-react for the
 * real-vite facet.
 *
 * Path C from PHASE1-BLOCKER.md §"Why this isn't trivially fixable":
 * instead of asking the facet to runtime-resolve plugin-react's ESM
 * dependencies (which failed because our userspace-require uses
 * `new Function(code)`, a CJS wrapper that rejects ESM source text),
 * we pre-bundle the WHOLE plugin — including @babel/core,
 * react-refresh/babel, and the two babel JSX-helper plugins — into
 * one self-contained ESM string.
 *
 * Two critical transformations happen here:
 *
 *   1. Asset inlining (module-top fs.readFileSync elimination).
 *      plugin-react reads react-refresh-runtime.development.js and
 *      refreshUtils.js at module-init via `fs.readFileSync(...)`.
 *      esbuild sees those calls literally — it can't replace them
 *      statically. So this script reads those files at bundle time
 *      and does TEXTUAL replacement of the template-literal
 *      substitutions INSIDE plugin-react's source, turning the
 *      fs.readFileSync calls into string constants. Same trick we
 *      used to inline the rollup-WASM binary in bundle-real-vite.mjs.
 *
 *   2. Dynamic-import rewiring. plugin-react lazily loads
 *      @babel/core and the babel plugins via `await import(path)`.
 *      In our facet the specifiers "react-refresh/babel", "@babel/core",
 *      etc. aren't resolvable at runtime (no LOADER module graph for
 *      user node_modules). So we replace `loadPlugin(path)` with a
 *      switch that does STATIC imports — esbuild sees those, follows
 *      them, and inlines the targets in the output.
 *
 * Output: src/cirrus-plugin-react.generated.ts, exporting
 *   - CIRRUS_PLUGIN_REACT_BUNDLE (ESM string, ~3 MB)
 *   - CIRRUS_PLUGIN_REACT_VERSION
 *
 * The facet imports this string via a LOADER module at spawn time
 * (see src/cirrus-real.ts). The user-config bundle's
 * `import react from '@vitejs/plugin-react'` is rewritten to point
 * at the LOADER module.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'src', 'cirrus-plugin-react.generated.ts');

// Pinned to the version the Cirrus-shim React starter uses. If users
// specify a different version in their own project we'll still use this
// one for real-vite mode — Path C is a compatibility bridge, not a
// per-project bundler.
const PINNED_PLUGIN_REACT_VERSION = '~4.3.4';
const PINNED_REACT_REFRESH_VERSION = '^0.14.0';
const PINNED_BABEL_CORE_VERSION = '^7.25.0';
const PINNED_BABEL_PLUGIN_TRANSFORM_REACT_JSX_SELF = '^7.25.0';
const PINNED_BABEL_PLUGIN_TRANSFORM_REACT_JSX_SOURCE = '^7.25.0';
// Added by pathC step 7: plugin-react 4.x delegates JSX transform
// to Vite's esbuild. We disabled vite:esbuild for workerd, so we
// need Babel's JSX transformer bundled in instead.
const PINNED_BABEL_PLUGIN_TRANSFORM_REACT_JSX = '^7.25.0';
const PINNED_BABEL_PLUGIN_SYNTAX_JSX = '^7.25.0';
// Step 8: Vite's esbuild also lowered TypeScript syntax (interface,
// type annotations, `!` non-null assertions, enums, etc.). Same
// disablement kills that too. Bundle @babel/plugin-transform-typescript
// so plugin-react's Babel pass strips TS syntax from .ts/.tsx files.
const PINNED_BABEL_PLUGIN_TRANSFORM_TYPESCRIPT = '^7.25.0';
const PINNED_BABEL_PLUGIN_SYNTAX_TYPESCRIPT = '^7.25.0';

// Same NODE_BUILTINS list bundle-real-vite.mjs uses. workerd provides
// these via nodejs_compat.
const NODE_BUILTINS = [
  'node:assert', 'node:buffer', 'node:child_process', 'node:crypto',
  'node:dns', 'node:events', 'node:fs', 'node:fs/promises', 'node:http',
  'node:https', 'node:module', 'node:net', 'node:os', 'node:path',
  'node:perf_hooks', 'node:process', 'node:querystring', 'node:readline',
  'node:stream', 'node:string_decoder', 'node:timers', 'node:timers/promises',
  'node:tls', 'node:tty', 'node:url', 'node:util', 'node:v8',
  'node:worker_threads', 'node:zlib',
  'fs', 'path', 'url', 'util', 'os', 'net', 'crypto', 'child_process',
  'dns', 'tty', 'worker_threads', 'assert', 'process', 'v8', 'events',
  'http', 'https', 'zlib', 'stream', 'buffer', 'readline', 'module',
  'string_decoder', 'timers', 'querystring', 'perf_hooks',
];

// Optional deps babel tries to require() to detect feature support but
// never actually USES in the transform path plugin-react exercises.
// Stubbing these keeps the bundle small and avoids esbuild resolution
// errors.
const STUB_AS_EMPTY = new Set([
  '@babel/preset-typescript/package.json',
  '@babel/preset-env/package.json',
  '@babel/preset-react/package.json',
  '@babel/preset-flow/package.json',
  'lightningcss',
  'fsevents',
]);

async function ensureInstalled(opts) {
  // Does /tmp/cirrus-plugin-react-src already have everything?
  const SRC_DIR = path.join(ROOT, '.cirrus-plugin-react-src');
  const pkgPath = path.join(SRC_DIR, 'package.json');
  const pluginPath = path.join(SRC_DIR, 'node_modules/@vitejs/plugin-react/package.json');
  const babelPath = path.join(SRC_DIR, 'node_modules/@babel/core/package.json');
  try {
    await fs.access(pluginPath);
    await fs.access(babelPath);
    return SRC_DIR;
  } catch { /* need install */ }

  console.log(`[bundle-plugin-react] installing plugin-react + babel into ${SRC_DIR}...`);
  await fs.mkdir(SRC_DIR, { recursive: true });
  await fs.writeFile(pkgPath, JSON.stringify({
    name: 'cirrus-plugin-react-build',
    private: true,
    version: '0.0.0',
    dependencies: {
      '@vitejs/plugin-react': PINNED_PLUGIN_REACT_VERSION,
      'react-refresh': PINNED_REACT_REFRESH_VERSION,
      '@babel/core': PINNED_BABEL_CORE_VERSION,
      '@babel/plugin-transform-react-jsx-self': PINNED_BABEL_PLUGIN_TRANSFORM_REACT_JSX_SELF,
      '@babel/plugin-transform-react-jsx-source': PINNED_BABEL_PLUGIN_TRANSFORM_REACT_JSX_SOURCE,
      '@babel/plugin-transform-react-jsx': PINNED_BABEL_PLUGIN_TRANSFORM_REACT_JSX,
      '@babel/plugin-syntax-jsx': PINNED_BABEL_PLUGIN_SYNTAX_JSX,
      '@babel/plugin-transform-typescript': PINNED_BABEL_PLUGIN_TRANSFORM_TYPESCRIPT,
      '@babel/plugin-syntax-typescript': PINNED_BABEL_PLUGIN_SYNTAX_TYPESCRIPT,
    },
  }, null, 2));
  const { execSync } = await import('node:child_process');
  execSync('bun install', { cwd: SRC_DIR, stdio: 'inherit' });
  return SRC_DIR;
}

/**
 * Read an asset file, returning empty-comment fallback if missing.
 * Catches the "package installed without dist files" edge case.
 */
async function readAssetOrBlank(p, label) {
  try { return await fs.readFile(p, 'utf8'); }
  catch {
    console.warn(`[bundle-plugin-react] WARN: ${label} at ${p} missing; bundling empty.`);
    return `/* cirrus: ${label} missing at bundle time */`;
  }
}

function makeInlineAssetsPlugin(srcDir) {
  const pluginIndex = /@vitejs[\\/]plugin-react[\\/]dist[\\/]index\.(mjs|cjs)$/;

  return {
    name: 'cirrus-plugin-react-inline',
    setup(build) {
      // Stub optional-probing requires.
      for (const s of STUB_AS_EMPTY) {
        const re = new RegExp(
          '^' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$',
        );
        build.onResolve({ filter: re }, (args) => ({
          path: args.path, namespace: 'cirrus-stub-empty',
        }));
      }
      build.onLoad({ filter: /.*/, namespace: 'cirrus-stub-empty' }, () => ({
        contents: 'module.exports = {};', loader: 'js',
      }));

      // Source-level rewrites for plugin-react's index.mjs.
      build.onLoad({ filter: pluginIndex }, async (args) => {
        const src = await fs.readFile(args.path, 'utf8');
        const pluginDir = args.path.replace(/[\\/]index\.(mjs|cjs)$/, '');
        // react-refresh is a sibling of @vitejs in node_modules/.
        // args.path = <srcDir>/node_modules/@vitejs/plugin-react/dist/index.mjs
        //   → node_modules_dir    = <srcDir>/node_modules
        //   → reactRefreshDir     = <srcDir>/node_modules/react-refresh
        const vitejs_dir = path.dirname(path.dirname(pluginDir)); // .../node_modules/@vitejs
        const nodeModulesDir = path.dirname(vitejs_dir);          // .../node_modules
        const reactRefreshDir = path.join(nodeModulesDir, 'react-refresh');

        const rrRuntime = await readAssetOrBlank(
          path.join(reactRefreshDir, 'cjs/react-refresh-runtime.development.js'),
          'react-refresh-runtime.development.js',
        );
        const rrUtils = await readAssetOrBlank(
          path.join(pluginDir, 'refreshUtils.js'),
          '@vitejs/plugin-react/dist/refreshUtils.js',
        );

        const esc = (s) =>
          s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

        let patched = src;

        // Inline the two fs.readFileSync calls that happen at module
        // init. Both are template-literal substitutions, so we swap
        // them for the escaped file contents.
        patched = patched.replace(
          /\$\{fs\.readFileSync\(runtimeFilePath,\s*"utf-8"\)\}/g,
          esc(rrRuntime),
        );
        patched = patched.replace(
          /\$\{fs\.readFileSync\(_require\.resolve\("\.\/refreshUtils\.js"\),\s*"utf-8"\)\}/g,
          esc(rrUtils),
        );

        // The two path-computation calls that populate runtimeFilePath
        // / reactRefreshDir are now dead — neutralise them so the
        // remaining `path.join` / `path.dirname` don't trip on bundle-
        // time `_require.resolve` (it won't exist at runtime).
        patched = patched.replace(
          /path\.dirname\(\s*_require\.resolve\("react-refresh\/package\.json"\)\s*\)/g,
          'String("/__cirrus_stub_react_refresh_dir__")',
        );
        patched = patched.replace(
          /path\.join\(\s*reactRefreshDir,\s*"cjs\/react-refresh-runtime\.development\.js"\s*\)/g,
          'String("/__cirrus_stub_runtime_file__")',
        );

        // Rewire loadPlugin() to use static imports. esbuild will
        // resolve these at bundle time and include the plugins inline.
        // Also add a new well-known entry "@babel/plugin-transform-react-jsx"
        // so our transform-patch (below) can load the JSX transformer.
        patched = patched.replace(
          /const loadedPlugin = [\s\S]*?return promise;\s*\}/,
          `
const loadedPlugin = /* @__PURE__ */ new Map();
async function loadPlugin(path) {
  if (loadedPlugin.has(path)) return loadedPlugin.get(path);
  let value;
  switch (path) {
    case "react-refresh/babel":
      value = (await import("react-refresh/babel")).default;
      break;
    case "@babel/plugin-transform-react-jsx-self":
      value = (await import("@babel/plugin-transform-react-jsx-self")).default;
      break;
    case "@babel/plugin-transform-react-jsx-source":
      value = (await import("@babel/plugin-transform-react-jsx-source")).default;
      break;
    case "@babel/plugin-transform-react-jsx":
      value = (await import("@babel/plugin-transform-react-jsx")).default;
      break;
    case "@babel/plugin-transform-typescript":
      value = (await import("@babel/plugin-transform-typescript")).default;
      break;
    default:
      throw new Error("[cirrus-plugin-react] unknown loadPlugin spec: " + path);
  }
  loadedPlugin.set(path, value);
  return value;
}
          `.trim(),
        );

        // Step 7 critical fix: plugin-react 4.x delegates JSX syntax
        // transformation to Vite's esbuild. In real-vite mode we
        // disabled vite:esbuild (workerd forbids eval), so JSX
        // reaches import-analysis unparsed and crashes. Inject the
        // Babel JSX transformer into plugins[] right after the
        // react-refresh/babel push — so every .jsx/.tsx file gets
        // JSX syntax lowered BEFORE import-analysis sees it.
        //
        // We insert the JSX plugin BEFORE the refresh plugin so the
        // refresh-sig detection (which runs on the post-JSX output
        // via the refreshContentRE regex) sees jsx(...) call
        // expressions, not raw JSX elements.
        patched = patched.replace(
          /const plugins = \[\.\.\.babelOptions\.plugins\];/,
          `const plugins = [...babelOptions.plugins];
        /* cirrus-real: inject Babel transforms for both JSX AND
           TypeScript syntax. plugin-react 4.x normally delegates
           both to Vite's esbuild — which we disabled because workerd
           forbids eval. */
        const filepath_cirrus = filepath;
        const isTS_cirrus = /\\.tsx?$/.test(filepath_cirrus);
        const isJSX_cirrus = filepath_cirrus.endsWith(".jsx") || filepath_cirrus.endsWith(".tsx");
        if (isTS_cirrus) {
          const tsPlugin = await loadPlugin("@babel/plugin-transform-typescript");
          plugins.push([tsPlugin, {
            isTSX: isJSX_cirrus,
            allExtensions: true,
            /* Allow namespace (required for some patterns). allowDeclareFields
               is a default-true in Babel 7.25+; noops on older versions. */
            allowNamespaces: true,
            allowDeclareFields: true,
            /* Preserve JSX — the jsx transform runs AFTER this plugin,
               converting JSX to jsx() calls. */
            onlyRemoveTypeImports: false,
          }]);
        }
        if (isJSX_cirrus) {
          const jsxPlugin = await loadPlugin("@babel/plugin-transform-react-jsx");
          plugins.push([jsxPlugin, {
            runtime: opts.jsxRuntime === "classic" ? "classic" : "automatic",
            importSource: opts.jsxImportSource || "react",
            development: !isProduction,
          }]);
        }`,
        );

        return { contents: patched, loader: 'js' };
      });
    },
  };
}

async function main() {
  const srcDir = await ensureInstalled();
  const entry = path.join(
    srcDir, 'node_modules/@vitejs/plugin-react/dist/index.mjs',
  );
  const pluginPkg = JSON.parse(
    await fs.readFile(
      path.join(srcDir, 'node_modules/@vitejs/plugin-react/package.json'),
      'utf8',
    ),
  );
  const pluginReactVersion = pluginPkg.version;

  console.log(`[bundle-plugin-react] bundling @vitejs/plugin-react@${pluginReactVersion}...`);

  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    write: false,
    // `vite` is external — the facet provides vite-config-helper.js
    // at runtime, pointing at the real bundled Vite.
    external: [...NODE_BUILTINS, 'vite'],
    conditions: ['import', 'node'],
    mainFields: ['module', 'main'],
    keepNames: true,
    minify: false,
    plugins: [makeInlineAssetsPlugin(srcDir)],
    define: {
      'process.env.NODE_ENV': JSON.stringify('development'),
      // @babel/types / @babel/helper-validator flip these off in
      // production builds; keep them off in our bundle too.
      'process.env.BABEL_TYPES_8_BREAKING': JSON.stringify('false'),
      'process.env.BABEL_8_BREAKING': JSON.stringify('false'),
      'process.env.BABEL_DISABLE_CACHE': JSON.stringify('true'),
      // Match bundle-real-vite.mjs's convention so any references to
      // import.meta.url inside plugin-react's bundle dont crash.
      'import.meta.url': JSON.stringify('file:///cirrus-plugin-react.js'),
    },
    logLevel: 'warning',
  });

  if (result.errors.length) {
    console.error('[bundle-plugin-react] errors:', result.errors);
    process.exit(1);
  }

  let bundle = result.outputFiles[0].text;
  console.log(
    `[bundle-plugin-react] pre-patch size: ${(bundle.length / 1024).toFixed(1)} KB`,
  );

  // Rewrite `import "vite"` / `from "vite"` → a facet-local helper.
  // LOADER.load modules must end in .js, so the specifier has to
  // resolve to a real filename. cirrus-real.ts provides
  // 'vite-config-helper.js' that re-exports vite.bundle.js.
  let viteRewrites = 0;
  bundle = bundle.replace(/from\s*["']vite["']/g, () => {
    viteRewrites++;
    return 'from "./vite-config-helper.js"';
  });
  bundle = bundle.replace(/import\s*["']vite["']/g, () => {
    viteRewrites++;
    return 'import "./vite-config-helper.js"';
  });
  console.log(`[bundle-plugin-react] vite import rewrites: ${viteRewrites}`);

  // Same esbuild __require polyfill replacement bundle-real-vite.mjs
  // does. The bundled babel/core uses __require for optional deps at
  // runtime; without replacement it throws on every lookup.
  let requirePolyfillPatches = 0;
  bundle = bundle.replace(
    /var __require = [\s\S]*?throw Error\('Dynamic require of "' \+ x \+ '" is not supported'\);\s*\}\);/,
    () => {
      requirePolyfillPatches++;
      return `var __require = /* @__PURE__ */ (function() {
  let _cjsRequire = null;
  function _getRequire() {
    if (_cjsRequire) return _cjsRequire;
    const cr = globalThis.__cirrusNodeCreateRequire;
    if (cr) {
      try { _cjsRequire = cr("file:///cirrus-plugin-react.js"); } catch {}
    }
    return _cjsRequire;
  }
  return function __require(name) {
    if (globalThis.__cirrusNodeBuiltinTable && globalThis.__cirrusNodeBuiltinTable[name]) {
      return globalThis.__cirrusNodeBuiltinTable[name];
    }
    if (globalThis.__cirrusRealRequireShim) {
      try { return globalThis.__cirrusRealRequireShim(name); } catch {}
    }
    if (globalThis.__cirrusRealUserspaceRequire) {
      try {
        const mod = globalThis.__cirrusRealUserspaceRequire(name);
        if (mod) return mod;
      } catch {}
    }
    const req = _getRequire();
    if (req) {
      try { return req(name); }
      catch (e) { throw Error('[cirrus-plugin-react __require] "' + name + '" failed: ' + (e?.message || e)); }
    }
    throw Error('[cirrus-plugin-react __require] "' + name + '" unresolved');
  };
})();`;
    },
  );
  console.log(
    `[bundle-plugin-react] __require polyfill patches: ${requirePolyfillPatches}`,
  );
  console.log(
    `[bundle-plugin-react] post-patch size: ${(bundle.length / 1024).toFixed(1)} KB`,
  );

  const header = `/**
 * cirrus-plugin-react.generated.ts — AUTO-GENERATED by
 * scripts/bundle-plugin-react.mjs. DO NOT EDIT.
 *
 * Self-contained @vitejs/plugin-react@${pluginReactVersion} bundle with
 * @babel/core + react-refresh/babel + jsx-self/source plugins inlined.
 * Module-top fs.readFileSync calls for refreshUtils.js and
 * react-refresh-runtime.development.js are pre-resolved to string
 * constants at bundle time.
 *
 * Consumed by src/cirrus-real.ts at facet spawn — injected as a
 * LOADER module named 'cirrus-plugin-react.js'. User vite.config.ts'
 * \`import react from '@vitejs/plugin-react'\` is rewritten to point
 * at that module.
 */

export const CIRRUS_PLUGIN_REACT_VERSION = ${JSON.stringify(pluginReactVersion)};

export const CIRRUS_PLUGIN_REACT_BUNDLE: string = ${JSON.stringify(bundle)};
`;

  await fs.writeFile(OUT, header, 'utf8');
  console.log(
    `[bundle-plugin-react] wrote ${OUT} (${(header.length / 1024).toFixed(1)} KB)`,
  );
}

main().catch((e) => {
  console.error('[bundle-plugin-react] failed:', e);
  process.exit(1);
});
