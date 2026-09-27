#!/usr/bin/env bun
// Bundle the public service with the host's compiled-WASM binding, then exercise real transforms.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fromCore = createRequire(new URL('../../packages/core/package.json', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'nimbus-esbuild-lazy-'));
try {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ['packages/core/src/runtime/esbuild-service.ts'],
    bundle: true, splitting: true, format: 'esm', platform: 'browser',
    outdir: scratch, outExtension: { '.js': '.mjs' }, metafile: true,
    plugins: [{ name: 'compiled-wasm-binding', setup(b) {
      b.onResolve({ filter: /^esbuild-wasm\/esbuild\.wasm$/ }, () => ({ path: 'esbuild.wasm', namespace: 'compiled' }));
      b.onLoad({ filter: /.*/, namespace: 'compiled' }, () => ({
        contents: 'globalThis.__nimbusWasmLoads++; export default globalThis.__nimbusCompiledWasm;', loader: 'js',
      }));
    } }],
  });
  const outputs = result.metafile.outputs;
  const entry = Object.keys(outputs).find((p) => outputs[p].entryPoint === 'packages/core/src/runtime/esbuild-service.ts');
  assert.ok(entry);
  const seen = new Set();
  const visit = (p) => {
    if (seen.has(p)) return;
    seen.add(p);
    for (const edge of outputs[p].imports) if (edge.kind !== 'dynamic-import' && !edge.external) visit(edge.path);
  };
  visit(entry);
  const wasmOutputs = Object.keys(outputs).filter((p) => Object.keys(outputs[p].inputs).some((input) => input === 'compiled:esbuild.wasm'));
  assert.equal(wasmOutputs.length, 1, 'the bundled asset binding is retained');
  assert.ok(!seen.has(wasmOutputs[0]), 'importing constants must not reach WASM in the static graph');

  globalThis.__nimbusWasmLoads = 0;
  // Compile only in this Node/Bun host fixture, as the production bundler supplies a precompiled binding.
  globalThis.__nimbusCompiledWasm = await WebAssembly.compile(await readFile(fromCore.resolve('esbuild-wasm/esbuild.wasm')));
  const { EsbuildService, BUNDLER_VERSION, loadEsbuild } = await import(pathToFileURL(resolve(root, entry)).href);
  assert.equal(typeof BUNDLER_VERSION, 'string');
  const service = new EsbuildService();
  assert.equal(globalThis.__nimbusWasmLoads, 0, 'importing the module and constructing the service do not evaluate the asset');
  assert.equal(service.isInitialized, false);
  const outcomes = await Promise.all([1, 2].map((n) => service.transform(`export const value: number = ${n};`, { loader: 'ts', format: 'esm' })));
  for (let i = 0; i < outcomes.length; i++) assert.match(outcomes[i].code, new RegExp(`value = ${i + 1}`));
  assert.equal(service.isInitialized, true);
  assert.equal(globalThis.__nimbusWasmLoads, 1, 'concurrent initialization evaluates the asset once');
  assert.match((await service.transform('export const again: number = 3;', { loader: 'ts', format: 'esm' })).code, /again = 3/);
  const second = new EsbuildService();
  assert.match((await second.transform('export const other: number = 4;', { loader: 'ts', format: 'esm' })).code, /other = 4/);
  assert.equal(second.isInitialized, true, 'a second service retains the already-initialized esbuild semantics');
  assert.equal(globalThis.__nimbusWasmLoads, 1);
  (await loadEsbuild()).stop();
  console.log('esbuild-lazy-wasm: static graph excludes asset; concurrent, repeated and second-service transforms pass');
} finally {
  delete globalThis.__nimbusCompiledWasm;
  delete globalThis.__nimbusWasmLoads;
  await rm(scratch, { recursive: true, force: true });
}
