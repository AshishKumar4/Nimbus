#!/usr/bin/env bun
// Check what ships after host minification: compiled guest entries, not live
// functions inspected by a string regex. "this" in a diagnostic is harmless;
// an undefined host helper in the actual guest module is not.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { assembleLoaderWorkerModuleSource } from '../../../packages/fabric/dist/isolate-pool.js';
import { WASI_INSTANCE_PREAMBLE_SRC } from '../../../packages/core/dist/runtime/wasi-instance.js';
import { NPM_RESOLVE_PREAMBLE } from '../../../packages/worker/dist/loaders/npm-resolve-preamble.js';
import { NPM_INSTALL_PREAMBLE } from '../../../packages/worker/dist/loaders/npm-install-preamble.js';
import { TAR_STREAM_PREAMBLE, W7_FRAME_PREAMBLE, WAVE_WRITER_PREAMBLE } from '../../../packages/worker/dist/loaders/generated-workers.js';
import { FACET_GLOBALS, freeNames } from '../../../packages/worker/scripts/free-names.mjs';

const root = new URL('../../../', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'nimbus-compiled-facet-check-'));
let count = 0;
try {
  const result = await build({
    stdin: { contents: [
      "export * as core from './packages/core/dist/runtime/compiled-bodies.generated.js';",
      "export * as worker from './packages/worker/dist/loaders/compiled-bodies.generated.js';",
    ].join('\n'), resolveDir: root, loader: 'js' },
    bundle: true, minify: true, format: 'esm', platform: 'neutral', write: false,
    conditions: ['workerd', 'worker', 'import'], logLevel: 'silent',
  });
  const file = join(dir, 'host.mjs');
  writeFileSync(file, result.outputFiles[0].text);
  const bundled = await import(pathToFileURL(file).href);
  for (const [pkg, exports] of Object.entries(bundled)) {
    let discovered = 0;
    for (const [name, task] of Object.entries(exports)) {
      if (task?.kind !== 'nimbus-facet-task') continue;
      assert.notEqual(typeof task, 'function', `${pkg}/${name}: no live callback`);
      const preamble = name === 'WASM_CALL_TASK' ? WASI_INSTANCE_PREAMBLE_SRC
        : name === 'NPM_RESOLVE_ONE_TASK' ? NPM_RESOLVE_PREAMBLE
        : name === 'NPM_INSTALL_BATCH_TASK' ? [TAR_STREAM_PREAMBLE, W7_FRAME_PREAMBLE, WAVE_WRITER_PREAMBLE, NPM_INSTALL_PREAMBLE].join('\n') : '';
      const source = assembleLoaderWorkerModuleSource({ fnSource: task.source, preamble, hasBindings: true });
      const absent = [...freeNames(source, { sourceType: 'module' })].filter((key) => !FACET_GLOBALS.has(key) && !(key in globalThis) && key !== 'WebAssembly');
      assert.deepEqual(absent, [], `${pkg}/${name}: host helpers cannot escape into the guest`);
      discovered++;
      count++;
    }
    assert.ok(discovered >= 6, `${pkg}: discovery found only ${discovered} compiled guest entries`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`static-checks/no-this-in-facet-fns: ${count} minified, compiled guest entries; no host closure leaks`);
