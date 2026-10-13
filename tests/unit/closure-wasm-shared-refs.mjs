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
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';

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
const staticRefs = (path) => manager._staticRefsOf(fs, CRED_KERNEL, path, pacer);
const glueReads = () => reads.filter((path) => path === glue).length;
const stripSlash = (path) => String(path).replace(/^\/+/, '');

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
const planned = await manager._closureStaticRefs(fs, CRED_KERNEL, [glue], pacer);
assert.equal(glueReads(), 1, 'and the data plan reads the same analysis');
assert.ok(planned[0].exact.some((ref) => ref.path === `/${PKG}/bindgen_bg.wasm` && ref.sync), 'which names the image as a synchronous read');

// Another credential's analysis is its own: it reads the file itself.
await manager._staticRefsOf(fs, { ...CRED_KERNEL, uid: 1000, gid: 1000, groups: [] }, glue, pacer);
assert.equal(glueReads(), 2, 'another credential reads the file for its own analysis');

// A mounted file reports no revision (0): it is known by its content, so an
// edit between launches is read anew, never answered from the last analysis.
{
  let text = source;
  const mounted = new Proxy(fs, {
    get(target, prop) {
      if (prop === 'revision') return async () => 0;
      if (prop === 'readFile') return async (path, ...rest) => stripSlash(path) === glue ? new TextEncoder().encode(text) : target.readFile(path, ...rest);
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const named = async () => ((await manager._staticRefsOf(mounted, { ...CRED_KERNEL, uid: 7, gid: 7, groups: [] }, glue, pacer))?.exact ?? [])
    .map((ref) => ref.path).filter((path) => path.endsWith('.wasm')).sort();
  assert.deepEqual(await named(), [`/${PKG}/bindgen_bg.wasm`, `/${PKG}/other.wasm`]);
  text = source.replace('bindgen_bg.wasm', 'edited_bg.wasm').replace('./other.wasm', './edited.wasm');
  assert.deepEqual(await named(), [`/${PKG}/edited.wasm`, `/${PKG}/edited_bg.wasm`], 'an edited mounted file names what it names now');
}

// A cell the shared analysis cannot answer (no file at its path) is analyzed itself.
const unfiled = `${PKG}/unfiled.js`;
const fallback = await collectClosureWasmImages(fs, { [unfiled]: source.replace(/glue/g, 'unfiled') }, [], staticRefs);
assert.ok(fallback.some((i) => i.vfsPath === `/${PKG}/bindgen_bg.wasm`), 'a cell with no file is analyzed from its own text');
console.log('closure-wasm-shared-refs: ok');
