#!/usr/bin/env node
/**
 * bundle-esbuild-wasm.mjs — package esbuild-wasm for facet consumption.
 *
 * Why this exists
 * ───────────────
 * Pre-bundling npm packages (the `Pre-bundling N modules…` step in
 * src/npm-installer.ts) runs inside NimbusFacetPool isolates so each
 * `esbuild.build()` allocation hits a fresh 128 MiB envelope rather
 * than the supervisor's. The facet needs two pieces of esbuild-wasm
 * at module-load time:
 *
 *   1. The JS adapter (`esbuild-wasm/esm/browser.js`) — small, stays
 *      in the worker bundle as a string constant.
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
 *     export const ESBUILD_WASM_JS_FN_BODY: string;  // ESM browser source
 *
 *   public/_assets/esbuild-<version>.wasm
 *     The raw wasm, picked up by the wrangler ASSETS binding.
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
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PKG_DIR = path.join(ROOT, 'node_modules', 'esbuild-wasm');
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
  // forces a fresh fetch (no stale-cache risk; cf. ESBUILD_WASM_ASSET_PATH
  // in src/esbuild-wasm-bytes.ts).
  await fs.mkdir(OUT_ASSETS_DIR, { recursive: true });
  const assetName = `esbuild-${version}.wasm`;
  const assetOut = path.join(OUT_ASSETS_DIR, assetName);
  const wasmBytes = await fs.readFile(WASM_SRC);
  await fs.writeFile(assetOut, wasmBytes);
  console.log(
    `[bundle-esbuild-wasm] copied esbuild.wasm → ${path.relative(ROOT, assetOut)} (${(wasmBytes.length / (1024 * 1024)).toFixed(1)} MiB)`,
  );

  // ── 3. Clean up any stale-versioned wasm assets in public/_assets/ ──
  // Keeps the deploy lean: a developer who bumped the esbuild-wasm
  // version locally won't accidentally ship two copies.
  for (const entry of await fs.readdir(OUT_ASSETS_DIR)) {
    if (entry.startsWith('esbuild-') && entry.endsWith('.wasm') && entry !== assetName) {
      const stale = path.join(OUT_ASSETS_DIR, entry);
      await fs.unlink(stale);
      console.log(`[bundle-esbuild-wasm] removed stale asset: ${entry}`);
    }
  }

  // ── 4. Emit the JS-only generated TS module ──────────────────────────
  // No ESBUILD_WASM_BASE64 export. The base64 string was 16 MiB and
  // sat in supervisor module scope for the isolate's lifetime; A'.5
  // moved the bytes to env.ASSETS to drop that residency.
  const header = `/**
 * esbuild-wasm-bundle.generated.ts — AUTO-GENERATED by scripts/bundle-esbuild-wasm.mjs
 * DO NOT EDIT.
 *
 * Bundled esbuild-wasm ${version} adapter for use inside NimbusFacetPool
 * isolates. Only the JS adapter is bundled here (~117 KiB); the wasm
 * binary itself lives in the static-assets layer at
 * public/_assets/esbuild-${version}.wasm and is fetched on demand by
 * src/esbuild-wasm-bytes.ts.
 *
 * Phase 2 A'.5 moved the base64 wasm string OUT of the supervisor
 * bundle (was 16 MiB UTF-8 → 21 MiB UTF-16 in JS string overhead).
 * If you're reading this and wondering where the bytes are: env.ASSETS.
 */

export const ESBUILD_WASM_VERSION: string = ${JSON.stringify(version)};

/**
 * Function body that, when wrapped in \`new Function(...)()\`, returns
 * the esbuild-wasm namespace (build, transform, initialize, ...).
 *
 * Source: node_modules/esbuild-wasm/esm/browser.js with the trailing
 * \`export { ... }\` rewritten to \`return { ... };\`. Why the browser
 * build:
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
export const ESBUILD_WASM_JS_FN_BODY: string = ${JSON.stringify(jsFn)};
`;

  await fs.writeFile(OUT_TS, header, 'utf8');
  const stat = await fs.stat(OUT_TS);
  console.log(
    `[bundle-esbuild-wasm] wrote ${path.relative(ROOT, OUT_TS)} (${(stat.size / 1024).toFixed(1)} KiB — JS adapter only)`,
  );
}

main().catch((e) => {
  console.error('[bundle-esbuild-wasm] failed:', e);
  process.exit(1);
});
