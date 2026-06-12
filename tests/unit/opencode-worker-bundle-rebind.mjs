#!/usr/bin/env bun
// Guard test: the staged opencode TUI worker bundles MUST route their birpc
// message channel through the per-worker context the in-isolate Worker polyfill
// claims (globalThis.__nimbusWorkerClaim), NOT the shared globalThis — two
// workers + the client share one facet isolate, so a bare globalThis.onmessage
// / postMessage would collide and the server worker would never answer the
// client's first RPC.
//
//   - worker.js (the TUI API server, opencode's own TS): the build-time
//     `define` + banner rebind bare onmessage/postMessage to `__nimbusWorker`.
//   - parser.worker.js (@opentui/core's @bun-prebuilt file): a local
//     `var self = globalThis` prelude shadows the global, so a fail-loud bundle
//     patch rewrites the initializer to claim the context.
//
// Both must be staged (built by build-node.ts with the worker entrypoints).
// SKIPS with a clear message when the staged dist is absent (a fresh checkout
// without the build); the build host that stages the artifact always has it.

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OPENCODE_ARTIFACT_VERSION,
  OPENCODE_TUI_WORKERS,
} from '../../packages/worker/src/opencode-artifact.generated.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const assetDir = path.resolve(
  here,
  '../../packages/worker/public/_assets/opencode',
  OPENCODE_ARTIFACT_VERSION,
);

if (!OPENCODE_TUI_WORKERS || !existsSync(path.join(assetDir, 'worker.js'))) {
  console.log(
    'opencode-worker-bundle-rebind SKIP: staged opencode TUI workers absent ' +
      '(no build dist) — rebuild via scripts/opencode/build-node.ts + bundle-opencode.mjs',
  );
  process.exit(0);
}

// ── worker.js: the server worker rebinds bare scope refs to __nimbusWorker ────
const serverSrc = readFileSync(path.join(assetDir, OPENCODE_TUI_WORKERS.server), 'utf8');
assert.ok(
  serverSrc.startsWith('var __nimbusWorker = globalThis.__nimbusWorkerClaim();'),
  'worker.js opens with the per-worker context-claim banner',
);
assert.ok(
  serverSrc.includes('__nimbusWorker.onmessage='),
  'worker.js Rpc.listen wires onmessage on the claimed context, not globalThis',
);
assert.ok(
  serverSrc.includes('__nimbusWorker.postMessage('),
  'worker.js Rpc.listen replies via the claimed context postMessage',
);
// The bare global scope refs must be GONE (rebound) — a leftover bare
// `onmessage=` global assignment would collide across the two workers.
assert.ok(
  !/[^.\w]onmessage\s*=/.test(serverSrc.replace(/__nimbusWorker\.onmessage/g, '')),
  'worker.js has no residual bare global onmessage assignment',
);
console.log('  [1] worker.js routes birpc through the claimed per-worker context');

// ── parser.worker.js: the self-scope patch claims the context ─────────────────
const parserSrc = readFileSync(path.join(assetDir, OPENCODE_TUI_WORKERS.parser), 'utf8');
assert.ok(
  parserSrc.includes('globalThis.__nimbusWorkerClaim?globalThis.__nimbusWorkerClaim():globalThis') ||
    parserSrc.includes('globalThis.__nimbusWorkerClaim ? globalThis.__nimbusWorkerClaim() : globalThis'),
  'parser.worker.js self prelude claims the per-worker context (fail-loud bundle patch)',
);
assert.ok(
  !parserSrc.includes('var self=globalThis;') && !parserSrc.includes('var self = globalThis;'),
  'parser.worker.js no longer binds self straight to the shared globalThis',
);
console.log('  [2] parser.worker.js self-scope is claimed, not the shared globalThis');

console.log(
  'opencode-worker-bundle-rebind OK: both staged TUI workers route their message ' +
    'channels through the in-isolate per-worker context (no globalThis collision)',
);
