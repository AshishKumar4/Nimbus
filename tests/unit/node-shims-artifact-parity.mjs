#!/usr/bin/env bun
// Parity guard for the staged node-compat shim asset. The ~230 KiB
// generateShimsCode() output is promoted out of the worker bundle into
// public/_assets/runtime/node-shims-<buildId>.js (scripts/bundle-node-shims.mjs),
// fetched per isolate by runtime/node-shims-artifact.ts. node-shims.ts stays
// the single source of truth, consumed at BUILD time — so an edit to
// node-shims.ts without re-running the bundle script would ship a stale shim.
// This test fails loud on exactly that drift:
//   1. the staged asset's bytes === the CURRENT src generateShimsCode() output
//   2. the generated sha/build-id constants match the staged bytes
// Mirrors tests/unit/package-abi-policy.mjs (generated-vs-source parity).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import {
  NODE_SHIMS_BUILD_ID,
  NODE_SHIMS_ENTRY,
  NODE_SHIMS_SHA256,
} from '../../packages/worker/src/node-shims-artifact.generated.ts';

const workerRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../packages/worker',
);

const staged = readFileSync(path.join(workerRoot, 'public', NODE_SHIMS_ENTRY.slice(1)), 'utf8');
const current = generateShimsCode();

assert.equal(
  staged.length,
  current.length,
  `staged shim asset length ${staged.length} != current generateShimsCode() ${current.length} — ` +
    'node-shims.ts changed without re-running scripts/bundle-node-shims.mjs',
);
assert.ok(
  staged === current,
  'staged shim asset bytes differ from current generateShimsCode() output — ' +
    'rerun scripts/bundle-node-shims.mjs (and rebuild dist first if src changed)',
);

const sha = createHash('sha256').update(staged, 'utf8').digest('hex');
assert.equal(sha, NODE_SHIMS_SHA256, 'generated NODE_SHIMS_SHA256 does not match the staged asset');
assert.equal(sha.slice(0, 16), NODE_SHIMS_BUILD_ID, 'NODE_SHIMS_BUILD_ID is not the sha prefix');
assert.ok(NODE_SHIMS_ENTRY.includes(NODE_SHIMS_BUILD_ID), 'asset path is not content-pinned to the build id');

console.log(
  `node-shims-artifact-parity OK: staged asset ${NODE_SHIMS_ENTRY} (${(staged.length / 1024).toFixed(1)} KiB) ` +
    'matches generateShimsCode() + sha constants',
);
