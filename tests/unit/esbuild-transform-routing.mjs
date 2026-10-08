#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';

function serviceWith(transform) {
  const service = new EsbuildService(undefined, { engine: async () => ({ transform }) });
  return service;
}

// Pi 0.84.3's pre-bundled CLI wraps CommonJS factories inside a call. Its
// awaits are all inside functions, but the old brace scanner treated them as
// top-level and routed the entire 3.7 MiB ESM chunk through the TLA line
// converter. A successful CJS transform is authoritative and must return
// directly, without a speculative second pass.
{
  const calls = [];
  const service = serviceWith(async (code, options) => {
    calls.push({ code, format: options.format });
    return { code: '/* direct-cjs */', map: '', warnings: [] };
  });
  const source = [
    'import value from "value";',
    'const wrapped = define({ "module.js"(exports) {',
    '  async function load() { await value(); }',
    '} });',
  ].join('\n');
  const output = await service.transform(source, { loader: 'js', format: 'cjs' });
  assert.equal(output.code, '/* direct-cjs */');
  assert.deepEqual(calls.map((call) => call.format), ['cjs']);
}

// Esbuild's real CJS-TLA rejection, not a Nimbus source heuristic, opens the
// existing two-pass path. Native ESM declarations stay above the async IIFE.
{
  const calls = [];
  const service = serviceWith(async (code, options) => {
    calls.push({ code, format: options.format });
    if (options.format === 'cjs') {
      throw new Error('Top-level await is currently not supported with the "cjs" output format');
    }
    return {
      code: 'import value from "value";\nawait value();\n',
      map: '',
      warnings: [],
    };
  });
  const output = await service.transform('import value from "value";\nawait value();', {
    loader: 'js',
    format: 'cjs',
  });
  assert.deepEqual(calls.map((call) => call.format), ['cjs', 'esm']);
  // The lowered module runs as CommonJS: it requires "value" and awaits its
  // call in the async body it returns.
  const required = [];
  let settled = false;
  const done = new Function('module', 'exports', 'require', output.code)({ exports: {} }, {}, (name) => {
    required.push(name);
    return () => new Promise((resolve) => setTimeout(() => { settled = true; resolve(); }, 1));
  });
  assert.deepEqual(required, ['value']);
  await done;
  assert.ok(settled, 'the body awaited value()');
}

// Errors unrelated to top-level await remain the original esbuild error.
{
  const original = new Error('Unexpected token');
  const service = serviceWith(async () => { throw original; });
  await assert.rejects(
    service.transform('export {', { loader: 'js', format: 'cjs' }),
    (error) => error === original,
  );
}

// transformMany is positional: a request the pre-pass cannot parse (one
// binding __commonJS, which it reads) is its own { error }, and the others
// still reach the host and keep their places.
for (const hosted of [true, false]) {
  const sent = [];
  const transform = async (code) => { sent.push(code); return { code: `T(${code})`, map: '', warnings: [] }; };
  const service = hosted
    ? new EsbuildService(undefined, { transformHost: async (requests) => Promise.all(requests.map(({ code }) => transform(code))) })
    : serviceWith(transform);
  const options = { loader: 'js', format: 'cjs' };
  const outcomes = await service.transformMany([
    { code: 'export const a = 1;', options },
    { code: 'import { __commonJS } from "./chunk.js";\nimport, and otherwise;', options },
    { code: 'export const c = 3;', options },
  ]);
  assert.equal(outcomes.length, 3);
  assert.equal(outcomes[0].code, 'T(export const a = 1;)');
  assert.match(outcomes[1].error, /Unexpected token/);
  assert.equal(outcomes[2].code, 'T(export const c = 3;)');
  assert.deepEqual(sent, ['export const a = 1;', 'export const c = 3;'], `hosted=${hosted}`);
}

console.log('esbuild-transform-routing: ok');

// An ES module is lowered without the engine; one nested past the lowering's
// parse loads it, for the engine's CommonJS.
{
  let loads = 0;
  const service = new EsbuildService(undefined, {
    engine: async () => {
      loads++;
      return { transform: async (code, options) => ({ code: `ENGINE(${options.format})`, map: '', warnings: [] }) };
    },
  });
  const at = { esModule: 'node', dynamicImportParent: 'file:///app/m.mjs' };
  const shallow = await service.transform('export const a = 1;', at);
  assert.match(shallow.code, /__esModule/);
  assert.equal(loads, 0, 'a lowered ES module loads no engine');
  const deep = await service.transform(`export const x = ${'['.repeat(7000)}1${']'.repeat(7000)};`, at);
  assert.equal(deep.code, 'ENGINE(cjs)', 'one nested past the lowering is the engine\'s');
  assert.equal(loads, 1);
}
console.log('esbuild-transform-routing: deep ES modules load the engine');

// A data: URL module nested past the lowering stages from the engine's emit, which has no map.
{
  const { stagedDataUrlModule } = await import('../../packages/worker/src/facets/manager.ts');
  const service = new EsbuildService(undefined, {
    engine: async () => ({ transform: async () => ({ code: 'module.exports.x = 1;', map: '', warnings: [] }) }),
  });
  const staged = await stagedDataUrlModule(`export const x = ${'['.repeat(7000)}1${']'.repeat(7000)};`, 'node', service);
  assert.match(staged, /module\.exports\.x = 1;/);
}
console.log('esbuild-transform-routing: a deep data: module stages');
