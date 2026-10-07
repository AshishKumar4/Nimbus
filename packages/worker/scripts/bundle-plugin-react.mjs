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
import { NODE_BUILTINS, replaceSeam, requirePolyfillSeam, withoutStorePaths } from './cirrus-bundle-shared.mjs';
import { patchPluginReactIndex } from './plugin-react-bundle-patches.mjs';
import { resolvePackageDir } from './resolve-package-dir.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'src', 'cirrus-plugin-react.generated.ts');
// [sdk-phase-1] Large bundle (~3 MB) ships via ASSETS binding.
const ASSETS_DIR = path.join(ROOT, 'public', '_assets');
const ASSET_PATH = '/_assets/cirrus-plugin-react.bundle.js';

// Every input is a devDependency of @nimbus-sh/worker, pinned exactly and
// installed from the repo lockfile, so `bun run bundle` rebuilds the staged
// bundle byte for byte and dist-integrity checks it like every other asset:
//   - @vitejs/plugin-react: the plugin itself, and refreshUtils.js.
//   - react-refresh: the runtime plugin-react serves at /@react-refresh, and
//     react-refresh/babel.
//   - The Babel transforms loadPlugin() loads. plugin-react 4.x leaves JSX
//     and TypeScript to Vite's esbuild, which real-vite mode disables, so
//     @babel/plugin-transform-react-jsx and -typescript are bundled in
//     beside the -jsx-self / -jsx-source plugins it ships with.
//   - @babel/types and @babel/parser, which every Babel package imports: the
//     lockfile keeps 7.29.7 for the dependents that had it before these pins
//     arrived, so without one resolution the bundle would carry two copies.
// They resolve from packages/worker, never from wherever a transitive
// dependency happens to be linked.
const WORKER_RESOLVED = new Set([
  'react-refresh/babel',
  '@babel/parser',
  '@babel/plugin-transform-react-jsx',
  '@babel/plugin-transform-react-jsx-self',
  '@babel/plugin-transform-react-jsx-source',
  '@babel/plugin-transform-typescript',
  '@babel/types',
]);

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

/** Read an asset plugin-react inlines; a missing one fails the build. */
async function readAsset(p, label) {
  try { return await fs.readFile(p, 'utf8'); }
  catch (e) {
    throw new Error(`[bundle-plugin-react] ${label} missing at ${p}: ${e?.message || e}`);
  }
}

function makeInlineAssetsPlugin() {
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

      // loadPlugin()'s targets resolve from packages/worker's own pins.
      build.onResolve({ filter: /^(?:react-refresh|@babel)\// }, async (args) => {
        if (!WORKER_RESOLVED.has(args.path) || args.pluginData?.fromWorker) return undefined;
        const resolved = await build.resolve(args.path, { kind: args.kind, resolveDir: ROOT, pluginData: { fromWorker: true } });
        if (resolved.errors.length > 0) return { errors: resolved.errors };
        return { path: resolved.path, namespace: resolved.namespace, sideEffects: resolved.sideEffects };
      });

      // Source-level rewrites for plugin-react's index.mjs.
      build.onLoad({ filter: pluginIndex }, async (args) => {
        const src = await fs.readFile(args.path, 'utf8');
        const pluginDir = path.dirname(args.path);
        const rrRuntime = await readAsset(
          path.join(resolvePackageDir('react-refresh', { start: ROOT }), 'cjs/react-refresh-runtime.development.js'),
          'react-refresh-runtime.development.js',
        );
        const rrUtils = await readAsset(
          path.join(pluginDir, 'refreshUtils.js'),
          '@vitejs/plugin-react/dist/refreshUtils.js',
        );

        const patched = patchPluginReactIndex(src, { refreshRuntime: rrRuntime, refreshUtils: rrUtils });

        return { contents: patched, loader: 'js' };
      });
    },
  };
}

async function main() {
  const pluginDir = resolvePackageDir('@vitejs/plugin-react', { start: ROOT });
  const entry = path.join(pluginDir, 'dist/index.mjs');
  const pluginReactVersion = JSON.parse(
    await fs.readFile(path.join(pluginDir, 'package.json'), 'utf8'),
  ).version;

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
    plugins: [makeInlineAssetsPlugin()],
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

  let bundle = withoutStorePaths(result.outputFiles[0].text);
  console.log(
    `[bundle-plugin-react] pre-patch size: ${(bundle.length / 1024).toFixed(1)} KB`,
  );

  // Rewrite `import "vite"` / `from "vite"` → a facet-local helper.
  // LOADER.load modules must end in .js, so the specifier has to
  // resolve to a real filename. cirrus-real.ts provides
  // 'vite-config-helper.js' that re-exports vite.bundle.js.
  bundle = replaceSeam(bundle, {
    label: 'plugin-react vite import',
    find: /\b(from|import)\s*["']vite["']/g,
    replace: (_m, keyword) => `${keyword} "./vite-config-helper.js"`,
    min: 1,
  });

  // The bundled babel/core uses __require for optional deps at runtime;
  // esbuild's polyfill throws on every lookup in workerd.
  bundle = replaceSeam(bundle, requirePolyfillSeam({
    base: 'file:///cirrus-plugin-react.js',
    label: 'cirrus-plugin-react',
  }));
  console.log(
    `[bundle-plugin-react] post-patch size: ${(bundle.length / 1024).toFixed(1)} KB`,
  );

  // [sdk-phase-1] Promote the big bundle string to a public asset.
  await fs.mkdir(ASSETS_DIR, { recursive: true });
  await fs.writeFile(path.join(ASSETS_DIR, 'cirrus-plugin-react.bundle.js'), bundle, 'utf8');

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
 *
 * [sdk-phase-1] The bundle string ships via the ASSETS binding instead
 * of inline. Use {@link getCirrusPluginReactBundle}. Version constant
 * stays inline.
 */

import { loadAssetText, type AssetsFetcher } from '@nimbus-sh/core/runtime/assets-loader.js';

export const CIRRUS_PLUGIN_REACT_VERSION = ${JSON.stringify(pluginReactVersion)};

/** Asset path for the bundle. Use {@link getCirrusPluginReactBundle}. */
export const CIRRUS_PLUGIN_REACT_BUNDLE_PATH = ${JSON.stringify(ASSET_PATH)};

/**
 * Fetch the bundle string from the ASSETS binding. Cached per-isolate.
 *
 * @param env Object with the \`ASSETS\` binding.
 * @returns The plugin-react bundle as a UTF-8 string.
 * @throws {NimbusAssetLoadError} when binding missing or fetch fails.
 */
export function getCirrusPluginReactBundle(env: { ASSETS: AssetsFetcher }): Promise<string> {
  return loadAssetText(env.ASSETS, CIRRUS_PLUGIN_REACT_BUNDLE_PATH);
}
`;

  await fs.writeFile(OUT, header, 'utf8');
  console.log(
    `[bundle-plugin-react] wrote ${OUT} (${(header.length / 1024).toFixed(1)} KB shim) + ${ASSETS_DIR}/cirrus-plugin-react.bundle.js (${(bundle.length / 1024 / 1024).toFixed(1)} MB)`,
  );
}

main().catch((e) => {
  console.error('[bundle-plugin-react] failed:', e);
  process.exit(1);
});
