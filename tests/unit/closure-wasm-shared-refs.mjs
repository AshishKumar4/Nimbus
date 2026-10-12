#!/usr/bin/env bun
// The launch's image collector (collectClosureWasmImages) and its data plan
// (FacetManager._closureStaticRefs) analyze the same modules for the paths
// they name. One analysis serves both, once per revision of each file in the
// session: pi's 487 KB wasm-naming chunk cost the collector 1.1 s on every
// warm launch, the data plan's memo having answered for it all along.

import assert from 'node:assert/strict';
import { collectClosureWasmImages, FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { wasmImageDigest } from '../../packages/worker/src/facets/wasm-image-digest.ts';
import { launchFs } from './lib/launch-fs.mjs';

const PKG = 'home/user/app/node_modules/bindgen';
const image = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const glue = `${PKG}/glue.js`;
// wasm-bindgen's folded template path, and a sibling named by a relative literal.
const source = [
  'const wasmPath = `${__dirname}/bindgen_bg.wasm`;',
  'const bytes = require("fs").readFileSync(wasmPath);',
  'const other = new URL("./other.wasm", import.meta.url);',
  'module.exports = new WebAssembly.Module(bytes);',
].join('\n');
const { fs, reads } = launchFs({
  [glue]: source,
  [`${PKG}/bindgen_bg.wasm`]: image,
  [`${PKG}/other.wasm`]: image,
});
const manager = Object.assign(Object.create(FacetManager.prototype), { staticRefsMemo: new Map() });
const pacer = { spend: async () => {} };
const staticRefs = (path) => manager._staticRefsOf(fs, path, pacer);
const glueReads = () => reads.filter((path) => path === glue).length;

const alone = await collectClosureWasmImages(fs, { [glue]: source }, []);
assert.equal(glueReads(), 0, 'without the shared analysis the collector reads only its cell');
const shared = await collectClosureWasmImages(fs, { [glue]: source }, [], staticRefs);
const byPath = (images) => [...images].sort((a, b) => a.vfsPath.localeCompare(b.vfsPath));
assert.deepEqual(byPath(shared), byPath(alone), 'the shared analysis names the same images as the cell\'s own');
assert.deepEqual(byPath(shared).map((i) => [i.vfsPath, i.digest]), [
  [`/${PKG}/bindgen_bg.wasm`, wasmImageDigest(image)],
  [`/${PKG}/other.wasm`, wasmImageDigest(image)],
], 'the folded template path and the relative literal both name their image');
assert.equal(glueReads(), 1, 'its first use reads the file once');

await collectClosureWasmImages(fs, { [glue]: source }, [], staticRefs);
assert.equal(glueReads(), 1, 'the next launch\'s collector neither reads nor parses it again');
const planned = await manager._closureStaticRefs(fs, [glue], pacer);
assert.equal(glueReads(), 1, 'and the data plan reads the same analysis');
assert.ok(planned[0].exact.some((ref) => ref.path === `/${PKG}/bindgen_bg.wasm` && ref.sync), 'which names the image as a synchronous read');

// A cell the shared analysis cannot answer (no file at its path) is analyzed itself.
const unfiled = `${PKG}/unfiled.js`;
const fallback = await collectClosureWasmImages(fs, { [unfiled]: source.replace(/glue/g, 'unfiled') }, [], staticRefs);
assert.ok(fallback.some((i) => i.vfsPath === `/${PKG}/bindgen_bg.wasm`), 'a cell with no file is analyzed from its own text');
console.log('closure-wasm-shared-refs: ok');
