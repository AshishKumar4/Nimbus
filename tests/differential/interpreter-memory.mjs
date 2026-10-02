#!/usr/bin/env bun
// What the runtime-code interpreter costs in heap, against V8 compiling the
// same code, on real framework code:
//
//   1. The functions Astro 7's dev server builds from strings for its first
//      page render (Vite's SSR modules), captured from a native run: built
//      and held, by V8 and by the interpreter. Also the interpreter's own
//      cost to load.
//   2. The config module Vite 8 bundles and imports for a build of the
//      react-ts template: imported natively, and run as an interpreter module
//      cell, with what it imports loaded beforehand in both.
//   3. Astro's dev server itself after its first page render, natively and
//      with every function built from a string interpreted: the whole live heap.
//
// Each figure is V8's used heap after full collections, the lower of two
// runs. Uses the apps of interpreter-frameworks.mjs (.cache/, made on first
// use). Run: bun tests/differential/interpreter-memory.mjs

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { buildInterpreterFiles } from '../unit/lib/interpreter-build.mjs';
import { APPS, CACHE, LIB, ensureApp, sleep, withServer } from './lib/apps.mjs';

const MiB = (bytes) => `${(bytes / 1048576).toFixed(2)} MiB`;
const files = await buildInterpreterFiles();
const interpreterEnv = { NIMBUS_INTERPRETER: files.interpreterFile, NIMBUS_INTERPRETER_OPS: files.opsFile };

function capture(name, dir, run) {
  const captureDir = join(CACHE, 'capture', name);
  rmSync(captureDir, { recursive: true, force: true });
  mkdirSync(captureDir, { recursive: true });
  return run(['--import', join(LIB, 'capture-preload.mjs')], { NIMBUS_CAPTURE_DIR: captureDir }).then(() => captureDir);
}

function measure(mode, captureDir, cwd) {
  const runs = [0, 1].map(() => {
    const r = spawnSync('node', ['--expose-gc', join(LIB, 'memory-child.mjs'), mode, captureDir, files.interpreterFile, files.opsFile], { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`${mode} failed:\n${r.stdout}\n${r.stderr}`);
    return JSON.parse(r.stdout.trim().split('\n').at(-1));
  });
  return runs.reduce((a, b) => (b.retained < a.retained ? b : a));
}

async function liveHeapAfterFirstRender(dir, interpreted, port) {
  const heapFile = join(files.dir, `heap-${port}`);
  const flags = ['--expose-gc', '--import', join(LIB, 'heap-preload.mjs')];
  if (interpreted) flags.push('--disallow-code-generation-from-strings', '--import', join(LIB, 'interpret-preload.mjs'));
  return withServer(APPS.astro, dir, port, flags, { ...interpreterEnv, NIMBUS_HEAP_FILE: heapFile }, async (_port, server) => {
    await APPS.astro.first(dir, port);
    server.kill('SIGUSR2');
    for (let i = 0; i < 100 && !existsSync(heapFile); i++) await sleep(100);
    return Number(readFileSync(heapFile, 'utf8'));
  });
}

try {
  const astro = ensureApp('astro');
  const vite = ensureApp('vite');
  const astroCapture = await capture('astro', astro, (flags, env) => withServer(APPS.astro, astro, 4800, flags, env, () => APPS.astro.first(astro, 4800)));
  const viteCapture = await capture('vite', vite, async (flags, env) => {
    const r = spawnSync('node', [...flags, ...APPS.vite.build('dist-memory')], { cwd: vite, env: { ...process.env, ...env }, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`vite build failed:\n${r.stderr.slice(-2000)}`);
  });

  const nativeFunctions = measure('native-functions', astroCapture, astro);
  const interpretedFunctions = measure('interpreted-functions', astroCapture, astro);
  const nativeConfig = measure('native-config', viteCapture, vite);
  const interpretedConfig = measure('interpreted-config', viteCapture, vite);
  const live = { native: [], interpreted: [] };
  let port = 4810;
  for (let i = 0; i < 2; i++) {
    live.native.push(await liveHeapAfterFirstRender(astro, false, port++));
    live.interpreted.push(await liveHeapAfterFirstRender(astro, true, port++));
  }
  const liveNative = Math.min(...live.native);
  const liveInterpreted = Math.min(...live.interpreted);

  console.log(`interpreter load: ${MiB(interpretedFunctions.interpreterLoad)}`);
  console.log(`Astro first render, ${nativeFunctions.functions} functions (${MiB(nativeFunctions.sourceBytes)} of source) built and held: native ${MiB(nativeFunctions.retained)}, interpreted ${MiB(interpretedFunctions.retained)} (${(interpretedFunctions.retained / nativeFunctions.retained).toFixed(2)}x)`);
  console.log(`Vite config module loaded and held: native ${MiB(nativeConfig.retained)}, interpreted ${MiB(interpretedConfig.retained)} (${(interpretedConfig.retained / nativeConfig.retained).toFixed(2)}x)`);
  console.log(`Astro dev server after its first render, live heap: native ${MiB(liveNative)}, interpreted ${MiB(liveInterpreted)} (+${MiB(liveInterpreted - liveNative)})`);
} finally {
  rmSync(files.dir, { recursive: true, force: true });
}
