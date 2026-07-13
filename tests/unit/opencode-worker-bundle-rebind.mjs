#!/usr/bin/env bun
// Guard test: the staged opencode TUI worker bundles MUST route their birpc
// message channel through the per-worker context the in-isolate Worker polyfill
// claims (globalThis.__nimbusWorkerClaim), NOT the shared globalThis — two
// workers + the client share one facet isolate, so a bare globalThis.onmessage
// / postMessage would collide and the server worker would never answer the
// client's first RPC.
//
//   - worker.js (the TUI API server): the split build shares chunks with
//     index.js, so the scope rebind is an explicit runtime parameter — the
//     entry claims the context at module-body start (nimbusPatchTuiWorkerEntry)
//     and the shared Rpc listen/emit seams write through the passed scope with
//     a globalThis fallback (nimbusPatchRpcWorkerScope).
//   - parser.worker.js (@opentui/core's @bun-prebuilt file): a local
//     `var self = globalThis` prelude shadows the global, so a fail-loud bundle
//     patch rewrites the initializer to claim the context.
//
// Both must be staged (built by build-node.ts). SKIPS with a clear message when
// the staged dist is absent (a fresh checkout without the build); the build
// host that stages the artifact always has it.

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OPENCODE_ARTIFACT_VERSION,
  OPENCODE_CHUNKS_PACK,
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

// ── worker.js: the entry claims the per-worker context before its TLA ────────
const serverSrc = readFileSync(path.join(assetDir, OPENCODE_TUI_WORKERS.server), 'utf8');
assert.ok(
  serverSrc.includes('__nimbusWorkerClaim?globalThis.__nimbusWorkerClaim():void 0') ||
    serverSrc.includes('__nimbusWorkerClaim ? globalThis.__nimbusWorkerClaim() : void 0'),
  'worker.js entry claims the per-worker context (nimbusPatchTuiWorkerEntry)',
);
assert.ok(
  !/[^.\w]onmessage\s*=/.test(serverSrc),
  'worker.js has no bare global onmessage assignment',
);
console.log('  [1] worker.js claims the per-worker context at module-body start');

// ── shared Rpc chunk: listen/emit write through the passed scope ──────────────
assert.ok(OPENCODE_CHUNKS_PACK, 'split-build chunk pack is staged');
const pack = JSON.parse(readFileSync(path.join(assetDir, OPENCODE_CHUNKS_PACK), 'utf8'));
const rpcChunks = Object.entries(pack).filter(
  ([, src]) => src.includes('"rpc.result"') && src.includes('"rpc.event"'),
);
assert.equal(rpcChunks.length, 1, `exactly one shared Rpc chunk (got ${rpcChunks.length})`);
const [rpcName, rpcSrc] = rpcChunks[0];
assert.ok(
  rpcSrc.includes('??globalThis'),
  `${rpcName}: Rpc listen/emit fall back to globalThis when no scope is passed`,
);
assert.ok(
  !/[^.\w]onmessage\s*=/.test(rpcSrc),
  `${rpcName}: onmessage is only ever assigned through the scope target`,
);
console.log(`  [2] shared Rpc chunk (${rpcName}) writes through the explicit worker scope`);

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
console.log('  [3] parser.worker.js self-scope is claimed, not the shared globalThis');

console.log(
  'opencode-worker-bundle-rebind OK: both staged TUI workers route their message ' +
    'channels through the in-isolate per-worker context (no globalThis collision)',
);
