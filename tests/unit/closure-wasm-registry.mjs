#!/usr/bin/env bun
// closure-wasm-registry — a wasm image in a program's closure is staged as a
// wasm map entry with its content digest, for both launch kinds, and the
// node-shims seam answers a compile of those bytes from the map.
//
// The general form of the real-vite inline-wasm registry: the closure walk
// records every `.wasm` file by path and digest — a cell it staged, and a
// file the bin-package pass saw but left out for size (esbuild-wasm's 11.9
// MiB image) — and the launch registers each under both keys.
import assert from 'node:assert/strict';
import {
  buildPrefetchBundle,
  collectClosureWasmImages,
  findInlineWasmImages,
  facetWasmImports,
} from '../../packages/worker/src/facets/manager.ts';
import { wasmImageDigest } from '../../packages/worker/src/facets/wasm-image-digest.ts';

import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { launchFs } from './lib/launch-fs.mjs';


// A minimal valid module (magic + version) and a large one the bundle's
// 4 MiB per-file cap leaves out: the shape of esbuild-wasm's image.
const WASM_HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const small = new Uint8Array(WASM_HEADER);
const big = new Uint8Array(5 * 1024 * 1024);
big.set(WASM_HEADER);
for (let i = 8; i < big.length; i += 4099) big[i] = i & 0xff;

const PKG = 'home/user/app/node_modules/esbuild-wasm';
const files = {
  [`${PKG}/package.json`]: JSON.stringify({ name: 'esbuild-wasm', version: '0.24.2', bin: { esbuild: 'bin/esbuild' } }),
  [`${PKG}/bin/esbuild`]: 'const fs = require("fs");\nnew WebAssembly.Module(fs.readFileSync(__dirname + "/../esbuild.wasm"));\n',
  [`${PKG}/esbuild.wasm`]: big,
  [`${PKG}/lib/small.wasm`]: small,
};
const vfs = launchFs(files).fs;
const esbuild = { async transform(code) { return { code }; } };

// ── the walk records both images, by path and digest ──────────────────
const state = await buildPrefetchBundle(vfs, { scriptPath: `${PKG}/bin/esbuild`, cwd: '/home/user/app', entryCode: files[`${PKG}/bin/esbuild`], esbuild });
assert.equal(`${PKG}/lib/small.wasm` in state.bundle, true, 'the small image is a bundle cell');
assert.equal(`${PKG}/esbuild.wasm` in state.bundle, false, 'the big image is over the per-file cap and not a cell');
const images = new Map((state.wasmImages ?? []).map((i) => [i.vfsPath, i.digest]));
assert.deepEqual(images, new Map([
  [`/${PKG}/esbuild.wasm`, wasmImageDigest(big)],
  [`/${PKG}/lib/small.wasm`, wasmImageDigest(small)],
]), 'the closure records every .wasm file with its content digest, whether or not it fit the bundle');
// The shared digest is the only registry left — inline-wasm is gone (real-vite-module was deleted).
console.log('  the closure walk records a staged image and an over-cap image, by path and digest');

// A cell is digested from the cell; a file from ranged reads, never whole:
// the coordinator digests while the launch's module map is resident, and a
// whole 15 MiB image beside it reset the isolate. A staged module naming a
// sibling image by a relative literal (lightningcss-wasm's
// `new URL('lightningcss_node.wasm', import.meta.url)`) names that image.
{
  let wholeReads = 0;
  let largestRange = 0;
  const counting = new Proxy(vfs, {
    get(target, prop) {
      if (prop === 'readFile') return (...a) => { wholeReads++; return target.readFile(...a); };
      if (prop === 'readRange') return (p, offset, length) => { largestRange = Math.max(largestRange, length); return target.readRange(p, offset, length); };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const loader = 'home/user/app/node_modules/esbuild-wasm/lib/main.js';
  const direct = (await collectClosureWasmImages(counting, {
    [`${PKG}/lib/small.wasm`]: small,
    [loader]: 'module.exports = new WebAssembly.Module(require("fs").readFileSync(new URL("../esbuild.wasm", import.meta.url)));',
  }, [`${PKG}/lib/small.wasm`, `${PKG}/missing.wasm`]));
  assert.equal(wholeReads, 0, 'no image is read whole; a staged cell is not read again; a missing file is skipped');
  assert.ok(largestRange > 0 && largestRange <= 1024 * 1024, `digested in slices of at most 1 MiB (largest ${largestRange})`);
  assert.deepEqual(new Map(direct.map((i) => [i.vfsPath, i.digest])), new Map([
    [`/${PKG}/esbuild.wasm`, wasmImageDigest(big)],
    [`/${PKG}/lib/small.wasm`, wasmImageDigest(small)],
  ]), 'the literal-named sibling image is collected, with the same digest as a whole read');
}

// wasm-bindgen uses a single-assignment template path, not a quoted relative
// literal. Its program still needs the same Loader-compiled image.
const templateImages = await collectClosureWasmImages(vfs, {
  [PKG + "/lib/bindings.js"]: "const wasmPath = `${__dirname}/small.wasm`; const bytes = require(\"fs\").readFileSync(wasmPath); new WebAssembly.Module(bytes);",
}, []);
assert.deepEqual(templateImages, [{ vfsPath: '/' + PKG + '/lib/small.wasm', digest: wasmImageDigest(small) }]);

// ── the launch stages them as wasm map entries, under both keys ───────
const imports = facetWasmImports([{ vfsPath: `/${PKG}/esbuild.wasm`, digest: undefined }], state.wasmImages);
assert.deepEqual(imports, [
  { vfsPath: `/${PKG}/esbuild.wasm`, digest: wasmImageDigest(big), moduleName: '__nimbus_wasm_0.wasm' },
  { vfsPath: `/${PKG}/lib/small.wasm`, digest: wasmImageDigest(small), moduleName: '__nimbus_wasm_1.wasm' },
], 'an image the options name by path gets the closure\'s digest; one they do not name is added');


// ── the seam answers those bytes from the map, and refuses others loudly ──
{
  const compiled = { tag: 'loader-compiled esbuild.wasm' };
  const byDigest = new Map([[wasmImageDigest(big), compiled]]);
  const shims = generateShimsCode();
  const seam = shims.slice(shims.indexOf('const __nimbusPrecompiledWasm ='), shims.indexOf('// ═══', shims.indexOf('WA.__nimbusPrecompiledSeam = true')));
  const WA = {
    Module: function Module(bytes) { void bytes; throw new Error('Wasm code generation disallowed for this context'); },
    compile: async () => { throw new Error('Wasm code generation disallowed for this context'); },
    instantiate: async (source) => {
      if (source === compiled) return { exports: {} };
      throw new Error('Wasm code generation disallowed for this context');
    },
  };
  WA.Module.prototype = {};
  const scope = { WebAssembly: WA, __nimbusPrecompiledWasm: new Map(), __nimbusPrecompiledWasmByDigest: byDigest };
  new Function('globalThis', '__BufferMod', seam)(scope, { from: (x) => x });
  // The program's own copy of the bytes — read by path, or arrived any other way.
  const copy = new Uint8Array(big);
  assert.equal(scope.WebAssembly.Module(copy), compiled, 'new WebAssembly.Module(bytes) is the loader\'s module');
  assert.equal(await scope.WebAssembly.compile(copy), compiled, 'WebAssembly.compile(bytes) too');
  const unknown = new Uint8Array(big); unknown[9] ^= 1;
  let refused;
  try { scope.WebAssembly.Module(unknown); } catch (e) { refused = e; }
  assert.ok(refused, 'bytes no launch registered are refused');
  assert.match(refused.message, /WebAssembly cannot be compiled from bytes here/);
  assert.match(refused.message, /Images this launch does carry: 1/);
  console.log('  the seam answers the closure\'s bytes by digest and refuses unknown bytes naming what it carries');
}

// ── inlined images: base64 and numeric array literals ───────────────────
// A module that carries its wasm in its own source never reads it from disk,
// so the closure walk cannot name it; the scan finds it by content. Both
// shapes are real: es-module-lexer (Vite 8) inlines base64, xxhash-wasm
// (Astro) a `new Uint8Array([0,97,115,109,…])`.
{
  const image = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 4, 1, 2, 0, 11]);
  assert.ok(WebAssembly.validate(image), 'fixture is a valid module');
  const padded = new Uint8Array(64);
  padded.set(image);
  const found = findInlineWasmImages({
    'home/user/app/node_modules/xxhash-wasm/cjs/xxhash-wasm.cjs': `"use strict";const t=new Uint8Array([${[...image].join(',')}]);WebAssembly.instantiate(t,{});`,
    'home/user/app/node_modules/spaced/index.js': `const w = new Uint8Array([ ${[...image].join(', ')} ]);`,
    'home/user/app/node_modules/lexer/index.js': `const C=()=>Uint8Array.from(atob("${btoa(String.fromCharCode(...padded))}"),c=>c.charCodeAt(0));`,
    'home/user/app/node_modules/not-wasm/index.js': 'const version = [0, 97, 115, 109, 2, 0, 0, 0, 5];',
    'home/user/app/node_modules/out-of-range/index.js': 'const x = [0,97,115,109,1,0,0,0,300];',
    'home/user/app/data.json': `[${[...image].join(',')}]`,
  });
  const digests = new Set(found.map((bytes) => wasmImageDigest(bytes)));
  assert.equal(found.length, 2, `the array image (once, however spaced) and the base64 image; nothing else (found ${found.length})`);
  assert.ok(digests.has(wasmImageDigest(image)), 'the numeric array literal is found with the exact bytes');
  assert.ok(digests.has(wasmImageDigest(padded)), 'the base64 literal is found');
  console.log('  inlined wasm is found by content in both shapes; version-2, out-of-range and non-JS cells are not');
}

console.log('closure-wasm-registry OK');
