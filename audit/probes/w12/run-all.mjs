#!/usr/bin/env bun
// W12 probe orchestrator. functional → regression → e2e.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUITE = [
  // Functional
  ['functional', 'replica-policy-classification.mjs'],
  ['functional', 'eventual-consistency-window-ms.mjs'],
  ['functional', 'replicas-suspension-counter.mjs'],
  ['functional', 'smart-placement-config-shape.mjs'],
  ['functional', 'replica-state-shape.mjs'],
  ['functional', 'should-delegate-decision.mjs'],
  ['functional', 'replica-metadata-flag-in-diag.mjs'],
  ['functional', 'ws-routes-are-primary-only.mjs'],
  // Regression
  ['regression', 'install-pipeline-coverage.mjs'],
  ['regression', 'mossaic-shape.mjs'],
  ['regression', 'w11-frameworks-detect-unchanged.mjs'],
  ['regression', 'w10-bindings-still-injected.mjs'],
  ['regression', 'w7-stream-rpc-still-present.mjs'],
  ['regression', 'w9-hib-config-still-present.mjs'],
  ['regression', 'w5-diag-memory-shape.mjs'],
  ['regression', 'wrangler-jsonc-still-valid.mjs'],
  // E2E (locally-runnable + prod-gated stubs)
  ['e2e', 'delegate-roundtrip.mjs'],
  ['e2e', 'replica-bookmark-roundtrip.mjs'],
  ['e2e', 'region-latency-baseline.mjs'],
  ['e2e', 'region-latency-after.mjs'],
  ['e2e', 'mossaic-regression-e2e.mjs'],
];

const results = [];
let allOk = true;

for (const [bucket, file] of SUITE) {
  const probe = path.join(HERE, bucket, file);
  console.log(`\n========================================`);
  console.log(`# Running ${bucket}/${file}`);
  console.log(`========================================`);
  const t0 = Date.now();
  const r = spawnSync('bun', [probe], {
    stdio: 'inherit',
    cwd: path.resolve(HERE, '..', '..', '..'),
  });
  const ms = Date.now() - t0;
  const ok = r.status === 0;
  results.push({ bucket, file, ok, ms, code: r.status });
  if (!ok) allOk = false;
}

console.log(`\n========================================`);
console.log(`# W12 probe summary`);
console.log(`========================================`);
const lines = [];
for (const r of results) {
  const flag = r.ok ? '✓' : '✗';
  const line = `${flag} ${r.bucket}/${r.file} (${r.ms}ms, exit=${r.code})`;
  console.log(line);
  lines.push(line);
}
console.log(allOk ? '\n# ALL GREEN' : '\n# FAILED');

const target = path.join(HERE, allOk ? 'results-build.txt' : 'results-pending.txt');
fs.writeFileSync(
  target,
  '# W12 probe run @ ' + new Date().toISOString() + '\n' + lines.join('\n') + '\n' +
  (allOk ? '# all green\n' : '# not all green\n'),
);

process.exit(allOk ? 0 : 1);
