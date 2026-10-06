#!/usr/bin/env node
/**
 * bundle-real-vite.mjs — Phase 0 spike bundler for real Vite in a facet.
 *
 * Pre-bundles the real `vite` npm package into a single ESM string that
 * we can inject into a dynamic worker loaded via env.LOADER.load(). The
 * facet imports it via `import * as vite from './real-vite.bundle.js'`.
 *
 * Strategy (matches PHASE2-REAL-VITE-PLAN.md §2):
 *   - Install vite from npm if missing
 *   - Bundle vite/dist/node/index.js with esbuild (platform=neutral)
 *   - Stub out all native-binding imports: rolldown/*, lightningcss,
 *     @swc/core, fsevents, #module-sync-enabled
 *   - Keep node:* imports external — the facet gets nodejs_compat so
 *     workerd provides them
 *   - Write to src/real-vite-bundle.generated.ts as a TS string export
 *
 * This is a FEASIBILITY SPIKE: the bundle will let Vite import, but any
 * call path that hits a stubbed function (most of build/*, some of
 * dev/* via bundleConfigFile) will throw. That's expected. The Phase 0
 * question is "can the import+createServer+listen path survive?"
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import { NODE_BUILTINS, withoutStorePaths } from './cirrus-bundle-shared.mjs';
import { patchRealViteBundle } from './real-vite-bundle-patches.mjs';
import { resolvePackageDir } from './resolve-package-dir.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'src', 'real-vite-bundle.generated.ts');
// [sdk-phase-1] Large blobs ship via the ASSETS binding instead of inline.
// Cuts Worker-bundle size from ~13 MB → ~5 MB while keeping the
// (small) version constant + browser-runtime mjs files inline.
const ASSETS_DIR = path.join(ROOT, 'public', '_assets');
const ASSET_PATH_VITE_BUNDLE = '/_assets/real-vite-bundle.js';
const ASSET_PATH_ROLLUP_WASM = '/_assets/rollup.wasm';
// LOADER modules the facet supplies at load time (cirrus-real.ts), kept
// external beside the native builtins:
//   - real-node-fs*.js: raw node:fs re-exports the fs-shim wraps.
//   - cirrus-fs*.js: the fs-shim (src/facets/real-vite-fs-shim.ts); Vite's
//     node:fs / node:fs/promises imports are rewritten to these.
//   - cirrus-ws.js / cirrus-chokidar.js: the HMR WebSocket server and
//     file-watcher shims.
const LOADER_EXTERNALS = [
  'real-node-fs.js', 'real-node-fs-promises.js',
  'cirrus-fs.js', 'cirrus-fs-promises.js',
  'cirrus-ws.js', 'cirrus-chokidar.js',
];

// Modules we fully replace with stubs. These are native-binding-backed or
// otherwise won't run inside workerd.
const HARD_STUBS = [
  'rolldown',
  'rolldown/parseAst',
  'rolldown/plugins',
  'rolldown/utils',
  'rolldown/filter',
  'rolldown/experimental',
  'rolldown/config',
  'lightningcss',
  '@swc/core',
  'fsevents',
];

// esbuild gets its own stub (separate from HARD_STUBS because it
// needs a different set of thrower functions). In real-vite mode
// no esbuild call is ever reachable: vite:esbuild transform is
// patched to use our CJS→ESM intercept, replaceDefine is patched
// to use regex replacement, optimizeDeps is disabled, and vite
// build is blocked (rolldown needs node:wasi). Bundling the real
// esbuild-wasm adds ~2.3 MB of JS + WASM to the facet for zero
// runtime benefit — big contributor to the facet OOM at 137.
const ESBUILD_STUB_SRC = `
const thrower = (name) => () => { throw new Error('[cirrus-real] esbuild.' + name + ' stubbed — real-vite facet does not ship esbuild runtime'); };
export const transform = thrower('transform');
export const transformSync = thrower('transformSync');
export const build = thrower('build');
export const buildSync = thrower('buildSync');
export const context = thrower('context');
export const formatMessages = async () => [];
export const formatMessagesSync = () => [];
export const analyzeMetafile = async () => '';
export const analyzeMetafileSync = () => '';
export const stop = () => {};
export const version = '0.0.0-cirrus-stub';
export const initialize = async () => {};
export default { transform, transformSync, build, buildSync, context, formatMessages, formatMessagesSync, analyzeMetafile, analyzeMetafileSync, stop, version, initialize };
`;

function stubSource() {
  // Minimal stub: every named export throws if ever actually called, and
  // plugin-factory-style exports return harmless no-op plugins so the
  // config phase doesn't blow up. Vite imports these statically from
  // rolldown/parseAst, rolldown/plugins, rolldown/utils, rolldown/filter,
  // rolldown/experimental at the TOP of its bundle — they MUST import
  // cleanly or the whole module graph fails to load.
  return `
const NOOP_PLUGIN = (name) => ({ name: 'real-vite-spike-stub-' + name });
const thrower = (name) => () => { throw new Error('[real-vite-spike] ' + name + ' is stubbed (native binding)'); };
// parseAst/parseAstAsync are invoked by vite.parseAst / parseAstAsync.
// They'll throw if reached — but Vite can boot without ever calling them
// if we avoid the build path.
export const parseAst = thrower('rolldown.parseAst');
export const parseAstAsync = async (...a) => parseAst(...a);
export const rolldown = thrower('rolldown');
export const VERSION = '0.0.0-stub';
export const TsconfigCache = class { constructor() {} get() { return null; } set() {} };
export const Visitor = class {};
export const minify = thrower('minify');
export const minifySync = thrower('minifySync');
export const parse = thrower('parse');
export const parseSync = thrower('parseSync');
export const transformSync = thrower('transformSync');
export const esmExternalRequirePlugin = () => NOOP_PLUGIN('esmExternalRequirePlugin');
export const exactRegex = (r) => r;
export const makeIdFiltersToMatchWithQuery = () => [];
export const prefixRegex = (r) => r;
export const withFilter = (x) => x;
// rolldown/experimental exports — these are called as plugin factories by Vite internals.
export const dev = () => {};
export const oxcRuntimePlugin = () => NOOP_PLUGIN('oxcRuntimePlugin');
export const resolveTsconfig = () => null;
export const scan = async () => ({});
export const viteAliasPlugin = () => NOOP_PLUGIN('viteAliasPlugin');
export const viteBuildImportAnalysisPlugin = () => NOOP_PLUGIN('viteBuildImportAnalysisPlugin');
export const viteDynamicImportVarsPlugin = () => NOOP_PLUGIN('viteDynamicImportVarsPlugin');
export const viteImportGlobPlugin = () => NOOP_PLUGIN('viteImportGlobPlugin');
export const viteJsonPlugin = () => NOOP_PLUGIN('viteJsonPlugin');
export const viteLoadFallbackPlugin = () => NOOP_PLUGIN('viteLoadFallbackPlugin');
export const viteManifestPlugin = () => NOOP_PLUGIN('viteManifestPlugin');
export const viteModulePreloadPolyfillPlugin = () => NOOP_PLUGIN('viteModulePreloadPolyfillPlugin');
export const viteReporterPlugin = () => NOOP_PLUGIN('viteReporterPlugin');
export const viteResolvePlugin = () => NOOP_PLUGIN('viteResolvePlugin');
export const viteTransformPlugin = () => NOOP_PLUGIN('viteTransformPlugin');
export const viteWasmFallbackPlugin = () => NOOP_PLUGIN('viteWasmFallbackPlugin');
export const viteWebWorkerPostPlugin = () => NOOP_PLUGIN('viteWebWorkerPostPlugin');
// lightningcss
export const transform = thrower('lightningcss.transform');
export const bundle = thrower('lightningcss.bundle');
export const bundleAsync = async (...a) => thrower('lightningcss.bundleAsync')();
// generic fallback
export default { __stubbed: true };
`.trim();
}

const stubPlugin = {
  name: 'real-vite-stubs',
  setup(build) {
    for (const s of HARD_STUBS) {
      const re = new RegExp('^' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\//g, '\\/') + '$');
      build.onResolve({ filter: re }, (args) => ({ path: args.path, namespace: 'real-vite-stub' }));
    }
    // Stub esbuild out of the bundle entirely (see ESBUILD_STUB_SRC
    // comment). Saves ~2.3 MB.
    build.onResolve({ filter: /^esbuild$/ }, (args) => ({
      path: args.path, namespace: 'real-vite-esbuild-stub',
    }));
    build.onLoad({ filter: /.*/, namespace: 'real-vite-esbuild-stub' }, () => ({
      contents: ESBUILD_STUB_SRC, loader: 'js',
    }));
    // Vite imports "#module-sync-enabled" as a subpath import conditionally.
    build.onResolve({ filter: /^#module-sync-enabled$/ }, (args) => ({
      path: args.path, namespace: 'real-vite-stub-bool-false',
    }));
    build.onLoad({ filter: /.*/, namespace: 'real-vite-stub' }, () => ({
      contents: stubSource(), loader: 'js',
    }));
    build.onLoad({ filter: /.*/, namespace: 'real-vite-stub-bool-false' }, () => ({
      contents: 'export default false;', loader: 'js',
    }));

    // FS shim: intercept node:fs / node:fs/promises at bundle time.
    // In Phase 0 we inlined a small shim here. In Phase 1 we route
    // EVERY node:fs import in the Vite bundle to a separate
    // 'cirrus-fs.js' / 'cirrus-fs-promises.js' module supplied at
    // facet-load time via LOADER.load's modules map. Keeping the
    // shim out-of-bundle means we can iterate on it (add VFS-backed
    // reads, watch events, etc.) WITHOUT rebuilding the 2.5 MB
    // vite.bundle.js.
    build.onResolve({ filter: /^node:fs$|^fs$/ }, () => ({
      path: 'cirrus-fs.js', external: true,
    }));
    build.onResolve({ filter: /^node:fs\/promises$|^fs\/promises$/ }, () => ({
      path: 'cirrus-fs-promises.js', external: true,
    }));

    // rollup and its subpaths → @rollup/wasm-node, the worker's pin, as an
    // esbuild alias would map them. Rollup 4's native.js
    // loads a platform-specific Rust binding via require(), which workerd
    // can't load; the wasm-node build is pure JS over a .wasm file. No
    // esbuild alias: `esbuild` is stubbed above, which saves ~2.3 MB the
    // facet would hold for code paths it never runs.
    build.onResolve({ filter: /^rollup(?:\/.*)?$/ }, async (args) => {
      const resolved = await build.resolve('@rollup/wasm-node' + args.path.slice('rollup'.length), {
        kind: args.kind, resolveDir: ROOT,
      });
      if (resolved.errors.length > 0) return { errors: resolved.errors };
      return { path: resolved.path, namespace: resolved.namespace, sideEffects: resolved.sideEffects };
    });

    // Phase 2: ws + chokidar shims. Externalize so the facet supplies
    // our WebSocket-server / file-watcher implementations at load time.
    build.onResolve({ filter: /^ws$/ }, () => ({
      path: 'cirrus-ws.js', external: true,
    }));
    build.onResolve({ filter: /^chokidar$/ }, () => ({
      path: 'cirrus-chokidar.js', external: true,
    }));
  },
};

// Vite 6.x (esbuild + Rollup, pure JS stack, no mandatory rolldown).
// Vite 7/8 made oxc + rolldown mandatory plugins in the dev-server
// resolve/load chain — both rely on native Rust binaries and a
// wasm32-wasi fallback that workerd can't host (no node:wasi).
// Vite 6 is the LAST version with a pure-JS dev server and — unlike
// Vite 5 — supports modern React (uses up-to-date esbuild).
//
// See PHASE2-REAL-VITE-PLAN.md §1.2: "rolldown cannot be instantiated
// inside a DO/facet today". Phase 0 confirmed this at plugin-init;
// Phase 1 e2e testing confirmed Vite 8 dev ALSO depends on these
// plugins for URL → file path resolution (oxcResolvePlugin).
const PINNED_VITE_MAJOR = '6';

async function main() {
  // vite and @rollup/wasm-node are exact devDependencies of @nimbus-sh/worker,
  // installed from the repo lockfile: `bun run bundle` rebuilds this bundle
  // byte for byte and dist-integrity checks it.
  const viteDir = resolvePackageDir('vite', { start: ROOT });
  const wasmRollupDir = resolvePackageDir('@rollup/wasm-node', { start: ROOT });
  const viteVersion = JSON.parse(await fs.readFile(path.join(viteDir, 'package.json'), 'utf8')).version;
  if (!viteVersion.startsWith(PINNED_VITE_MAJOR + '.')) {
    throw new Error(`bundle-real-vite: vite@${viteVersion} is pinned; only Vite ${PINNED_VITE_MAJOR} has a dev server without rolldown`);
  }
  console.log(`[bundle-real-vite] bundling vite@${viteVersion} dist/node/index.js...`);

  // The rollup wasm-node binding does `readFileSync(__dirname + '/bindings_wasm_bg.wasm')`;
  // the facet's fs shim answers that from this binary, staged beside the
  // bundle (a LOADER module cannot be .wasm).
  const wasmBytes = await fs.readFile(path.join(wasmRollupDir, 'dist/wasm-node/bindings_wasm_bg.wasm'));
  console.log(`[bundle-real-vite] rollup wasm binary: ${(wasmBytes.length / 1024).toFixed(1)} KB`);

  const result = await esbuild.build({
    entryPoints: [path.join(viteDir, 'dist/node/index.js')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    external: [...NODE_BUILTINS, ...LOADER_EXTERNALS],
    plugins: [stubPlugin],
    write: false,
    mainFields: ['module', 'main'],
    conditions: ['import', 'node'],
    logLevel: 'warning',
    keepNames: true,
    minify: false,
    // When loaded via LOADER.load() with modules:{'vite.bundle.js':...},
    // workerd sets import.meta.url to undefined (or a non-file URL),
    // which breaks createRequire(import.meta.url). Force a synthetic
    // file URL at build time so the bundle is self-contained.
    define: {
      'import.meta.url': JSON.stringify('file:///vite.bundle.js'),
      // Bundled CJS modules inside vite (rollup's native.js etc.)
      // reference __dirname / __filename. esbuild's __commonJS
      // wrapper doesn't inject them; we define them to plausible
      // synthetic paths here so the modules load without throwing.
      '__dirname': JSON.stringify('/'),
      '__filename': JSON.stringify('/vite.bundle.js'),
    },
    // Leave dynamic import specifiers alone; we'll deal with them at
    // runtime via the shim.
  });

  let bundle = withoutStorePaths(result.outputFiles[0].text);
  console.log(`[bundle-real-vite] pre-patch size: ${(bundle.length / 1024).toFixed(1)} KB`);

  // Each seam fails the build if the bundled Vite moved its anchor; see
  // real-vite-bundle-patches.mjs.
  bundle = patchRealViteBundle(bundle);
  console.log(`[bundle-real-vite] post-patch size: ${(bundle.length / 1024).toFixed(1)} KB`);

  // Ship the REAL vite client runtime alongside the server bundle.
  // Vite serves these at /@vite/client + /@vite/env at dev time.
  // Without them our synthetic 'stub' gets served and the browser's
  // HMR client + import.meta.env are broken.
  let viteClientMjs = '// vite client not shipped';
  let viteEnvMjs = '// vite env not shipped';
  try {
    viteClientMjs = await fs.readFile(
      path.join(viteDir, 'dist/client/client.mjs'),
      'utf8',
    );
    viteEnvMjs = await fs.readFile(
      path.join(viteDir, 'dist/client/env.mjs'),
      'utf8',
    );
    console.log(
      `[bundle-real-vite] vite client runtime: client.mjs ${(viteClientMjs.length / 1024).toFixed(1)} KB, env.mjs ${viteEnvMjs.length}B`,
    );
  } catch (e) {
    console.warn('[bundle-real-vite] could not read vite client files:', e?.message);
  }

  // [sdk-phase-1] Promote the two huge blobs (bundle + rollup-wasm) to
  // the ASSETS binding. Lazy-fetched at first cirrus-real instantiation
  // (same pattern as esbuild-wasm-bytes.ts). Keeps Worker bundle small.
  await fs.mkdir(ASSETS_DIR, { recursive: true });
  await fs.writeFile(path.join(ASSETS_DIR, 'real-vite-bundle.js'), bundle, 'utf8');
  await fs.writeFile(path.join(ASSETS_DIR, 'rollup.wasm'), wasmBytes);

  const header = `/**
 * real-vite-bundle.generated.ts — AUTO-GENERATED by scripts/bundle-real-vite.mjs
 * DO NOT EDIT.
 *
 * Bundled Vite ${viteVersion} with native-binding stubs (rolldown,
 * lightningcss, etc.). Consumed by src/cirrus-real.ts at facet spawn time.
 *
 * [sdk-phase-1] The large strings (REAL_VITE_BUNDLE, ROLLUP_WASM_BASE64)
 * now ship via the ASSETS binding rather than inline. Use the async
 * getters below. Constants + browser-runtime mjs files remain inline
 * since they're small enough to not warrant a network round-trip.
 */

import { loadAssetText, loadAssetBytes, type AssetsFetcher } from '@nimbus-sh/core/runtime/assets-loader.js';

export const REAL_VITE_VERSION = ${JSON.stringify(viteVersion)};

/** Asset path for the bundled Vite source. Use {@link getRealViteBundle}. */
export const REAL_VITE_BUNDLE_PATH = ${JSON.stringify(ASSET_PATH_VITE_BUNDLE)};

/** Asset path for the rollup wasm bytes. Use {@link getRollupWasmBase64}. */
export const ROLLUP_WASM_PATH = ${JSON.stringify(ASSET_PATH_ROLLUP_WASM)};

/**
 * Fetch the bundled Vite JS from the ASSETS binding. Cached per-isolate.
 *
 * @param env Object exposing the \`ASSETS\` binding (Fetcher).
 * @returns The Vite bundle as a UTF-8 string.
 * @throws {NimbusAssetLoadError} when the binding is missing or fetch fails.
 */
export function getRealViteBundle(env: { ASSETS: AssetsFetcher }): Promise<string> {
  return loadAssetText(env.ASSETS, REAL_VITE_BUNDLE_PATH);
}

/**
 * Fetch the rollup wasm bytes + base64-encode for the synthetic-fs
 * pre-seed. Cached per-isolate; the base64 string ends up the same on
 * every call.
 *
 * @returns base64-encoded rollup wasm bytes.
 */
export async function getRollupWasmBase64(env: { ASSETS: AssetsFetcher }): Promise<string> {
  const bytes = await loadAssetBytes(env.ASSETS, ROLLUP_WASM_PATH);
  // btoa(String.fromCharCode(...bytes)) blows the stack on 1 MB inputs.
  // Build the binary string in 8 KiB chunks.
  let binary = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, Math.min(i + CHUNK, bytes.length)) as unknown as number[],
    );
  }
  return btoa(binary);
}

/**
 * Vite's browser-side HMR runtime. Served to the browser at
 * /@vite/client and /@vite/env during dev. Unlike the server
 * bundle, these are tiny ESM files that run in-page — keep inline.
 */
export const VITE_CLIENT_MJS: string = ${JSON.stringify(viteClientMjs)};
export const VITE_ENV_MJS: string = ${JSON.stringify(viteEnvMjs)};
`;
  await fs.writeFile(OUT, header, 'utf8');
  console.log(`[bundle-real-vite] wrote ${OUT} (${(header.length / 1024).toFixed(1)} KB shim) + ${ASSETS_DIR}/{real-vite-bundle.js (${(bundle.length / 1024 / 1024).toFixed(1)} MB), rollup.wasm (${(wasmBytes.length / 1024 / 1024).toFixed(1)} MB)}`);
}

main().catch((e) => {
  console.error('[bundle-real-vite] failed:', e);
  process.exit(1);
});
