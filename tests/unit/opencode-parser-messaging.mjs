#!/usr/bin/env bun
// The staged OpenTUI parser answers what the TUI sends it. The attached
// runner hosts `new Worker("./parser.worker.js")` in its own isolate (the
// Worker polyfill), so the parser shares the client's thread, where the
// platform's worker_threads says main; parser.worker.js installs its handler
// only off the main thread (`if (!isMainThread)`), so its build gives it a
// worker_threads of its own (packages/worker/scripts/opencode/build-node.ts).
// Through the real generated attached runner, its real polyfill and the real
// staged parser module: OpenTUI's GET_PERFORMANCE gets its
// PERFORMANCE_RESPONSE; and the parser's console is its own: its worker
// branch reroutes console.log/error/warn to WORKER_LOG messages, which must
// not take the TUI's console with it (the runner routes that to stdout and
// stderr).
//
// Red before: the staged parser read the platform's isMainThread (true here,
// as in workerd: src/node/worker_threads.ts) and never answered; then, once
// it answered, it replaced the shared console's methods.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMainThread } from 'node:worker_threads';
import { OPENCODE_ARTIFACT_VERSION, OPENCODE_TUI_PARSER_WORKER } from '../../packages/worker/src/opencode-artifact.generated.ts';

const realProcess = globalThis.process;
const realStdout = realProcess.stdout.write.bind(realProcess.stdout);
const realStderr = realProcess.stderr.write.bind(realProcess.stderr);
const rawSetTimeout = globalThis.setTimeout;
const here = path.dirname(fileURLToPath(import.meta.url));
const assetDir = path.resolve(here, '../../packages/worker/public/_assets/opencode', OPENCODE_ARTIFACT_VERSION);

try {
  // The question this answers: this thread is the main one, as the facet's is.
  assert.equal(isMainThread, true);
  const { importOpencodeRunner } = await import('./lib/opencode-runner-module.mjs');
  let dir = null;
  const loaded = Promise.withResolvers();
  globalThis.__nimbusWorkerImport = async (specifier) => {
    const failure = await import(pathToFileURL(path.join(dir, specifier)).href).then(() => null, (error) => error);
    loaded.resolve(failure);
    if (failure) throw failure;
  };
  ({ dir } = await importOpencodeRunner({
    mode: 'attached', program: 'export async function nimbusMain() {}\n', env: { NIMBUS_ATTACHED_TTY: '1' },
    members: { [OPENCODE_TUI_PARSER_WORKER]: { js: readFileSync(path.join(assetDir, OPENCODE_TUI_PARSER_WORKER), 'utf8') } },
  }));
  const parentConsole = { log: console.log, error: console.error, warn: console.warn };
  const parser = new globalThis.Worker(new URL(`file:///opencode/${OPENCODE_TUI_PARSER_WORKER}`), {});
  const answers = [];
  parser.onmessage = (event) => answers.push(event.data);
  parser.onerror = (event) => answers.push({ error: String(event.message) });
  assert.equal(await loaded.promise, null, 'the staged parser module loads through the polyfill');
  // OpenTUI's own request (parser.worker.js: case "GET_PERFORMANCE" answers PERFORMANCE_RESPONSE).
  parser.postMessage({ type: 'GET_PERFORMANCE', messageId: 1 });
  const deadline = Date.now() + 5_000;
  while (answers.length === 0 && Date.now() < deadline) await new Promise((resolve) => rawSetTimeout(resolve, 10));
  assert.equal(answers[0]?.type, 'PERFORMANCE_RESPONSE', `the parser answers GET_PERFORMANCE within 5 s (answers: ${JSON.stringify(answers)})`);
  assert.equal(answers[0].messageId, 1);
  assert.deepEqual({ log: console.log === parentConsole.log, error: console.error === parentConsole.error, warn: console.warn === parentConsole.warn },
    { log: true, error: true, warn: true }, "the parser's console is its own: the TUI's console keeps its methods");
  realStdout('opencode-parser-messaging: ok\n');
  realProcess.exit(0);
} catch (error) {
  realStderr(`opencode-parser-messaging FAILED\n${(error && error.stack) || error}\n`);
  realProcess.exit(1);
}
