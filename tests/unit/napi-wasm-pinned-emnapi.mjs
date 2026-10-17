#!/usr/bin/env bun
// The N-API loader's emnapi (packages/worker/scripts/napi-wasm/inputs.mjs
// pinnedEmnapi): bundled from the pinned, seamed packages even when the
// workspace installs its own copy on the loader's resolution path, and
// refused when only an unpinned copy exists.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { pinnedEmnapi } from '../../packages/worker/scripts/napi-wasm/inputs.mjs';

const root = mkdtempSync(join(tmpdir(), 'pinned-emnapi-'));
/** A package `name` under `dir`/node_modules whose module says where it came from. */
const install = (dir, name, origin) => {
  const at = join(dir, 'node_modules', name);
  mkdirSync(at, { recursive: true });
  writeFileSync(join(at, 'package.json'), JSON.stringify({ name, version: '1.4.5', module: 'index.js' }));
  writeFileSync(join(at, 'index.js'), `export const origin = ${JSON.stringify(origin)};\n`);
};
const pinned = join(root, 'npm');
const workspace = join(root, 'workspace');
const entry = (imports) => {
  writeFileSync(join(workspace, 'entry.js'), `${imports.map((name, i) => `import { origin as o${i} } from '${name}';`).join('\n')}\nexport const origins = [${imports.map((_, i) => `o${i}`).join(', ')}];\n`);
  return join(workspace, 'entry.js');
};
/** Bundle `imports` as the loader build does, with the pinned packages on nodePaths: the origins it bundled, or its errors. */
const bundle = async (imports, plugins) => {
  const result = await build({
    entryPoints: [entry(imports)], bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent',
    mainFields: ['module', 'main'], nodePaths: [join(pinned, 'node_modules')], plugins,
  }).catch((error) => ({ errors: error.errors }));
  if (result.errors.length > 0) return { errors: result.errors.map((error) => error.text) };
  return { origins: [...result.outputFiles[0].text.matchAll(/origin\d* = "(\w+)"/g)].map((match) => match[1]) };
};

try {
  mkdirSync(workspace, { recursive: true });
  install(pinned, '@emnapi/core', 'pinned');
  install(pinned, '@emnapi/runtime', 'pinned');
  install(workspace, '@emnapi/core', 'workspace');

  assert.deepEqual(await bundle(['@emnapi/core'], []), { origins: ['workspace'] }, 'without the plugin, the workspace copy wins');
  assert.deepEqual(await bundle(['@emnapi/core', '@emnapi/runtime'], [pinnedEmnapi(pinned)]), { origins: ['pinned', 'pinned'] }, 'with it, every @emnapi/* is the pinned one');

  install(workspace, '@emnapi/wasi-threads', 'workspace');
  const refused = await bundle(['@emnapi/wasi-threads'], [pinnedEmnapi(pinned)]);
  assert.equal(refused.origins, undefined, 'a package only the workspace has is refused');
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log('napi-wasm-pinned-emnapi: the loader bundles the pinned emnapi over a workspace copy, and refuses an unpinned one');
