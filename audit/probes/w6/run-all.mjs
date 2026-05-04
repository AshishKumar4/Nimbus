#!/usr/bin/env bun
// W6 probe orchestrator.
//
// Each probe runs as a child `bun` process so global-state leaks
// don't taint others. Halts the process with non-zero exit if any
// probe fails; finishes the full sweep first.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const SUITE = [
  // Functional (pure-unit; no network)
  ['functional', 'registry-shape.mjs'],
  ['functional', 'lookup.mjs'],
  ['functional', 'apply-swaps.mjs'],
  ['functional', 'find-rejects.mjs'],
  ['functional', 'format-messages.mjs'],
  ['functional', 'no-conflict-with-skip.mjs'],
  ['functional', 'preamble-parity.mjs'],

  // Regression
  ['regression', 'install-pipeline-coverage-meta.mjs'],
  ['regression', 'skip-set-curated.mjs'],
  ['regression', 'builds-specs-passthrough.mjs'],
  ['regression', 'resolver-paths-symmetric.mjs'],

  // E2E
  ['e2e', 'build-specs-integration.mjs'],
  ['e2e', 'transitive-warn-not-throw.mjs'],
  ['e2e', 'lockfile-replay-with-swap.mjs'],
  ['e2e', 'swap-target-symbol-parity.mjs'],
  ['e2e', 'swap-preserves-package-json.mjs'],
  ['e2e', 'registry-coverage.mjs'],   // prod-gated; SKIPs unless NIMBUS_W6_E2E_PROD=1
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

console.log('\n========================================');
console.log('# W6 probe summary');
console.log('========================================');
for (const r of results) {
  const tag = r.ok ? 'OK ' : 'FAIL';
  console.log(`  [${tag}] ${r.bucket}/${r.file}  (${r.ms}ms, exit=${r.code})`);
}
console.log('');
console.log(allOk ? '# ALL W6 PROBES PASS' : '# SOME W6 PROBES FAILED');
process.exit(allOk ? 0 : 1);
