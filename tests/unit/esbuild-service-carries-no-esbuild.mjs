#!/usr/bin/env bun
// The host Worker carries no part of esbuild-wasm: Nimbus runs esbuild only
// in the esbuild facet, from staged assets (worker runtime/esbuild-wasm-bytes.ts).
// Bundled as the Worker bundles it, core's EsbuildService reaches no module
// of esbuild-wasm, its wasm or its JS; with no host, a call runs on the
// engine its caller hands it, and without one it rejects.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';
import { esbuildEngine, stopEsbuildEngine } from './lib/esbuild-engine.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const scratch = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'nimbus-esbuild-free-'));
try {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ['packages/core/src/runtime/esbuild-service.ts'],
    bundle: true, format: 'esm', platform: 'browser', outdir: scratch, metafile: true, logLevel: 'silent',
  });
  const reached = Object.keys(result.metafile.inputs).filter((input) => /esbuild-wasm|esbuild\.wasm/.test(input));
  assert.deepEqual(reached, [], 'bundling EsbuildService reaches no esbuild-wasm module');
  console.log('  ok  EsbuildService bundles without esbuild-wasm');

  const service = new EsbuildService();
  await assert.rejects(service.transform('export const a: number = 1;', { loader: 'ts', format: 'esm' }), /no host for this call, and no engine/);
  const engined = new EsbuildService(undefined, { engine: esbuildEngine });
  assert.equal(engined.isInitialized, false, 'constructing the service loads no engine');
  const outcomes = await Promise.all([1, 2].map((n) => engined.transform(`export const value: number = ${n};`, { loader: 'ts', format: 'esm' })));
  for (let i = 0; i < outcomes.length; i++) assert.match(outcomes[i].code, new RegExp(`value = ${i + 1}`));
  assert.equal(engined.isInitialized, true);
  console.log('  ok  without a host a call needs an engine, loaded on the first call');
} finally {
  await stopEsbuildEngine();
  await rm(scratch, { recursive: true, force: true });
}
console.log('esbuild-service-carries-no-esbuild OK');
