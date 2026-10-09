#!/usr/bin/env bun
// What a resident boot reads into the session, and when (process-fabric.ts
// residentLoaderConfig). The loader is handed every module at once, so the
// session holds them all while the facet loads: an astro project's second
// `astro dev` read its wasm images (38 MiB: lightningcss, rolldown, satteri,
// the astro compiler), then its code pack's 25.7 MB of bytes beside them,
// decoded into one string of 24.2 M characters that a single non-Latin-1
// character makes two-byte throughout (48 MiB) and every module a slice of,
// and reset the session's isolate where its first launch (18.1 MB) had fit.
//
// A pack is read first, before any other image is in hand, and each module
// is decoded from its own bytes: the pack's bytes are let go before the wasm
// is read, and a Latin-1 module is a string of its own, not a slice of a
// two-byte whole. Pinned on what can be observed here: the order of the
// reads, and the size of what is decoded at once.

import assert from 'node:assert/strict';
import { encodeCommonJsPack, facetImageDigest, facetImagePath, residentLoaderConfig } from '../../packages/fabric/src/process-fabric.ts';

const encoder = new TextEncoder();
const images = new Map();
const store = async (bytes) => { const path = facetImagePath(await facetImageDigest(bytes)); images.set(path, bytes); return path; };

const modules = {};
for (let i = 0; i < 40; i++) {
  modules[`node_modules/pkg/${i}.js`] = i % 9 === 0 ? `module.exports = "${'é€😀'.repeat(2048)}";` : `module.exports = ${i};\n`.repeat(2048);
}
const packPath = await store(encoder.encode(encodeCommonJsPack(modules).join('')));
const mainPath = await store(encoder.encode('export default {};'));
const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const wasmPath = '/home/user/app/node_modules/pkg/pkg.wasm';
images.set(wasmPath, wasm);

const reads = [];
const disk = { async readFile(path) { reads.push(path); return images.get(path); } };

// Every decode's input size, while the config is read.
let largestDecode = 0;
const nativeDecode = TextDecoder.prototype.decode;
TextDecoder.prototype.decode = function (input, options) {
  const bytes = input === undefined ? 0 : input.byteLength;
  if (bytes > largestDecode) largestDecode = bytes;
  return nativeDecode.call(this, input, options);
};
let config;
try {
  config = await residentLoaderConfig({
    compatibilityDate: '2026-01-01', compatibilityFlags: [], mainModule: 'worker.js', modules: {},
    vfsTextModules: { 'worker.js': mainPath },
    vfsWasmModules: { 'pkg.wasm': wasmPath },
    vfsCommonJsPacks: [packPath],
  }, disk);
} finally {
  TextDecoder.prototype.decode = nativeDecode;
}

for (const [name, text] of Object.entries(modules)) assert.equal(config.modules[name]?.cjs, text, `${name} decodes to its text`);
assert.equal(config.modules['worker.js'], 'export default {};');
assert.ok(config.modules['pkg.wasm'].wasm instanceof ArrayBuffer);
assert.equal(reads.indexOf(packPath), 0, `the pack is read before any other image: ${JSON.stringify(reads)}`);
const largestModule = Math.max(...Object.values(modules).map((text) => encoder.encode(text).byteLength));
const packBytes = images.get(packPath).byteLength;
assert.ok(largestDecode < packBytes / 4 && largestDecode <= largestModule + 4096,
  `each module is decoded from its own bytes: the largest decode was ${largestDecode} bytes, the pack ${packBytes}, the largest module ${largestModule}`);
console.log('  a pack is read first, and decoded a module at a time');

// A pack whose index names fewer or more bytes than it holds is refused.
const short = encoder.encode(encodeCommonJsPack(modules).join('').slice(0, -1));
const shortPath = await store(short);
await assert.rejects(
  residentLoaderConfig({ compatibilityDate: '2026-01-01', compatibilityFlags: [], mainModule: 'worker.js', modules: {}, vfsCommonJsPacks: [shortPath] }, disk),
  /pack/,
  'a pack its index does not describe is refused',
);
console.log('  a pack its index does not describe is refused');

console.log('resident-boot-read-order: ok');
