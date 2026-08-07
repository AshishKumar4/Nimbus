#!/usr/bin/env bun
// Parity guard for the facet bodies that are compiled out of TypeScript.
//
// The WASI shim (runtime/wasi/preamble.ts) and the bash scheduler
// (runtime/bash/preamble.ts) are real, type-checked modules. What actually
// ships is the STRING scripts/bundle-facet-workers.mjs esbuilds out of them
// into runtime/wasi-instance.generated.ts and runtime/bash-runner.generated.ts,
// which the runners splice into their facet module sources.
//
// Both generated files are tracked, so an edit to a preamble without re-running
// the bundler ships the OLD body while the source, the types and every review
// show the new one. That drift is invisible: the code reads correct and the
// facet runs something else. This fails loud on exactly it.
//
// It re-derives the bodies through the bundler's own exported functions rather
// than restating the esbuild settings — treeShaking:false and the flat-ESM /
// IIFE split are load-bearing, and a second copy of them here would drift from
// the build in the same way.
//
// Mirrors tests/unit/node-shims-artifact-parity.mjs (generated-vs-source parity).

import assert from 'node:assert/strict';

import {
  bundleBashRunner,
  bundleWasiInstance,
} from '../../packages/worker/scripts/bundle-facet-workers.mjs';
import { WASI_INSTANCE_BODY_SRC } from '../../packages/worker/src/runtime/wasi-instance.generated.ts';
import { BASH_RUNNER_BODY_SRC } from '../../packages/worker/src/runtime/bash-runner.generated.ts';

const cases = [
  {
    label: 'WASI shim',
    source: 'packages/worker/src/runtime/wasi/preamble.ts',
    generated: 'packages/worker/src/runtime/wasi-instance.generated.ts',
    committed: WASI_INSTANCE_BODY_SRC,
    rebuild: bundleWasiInstance,
  },
  {
    label: 'bash scheduler',
    source: 'packages/worker/src/runtime/bash/preamble.ts',
    generated: 'packages/worker/src/runtime/bash-runner.generated.ts',
    committed: BASH_RUNNER_BODY_SRC,
    rebuild: bundleBashRunner,
  },
];

for (const c of cases) {
  const fresh = await c.rebuild();
  assert.equal(
    fresh.length,
    c.committed.length,
    `${c.label}: ${c.generated} is ${c.committed.length} bytes but ${c.source} now bundles to ` +
      `${fresh.length} — re-run scripts/bundle-facet-workers.mjs`,
  );
  assert.ok(
    fresh === c.committed,
    `${c.label}: ${c.generated} does not match a fresh bundle of ${c.source} — ` +
      're-run scripts/bundle-facet-workers.mjs, then rebuild dist',
  );
  console.log(
    `  ✓ ${c.label}: ${c.generated} matches ${c.source} (${(fresh.length / 1024).toFixed(1)} KiB)`,
  );
}

console.log(`facet-body-generated-parity OK: ${cases.length} generated facet bodies match their sources`);
