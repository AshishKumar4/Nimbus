#!/usr/bin/env bun
// Guard test: the staged OpenTUI parser worker MUST route its message channel
// through the per-worker context the in-isolate Worker polyfill claims
// (globalThis.__nimbusWorkerClaim), NOT the shared globalThis — the parser and
// its client share one facet isolate, so a bare globalThis.onmessage /
// postMessage would collide and the parser would never answer.
//
// parser.worker.js (@opentui/core's @bun-prebuilt file) opens with a local
// `var self = globalThis` prelude that shadows the global, so a fail-loud
// bundle patch rewrites the initializer to claim the context.
//
// The staged artifact must also carry NO API-server worker: a Nimbus TUI
// attaches to an `opencode serve` facet over HTTP, nothing spawns that worker,
// and the runner's polyfill fails loud if anything names it.
//
// SKIPS with a clear message when the staged dist is absent (a fresh checkout
// without the build); the build host that stages the artifact always has it.

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OPENCODE_ARTIFACT_DIGESTS,
  OPENCODE_ARTIFACT_VERSION,
  OPENCODE_TUI_PARSER_WORKER,
} from '../../packages/worker/src/opencode-artifact.generated.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const assetDir = path.resolve(
  here,
  '../../packages/worker/public/_assets/opencode',
  OPENCODE_ARTIFACT_VERSION,
);

if (!OPENCODE_TUI_PARSER_WORKER || !existsSync(path.join(assetDir, OPENCODE_TUI_PARSER_WORKER))) {
  console.log(
    'opencode-worker-bundle-rebind SKIP: staged OpenTUI parser worker absent ' +
      '(no build dist) — rebuild via scripts/opencode/build-node.ts + bundle-opencode.mjs',
  );
  process.exit(0);
}

// ── parser.worker.js: the self-scope patch claims the context ─────────────────
const parserSrc = readFileSync(path.join(assetDir, OPENCODE_TUI_PARSER_WORKER), 'utf8');
assert.ok(
  parserSrc.includes('globalThis.__nimbusWorkerClaim?globalThis.__nimbusWorkerClaim():globalThis') ||
    parserSrc.includes('globalThis.__nimbusWorkerClaim ? globalThis.__nimbusWorkerClaim() : globalThis'),
  'parser.worker.js self prelude claims the per-worker context (fail-loud bundle patch)',
);
assert.ok(
  !parserSrc.includes('var self=globalThis;') && !parserSrc.includes('var self = globalThis;'),
  'parser.worker.js no longer binds self straight to the shared globalThis',
);
console.log('  [1] parser.worker.js self-scope is claimed, not the shared globalThis');

// ── the API-server worker is not staged at all ───────────────────────────────
assert.ok(
  !existsSync(path.join(assetDir, 'worker.js')),
  'opencode\'s API-server worker is not staged in the asset directory',
);
assert.ok(
  !Object.prototype.hasOwnProperty.call(OPENCODE_ARTIFACT_DIGESTS, 'worker.js'),
  'opencode\'s API-server worker has no pinned digest (it is not part of the artifact)',
);
console.log('  [2] the API-server worker is absent from the staged artifact and its digests');

console.log(
  'opencode-worker-bundle-rebind OK: the staged parser worker routes its message channel ' +
    'through the in-isolate per-worker context; no API-server worker is staged',
);
