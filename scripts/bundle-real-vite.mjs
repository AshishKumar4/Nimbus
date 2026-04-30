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
import { createRequire } from 'node:module';
import esbuild from 'esbuild';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'src', 'real-vite-bundle.generated.ts');

// Keep node:* modules external — workerd provides them via nodejs_compat.
// Any module in this list is passed through as-is in the bundle.
const NODE_BUILTINS = [
  'node:assert', 'node:buffer', 'node:child_process', 'node:crypto',
  'node:dns', 'node:events', 'node:fs', 'node:fs/promises', 'node:http',
  'node:https', 'node:module', 'node:net', 'node:os', 'node:path',
  'node:perf_hooks', 'node:process', 'node:querystring', 'node:readline',
  'node:stream', 'node:string_decoder', 'node:timers', 'node:timers/promises',
  'node:tls', 'node:tty', 'node:url', 'node:util', 'node:v8',
  'node:worker_threads', 'node:zlib', 'node:http2', 'node:stream/web',
  'node:stream/promises', 'node:async_hooks', 'node:vm', 'node:diagnostics_channel',
  'node:inspector', 'node:constants',
  // bare specifiers that also need to pass through
  'fs', 'path', 'url', 'util', 'os', 'net', 'crypto', 'child_process',
  'dns', 'tty', 'worker_threads', 'assert', 'process', 'v8', 'events',
  'http', 'https', 'zlib', 'stream', 'buffer', 'readline', 'module',
  'string_decoder', 'timers', 'querystring', 'perf_hooks', 'http2',
  'tls', 'async_hooks',
  // Virtual wrappers consumed by the fs-shim — resolved to real node:fs
  // at facet load time via LOADER.load's modules map.
  'real-node-fs.js', 'real-node-fs-promises.js',
  // Phase 1: the REAL fs-shim (not the inline Phase 0 wrapper) lives
  // in src/real-vite-fs-shim.ts and is supplied as LOADER modules
  // 'cirrus-fs.js' + 'cirrus-fs-promises.js'. Vite's `node:fs` /
  // `node:fs/promises` imports are rewritten to those specifiers.
  'cirrus-fs.js', 'cirrus-fs-promises.js',
  // Phase 2: ws (Vite HMR server) + chokidar (Vite file-watcher) shims.
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

// Phase 1: removed — the fs-shim now lives in src/real-vite-fs-shim.ts
// and is supplied as 'cirrus-fs.js' / 'cirrus-fs-promises.js' LOADER
// modules. Keeping the shim out-of-bundle lets us iterate on it
// without rebuilding the 2.5 MB vite.bundle.js every time.
// ── (legacy inline shim generator, unused) ────────────────────────
function _unusedFsShimSource(flavor /* 'sync' | 'promises' */) {
  if (flavor === 'promises') {
    return `
import * as _real from 'real-node-fs-promises.js';
const _syn = globalThis.__cirrusRealSynthetic || new Map();
globalThis.__cirrusRealSynthetic = _syn;
function _norm(p) {
  if (typeof p !== 'string') {
    try { p = p.pathname || String(p); } catch { return null; }
  }
  return p.replace(/^file:\\/\\//, '');
}
const _readFile = _real.readFile;
export const readFile = async function(p, ...rest) {
  const n = _norm(p);
  if (n != null && _syn.has(n)) {
    const c = _syn.get(n);
    const opts = rest[0], enc = typeof opts === 'string' ? opts : opts?.encoding;
    return enc ? c : new TextEncoder().encode(c);
  }
  return _readFile.call(_real, p, ...rest);
};
export const { writeFile, stat, readdir, mkdir, unlink, access, lstat, realpath, rm, rmdir, rename, cp, copyFile, appendFile, chmod, chown, open, constants, utimes } = _real;
export default { ..._real, readFile };
`;
  }
  return `
import * as _real from 'real-node-fs.js';
const _syn = globalThis.__cirrusRealSynthetic || new Map();
globalThis.__cirrusRealSynthetic = _syn;
function _norm(p) {
  if (typeof p !== 'string') {
    try { p = p.pathname || String(p); } catch { return null; }
  }
  return p.replace(/^file:\\/\\//, '');
}
const _rfs = _real.readFileSync, _ex = _real.existsSync, _st = _real.statSync, _rp = _real.realpathSync;
export const readFileSync = function(p, ...rest) {
  const n = _norm(p);
  if (n != null && _syn.has(n)) {
    const c = _syn.get(n);
    const opts = rest[0], enc = typeof opts === 'string' ? opts : opts?.encoding;
    if (enc) return c;
    // Callers that don't pass an encoding expect a Buffer in Node; in
    // workerd, Buffer.from(string, 'utf-8') Just Works. We return the
    // Buffer so JSON.parse(readFileSync(path)) — Vite's common pattern
    // on its own package.json — treats the bytes as a UTF-8 string.
    try { return globalThis.Buffer.from(c, 'utf-8'); }
    catch { return new TextEncoder().encode(c); }
  }
  return _rfs.call(_real, p, ...rest);
};
export const existsSync = function(p) {
  const n = _norm(p);
  if (n != null && _syn.has(n)) return true;
  try { return _ex.call(_real, p); } catch { return false; }
};
export const statSync = function(p, ...rest) {
  const n = _norm(p);
  if (n != null && _syn.has(n)) {
    const size = _syn.get(n).length;
    return {
      isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false,
      size, mtime: new Date(0), ctime: new Date(0), atime: new Date(0),
      mtimeMs: 0, ctimeMs: 0, atimeMs: 0, birthtimeMs: 0,
      mode: 0o100644, uid: 0, gid: 0, ino: 0, nlink: 1, dev: 0, rdev: 0, blksize: 4096, blocks: 1,
    };
  }
  try { return _st.call(_real, p, ...rest); }
  catch (e) { if (rest[0]?.throwIfNoEntry === false) return undefined; throw e; }
};
export const realpathSync = function(p, ...rest) {
  const n = _norm(p);
  if (n != null && _syn.has(n)) return n;
  try { return _rp.call(_real, p, ...rest); } catch { return n || p; }
};
// Promise API passthrough (Vite reads fs.promises.readFile too)
const _pReadFile = _real.promises?.readFile;
const _pStat = _real.promises?.stat;
export const promises = {
  ..._real.promises,
  readFile: async (p, ...rest) => {
    const n = _norm(p);
    if (n != null && _syn.has(n)) {
      const c = _syn.get(n);
      const opts = rest[0], enc = typeof opts === 'string' ? opts : opts?.encoding;
      return enc ? c : new TextEncoder().encode(c);
    }
    return _pReadFile.call(_real.promises, p, ...rest);
  },
  stat: async (p, ...rest) => {
    const n = _norm(p);
    if (n != null && _syn.has(n)) return statSync(p);
    return _pStat.call(_real.promises, p, ...rest);
  },
};
// All other top-level fs exports passthrough. We list the common ones
// explicitly so esbuild's ESM checker can verify all of Vite's + deps'
// named imports. Anything not listed here will fail at bundle time.
export const { readFile, writeFile, writeFileSync, readdir, readdirSync, mkdir, mkdirSync, unlink, unlinkSync, access, accessSync, lstat, lstatSync, stat, realpath, rm, rmSync, rmdir, rmdirSync, rename, renameSync, cp, cpSync, copyFile, copyFileSync, appendFile, appendFileSync, chmod, chmodSync, chown, chownSync, open, openSync, close, closeSync, read, readSync, write, writeSync, createReadStream, createWriteStream, watch, watchFile, unwatchFile, constants, utimes, utimesSync, Stats, Dirent, ReadStream, WriteStream, truncate, truncateSync, symlink, symlinkSync, link, linkSync, mkdtemp, mkdtempSync, fsync, fsyncSync, fdatasync, fdatasyncSync, readv, readvSync, writev, writevSync, ftruncate, ftruncateSync, futimes, futimesSync, fchmod, fchmodSync, fchown, fchownSync, fstat, fstatSync, opendir, opendirSync, Dir } = _real;
export default { ..._real, readFileSync, existsSync, statSync, realpathSync, promises };
`;
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
const PINNED_VITE_VERSION = '^6.4.0';

async function ensureViteInstalled() {
  const vitePkg = path.join(ROOT, 'node_modules', 'vite', 'package.json');
  const wasmRollupPkg = path.join(ROOT, 'node_modules', '@rollup/wasm-node', 'package.json');
  let needsInstall = false;
  try {
    const parsed = JSON.parse(await fs.readFile(vitePkg, 'utf8'));
    if (!parsed.version || !parsed.version.startsWith(PINNED_VITE_MAJOR + '.')) {
      console.log(`[bundle-real-vite] found vite@${parsed.version}; reinstalling as ${PINNED_VITE_VERSION}...`);
      needsInstall = true;
    }
  } catch { needsInstall = true; }
  try {
    await fs.access(wasmRollupPkg);
  } catch { needsInstall = true; }
  if (!needsInstall) return;
  const { execSync } = await import('node:child_process');
  execSync(`bun add --no-save vite@${PINNED_VITE_VERSION} @rollup/wasm-node`, {
    cwd: ROOT, stdio: 'inherit',
  });
}

async function main() {
  await ensureViteInstalled();

  console.log('[bundle-real-vite] bundling vite/dist/node/index.js...');
  // Pre-read the rollup-wasm binary and embed it as a base64 string.
  // The rollup wasm-node binding does `readFileSync(__dirname + '/bindings_wasm_bg.wasm')`;
  // we answer that via our fs shim by seeding a synthetic entry that
  // decodes the base64 back to a Uint8Array. This avoids bundling
  // the wasm as a separate LOADER module (which doesn't accept .wasm).
  let wasmBase64 = '';
  try {
    const wasmBytes = await fs.readFile(
      path.join(ROOT, 'node_modules/@rollup/wasm-node/dist/wasm-node/bindings_wasm_bg.wasm'),
    );
    wasmBase64 = wasmBytes.toString('base64');
    console.log(`[bundle-real-vite] rollup wasm binary: ${(wasmBytes.length / 1024).toFixed(1)} KB`);
  } catch (e) {
    console.warn('[bundle-real-vite] could not read rollup wasm binary:', e?.message);
  }

  const result = await esbuild.build({
    entryPoints: [path.join(ROOT, 'node_modules/vite/dist/node/index.js')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    external: NODE_BUILTINS,
    plugins: [stubPlugin],
    write: false,
    mainFields: ['module', 'main'],
    conditions: ['import', 'node'],
    logLevel: 'warning',
    keepNames: true,
    minify: false,
    // Alias rollup → @rollup/wasm-node. Rollup 4's native.js loads a
    // platform-specific Rust binding via require(); workerd can't
    // load .node addons. @rollup/wasm-node ships a pure-WASM binding
    // that imports via require('./wasm-node/bindings_wasm.js') —
    // pure JS + a .wasm file, no native code.
    alias: {
      'rollup': '@rollup/wasm-node',
      'rollup/dist/native.js': '@rollup/wasm-node/dist/native.js',
      'rollup/dist/parseAst.js': '@rollup/wasm-node/dist/parseAst.js',
      // NOTE: no esbuild alias. `esbuild` is stubbed via the
      // onResolve filter above. Saves ~2.3 MB of JS + WASM that
      // the facet would otherwise hold in memory for code paths
      // we never run (optimizeDeps + build + esbuildPlugin.transform
      // are all patched or disabled).
    },
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

  let bundle = result.outputFiles[0].text;
  console.log(`[bundle-real-vite] pre-patch size: ${(bundle.length / 1024).toFixed(1)} KB`);

  // ── Post-process: rewrite __require2(...) calls ─────────────────────
  // esbuild leaves `createRequire("file:///vite.bundle.js")` in the
  // bundle (we can't eliminate it — Vite's code uses it deliberately),
  // and inside bundled CJS wrappers this createRequire gets called as
  // `__require2("picomatch")` etc. workerd's createRequire throws on
  // bare module names it can't find in node_modules, which fails
  // uncatchably from inside module-init blocks.
  //
  // We inject a shim that consults a map of bundled __commonJS module
  // ids first, falling back to the real createRequire only for node:
  // builtins (which workerd DOES resolve). Modules NOT bundled get
  // replaced with empty-exports stubs.
  //
  // The shim references require_* factory functions emitted by esbuild
  // for each __commonJSMin module. We pattern-match them by name to
  // build a lookup table.
  const factoryNames = new Set();
  for (const m of bundle.matchAll(/\b(require_[a-zA-Z0-9_$]+)\s*=\s*__commonJS/g)) {
    factoryNames.add(m[1]);
  }
  // Map bare module names → factory function names (heuristic: strip
  // non-alphanum + lowercase).
  const wantBundled = new Set(['picomatch', 'postcss']);
  const nameToFactory = {};
  for (const want of wantBundled) {
    const candidates = [
      'require_' + want,
      'require_' + want.replace(/[^a-z0-9]/gi, '_'),
      'require_picocolors2', // not used but placeholder
    ];
    const hit = candidates.find((n) => factoryNames.has(n));
    if (hit) nameToFactory[want] = hit;
  }
  console.log('[bundle-real-vite] bundled CJS factories resolved:', nameToFactory);

  const shimInjection = `
// ── Cirrus real-vite bundler: __require2 + __require shim ───────
// Injected by scripts/bundle-real-vite.mjs.
//
// 1. __cirrusRealRequireShim resolves a small whitelist of bundled
//    CJS factories (picomatch/postcss inside readdirp/chokidar) —
//    consumed by the post-patched __require2 call sites.
// 2. __cirrusRealCjsRequire is a general CJS require polyfill that
//    works inside workerd. esbuild's built-in __require polyfill
//    uses \`typeof require !== "undefined" ? require : throw\`, which
//    always throws in workerd because the global \`require\` doesn't
//    exist in ESM contexts. We replace the polyfill below.
;(() => {
  const _origCreateRequire = globalThis.__origCreateRequire || null;
  const _bundledFactories = { ${Object.entries(nameToFactory)
    .map(([k, v]) => `${JSON.stringify(k)}: () => ${v}()`)
    .join(', ')} };
  const _stubModule = { __stubbed: true };
  const _stubsFor = new Set(['bufferutil', 'utf-8-validate', 'fsevents', 'sugarss']);
  globalThis.__cirrusRealRequireShim = function(name) {
    if (_bundledFactories[name]) return _bundledFactories[name]();
    if (_stubsFor.has(name)) return _stubModule;
    throw new Error('[cirrus-real] __require2("' + name + '") — not bundled');
  };

  // CJS require polyfill. Build a createRequire-backed fallback for
  // node:* builtins. Non-builtin specifiers throw loudly so we see
  // which deps still need bundling.
  let _cjsRequire = null;
  globalThis.__cirrusRealCjsRequire = function(name) {
    if (_bundledFactories[name]) return _bundledFactories[name]();
    if (_stubsFor.has(name)) return _stubModule;
    if (!_cjsRequire) {
      try {
        const { createRequire } = globalThis.require
          ? { createRequire: globalThis.require('node:module').createRequire }
          : (() => {
              // ESM-only path: import node:module statically up top? No,
              // we can't do that from injected JS. Use a synchronous
              // createRequire workaround: workerd DOES populate a
              // top-level createRequire for certain contexts.
              try { return require('node:module'); } catch { return null; }
            })();
        _cjsRequire = createRequire ? createRequire('file:///vite.bundle.js') : null;
      } catch { _cjsRequire = null; }
    }
    if (_cjsRequire) {
      try { return _cjsRequire(name); } catch (e) {
        throw new Error('[cirrus-real] __require("' + name + '") failed: ' + (e?.message || e));
      }
    }
    throw new Error('[cirrus-real] __require("' + name + '") — no CJS require available');
  };
})();
`;

  // Replace esbuild's __require polyfill. The polyfill as emitted
  // tries \`typeof require !== "undefined" ? require : throw\`, which
  // ALWAYS throws in workerd ESM context (no global require). Our
  // replacement uses createRequire(import.meta.url) + a fallback to
  // our bundled-factory lookup + a safe shim for the rewritten
  // cirrus-fs.js / cirrus-fs-promises.js specifiers.
  //
  // We also swallow the cirrus-fs aliases: rollup's native.js uses
  // \`require('fs').existsSync\` to detect a sideload; in our facet
  // rollup is never used for dev, so an empty-ish fs-module is fine.
  const rollupNativePatches = [];
  let requirePolyfillPatches = 0;
  bundle = bundle.replace(
    /var __require = [\s\S]*?throw Error\('Dynamic require of "' \+ x \+ '" is not supported'\);\s*\}\);/,
    () => {
      requirePolyfillPatches++;
      return `var __require = /* @__PURE__ */ (function() {
  // Lazy-init: __cirrusNodeCreateRequire is set by main.js BEFORE
  // the bundle evaluates, but we defer the createRequire() call
  // until first use so module-init order doesn't matter.
  let _cjsRequire = null;
  function _getRequire() {
    if (_cjsRequire) return _cjsRequire;
    const cr = globalThis.__cirrusNodeCreateRequire;
    if (cr) {
      try { _cjsRequire = cr("file:///vite.bundle.js"); } catch (e) {
        console.warn('[cirrus-real __require] createRequire failed:', e?.message);
      }
    }
    return _cjsRequire;
  }
  // A table of known-safe stubs for CJS modules that vite's bundled
  // deps try to require but that workerd can't satisfy via
  // createRequire. Returning an empty-ish object lets the dep
  // load without crashing.
  // Rollup's native + wasm-node bindings require 'fs' / 'cirrus-fs.js'
  // for a handful of read paths at module-init. Return the actual fs
  // shim (via the global seeded by synthetic.js) so they get a
  // working module, not an empty stub.
  const _stubs = {};
  Object.defineProperty(_stubs, 'cirrus-fs.js', {
    get() { return globalThis.__cirrusRealFsShim || { existsSync: () => false }; },
  });
  Object.defineProperty(_stubs, 'cirrus-fs-promises.js', {
    get() { return (globalThis.__cirrusRealFsShim || {}).promises || {}; },
  });
  return function __require(name) {
    if (_stubs[name]) return _stubs[name];
    if (globalThis.__cirrusNodeBuiltinTable && globalThis.__cirrusNodeBuiltinTable[name]) {
      return globalThis.__cirrusNodeBuiltinTable[name];
    }
    if (globalThis.__cirrusRealRequireShim) {
      try { return globalThis.__cirrusRealRequireShim(name); }
      catch (_e) { /* fall through */ }
    }
    // VFS-backed userspace modules (e.g. react-refresh/babel loaded
    // dynamically by @vitejs/plugin-react at transform time). Lives
    // in cirrus-real.ts' main.js synthetic init.
    if (globalThis.__cirrusRealUserspaceRequire) {
      try {
        const mod = globalThis.__cirrusRealUserspaceRequire(name);
        if (mod) return mod;
      } catch (_e) { /* fall through */ }
    }
    const req = _getRequire();
    if (req) {
      try { return req(name); }
      catch (e) { throw Error('[cirrus-real __require] failed resolving "' + name + '": ' + (e?.message || e)); }
    }
    throw Error('[cirrus-real __require] no createRequire available for "' + name + '"');
  };
})();`;
    },
  );
  // Replace every `__require2("bare")` with `__cirrusRealRequireShim("bare")`
  // for the targeted bare-name deps. Node builtins like 'node:fs' we
  // leave alone — workerd handles them.
  const NODE_BUILTINS_RE = /^(?:node:)?(?:fs|fs\/promises|http|http2|https|net|tls|path|url|util|events|stream|buffer|crypto|os|zlib|child_process|module|assert|perf_hooks|readline|querystring|dns|tty|worker_threads|v8|process|async_hooks|timers|string_decoder)$/;
  const targets = [...wantBundled, ...['bufferutil', 'utf-8-validate', 'fsevents', 'sugarss']];
  let patchCount = 0;
  for (const t of targets) {
    // Escape regex metacharacters in the target name, then build the
    // '__require2("name")' pattern.
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('__require2\\("' + escaped + '"\\)', 'g');
    bundle = bundle.replace(re, (_m) => { patchCount++; return `__cirrusRealRequireShim(${JSON.stringify(t)})`; });
  }
  // ── Post-process: redirect chokidar + ws to our shims ────────────
  // Vite's bundle INLINES chokidar + ws as CJS modules, so we can't
  // externalize them via esbuild. Instead we replace the single
  // `var import_chokidar = __toESM2(require_chokidar(), 1);` line
  // with a call to our shim accessor, and similarly rewrite the
  // WebSocketServerRaw binding to point at globalThis.__cirrusWsModule
  // (which the facet entrypoint seeds from cirrus-ws.js BEFORE the
  // bundle evaluates).
  let chokidarPatches = 0;
  // Vite 8 (legacy, not shipped but kept for future upgrades):
  //   var import_chokidar = /* @__PURE__ */ __toESM2(require_chokidar(), 1);
  bundle = bundle.replace(
    /var\s+import_chokidar\s*=\s*\/\*\s*@__PURE__\s*\*\/\s*__toESM2?\(require_chokidar\(\),\s*1\);/g,
    () => {
      chokidarPatches++;
      return `var import_chokidar = /* @__PURE__ */ (function(){ const m = globalThis.__cirrusChokidarModule; if (!m) throw new Error('cirrus-chokidar not seeded'); return { default: m.default || m, ...m }; })();`;
    },
  );
  // Vite 5 (current target): two assignments in series —
  //   chokidarExports = /* @__PURE__ */ requireChokidar();
  //   chokidar = /* @__PURE__ */ getDefaultExportFromCjs2(chokidarExports);
  // We replace the first one; the second stays but consumes our shim.
  bundle = bundle.replace(
    /chokidarExports\s*=\s*\/\*\s*@__PURE__\s*\*\/\s*requireChokidar\(\);/g,
    () => {
      chokidarPatches++;
      return `chokidarExports = (globalThis.__cirrusChokidarModule || (() => { throw new Error('cirrus-chokidar not seeded'); })());`;
    },
  );
  // Vite 6 has a SECOND chokidar instance (`chokidar2`) built inline
  // with its own FSWatcher class + watch factory. Replace
  //   chokidar2 = {};
  // with a pre-seeded copy pointing at our shim, and no-op the
  // subsequent `chokidar2.watch = watch2; chokidar2.FSWatcher = FSWatcher;`
  // assignments (which would otherwise overwrite our shim).
  bundle = bundle.replace(
    /(\bchokidar2)\s*=\s*\{\s*\};/g,
    () => {
      chokidarPatches++;
      return `chokidar2 = (globalThis.__cirrusChokidarModule || {});`;
    },
  );
  // Suppress overwrites of chokidar2.{watch,FSWatcher} — they'd
  // replace our seeded module with the in-bundle (native) classes.
  const beforeChok2Guard = chokidarPatches;
  bundle = bundle.replace(
    /\bchokidar2\.(watch|FSWatcher)\s*=\s*\w+;/g,
    () => { chokidarPatches++; return `/* cirrus: chokidar2 override suppressed */;`; },
  );

  let wssPatches = 0;
  // Vite 8: var WebSocketServerRaw = process.versions.bun ? ... : import_websocket_server.default;
  bundle = bundle.replace(
    /var\s+WebSocketServerRaw\s*=\s*process\.versions\.bun\s*\?[^;]+;/g,
    () => {
      wssPatches++;
      return `var WebSocketServerRaw = (globalThis.__cirrusWsModule?.WebSocketServer) || (function(){ throw new Error('cirrus-ws not seeded'); })();`;
    },
  );
  // Vite 5 has ws inlined differently. The WebSocketServer class is
  // bundled DIRECTLY (no require wrapper); Vite refers to it as
  // `WebSocketServer` from the bundled ws CJS module. The reference
  // looks like: `let WebSocketServer = wsExports.WebSocketServer;`
  bundle = bundle.replace(
    /(let|var|const)\s+WebSocketServer\s*=\s*wsExports\.WebSocketServer;/g,
    () => {
      wssPatches++;
      return `var WebSocketServer = (globalThis.__cirrusWsModule?.WebSocketServer) || (function(){ throw new Error('cirrus-ws not seeded'); })();`;
    },
  );
  // Vite 5 ws routing. The bundle:
  //   1. Defines WebSocketServer = class extends EventEmitter {...}
  //      (the real ws package inlined as a CJS module via __commonJS).
  //   2. websocketServer = WebSocketServer;
  //   3. WebSocketServerRaw_ = getDefaultExportFromCjs2(websocketServer);
  //   4. WebSocketServerRaw = process.versions.bun ? ... : WebSocketServerRaw_;
  //   5. Usage: new WebSocketServerRaw({noServer: true}).
  //
  // We substitute step 4 — assigning WebSocketServerRaw from our shim.
  // This preserves the rest of ws's module so nothing errors at
  // module-init, but any `new WebSocketServerRaw(...)` construction
  // hits our CirrusWsServer instead.
  bundle = bundle.replace(
    /WebSocketServerRaw\s*=\s*process\.versions\.bun\s*\?[\s\S]*?:\s*WebSocketServerRaw_;/g,
    () => {
      wssPatches++;
      return `WebSocketServerRaw = (globalThis.__cirrusWsModule?.WebSocketServer) || (function(){ throw new Error('cirrus-ws not seeded'); })();`;
    },
  );

  // esbuild's lib/main.js has a "bundling guard" that throws if it
  // detects its source has been bundled. When we call vite.createServer,
  // Vite's module-init evaluates the bundled esbuild module and
  // (even without calling esbuild.build) the guard tries to spawn a
  // binary on the first esbuild API call. Patch the guard so any
  // attempt to spawn returns a harmless stub.
  let esbuildGuardPatches = 0;
  bundle = bundle.replace(
    /esbuildCommandAndArgs\s*=\s*\/\*\s*@__PURE__\s*\*\/\s*__name\(\(\)\s*=>\s*\{[\s\S]{0,2000}?\},\s*"esbuildCommandAndArgs"\)/,
    () => {
      esbuildGuardPatches++;
      return `esbuildCommandAndArgs = /* @__PURE__ */ __name(() => { throw new Error('[cirrus-real] esbuild.build is not available inside the real-vite facet. Use @vitejs/plugin-react (Babel) or a pure-JS plugin for JSX.'); }, "esbuildCommandAndArgs")`;
    },
  );

  // Patch es-module-lexer's `function k(A){try{return (0, eval)(A)}catch(A){}}`.
  // The bundled lexer uses indirect-eval to "unescape" import specifier
  // strings (input: `"react"`, output: `react`). In workerd, eval is
  // disallowed OUTSIDE startup scope (compatibility flag
  // `allow_eval_during_startup` is default-on, but it's a STARTUP-only
  // permission — transform handlers run post-startup so eval silently
  // returns undefined via the catch). The result: every parsed import
  // has `.n = undefined`, which makes vite:import-analysis treat all
  // specifiers as "non-string" and wrap them in
  // `__vite__injectQuery(...)` string literals — totally breaks
  // `import X from 'react'` resolution.
  //
  // Fix: replace `(0, eval)(A)` with JSON-parse-compatible logic.
  // Input `A` is always a JS string literal (double- or single-quoted).
  let lexerEvalPatches = 0;
  bundle = bundle.replace(
    /function k\((\w+)\) \{\s*try \{\s*return \(0, eval\)\(\1\);\s*\} catch \(\w+\) \{\s*\}\s*\}/,
    (_, arg) => {
      lexerEvalPatches++;
      // Replace with JSON-parse-based unescape. Input is a JS string
      // literal: `"react"`, `'react'`, or `` `react` ``.
      return `function k(${arg}) {
    try {
      const q = ${arg}[0];
      if (q === '"') return JSON.parse(${arg});
      if (q === "'") return JSON.parse('"' + ${arg}.slice(1, -1).replace(/"/g, '\\\\"').replace(/\\\\'/g, "'") + '"');
      if (q === '\`') return ${arg}.slice(1, -1);
      return ${arg};
    } catch (_e) {
      return undefined;
    }
  }`;
    },
  );
  // Debug: log normalizeUrl call → see exactly what importAnalysis asks to resolve.
  bundle = bundle.replace(
    /const normalizeUrl = \/\* @__PURE__ \*\/ __name\(async \((\w+), (\w+), forceSkipImportAnalysis = false\) => \{/,
    (_, url, pos) =>
      `const normalizeUrl = /* @__PURE__ */ __name(async (${url}, ${pos}, forceSkipImportAnalysis = false) => {
        if (globalThis.__cirrusResolveDebug) console.log('[normalizeUrl]', ${url}, 'importer=', importer);
`,
  );

  // Replace the vite:esbuild plugin's transform with a pure-JS
  // implementation that:
  //   - passes ESM through unchanged (plugin-react already did JSX)
  //   - wraps CJS modules (detected by `module.exports`, `exports.X`,
  //     or \`require(\`) into a minimal ESM adapter that evaluates
  //     the CJS code in a Function wrapper and re-exports
  //     module.exports. Named exports are discovered via textual
  //     scan of `module.exports.X =` / `exports.X =` patterns and
  //     re-exported individually.
  //
  // This is necessary because real-world React packages (react,
  // react-dom, scheduler, babel core, many more) ship CJS, and
  // browsers can't load CJS via `<script type="module">`.
  // Without this conversion, every `import React from 'react'` 404s
  // at the browser. Vite's optimizeDeps normally handles this via
  // esbuild, which we can't run.
  let vitEsbuildTransformPatches = 0;
  bundle = bundle.replace(
    /(name:\s*"vite:esbuild",[\s\S]{0,200}?async transform\(code,\s*)(id\d*)(\)\s*\{)[\s\S]{0,1500}?(\}\s*\}\s*;\s*\})/,
    (_, head, idArg, openBrace, tail) => {
      vitEsbuildTransformPatches++;
      return head + idArg + openBrace + `
      /* cirrus-real: intercept CJS packages with pre-built ESM bundles. */
      if (globalThis.__cirrusNpmCjsMap) {
        const prebuilt = globalThis.__cirrusNpmCjsMap(${idArg});
        if (prebuilt) return { code: prebuilt, map: null };
      }
      return { code, map: null };
    ` + tail;
    },
  );

  // replaceDefine (used by the define plugin + client-inject) also
  // calls esbuild.transform to substitute `process.env.X` etc. We
  // replace it with a pure-JS string-replacement implementation that
  // covers the 99% case (literal identifier → literal value) and
  // skips sourcemap munging. Good enough for real-vite mode where
  // the only defines we set are NODE_ENV + a handful of Vite
  // client-inject variables.
  let replaceDefinePatches = 0;
  bundle = bundle.replace(
    /async function replaceDefine\((\w+), (\w+), (\w+), (\w+)\) \{[\s\S]{0,1500}?return \{\s*code: result\.code,\s*map: result\.map \|\| null\s*\};\s*\}/,
    (_, env, codeArg, idArg, defineArg) => {
      replaceDefinePatches++;
      return `async function replaceDefine(${env}, ${codeArg}, ${idArg}, ${defineArg}) {
    /* cirrus-real: pure-JS replacement for esbuild.transform-based define injection */
    let out = ${codeArg};
    for (const key of Object.keys(${defineArg})) {
      const value = ${defineArg}[key];
      const escaped = key.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
      const re = new RegExp('(?<![\\\\w$])' + escaped + '(?![\\\\w$])', 'g');
      out = out.replace(re, String(value));
    }
    return { code: out, map: null };
  }`;
    },
  );

  bundle = shimInjection + '\n' + bundle;
  console.log(`[bundle-real-vite] __require2 patches: ${patchCount}`);
  console.log(`[bundle-real-vite] chokidar patches: ${chokidarPatches}, WebSocketServerRaw patches: ${wssPatches}`);
  console.log(`[bundle-real-vite] rollup-native __require shims: ${rollupNativePatches.length}`);
  console.log(`[bundle-real-vite] esbuild bundling-guard patches: ${esbuildGuardPatches}`);
  console.log(`[bundle-real-vite] vite:esbuild transform-disabled patches: ${vitEsbuildTransformPatches}`);
  console.log(`[bundle-real-vite] replaceDefine esbuild-free patches: ${replaceDefinePatches}`);
  console.log(`[bundle-real-vite] es-module-lexer eval-replacement patches: ${lexerEvalPatches}`);
  console.log(`[bundle-real-vite] post-patch size: ${(bundle.length / 1024).toFixed(1)} KB`);

  const viteVersion = JSON.parse(
    await fs.readFile(path.join(ROOT, 'node_modules/vite/package.json'), 'utf8'),
  ).version;

  // Ship the REAL vite client runtime alongside the server bundle.
  // Vite serves these at /@vite/client + /@vite/env at dev time.
  // Without them our synthetic 'stub' gets served and the browser's
  // HMR client + import.meta.env are broken.
  let viteClientMjs = '// vite client not shipped';
  let viteEnvMjs = '// vite env not shipped';
  try {
    viteClientMjs = await fs.readFile(
      path.join(ROOT, 'node_modules/vite/dist/client/client.mjs'),
      'utf8',
    );
    viteEnvMjs = await fs.readFile(
      path.join(ROOT, 'node_modules/vite/dist/client/env.mjs'),
      'utf8',
    );
    console.log(
      `[bundle-real-vite] vite client runtime: client.mjs ${(viteClientMjs.length / 1024).toFixed(1)} KB, env.mjs ${viteEnvMjs.length}B`,
    );
  } catch (e) {
    console.warn('[bundle-real-vite] could not read vite client files:', e?.message);
  }

  // Emit as a TS module exporting the bundle as a string.
  const header = `/**
 * real-vite-bundle.generated.ts — AUTO-GENERATED by scripts/bundle-real-vite.mjs
 * DO NOT EDIT.
 *
 * Bundled Vite ${viteVersion} with native-binding stubs (rolldown,
 * lightningcss, etc.). Consumed by src/cirrus-real.ts at facet spawn time.
 */

export const REAL_VITE_VERSION = ${JSON.stringify(viteVersion)};

export const REAL_VITE_BUNDLE: string = ${JSON.stringify(bundle)};

/**
 * Base64-encoded @rollup/wasm-node bindings. Rollup's native.js does
 * a sync readFileSync on the .wasm file at module-init; we pre-seed
 * the synthetic filesystem with this buffer so that read succeeds.
 */
export const ROLLUP_WASM_BASE64: string = ${JSON.stringify(wasmBase64)};

/**
 * Vite's browser-side HMR runtime. Served to the browser at
 * /@vite/client and /@vite/env during dev. Unlike the server
 * bundle, these are tiny ESM files that run in-page.
 */
export const VITE_CLIENT_MJS: string = ${JSON.stringify(viteClientMjs)};
export const VITE_ENV_MJS: string = ${JSON.stringify(viteEnvMjs)};
`;
  await fs.writeFile(OUT, header, 'utf8');
  console.log(`[bundle-real-vite] wrote ${OUT} (${(header.length / 1024).toFixed(1)} KB)`);
}

main().catch((e) => {
  console.error('[bundle-real-vite] failed:', e);
  process.exit(1);
});
