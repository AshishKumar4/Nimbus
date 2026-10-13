#!/usr/bin/env bun
// Transform routing: CommonJS engine errors stay authoritative; JavaScript
// ES modules stage unchanged without an engine, and TS/JSX retain module syntax.

import assert from 'node:assert/strict';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';

function serviceWith(transform) {
  const service = new EsbuildService(undefined, { engine: async () => ({ transform }) });
  return service;
}

// A successful CJS transform is authoritative, including a pre-bundled CLI
// whose awaits are all inside functions.
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

// CJS top-level await is refused by the engine, with no second transform.
{
  const calls = [];
  const original = new Error('Top-level await is currently not supported with the "cjs" output format');
  const service = serviceWith(async (code, options) => {
    calls.push({ code, format: options.format });
    throw original;
  });
  await assert.rejects(service.transform('import value from "value";\nawait value();', {
    loader: 'js', format: 'cjs',
  }), (error) => error === original);
  assert.deepEqual(calls.map((call) => call.format), ['cjs']);
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

// An ES module, shallow or deeply nested, stages without loading the engine.
{
  let loads = 0;
  const service = new EsbuildService(undefined, {
    engine: async () => {
      loads++;
      return { transform: async (code, options) => ({ code: `ENGINE(${options.format})`, map: '', warnings: [] }) };
    },
  });
  const at = { esModule: 'node', dynamicImportParent: 'file:///app/m.mjs' };
  for (const source of ['export const a = 1;', `export const x = ${'['.repeat(7000)}1${']'.repeat(7000)};`]) {
    const result = await service.transform(source, at);
    assert.equal(result.code, source, 'native ES-module source is unchanged');
    assert.equal(result.esModule, 'node');
    assert.deepEqual(JSON.parse(result.map), {
      calls: [], metas: [], statics: [], moduleSyntax: true, bindings: { exports: [source.startsWith('export const a') ? 'a' : 'x'], imports: [], stars: [] },
    });
  }
  assert.equal(loads, 0, 'native ES-module staging loads no engine');
}
console.log('esbuild-transform-routing: deep ES modules stage without the engine');

// TypeScript and JSX compile with no output format. Module syntax stages
// natively; a CommonJS emit only has its dynamic import() calls routed.
{
  const calls = [];
  const service = serviceWith(async (code, options) => {
    calls.push(options);
    return { code, map: '', warnings: [] };
  });
  for (const loader of ['ts', 'jsx']) {
    const source = 'export const x = import.meta.url;';
    const result = await service.transform(source, { loader, esModule: 'node', dynamicImportParent: 'file:///app/x.js' });
    assert.equal(result.code, source);
    assert.equal(result.esModule, 'node');
    assert.equal(JSON.parse(result.map).metas.length, 1);
    const commonJs = await service.transform('module.exports = () => import("./x.mjs");', {
      loader, esModule: 'node', dynamicImportParent: 'file:///app/x.js',
    });
    assert.equal(commonJs.esModule, undefined);
    assert.equal(commonJs.map, '');
    assert.match(commonJs.code, /__nimbusDynamicImport\("file:\/\/\/app\/x\.js",/);
  }
  for (const options of calls) {
    assert.equal(Object.hasOwn(options, 'format'), false, 'the engine keeps the compiled source\'s module syntax');
    assert.deepEqual(options.supported, { 'dynamic-import': true, 'import-meta': true });
  }
}
console.log('esbuild-transform-routing: TS/JSX emits retain their module format');
