#!/usr/bin/env node
/**
 * bundle-esbuild-wasm.mjs — package esbuild-wasm for facet consumption.
 *
 * Why this exists
 * ───────────────
 * Pre-bundling npm packages (the `Pre-bundling N modules…` step in
 * src/npm-installer.ts:704) used to run inside the supervisor DO
 * isolate. Each `esbuild.build()` call allocates 30–80 MiB of WASM
 * linear memory plus the bundle's input/output graph; against the
 * 128 MB DO heap cap this OOM-killed the supervisor on installs
 * that touch large React libraries (motion, framer-motion, …).
 * The fix is to dispatch each build to a NimbusFacetPool isolate so
 * each gets its own 128 MB.
 *
 * Two challenges blocked the obvious "import esbuild-wasm in the
 * facet" approach:
 *   1. The default CJS entry (`lib/main.js`) calls
 *      `createRequire(import.meta.url)('fs')` at module init.
 *      `nodejs_compat` only satisfies static `import 'node:fs'`,
 *      so dynamic-require throws on dynamic-worker isolates
 *      created via env.LOADER.load(). Documented at
 *      src/esbuild-service.ts:108-119.
 *   2. The `import esbuildWasmUrl from 'esbuild-wasm/esbuild.wasm'`
 *      asset binding is a wrangler bundling feature — facets built
 *      from inline `modules:` strings have no asset resolver, so
 *      that import fails in the facet.
 *
 * Solution: package both pieces as plain string assets that can be
 * inlined into the facet's worker module.
 *   • `ESBUILD_WASM_JS` — the contents of esbuild-wasm/esm/browser.js
 *     verbatim. Pure ESM, no createRequire, no fs require — designed
 *     for the browser-worker case which is exactly what we need.
 *     Verified against esbuild-wasm@0.24.2 (the version pinned in
 *     package.json).
 *   • `ESBUILD_WASM_BASE64` — the bytes of `esbuild.wasm` (~12 MiB
 *     uncompressed → ~16 MiB base64). The facet decodes this to a
 *     Uint8Array, compiles via WebAssembly.compile, then calls
 *     `esbuild.initialize({ wasmModule, worker: false })`.
 *
 * Inlining as base64 (rather than fetching from the supervisor at
 * facet boot) follows the precedent set by
 * scripts/bundle-real-vite.mjs:366-371, which embeds the rollup
 * wasm-node binary the same way. Rationale:
 *   • Zero supervisor RPC traffic at facet boot — every byte the
 *     facet needs is already in its module source.
 *   • Stable-slot reuse in NimbusFacetPool means each warm slot
 *     pays the decode+compile cost once; subsequent dispatches
 *     hit the cached `WebAssembly.Module`.
 *   • The generated TS file's size sits at ~16 MiB; that matters
 *     only when wrangler ships the supervisor bundle (it gzips to
 *     ~5 MiB, well under the 25 MiB worker upload cap), and is
 *     never re-shipped per request.
 *
 * Output:
 *   src/esbuild-wasm-bundle.generated.ts
 *     export const ESBUILD_WASM_VERSION: string;
 *     export const ESBUILD_WASM_JS: string;       // ESM source
 *     export const ESBUILD_WASM_BASE64: string;   // wasm bytes
 *
 * Run via:
 *   node scripts/bundle-esbuild-wasm.mjs
 *   (also wired into package.json predev/predeploy/postinstall)
 *
 * If a future esbuild-wasm release breaks `esm/browser.js` (e.g.
 * reintroduces a dynamic require), this script must learn to patch
 * it the same way bundle-real-vite.mjs patches __require2(...) call
 * sites. Keep verification light — do a regex sniff for
 * `require\("(fs|path|os|child_process|module)"\)` and bail loud.
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
const OUT = path.join(ROOT, 'src', 'esbuild-wasm-bundle.generated.ts');

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

  // Read ESM browser entry. We will rewrite the trailing `export { ... }`
  // into `return { ... };` so the entire file becomes the body of a
  // function. The facet evaluates it via `new Function(body)()`, which
  // workerd permits inside dynamic workers (precedent: src/facet-manager.ts:176,
  // src/nimbus-session.ts:1828). This avoids relying on
  // `import('data:text/javascript;base64,...')` whose support across
  // workerd versions is not contractual.
  const jsRaw = await fs.readFile(JS_SRC, 'utf8');
  console.log(`[bundle-esbuild-wasm] esm/browser.js: ${(jsRaw.length / 1024).toFixed(1)} KiB`);

  // Sanity-check: bail loud if the browser build picks up node-only
  // imports in some future release.
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

  // ── Rewrite trailing `export { ... }` → `return { ... };` ─────────────
  // The esbuild esm/browser.js ends with:
  //   export {
  //     analyzeMetafile,
  //     ...,
  //     browser_default as default,
  //     ...
  //   };
  // Convert that into a function-body that returns the namespace, so
  // `new Function(jsBody)()` produces the same shape as
  // `await import('esbuild-wasm/esm/browser.js')`.
  const exportRe = /\nexport\s*\{([\s\S]+?)\};?\s*$/;
  const m = jsRaw.match(exportRe);
  if (!m) {
    throw new Error(
      `[bundle-esbuild-wasm] could not locate trailing 'export {…}' block\n` +
        `   in esm/browser.js — esbuild-wasm may have changed shape.`,
    );
  }
  const exportBody = m[1];
  // exportBody looks like: `\n  analyzeMetafile,\n  ..., browser_default as default,\n  ...\n`
  // Convert each `name as alias` → `alias: name`; bare `name` → `name`.
  const objectMembers = exportBody
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const asMatch = entry.match(/^(\S+)\s+as\s+(\S+)$/);
      if (asMatch) return `${asMatch[2]}: ${asMatch[1]}`;
      return entry; // shorthand
    })
    .join(', ');
  const jsFn = jsRaw.replace(exportRe, '\n') + `\nreturn { ${objectMembers} };\n`;
  console.log(
    `[bundle-esbuild-wasm] rewrote ${exportBody.split(',').length} exports → object-return shape`,
  );

  // Read wasm bytes. Encode base64 — the JSON.stringify on the output
  // will produce a string literal the TS module exports verbatim.
  const wasmBytes = await fs.readFile(WASM_SRC);
  const wasmBase64 = wasmBytes.toString('base64');
  console.log(
    `[bundle-esbuild-wasm] esbuild.wasm: ${(wasmBytes.length / (1024 * 1024)).toFixed(1)} MiB raw → ${(wasmBase64.length / (1024 * 1024)).toFixed(1)} MiB base64`,
  );

  const header = `/**
 * esbuild-wasm-bundle.generated.ts — AUTO-GENERATED by scripts/bundle-esbuild-wasm.mjs
 * DO NOT EDIT.
 *
 * Bundled esbuild-wasm ${version} for use inside NimbusFacetPool isolates.
 * The supervisor's EsbuildService still imports esbuild-wasm directly
 * via wrangler asset bindings; this generated module only feeds the
 * pre-bundle facet path (src/pre-bundle-facet.ts).
 *
 * Usage:
 *   const { ESBUILD_WASM_JS_FN_BODY, ESBUILD_WASM_BASE64 } = ...;
 *   // 1. Materialise the esbuild namespace via new Function (allowed
 *   //    in workerd dynamic workers — see src/facet-manager.ts:176):
 *   const esb = (new Function(ESBUILD_WASM_JS_FN_BODY))();
 *   // 2. Decode the wasm and initialize:
 *   const bin = atob(ESBUILD_WASM_BASE64);
 *   const bytes = new Uint8Array(bin.length);
 *   for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
 *   const wasmModule = await WebAssembly.compile(bytes);
 *   await esb.initialize({ wasmModule, worker: false });
 *
 * If you change this file by hand it WILL be overwritten by the next
 * predev / predeploy / postinstall.
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
 *     (src/facet-manager.ts:176 has been doing this since 2025).
 *
 * The bundle script verifies the file does NOT contain the forbidden
 * patterns (createRequire / dynamic node-builtin require / process.binding)
 * and bails loud if a future release reintroduces them.
 */
export const ESBUILD_WASM_JS_FN_BODY: string = ${JSON.stringify(jsFn)};

/**
 * Base64-encoded contents of node_modules/esbuild-wasm/esbuild.wasm.
 * ~12 MiB raw → ~16 MiB base64.
 *
 * Decode in the facet via:
 *   const raw = atob(ESBUILD_WASM_BASE64);
 *   const bytes = new Uint8Array(raw.length);
 *   for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
 *   const wasmModule = await WebAssembly.compile(bytes);
 */
export const ESBUILD_WASM_BASE64: string = ${JSON.stringify(wasmBase64)};
`;

  await fs.writeFile(OUT, header, 'utf8');
  const stat = await fs.stat(OUT);
  console.log(
    `[bundle-esbuild-wasm] wrote ${path.relative(ROOT, OUT)} (${(stat.size / (1024 * 1024)).toFixed(1)} MiB)`,
  );
}

main().catch((e) => {
  console.error('[bundle-esbuild-wasm] failed:', e);
  process.exit(1);
});
