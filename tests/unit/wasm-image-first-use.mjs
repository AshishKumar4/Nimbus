#!/usr/bin/env bun
// Complete one-shot and resident entries register images without evaluating
// their wasm members until the program first compiles their bytes.
import assert from 'node:assert/strict';
import { wasmImageDigest } from '../../packages/worker/src/facets/wasm-image-key.ts';
import { createAuthority, facetSupervisor, launchResident, runScenarios } from './lib/resident-body.mjs';
import { adoptSessionSupervisor, oneShotManager, runnerLoader } from './lib/one-shot-runner.mjs';

const nativeWasm = WebAssembly;
const realGlobals = { process, console, Buffer };
const PATHS = ['/home/user/app/first.wasm', '/home/user/app/second.wasm'];
const image = (value) => new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0,
  1, 5, 1, 96, 0, 1, 127, 3, 2, 1, 0,
  7, 9, 1, 5, 118, 97, 108, 117, 101, 0, 0,
  10, 6, 1, 4, 0, 65, value, 11,
]);
const IMAGES = [image(7), image(42)];

function requestTimeWasm() {
  const refused = () => { throw new nativeWasm.CompileError('byte compilation is unavailable during a request'); };
  function Module() { refused(); }
  Module.prototype = nativeWasm.Module.prototype;
  for (const name of ['exports', 'imports', 'customSections']) Module[name] = nativeWasm.Module[name];
  globalThis.WebAssembly = Object.assign(Object.create(nativeWasm), {
    Module,
    compile: async () => refused(),
    instantiate: async (source, imports) => {
      if (!(source instanceof nativeWasm.Module)) refused();
      return nativeWasm.instantiate(source, imports);
    },
  });
}

const PROGRAM = `
const fs = require('fs');
const observe = globalThis.observeWasmFirstUse;
(async () => {
  const firstBytes = fs.readFileSync(${JSON.stringify(PATHS[0])});
  observe('read first');
  const copy = new Uint8Array(firstBytes);
  const first = new WebAssembly.Module(copy);
  observe('first module', first);
  observe('repeat module', new WebAssembly.Module(new Uint8Array(copy)));
  observe('compile', await WebAssembly.compile(copy.buffer.slice(0)));
  const built = await WebAssembly.instantiate(new Uint8Array(copy), {});
  observe('instantiate bytes', built.module, built.instance.exports.value());
  const instance = await WebAssembly.instantiate(first, {});
  observe('instantiate module', first, instance.exports.value());
  const secondBytes = fs.readFileSync(${JSON.stringify(PATHS[1])});
  observe('read second');
  const second = new WebAssembly.Module(secondBytes);
  const secondInstance = await WebAssembly.instantiate(second, {});
  observe('second module', second, secondInstance.exports.value());
  const unknown = new Uint8Array(copy);
  unknown[unknown.length - 2] = 9;
  observe('unknown valid', undefined, WebAssembly.validate(unknown));
  try { new WebAssembly.Module(unknown); observe('unknown module accepted'); }
  catch { observe('unknown module refused'); }
  try { await WebAssembly.compile(unknown); observe('unknown compile accepted'); }
  catch { observe('unknown compile refused'); }
  try { await WebAssembly.instantiate(unknown, {}); observe('unknown instantiate accepted'); }
  catch { observe('unknown instantiate refused'); }
})();
`;

async function launch(kind, mode = 'use') {
  const authority = createAuthority();
  const { kfs, rawVfs, host } = authority;
  kfs.mkdir('home/user/app', { recursive: true });
  if (mode !== 'empty') for (let i = 0; i < IMAGES.length; i++) kfs.writeFile(PATHS[i].slice(1), IMAGES[i]);
  const evaluations = [];
  const observations = [];
  let imports = 0;
  const onImported = () => {
    imports++;
    assert.deepEqual(evaluations, [], 'importing the complete entry evaluates no wasm member');
  };
  const onWasmEvaluate = (name, compiled) => evaluations.push({ name, compiled });
  globalThis.observeWasmFirstUse = (phase, compiled, value) => observations.push({ phase, compiled, value, evaluations: evaluations.length });
  requestTimeWasm();
  const program = mode === 'empty' ? 'globalThis.observeWasmFirstUse("no images", undefined, 42);'
    : mode === 'read' ? `require('fs').readFileSync(${JSON.stringify(PATHS[0])}); globalThis.observeWasmFirstUse('read only');`
      : PROGRAM;
  let output = '';
  try {
    if (kind === 'one-shot') {
      adoptSessionSupervisor(host, (text) => { output += text; });
      const loader = runnerLoader(`wasm-first-use-${mode}`, { onImported, onWasmEvaluate });
      const manager = oneShotManager(`wasm-first-use-${mode}`, { host, rawVfs, loader });
      const result = await manager.exec(program, { filename: '/home/user/app/main.js', cwd: '/home/user/app' });
      assert.equal(result.exitCode, 0, result.stderr + output);
    } else {
      const { supervisor, log } = facetSupervisor(authority);
      const wasmImports = mode === 'empty' ? [] : IMAGES.map((bytes, i) => ({
        vfsPath: PATHS[i], moduleName: `image-${i}.wasm`,
        // The second image must use the real fs.readFileSync path tag, not a digest fallback.
        digest: i === 0 ? wasmImageDigest(bytes) : undefined,
      }));
      const wasmModules = Object.fromEntries(wasmImports.map((entry, i) => [entry.moduleName, { wasm: IMAGES[i].buffer }]));
      await launchResident({
        program, env: { SUPERVISOR: supervisor }, authority, cursor: authority.cursor(),
        bundle: Object.fromEntries(mode === 'empty' ? [] : IMAGES.map((bytes, i) => [PATHS[i].slice(1), bytes])),
        wasmImports, wasmModules, onImported, onWasmEvaluate,
      });
      output = log.stderr;
    }
  } finally { Object.assign(globalThis, realGlobals); }
  assert.equal(imports, 1, 'one complete entry was imported');
  if (mode !== 'use') {
    assert.deepEqual(evaluations, [], 'an unused launch image never evaluates');
    assert.deepEqual(observations.map(({ phase, value }) => ({ phase, value })), [
      mode === 'empty' ? { phase: 'no images', value: 42 } : { phase: 'read only', value: undefined },
    ]);
    return;
  }
  assert.deepEqual(observations.map(({ phase, evaluations: count }) => [phase, count]), [
    ['read first', 0], ['first module', 1], ['repeat module', 1], ['compile', 1],
    ['instantiate bytes', 1], ['instantiate module', 1], ['read second', 1], ['second module', 2],
    ['unknown valid', 2], ['unknown module refused', 2], ['unknown compile refused', 2], ['unknown instantiate refused', 2],
  ], output);
  assert.equal(evaluations.length, 2, 'each image evaluates exactly once');
  assert.notEqual(evaluations[0].name, evaluations[1].name);
  assert.ok(evaluations.every(({ compiled }) => compiled instanceof nativeWasm.Module), 'the registry returns genuine precompiled modules');
  for (const observed of observations.slice(1, 6)) assert.equal(observed.compiled, evaluations[0].compiled, observed.phase);
  assert.equal(observations[7].compiled, evaluations[1].compiled);
  assert.deepEqual(observations.filter(({ value }) => value !== undefined).map(({ value }) => value), [7, 7, 42, true]);
}

await runScenarios(import.meta.path, {
  'one-shot first use': () => launch('one-shot'),
  'one-shot reads only': () => launch('one-shot', 'read'),
  'one-shot no images': () => launch('one-shot', 'empty'),
  'resident first use': () => launch('resident'),
  'resident reads only': () => launch('resident', 'read'),
  'resident no images': () => launch('resident', 'empty'),
});

console.log('wasm-image-first-use: ok');
