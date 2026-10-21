#!/usr/bin/env bun
// The staged OpenTUI parser worker runs in the attached TUI's own isolate,
// through the runner's in-isolate Worker polyfill, on the per-worker context
// the polyfill claims for it (globalThis.__nimbusWorkerClaim), NOT the shared
// globalThis: the parser and its client share one facet isolate, so a bare
// globalThis.onmessage / postMessage would collide.
//
// The real attached runner is evaluated (importOpencodeRunner), and the real
// staged parser.worker.js is the map member its polyfill imports. Loading it
// claims the context the polyfill made for that worker, at the bundle's
// banner and at its patched `self` initializer, and leaves the shared global's
// message channel alone.
//
// The staged artifact carries NO API-server worker: a Nimbus TUI attaches to
// an `opencode serve` facet over HTTP, nothing spawns that worker, and the
// polyfill refuses both names upstream's resolver can give it, importing
// nothing.
//
// SKIPS with a clear message when the staged dist is absent (a fresh checkout
// without the build); the build host that stages the artifact always has it.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  OPENCODE_ARTIFACT_DIGESTS,
  OPENCODE_ARTIFACT_VERSION,
  OPENCODE_TUI_PARSER_WORKER,
} from '../../packages/worker/src/opencode-artifact.generated.ts';

// The attached runner makes the shim process and console the realm's: report through these.
const realProcess = globalThis.process;
const realStdout = realProcess.stdout.write.bind(realProcess.stdout);
const realStderr = realProcess.stderr.write.bind(realProcess.stderr);
const here = path.dirname(fileURLToPath(import.meta.url));
const assetDir = path.resolve(here, '../../packages/worker/public/_assets/opencode', OPENCODE_ARTIFACT_VERSION);

if (!OPENCODE_TUI_PARSER_WORKER || !existsSync(path.join(assetDir, OPENCODE_TUI_PARSER_WORKER))) {
  console.log(
    'opencode-worker-bundle-rebind SKIP: staged OpenTUI parser worker absent ' +
      '(no build dist) — rebuild via scripts/opencode/build-node.ts + bundle-opencode.mjs',
  );
  process.exit(0);
}

// ── the API-server worker is not staged at all ───────────────────────────────
assert.ok(!existsSync(path.join(assetDir, 'worker.js')), 'opencode\'s API-server worker is not staged in the asset directory');
assert.ok(
  !Object.prototype.hasOwnProperty.call(OPENCODE_ARTIFACT_DIGESTS, 'worker.js'),
  'opencode\'s API-server worker has no pinned digest (it is not part of the artifact)',
);
console.log('  [1] the API-server worker is absent from the staged artifact and its digests');

// ── the parser runs through the attached runner's own polyfill ───────────────
try {
  const { importOpencodeRunner } = await import('./lib/opencode-runner-module.mjs');
  // The loader resolves the polyfill's import() of a worker to the map member
  // of that name: here, the file beside the runner.
  let dir = null;
  const imported = [];
  const loaded = Promise.withResolvers();
  globalThis.__nimbusWorkerImport = async (specifier) => {
    imported.push(specifier);
    const failure = await import(pathToFileURL(path.join(dir, specifier)).href).then(() => null, (error) => error);
    loaded.resolve(failure);
    if (failure) throw failure;
  };
  const program = 'export async function nimbusMain() {}\n';
  const parserSource = readFileSync(path.join(assetDir, OPENCODE_TUI_PARSER_WORKER), 'utf8');
  ({ dir } = await importOpencodeRunner({
    mode: 'attached', program, terminal: { NIMBUS_ATTACHED_TTY: '1' },
    members: { [OPENCODE_TUI_PARSER_WORKER]: { js: parserSource } },
  }));
  const Worker = globalThis.Worker;
  assert.equal(typeof Worker, 'function', 'the attached runner installs its Worker');

  const sharedChannel = { onmessage: globalThis.onmessage, postMessage: globalThis.postMessage };
  // OpenTUI's own spawn: the worker path resolved against its module's URL.
  new Worker(new URL(`file:///opencode/${OPENCODE_TUI_PARSER_WORKER}`), {});
  // What each claim answers. The module is still loading: it evaluates after this.
  const claim = globalThis.__nimbusWorkerClaim;
  const contexts = [];
  globalThis.__nimbusWorkerClaim = () => { const context = claim(); contexts.push(context); return context; };
  assert.equal(await loaded.promise, null, 'the staged parser module loads through the polyfill');
  assert.deepEqual(imported, [OPENCODE_TUI_PARSER_WORKER], 'the polyfill imports the staged parser member');
  assert.equal(contexts.length, 2, 'the parser claims its context at its banner and at its patched `self`');
  for (const context of contexts) {
    assert.equal(context, contexts[0], 'one context, the worker\'s');
    assert.notEqual(context, globalThis, 'not the shared global');
    assert.equal(typeof context.postMessage, 'function', 'whose postMessage is the worker\'s own channel');
  }
  assert.deepEqual(
    { onmessage: globalThis.onmessage, postMessage: globalThis.postMessage }, sharedChannel,
    'the shared global\'s message channel is left alone',
  );
  realStdout('  [2] the staged parser loads through the attached runner\'s polyfill on the worker\'s own context\n');

  // ── the API-server worker fails loud, importing nothing ────────────────────
  for (const spec of ['./worker.js', new URL('file:///opencode/cli/cmd/tui/worker.ts')]) {
    assert.throws(() => new Worker(spec, {}), /API-server worker .* is never built or staged/, `spawning ${spec} fails loud`);
  }
  assert.deepEqual(imported, [OPENCODE_TUI_PARSER_WORKER], 'nothing was imported for the API-server worker');
  realStdout('  [3] the attached runner\'s polyfill refuses the API-server worker\n');
} catch (error) {
  realStderr(`opencode-worker-bundle-rebind FAILED\n${(error && error.stack) || error}\n`);
  realProcess.exit(1);
}

realStdout('opencode-worker-bundle-rebind OK: the staged parser runs on its own worker context; no API-server worker is staged or spawned\n');
realProcess.exit(0);
