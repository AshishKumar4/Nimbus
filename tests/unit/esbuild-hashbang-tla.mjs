#!/usr/bin/env bun
// A CLI imported as a module can have both a hashbang and top-level await
// (Vite's bin/vite.js imported by Vinext). Native staging keeps that source
// as written; an ordinary CommonJS CLI still runs through its cell wrapper.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';
import { wrapCommonJsCell } from '../../packages/core/src/_shared/commonjs-cell.ts';
import { loadCell } from './lib/cell-module.mjs';
import { oxcTransforms } from './lib/oxc-engine.mjs';
const service = new EsbuildService(undefined, oxcTransforms);
const require = createRequire(import.meta.url);
{
  const source = '#!/usr/bin/env node\nimport { sep } from "node:path";\nexport const value = await Promise.resolve(sep + "ready");';
  const result = await service.transform(source, { loader: 'js', esModule: 'node' });
  assert.equal(result.code, source, 'native staging preserves the hashbang and top-level await');
  assert.equal(result.esModule, 'node');
  const sites = JSON.parse(result.map);
  assert.equal(sites.moduleSyntax, true);
  assert.equal(sites.statics[0].specifier, 'node:path');
  assert.equal(source.slice(sites.statics[0].start, sites.statics[0].end), '"node:path"', 'import sites account for the hashbang');
}
{
  const source = '#!/usr/bin/env node\nmodule.exports.value = "/ready";';
  const { code } = await service.transform(source, { loader: 'js', format: 'cjs', target: 'esnext' });
  const mod = { exports: {} };
  await loadCell(wrapCommonJsCell(code, 'block'))(Function)(mod.exports, require, mod, '/cli.js', '/');
  assert.equal(mod.exports.value, '/ready', 'a CommonJS hashbang stays outside the wrapper and the CLI executes');
}
console.log('esbuild-hashbang-tla: ok');
