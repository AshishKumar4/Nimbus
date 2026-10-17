#!/usr/bin/env bun
// Unsupported targets fail at construction and import nothing. Parser
// messaging is covered with the staged module in opencode-parser-messaging
// and opencode-parser-facet-workerd.

import assert from 'node:assert/strict';
import { WORKER_POLYFILL_SRC } from '../../packages/worker/src/runtime/opencode-facet-runner.ts';

const installPolyfill = new Function(WORKER_POLYFILL_SRC + '\nreturn globalThis.Worker;');
const Worker = installPolyfill();
assert.equal(typeof Worker, 'function', 'polyfill installed globalThis.Worker');

// Upstream's resolver (cli/cmd/tui/thread.ts target()) can only ever name the
// built worker.js or the worker.ts source URL it falls back to. Both must throw
// at construction, and no module import may be attempted for either.
const imported = [];
globalThis.__nimbusWorkerImport = async (specifier) => {
  imported.push(specifier);
};
for (const spec of [
  './worker.js',
  'worker.js',
  new URL('file:///opencode/cli/cmd/tui/worker.js'),
  new URL('file:///opencode/cli/cmd/tui/worker.ts'),
]) {
  assert.throws(
    () => new Worker(spec, { env: { OPENCODE_PROCESS_ROLE: 'worker' } }),
    Error,
    `spawning the API-server worker fails loud: ${spec}`,
  );
}
assert.deepEqual(imported, [], 'no module was imported for the API-server worker');

assert.throws(
  () => new Worker('./mystery.js', {}),
  Error,
  'an unrecognized Worker target fails loud (no silent no-op)',
);
assert.deepEqual(imported, [], 'an unrecognized Worker target imports nothing');
console.log('opencode-worker-polyfill OK: unsupported targets throw at construction and import nothing');
