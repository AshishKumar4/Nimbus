#!/usr/bin/env node
/**
 * bundle-sqlite-wasm.mjs — package sql.js for facet consumption, backing
 * the node:sqlite shim.
 *
 * Why this exists
 * ───────────────
 * `import { DatabaseSync } from "node:sqlite"` runs inside NimbusLoaderPool
 * facet isolates. sql.js (Emscripten SQLite) needs two pieces at facet
 * runtime:
 *
 *   1. The JS glue (`dist/sql-wasm.js`) — ~46 KiB. Embedded in the worker
 *      bundle as a string constant (sqlite-wasm-bundle.generated.ts) and
 *      evaluated inside the facet via `new Function`. The trailing CJS/AMD
 *      export footer is rewritten to `return initSqlJs;` so the file
 *      becomes a function body (mirrors bundle-esbuild-wasm.mjs).
 *
 *   2. The wasm binary (`dist/sql-wasm.wasm`) — ~648 KiB. Lives in the
 *      static-assets layer at public/_assets/sqljs-<version>.wasm and is
 *      fetched on demand by src/runtime/sqlite-wasm-bytes.ts. workerd
 *      blocks request-time WebAssembly.compile(bytes); the supervisor
 *      hands the bytes to the Worker Loader module map (as a `wasm`
 *      module), and the shim feeds the resulting WebAssembly.Module to
 *      sql.js's `instantiateWasm` hook — so sql.js never compiles bytes.
 *
 * Output:
 *   src/sqlite-wasm-bundle.generated.ts
 *     export const SQLJS_BUNDLE_VERSION: string;
 *     export const SQLITE_WASM_SHA256: string;   // staged wasm digest
 *     export const SQLJS_GLUE_FN_BODY: string;   // initSqlJs factory body
 *
 *   public/_assets/sqljs-<version>.wasm
 *     The raw wasm, picked up by the wrangler ASSETS binding.
 *
 * Run via:
 *   node scripts/bundle-sqlite-wasm.mjs
 *   (wired into package.json bundle/predev/predeploy/postinstall)
 *
 * The version is pinned in src/constants.ts (SQLJS_VERSION); this script
 * asserts the installed sql.js matches so an accidental dependency bump
 * surfaces loudly instead of shipping a wasm/asset-path mismatch.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { resolvePackageDir } from './resolve-package-dir.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const PKG_DIR = resolvePackageDir('sql.js', { start: ROOT });
const JS_SRC = path.join(PKG_DIR, 'dist', 'sql-wasm.js');
const WASM_SRC = path.join(PKG_DIR, 'dist', 'sql-wasm.wasm');
const PKG_JSON = path.join(PKG_DIR, 'package.json');
const OUT_TS = path.join(ROOT, 'src', 'sqlite-wasm-bundle.generated.ts');
const OUT_ASSETS_DIR = path.join(ROOT, 'public', '_assets');

// SQLJS_VERSION is the source of truth (src/constants.ts). Read it back
// out of the TS source rather than importing (constants.ts is ESM TS).
async function readPinnedVersion() {
  const src = await fs.readFile(path.join(ROOT, 'src', 'constants.ts'), 'utf8');
  const m = src.match(/SQLJS_VERSION\s*=\s*'([^']+)'/);
  if (!m) throw new Error('[bundle-sqlite-wasm] SQLJS_VERSION not found in constants.ts');
  return m[1];
}

/**
 * Patterns that, if present in the glue OUTSIDE the Node-only
 * (ENVIRONMENT_IS_NODE) branch, would break facet evaluation. sql.js
 * gates all node:fs / node:crypto / process.argv access behind
 * `ca = globalThis.process?.versions?.node`; the shim masks
 * globalThis.process during eval so `ca` is false and those branches
 * never run. We still bail if the glue grows an UNGATED top-level
 * require — the assertion guards against a future sql.js refactor that
 * moves the require out of the `if(ca)` block.
 */
const FORBIDDEN_PATTERNS = [
  /(^|[^.\w])require\(["']node:fs["']\)\s*;?\s*$/m, // top-level standalone require
  /process\.binding\s*\(/,
];

async function main() {
  const pkgJson = JSON.parse(await fs.readFile(PKG_JSON, 'utf8'));
  const installed = pkgJson.version;
  const pinned = await readPinnedVersion();
  console.log(`[bundle-sqlite-wasm] installed sql.js: ${installed}`);
  if (installed !== pinned) {
    throw new Error(
      `[bundle-sqlite-wasm] version mismatch: installed sql.js ${installed} ` +
        `!= SQLJS_VERSION ${pinned} in constants.ts.\n` +
        `   Update SQLJS_VERSION (and re-verify the asset path) or pin the dep.`,
    );
  }
  const version = installed;

  // ── 1. Read & rewrite the glue into a function body ─────────────────
  const jsRaw = await fs.readFile(JS_SRC, 'utf8');
  console.log(`[bundle-sqlite-wasm] dist/sql-wasm.js: ${(jsRaw.length / 1024).toFixed(1)} KiB`);

  for (const re of FORBIDDEN_PATTERNS) {
    if (re.test(jsRaw)) {
      throw new Error(
        `[bundle-sqlite-wasm] dist/sql-wasm.js contains forbidden pattern ${re}\n` +
          `   sql.js may have moved a node-only call out of its ENVIRONMENT_IS_NODE\n` +
          `   guard, which would break facet evaluation. Update this script or pin\n` +
          `   sql.js to the prior version.`,
      );
    }
  }

  // The glue declares `var initSqlJs = function(...)` then appends a CJS/AMD
  // export footer that references `module`/`exports`/`define`. Inside a
  // `new Function` those identifiers are undefined and the footer would
  // throw on the `typeof` checks — except they're all `typeof X === ...`
  // guards, so they're safe. We still strip the footer and append an
  // explicit `return initSqlJs;` so the body returns the factory.
  const footerRe = /\nif \(typeof exports === 'object'[\s\S]*$/;
  if (!footerRe.test(jsRaw)) {
    throw new Error(
      `[bundle-sqlite-wasm] could not locate the trailing CJS/AMD export footer\n` +
        `   in dist/sql-wasm.js — sql.js may have changed its module shape.`,
    );
  }
  const jsFn = jsRaw.replace(footerRe, '\n') + '\nreturn initSqlJs;\n';

  // ── 2. Stage the wasm into public/_assets/ ──────────────────────────
  await fs.mkdir(OUT_ASSETS_DIR, { recursive: true });
  const assetName = `sqljs-${version}.wasm`;
  const assetOut = path.join(OUT_ASSETS_DIR, assetName);
  const wasmBytes = await fs.readFile(WASM_SRC);
  await fs.writeFile(assetOut, wasmBytes);
  const wasmSha256 = createHash('sha256').update(wasmBytes).digest('hex');
  console.log(
    `[bundle-sqlite-wasm] copied sql-wasm.wasm → ${path.relative(ROOT, assetOut)} ` +
      `(${(wasmBytes.length / 1024).toFixed(1)} KiB)`,
  );

  // ── 3. Clean up stale-versioned sqljs wasm assets ──────────────────
  for (const entry of await fs.readdir(OUT_ASSETS_DIR)) {
    if (entry.startsWith('sqljs-') && entry.endsWith('.wasm') && entry !== assetName) {
      await fs.unlink(path.join(OUT_ASSETS_DIR, entry));
      console.log(`[bundle-sqlite-wasm] removed stale asset: ${entry}`);
    }
  }

  // ── 4. Emit the JS-only generated TS module ─────────────────────────
  const header = `/**
 * sqlite-wasm-bundle.generated.ts — AUTO-GENERATED by scripts/bundle-sqlite-wasm.mjs
 * DO NOT EDIT.
 *
 * Bundled sql.js ${version} JS glue for the node:sqlite shim. Only the JS
 * glue (~${(jsRaw.length / 1024).toFixed(0)} KiB) is bundled here; the wasm binary lives in the
 * static-assets layer at public/_assets/sqljs-${version}.wasm and is fetched
 * on demand by src/runtime/sqlite-wasm-bytes.ts.
 *
 * SQLJS_GLUE_FN_BODY is the body of the sql.js \`initSqlJs\` factory with the
 * trailing CJS/AMD export footer rewritten to \`return initSqlJs;\`. The
 * node:sqlite shim evaluates it via \`new Function("globalThis", body)\`
 * passing a globalThis proxy that masks \`process\` so sql.js takes the
 * worker (not node) code path, then drives it with an \`instantiateWasm\`
 * hook backed by a pre-compiled WebAssembly.Module from the facet module
 * map.
 */

export const SQLJS_BUNDLE_VERSION: string = ${JSON.stringify(version)};

/**
 * SHA-256 of the staged public/_assets/sqljs-${version}.wasm bytes.
 * src/runtime/sqlite-wasm-bytes.ts verifies every fetch against it — the L2
 * (caches.default) tier included — before the bytes reach workerd's loader.
 */
export const SQLITE_WASM_SHA256: string = ${JSON.stringify(wasmSha256)};

export const SQLJS_GLUE_FN_BODY: string = ${JSON.stringify(jsFn)};
`;

  await fs.writeFile(OUT_TS, header, 'utf8');
  const stat = await fs.stat(OUT_TS);
  console.log(
    `[bundle-sqlite-wasm] wrote ${path.relative(ROOT, OUT_TS)} ` +
      `(${(stat.size / 1024).toFixed(1)} KiB — JS glue only)`,
  );
}

main().catch((e) => {
  console.error('[bundle-sqlite-wasm] failed:', e);
  process.exit(1);
});
