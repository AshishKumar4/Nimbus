#!/usr/bin/env bun
// A CLI imported as a module can have both a hashbang and top-level await
// (Vite's bin/vite.js imported by Vinext). The CJS TLA fallback must not move
// the hashbang inside its async wrapper, where '#' is invalid syntax.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';
import { wrapCommonJsCell } from '../../packages/core/src/_shared/commonjs-cell.ts';
import { oxcEngine } from './lib/oxc-engine.mjs';
const service = new EsbuildService();
service.ensureInit = async () => {};
service._esbuild = oxcEngine;
const require = createRequire(import.meta.url);
for (const source of [
  '#!/usr/bin/env node\nimport { sep } from "node:path";\nexport const value = await Promise.resolve(sep + "ready");',
  '#!/usr/bin/env node\nmodule.exports.value = await Promise.resolve("/ready");',
]) {
  const { code } = await service.transform(source, { loader: 'js', format: 'cjs', target: 'esnext' });
  const registryCell = { exports: {} };
  new Function('module', wrapCommonJsCell(code, 'block').text)(registryCell);
  const mod = { exports: {} };
  await registryCell.exports(mod.exports, require, mod, '/cli.js', '/');
  assert.equal(mod.exports.value, '/ready', 'hashbang + TLA module executes and exports its awaited value');
}
console.log('esbuild-hashbang-tla: ok');
