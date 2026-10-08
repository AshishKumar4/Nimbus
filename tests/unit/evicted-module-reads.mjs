#!/usr/bin/env bun
// A module the launch evicted from its map still names what it reads.
//
// A launch's map is bounded (VFS_BUNDLE_MAX_BYTES), and past the bound it
// evicts optional enrichment, largest first: `nuxt dev` evicted 578 files,
// rollup's bundler among them, which Nitro then loads late, through an
// import(), as runtime code. Rollup's wasm-node glue reads its image
// (bindings_wasm_bg.wasm, 582 KB) with readFileSync when it evaluates. The
// launch neither carried the image as a wasm member (only the map's
// modules were scanned for images) nor knew the read, so the bytes were
// never resident: "Loading @nuxt/nitro-server server builder failed".
//
// An evicted module is still a module the program may load late. Its wasm
// images are carried (bytes only: they compile on first use), and one that
// names a synchronous call is a reader: the data plan puts its static reads
// in the lazy-read table under its own path, for the import() whose closure
// walk reaches it to fetch (node-shims.ts __nimbusStageImport).

import assert from 'node:assert/strict';
import { buildPrefetchBundle } from '../../packages/worker/src/facets/manager.ts';
import { findStaticFsReferences } from '../../packages/core/src/runtime/static-fs-refs.ts';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';
import { launchFs } from './lib/launch-fs.mjs';

// A lowering whose emit is half again its file (a real one's CommonJS
// wrapper costs more than the walk, which counts files, can know), and the
// same every run: the eviction must not depend on an engine.
const esbuild = new EsbuildService(undefined, {
  transformHost: async (requests) => requests.map(({ code }) => ({ code: code + '\n//' + '~'.repeat(code.length >> 1), map: '', warnings: [] })),
});
const APP = 'home/user/app';
const NM = `${APP}/node_modules`;
const image = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 4, 1, 2, 0, 11]);
const files = {
  [`${APP}/package.json`]: JSON.stringify({ name: 'app', dependencies: { glue: '1', big: '1' } }),
  // The program loads glue by a name it computes: glue is a guess (greedy), not the closure.
  [`${APP}/entry.js`]: 'const name = ["gl", "ue"].join("");\nmodule.exports = () => import(name);\n',
  [`${NM}/glue/package.json`]: JSON.stringify({ name: 'glue', type: 'module', main: 'index.mjs' }),
  [`${NM}/glue/index.mjs`]: [
    'import { readFileSync } from "node:fs";',
    'export const table = JSON.parse(readFileSync(new URL("./table.json", import.meta.url), "utf8"));',
    'export const load = () => new WebAssembly.Module(readFileSync(new URL("./bindings_bg.wasm", import.meta.url)));',
    '// ' + 'g'.repeat(100_000),
  ].join('\n'),
  [`${NM}/glue/table.json`]: '{"a":1}',
  [`${NM}/glue/bindings_bg.wasm`]: image,
  [`${NM}/big/package.json`]: JSON.stringify({ name: 'big', main: 'index.ts' }),
  [`${NM}/big/index.ts`]: 'export const answer: number = 1;\n// ' + 'b'.repeat(40_000),
};

// Both guesses fit the bound as the walk counts them, by their files. With
// their emits they do not, and the larger unit, glue, is what goes.
const state = await buildPrefetchBundle(launchFs(files).fs, {
  scriptPath: `${APP}/entry.js`, cwd: '/' + APP, entryCode: files[`${APP}/entry.js`], esbuild,
  maxBundleBytes: 170_000,
});
assert.equal(state.truncated, true, `the launch evicted a guess (staged: ${JSON.stringify(Object.keys(state.bundle))})`);
assert.equal(state.bundle[`${NM}/glue/index.mjs`], undefined, 'glue was evicted from the map');
assert.equal(typeof state.bundle[`${NM}/big/index.ts`], 'string', 'big stayed');

const images = (state.wasmImages ?? []).map((record) => record.vfsPath);
assert.ok(images.includes(`/${NM}/glue/bindings_bg.wasm`), `an evicted module's image is carried (${JSON.stringify(images)})`);
assert.deepEqual(state.evictedReaders, [`${NM}/glue/index.mjs`],
  'the evicted module that names a synchronous call is a reader for the data plan; big, which names none, is not');
// What the data plan reads of it, from the VFS as written (the map's cell lost its import.meta to the lowering).
const named = findStaticFsReferences(files[`${NM}/glue/index.mjs`], `/${NM}/glue/index.mjs`).exact
  .filter((ref) => ref.sync).map((ref) => ref.path).sort();
assert.deepEqual(named, [`/${NM}/glue/bindings_bg.wasm`, `/${NM}/glue/table.json`]);
console.log('evicted-module-reads: ok');
