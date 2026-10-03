#!/usr/bin/env bun
// Nimbus's bundler reports every module a build read, as esbuild's metafile does.
//
// buildWithRolldown returned `metafile.inputs: {}` even for a bundle that
// inlined dependencies, so a caller reading the metafile for what a build
// read (the Vite dev server records it as a cached bundle's provenance, and
// serves the bundle only to a principal who may read all of it) was told it
// read nothing. What has to hold: for the same build behind the same
// EsbuildService and VFS plugin, rolldown's inputs are esbuild's: the same
// modules, keyed the same way, with the same byte counts and the same
// imports between them.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { EsbuildService, buildWithEsbuild, vfsBuildInputs } from '../../packages/core/src/runtime/esbuild-service.ts';
import { buildWithRolldown } from '../../packages/core/src/runtime/rolldown-build.ts';

const fromCore = createRequire(new URL('../../packages/core/package.json', import.meta.url));
const esbuild = await import(fromCore.resolve('esbuild-wasm/esm/browser.js'));
await esbuild.initialize({ wasmModule: await WebAssembly.compile(await readFile(fromCore.resolve('esbuild-wasm/esbuild.wasm'))), worker: false });
const rolldown = await import(createRequire(new URL('../../packages/worker/package.json', import.meta.url)).resolve('rolldown'));

const clone = (value) => structuredClone(value);
const hosts = {
  esbuild: async (options, plugin) => clone(await buildWithEsbuild(esbuild, clone(options), plugin)),
  rolldown: async (options, plugin) => clone(await buildWithRolldown(rolldown, clone(options), plugin)),
};

const FILES = {
  'home/user/app/src/main.js': "import dep from './dep.js';\nimport { name } from 'lib';\nimport './style.css';\nexport default dep + name;\n",
  'home/user/app/src/dep.js': "import { helper } from './nested/helper.js';\nexport default helper('dep');\n",
  'home/user/app/src/nested/helper.js': 'export const helper = (s) => s.toUpperCase();\n',
  'home/user/app/src/style.css': 'body { color: red; }\n',
  'home/user/app/node_modules/lib/package.json': JSON.stringify({ name: 'lib', main: 'index.js' }),
  'home/user/app/node_modules/lib/index.js': "export { name } from './name.js';\n",
  'home/user/app/node_modules/lib/name.js': "export const name = 'lib — ünïcode';\n",
};
const at = new Map(Object.entries(FILES).map(([p, text]) => [p, new TextEncoder().encode(text)]));
const strip = (p) => p.replace(/^\/+/, '');
const isDir = (p) => [...at.keys()].some((k) => k.startsWith(strip(p).replace(/\/+$/, '') + '/'));
const fs = {
  exists: (p) => at.has(strip(p)) || isDir(p),
  isDirectory: (p) => !at.has(strip(p)) && isDir(p),
  readFile: (p) => { const b = at.get(strip(p)); if (!b) throw new Error(`ENOENT ${p}`); return b; },
  readFileString: (p) => { const b = at.get(strip(p)); if (!b) throw new Error(`ENOENT ${p}`); return new TextDecoder().decode(b); },
};

/** What a caller reads of the inputs: each module's key and bytes, and the modules it imports, with how. */
const inputsOf = (metafile) => Object.fromEntries(Object.entries(metafile?.inputs ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, input]) => [key, {
  bytes: input.bytes,
  imports: input.imports.filter((i) => !i.external).map((i) => `${i.kind} ${i.path}${i.original ? ` (${i.original})` : ""}`),
}]));

const seen = {};
for (const [engine, buildHost] of Object.entries(hosts)) {
  const service = new EsbuildService(fs, { buildHost });
  const result = await service.build(['/home/user/app/src/main.js'], { bundle: true, format: 'esm', outdir: '/dist' });
  assert.deepEqual(result.errors ?? [], [], `${engine} built`);
  seen[engine] = inputsOf(result.metafile);
}
assert.equal(Object.keys(seen.esbuild).length, 6, `esbuild read the six modules: ${JSON.stringify(seen.esbuild)}`);
assert.deepEqual(seen.rolldown, seen.esbuild, 'rolldown reports the modules esbuild does, with their bytes and imports');
assert.deepEqual(
  vfsBuildInputs({ inputs: seen.rolldown }).sort(),
  Object.keys(FILES).filter((p) => !p.endsWith('package.json')).map((p) => '/' + p).sort(),
  'so the workspace paths a build read are every module it inlined',
);

console.log('ok - rolldown-metafile-inputs (rolldown\'s metafile names every module it read, as esbuild\'s does)');
