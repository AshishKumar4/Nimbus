#!/usr/bin/env bun
// A module only an import() reaches reads synchronously at evaluation; those
// reads are fetched by that import(), not staged at every launch.
//
// Vite 8 imports lightningcss lazily (`createCachedImport(() =>
// import("lightningcss"))`), and Nimbus's lightningcss is its wasm build,
// whose wasm-node.mjs reads lightningcss_node.wasm (15.8 MB) with
// readFileSync at module top level. The closure walk reaches it in phase 2,
// and the resident data plan's static rule staged those bytes at every
// launch: vite8 dev's resident boot carried 19.46 MB, 15.8 MB of it this one
// file, which a dev server reads only with css.transformer 'lightningcss'
// (measured live: boot 0.74 to 1.13 s with it, 0.25 to 0.42 s without).
//
// The planner now marks what only an import() reaches (lazyModules: phase
// 2's modules, less any a staged package entry's static walk reaches), and
// moves their synchronous reads to a table keyed by every lazy module whose
// evaluation evaluates the reader (lazyReadsByTarget). The import() of a
// target fetches its entry first (node-shims.ts __nimbusStageImport).

import assert from 'node:assert/strict';
import { buildPrefetchBundle, lazyReadsByTarget } from '../../packages/worker/src/facets/manager.ts';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';
import { launchFs } from './lib/launch-fs.mjs';

const identityEsbuild = new EsbuildService(undefined, {
  transformHost: async (requests) => requests.map(({ code }) => ({ code, map: '', warnings: [] })),
});
const APP = 'home/user/app';
const NM = `${APP}/node_modules`;
const files = {
  [`${APP}/package.json`]: JSON.stringify({ name: 'app', type: 'module', dependencies: { tool: '1' } }),
  [`${APP}/entry.mjs`]: 'import { run } from "tool";\nrun();\n',
  [`${NM}/tool/package.json`]: JSON.stringify({ name: 'tool', type: 'module', exports: './index.mjs', dependencies: { lazycss: '1', eager: '1' } }),
  [`${NM}/tool/index.mjs`]: [
    'import "eager";',
    'const importLazy = () => import("lazycss");',
    'export function run() { return importLazy; }',
  ].join('\n'),
  // Reached statically: its read stays a boot read.
  [`${NM}/eager/package.json`]: JSON.stringify({ name: 'eager', type: 'module', exports: './index.mjs' }),
  [`${NM}/eager/index.mjs`]: 'import fs from "node:fs";\nexport const data = fs.readFileSync(new URL("eager.dat", import.meta.url));\n',
  [`${NM}/eager/eager.dat`]: 'eager',
  // Reached only through the import(): its reads are the import()'s.
  [`${NM}/lazycss/package.json`]: JSON.stringify({ name: 'lazycss', type: 'module', exports: { '.': { node: { import: './wasm-node.mjs' } } } }),
  [`${NM}/lazycss/wasm-node.mjs`]: 'import { helper } from "./helper.mjs";\nexport const ready = helper;\nexport const later = () => import("./later.mjs");\n',
  // What a lazy module only defers is not evaluated with it: its reads are its own import()'s.
  [`${NM}/lazycss/later.mjs`]: 'import fs from "node:fs";\nexport const later = fs.readFileSync(new URL("later.dat", import.meta.url));\n',
  [`${NM}/lazycss/later.dat`]: 'later',
  [`${NM}/lazycss/helper.mjs`]: [
    'import fs from "node:fs";',
    'const bytes = fs.readFileSync(new URL("image.wasm", import.meta.url));',
    'export const helper = bytes.length;',
  ].join('\n'),
  [`${NM}/lazycss/image.wasm`]: 'x'.repeat(64),
};

const snapshot = await buildPrefetchBundle(launchFs(files).fs, {
  scriptPath: `/${APP}/entry.mjs`, cwd: `/${APP}`, entryCode: files[`${APP}/entry.mjs`], esbuild: identityEsbuild,
});
const lazy = new Set(snapshot.lazyModules ?? []);
assert.ok(lazy.has(`${NM}/lazycss/wasm-node.mjs`), 'the import() target is lazy');
assert.ok(lazy.has(`${NM}/lazycss/helper.mjs`), 'and what it imports');
assert.ok(!lazy.has(`${NM}/eager/index.mjs`), 'a statically reached module is not');
assert.ok(!lazy.has(`${NM}/tool/index.mjs`));
assert.deepEqual(snapshot.lazyImporters?.[`${NM}/lazycss/helper.mjs`], [`${NM}/lazycss/wasm-node.mjs`]);
assert.equal(snapshot.lazyImporters?.[`${NM}/lazycss/later.mjs`], undefined,
  'a module a lazy module only defers (import()) is not its static descendant: importing the one does not prefetch the other');

// The table: the reader's read under every lazy module that evaluates it.
const table = lazyReadsByTarget(
  new Map([[`${NM}/lazycss/helper.mjs`, [`${NM}/lazycss/image.wasm`]]]),
  snapshot.lazyImporters ?? {},
);
assert.deepEqual(table, {
  [`${NM}/lazycss/helper.mjs`]: [`${NM}/lazycss/image.wasm`],
  [`${NM}/lazycss/wasm-node.mjs`]: [`${NM}/lazycss/image.wasm`],
});

// A cycle among lazy importers ends; reads of two readers merge under a shared ancestor.
const sorted = (table) => Object.fromEntries(Object.entries(table).map(([k, v]) => [k, [...v].sort()]));
assert.deepEqual(
  sorted(lazyReadsByTarget(new Map([['a', ['ra']], ['b', ['rb']]]), { a: ['root', 'b'], b: ['root', 'a'] })),
  { a: ['ra', 'rb'], root: ['ra', 'rb'], b: ['ra', 'rb'] },
);

console.log('lazy-sync-reads: ok');
