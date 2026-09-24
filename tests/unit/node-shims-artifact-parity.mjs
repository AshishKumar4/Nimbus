#!/usr/bin/env bun
// Parity guard for the node-compat layer's staged assets. The ~230 KiB
// generateShimsCode() output, VFS_WRITE_LEDGER_SOURCE and
// FACET_RESIDENT_STORE_SOURCE are promoted out of the worker bundle into
// public/_assets/runtime/<family>-<buildId>.js (scripts/bundle-node-shims.mjs)
// and fetched per isolate by runtime/node-shims-artifact.ts. The src modules
// stay the single source of truth, consumed at BUILD time — so an edit to one
// of them without re-running the bundle script would ship a stale source.
// This test fails loud on exactly that drift, for each of the three:
//   1. the staged asset's bytes === the CURRENT src output
//   2. the generated sha/build-id constants match the staged bytes
// Mirrors tests/unit/package-abi-policy.mjs (generated-vs-source parity).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { VFS_WRITE_LEDGER_SOURCE } from '../../packages/core/src/_shared/vfs-write-ledger.ts';
import { FACET_RESIDENT_STORE_SOURCE } from '../../packages/worker/src/vfs/facet-resident-store.ts';
import * as pins from '../../packages/worker/src/node-shims-artifact.generated.ts';

const workerRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../packages/worker',
);

const cases = [
  { name: 'NODE_SHIMS', source: 'generateShimsCode()', current: generateShimsCode() },
  { name: 'VFS_WRITE_LEDGER', source: 'VFS_WRITE_LEDGER_SOURCE', current: VFS_WRITE_LEDGER_SOURCE },
  { name: 'RESIDENT_STORE', source: 'FACET_RESIDENT_STORE_SOURCE', current: FACET_RESIDENT_STORE_SOURCE },
];

for (const { name, source, current } of cases) {
  const entry = pins[`${name}_ENTRY`];
  const buildId = pins[`${name}_BUILD_ID`];
  const sha256 = pins[`${name}_SHA256`];
  const staged = readFileSync(path.join(workerRoot, 'public', entry.slice(1)), 'utf8');

  assert.equal(
    staged.length,
    current.length,
    `staged ${entry} length ${staged.length} != current ${source} ${current.length} — ` +
      'src changed without re-running scripts/bundle-node-shims.mjs',
  );
  assert.ok(
    staged === current,
    `staged ${entry} bytes differ from current ${source} — ` +
      'rerun scripts/bundle-node-shims.mjs (and rebuild dist first if src changed)',
  );

  const sha = createHash('sha256').update(staged, 'utf8').digest('hex');
  assert.equal(sha, sha256, `generated ${name}_SHA256 does not match the staged asset`);
  assert.equal(sha.slice(0, 16), buildId, `${name}_BUILD_ID is not the sha prefix`);
  assert.ok(entry.includes(buildId), `${entry} is not content-pinned to the build id`);
  console.log(`  ✓ ${entry} (${(staged.length / 1024).toFixed(1)} KiB) matches ${source} + sha constants`);
}

console.log(`node-shims-artifact-parity OK: ${cases.length} staged node-compat sources match src`);
