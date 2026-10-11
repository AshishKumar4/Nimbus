#!/usr/bin/env bun
// Every emitted task closes over its imports at build time. The only free names
// left are the guest's actual preamble and runtime, never the host's bundle.
import assert from 'node:assert/strict';
import * as core from '../../packages/core/src/runtime/compiled-bodies.generated.ts';
import * as worker from '../../packages/worker/src/loaders/compiled-bodies.generated.ts';
import { WASI_INSTANCE_PREAMBLE_SRC } from '../../packages/core/src/runtime/wasi-instance.ts';
import { NPM_RESOLVE_PREAMBLE } from '../../packages/worker/src/loaders/npm-resolve-preamble.ts';
import { NPM_INSTALL_PREAMBLE } from '../../packages/worker/src/loaders/npm-install-preamble.ts';
import { TAR_STREAM_PREAMBLE, W7_FRAME_PREAMBLE, WAVE_WRITER_PREAMBLE } from '../../packages/worker/src/loaders/generated-workers.ts';
import { assembleLoaderWorkerModuleSource } from '../../packages/fabric/src/isolate-pool.ts';
import { FACET_GLOBALS, freeNames } from '../../packages/worker/scripts/free-names.mjs';
import { requireFacetTaskSource } from '../../packages/core/src/runtime/facet-task.ts';

let count = 0;
for (const [name, task] of Object.entries({ ...core, ...worker })) {
  if (task?.kind !== 'nimbus-facet-task') continue;
  const preamble = name === 'NPM_RESOLVE_ONE_TASK' ? NPM_RESOLVE_PREAMBLE
    : name === 'NPM_INSTALL_BATCH_TASK' ? [TAR_STREAM_PREAMBLE, W7_FRAME_PREAMBLE, WAVE_WRITER_PREAMBLE, NPM_INSTALL_PREAMBLE].join('\n')
    : name === 'WASM_CALL_TASK' ? WASI_INSTANCE_PREAMBLE_SRC : '';
  const module = assembleLoaderWorkerModuleSource({ fnSource: task.source, preamble, hasBindings: true });
  const absent = [...freeNames(module, { sourceType: 'module' })].filter((key) => !FACET_GLOBALS.has(key) && !(key in globalThis) && key !== 'WebAssembly');
  assert.deepEqual(absent, [], `${name} may read only the actual guest's bindings`);
  count++;
}
assert.ok(count >= 12, `found only ${count} compiled tasks`);
assert.throws(() => requireFacetTaskSource(() => 1), /precompiled task-source/, 'a plain closure is rejected at the boundary');
console.log(`facet-fn-no-module-imports: ${count} compiled task closures`);
