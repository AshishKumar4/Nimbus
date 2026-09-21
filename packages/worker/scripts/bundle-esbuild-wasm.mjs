#!/usr/bin/env node
/**
 * bundle-esbuild-wasm.mjs — package esbuild-wasm for facet consumption.
 *
 * Why this exists
 * ───────────────
 * Pre-bundling npm packages (the `Pre-bundling N modules…` step in
 * src/npm/installer.ts) runs inside NimbusIsolatePool isolates so each
 * `esbuild.build()` allocation hits a fresh 128 MiB envelope rather
 * than the supervisor's. The facet needs two pieces of esbuild-wasm
 * at module-load time:
 *
 *   1. The JS adapter (`esbuild-wasm/esm/browser.js`, ~117 KiB), rewritten
 *      into a function body. The supervisor already imports the same
 *      build as a module for its own transforms, so the adapter is staged
 *      beside the wasm rather than embedded a second time as a string.
 *
 *   2. The wasm binary (`esbuild.wasm`) — 12 MiB. Lives in the
 *      static-assets layer (Workers ASSETS binding) at
 *      `public/_assets/esbuild-<version>.wasm` and is fetched on
 *      demand by the supervisor at pool-construction time. NEVER
 *      bundled into the worker code object — keeping the bytes out
 *      of the supervisor's static baseline drops ~21 MiB of resident
 *      heap (verified via src/observability/heap-estimate.ts).
 *
 * Pre-A'.5 design (this script's prior form) embedded the wasm bytes
 * as a base64 string in src/esbuild-wasm-bundle.generated.ts. That
 * had two problems:
 *   • The 16 MiB base64 string lived in supervisor module scope for
 *     the lifetime of the isolate (~21 MiB UTF-16 overhead).
 *   • Decoding to a Uint8Array allocated another 12 MiB which the
 *     prior esbuild-wasm-bytes.ts cached for the same lifetime.
 * Combined: ~37 MiB resident in supervisor for esbuild that almost
 * never used it directly. Phase 2 A'.5 moved that out.
 *
 * Workarounds tried & rejected (kept here as institutional memory):
 *   1. The default CJS entry (`lib/main.js`) calls
 *      `createRequire(import.meta.url)('fs')` at module init.
 *      `nodejs_compat` only satisfies static `import 'node:fs'`,
 *      so dynamic-require throws on dynamic-worker isolates.
 *   2. The `import esbuildWasmUrl from 'esbuild-wasm/esbuild.wasm'`
 *      asset binding is a wrangler bundling feature — facets built
 *      from inline `modules:` strings have no asset resolver, so
 *      that import fails in the facet.
 *   3. Fetching the wasm from R2 at facet boot — adds an RPC hop
 *      per dispatch, costs more than the in-supervisor fetch we do
 *      now (which happens once per pool construction, not per
 *      dispatch).
 *
 * Output:
 *   src/esbuild-wasm-bundle.generated.ts
 *     export const ESBUILD_WASM_VERSION: string;
 *     export const ESBUILD_WASM_ASSET_PATH: string;  // /_assets/esbuild-<version>.wasm
 *     export const ESBUILD_JS_ASSET_PATH: string;    // /_assets/esbuild-<version>.js
 *     export const ESBUILD_WASM_SHA256: string;      // staged wasm digest
 *     export const ESBUILD_JS_SHA256: string;        // staged adapter digest
 *
 *   public/_assets/esbuild-<version>.wasm
 *     The raw wasm, picked up by the wrangler ASSETS binding.
 *   public/_assets/esbuild-<version>.js
 *     The adapter as a function body, same binding.
 *
 * Run via:
 *   node scripts/bundle-esbuild-wasm.mjs
 *   (also wired into package.json predev/predeploy/postinstall)
 *
 * If a future esbuild-wasm release breaks `esm/browser.js` (e.g.
 * reintroduces a dynamic require), this script bails loud rather
 * than shipping a broken bundle to prod.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { resolvePackageDir } from './resolve-package-dir.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PKG_DIR = resolvePackageDir('esbuild-wasm', { start: ROOT });
const JS_SRC = path.join(PKG_DIR, 'esm', 'browser.js');
const WASM_SRC = path.join(PKG_DIR, 'esbuild.wasm');
const PKG_JSON = path.join(PKG_DIR, 'package.json');
const OUT_TS = path.join(ROOT, 'src', 'esbuild-wasm-bundle.generated.ts');
const OUT_ASSETS_DIR = path.join(ROOT, 'public', '_assets');

/**
 * Patterns that, if present in the JS source, mean the browser build
 * has been changed and is no longer safe to run inside a dynamic
 * worker. The script bails rather than silently shipping a broken
 * bundle to prod.
 */
const FORBIDDEN_PATTERNS = [
  /createRequire\s*\(/,
  /require\(["'](fs|path|os|child_process|module|crypto|stream)["']\)/,
  /process\.binding\s*\(/,
];

async function main() {
  const pkgJson = JSON.parse(await fs.readFile(PKG_JSON, 'utf8'));
  const version = pkgJson.version;
  console.log(`[bundle-esbuild-wasm] version: ${version}`);

  // ── 1. Read & rewrite the ESM browser entry ─────────────────────────
  // We rewrite the trailing `export { ... }` into `return { ... };` so
  // the entire file becomes the body of a function. The facet
  // evaluates it via `new Function(body)()`, which workerd permits
  // inside dynamic workers at startup-time (precedent:
  // src/facet-manager.ts).
  const jsRaw = await fs.readFile(JS_SRC, 'utf8');
  console.log(`[bundle-esbuild-wasm] esm/browser.js: ${(jsRaw.length / 1024).toFixed(1)} KiB`);

  for (const re of FORBIDDEN_PATTERNS) {
    if (re.test(jsRaw)) {
      throw new Error(
        `[bundle-esbuild-wasm] esm/browser.js contains forbidden pattern ${re}\n` +
          `   The browser build is no longer safe for facet consumption.\n` +
          `   Update this script to patch the offending call site or pin\n` +
          `   esbuild-wasm to the prior version.`,
      );
    }
  }

  const exportRe = /\nexport\s*\{([\s\S]+?)\};?\s*$/;
  const m = jsRaw.match(exportRe);
  if (!m) {
    throw new Error(
      `[bundle-esbuild-wasm] could not locate trailing 'export {…}' block\n` +
        `   in esm/browser.js — esbuild-wasm may have changed shape.`,
    );
  }
  const exportBody = m[1];
  const objectMembers = exportBody
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const asMatch = entry.match(/^(\S+)\s+as\s+(\S+)$/);
      if (asMatch) return `${asMatch[2]}: ${asMatch[1]}`;
      return entry;
    })
    .join(', ');
  const jsFn = jsRaw.replace(exportRe, '\n') + `\nreturn { ${objectMembers} };\n`;
  console.log(
    `[bundle-esbuild-wasm] rewrote ${exportBody.split(',').length} exports → object-return shape`,
  );

  // ── 2. Stage the wasm into public/_assets/ ──────────────────────────
  // The ASSETS binding picks up everything under `assets.directory`
  // (./public per wrangler.jsonc). We version-name the file so a
  // future esbuild-wasm bump produces a different asset filename and
  // forces a fresh fetch (no stale-cache risk; the generated module names
  // the path and src/runtime/esbuild-wasm-bytes.ts reads it).
  await fs.mkdir(OUT_ASSETS_DIR, { recursive: true });
  const assetName = `esbuild-${version}.wasm`;
  const assetOut = path.join(OUT_ASSETS_DIR, assetName);
  const wasmBytes = await fs.readFile(WASM_SRC);
  await fs.writeFile(assetOut, wasmBytes);
  const wasmSha256 = createHash('sha256').update(wasmBytes).digest('hex');
  console.log(
    `[bundle-esbuild-wasm] copied esbuild.wasm → ${path.relative(ROOT, assetOut)} (${(wasmBytes.length / (1024 * 1024)).toFixed(1)} MiB)`,
  );
  // The JS adapter is staged the same way. Facets splice it into their
  // source as a string; the supervisor imports esbuild-wasm as a module
  // for its own transforms, so carrying the adapter inline as well
  // shipped it twice in the Worker bundle.
  const jsAssetName = `esbuild-${version}.js`;
  const jsAssetOut = path.join(OUT_ASSETS_DIR, jsAssetName);
  const jsBytes = Buffer.from(jsFn, 'utf8');
  await fs.writeFile(jsAssetOut, jsBytes);
  const jsSha256 = createHash('sha256').update(jsBytes).digest('hex');
  console.log(
    `[bundle-esbuild-wasm] wrote JS adapter → ${path.relative(ROOT, jsAssetOut)} (${(jsBytes.length / 1024).toFixed(1)} KiB)`,
  );

  // ── 3. Clean up any stale-versioned wasm assets in public/_assets/ ──
  // Keeps the deploy lean: a developer who bumped the esbuild-wasm
  // version locally won't accidentally ship two copies.
  for (const entry of await fs.readdir(OUT_ASSETS_DIR)) {
    if (entry.startsWith('esbuild-') && (entry.endsWith('.wasm') || entry.endsWith('.js'))
      && entry !== assetName && entry !== jsAssetName) {
      const stale = path.join(OUT_ASSETS_DIR, entry);
      await fs.unlink(stale);
      console.log(`[bundle-esbuild-wasm] removed stale asset: ${entry}`);
    }
  }

  // ── 4. Emit the generated TS module: versions and digests only ──────
  // Neither artifact is inline. The base64 wasm string was 16 MiB and
  // sat in supervisor module scope for the isolate's lifetime (A'.5
  // moved it to env.ASSETS); the JS adapter followed so the bundle
  // carries esbuild-wasm once, as the module the supervisor imports.
  const header = `/**
 * esbuild-wasm-bundle.generated.ts — AUTO-GENERATED by scripts/bundle-esbuild-wasm.mjs
 * DO NOT EDIT.
 *
 * Digests of the staged esbuild-wasm ${version} artifacts. Both live in
 * the static-assets layer, public/_assets/esbuild-${version}.{wasm,js},
 * and are fetched on demand and verified by src/runtime/esbuild-wasm-bytes.ts.
 *
 * The JS adapter is node_modules/esbuild-wasm/esm/browser.js with the
 * trailing \`export { ... }\` rewritten to \`return { ... };\`, so that
 * \`new Function(body)()\` yields the esbuild namespace inside a facet.
 * Why the browser build:
 *   - Pure ESM with no \`createRequire\`, no \`require("fs")\`, and
 *     no \`process.binding\` — safe to evaluate inside a workerd
 *     dynamic-worker isolate.
 *   - The supported public surface for "esbuild inside a worker" is
 *     exactly this build.
 *
 * Why \`new Function(body)()\` (rather than \`import('data:...')\`):
 *   - data: URL imports across workerd versions are not contractual
 *     and we don't want a deploy that worked yesterday to silently
 *     break tomorrow when the runtime is upgraded.
 *   - new Function is documented as supported inside dynamic workers
 *     (src/facet-manager.ts has been doing this since 2025).
 *
 * The bundle script verifies the file does NOT contain the forbidden
 * patterns (createRequire / dynamic node-builtin require / process.binding)
 * and bails loud if a future release reintroduces them.
 */
export const ESBUILD_WASM_VERSION: string = ${JSON.stringify(version)};
/**
 * Where the artifacts live inside env.ASSETS. Version-named, so a bump
 * lands under a new name and never serves a stale cache entry. Naming them
 * here is what puts them under scripts/dist-integrity.mjs's staged-asset
 * check, which discovers asset paths by value in generated modules.
 */
export const ESBUILD_WASM_ASSET_PATH: string = ${JSON.stringify('/_assets/' + assetName)};
export const ESBUILD_JS_ASSET_PATH: string = ${JSON.stringify('/_assets/' + jsAssetName)};
/**
 * SHA-256 of the staged public/_assets/esbuild-${version}.wasm bytes.
 * src/runtime/esbuild-wasm-bytes.ts verifies every fetch against it — the L2
 * (caches.default) tier included — before the bytes reach workerd's loader.
 */
export const ESBUILD_WASM_SHA256: string = ${JSON.stringify(wasmSha256)};
/** SHA-256 of the staged public/_assets/esbuild-${version}.js adapter, checked the same way. */
export const ESBUILD_JS_SHA256: string = ${JSON.stringify(jsSha256)};
`;
  await fs.writeFile(OUT_TS, header, 'utf8');
  const stat = await fs.stat(OUT_TS);
  console.log(
    `[bundle-esbuild-wasm] wrote ${path.relative(ROOT, OUT_TS)} (${(stat.size / 1024).toFixed(1)} KiB — digests only)`,
  );
}

main().catch((e) => {
  console.error('[bundle-esbuild-wasm] failed:', e);
  process.exit(1);
});
