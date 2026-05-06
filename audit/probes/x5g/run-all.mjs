#!/usr/bin/env bun
// X5G run-all: orchestrates functional + regression probes.
// E2E probes (e2e/) are gated behind NIMBUS_X5G_E2E=1 and require a
// live wrangler dev (BASE=http://127.0.0.1:8787 per AGENTS.md).

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const FUNCTIONAL = [
  'native-binding-detect.mjs',
  'optional-deps-parse.mjs',
  'peer-meta-only-not-installed.mjs',
  'applySwaps-rollup.mjs',
  'preamble-parity-rollup.mjs',
  'error-classification.mjs',
];

const REGRESSION = [
  'single-resolver-source.mjs',
  'transitive-warn-still-warns.mjs',
  'w65-telemetry-events-compatible.mjs',
  'install-pipeline-coverage-shim.mjs',
  'skip-still-skips-buildtools.mjs',
];

const E2E = [
  'rollup.mjs',
  'radix-react-dialog.mjs',
  'ts-jest.mjs',
  'nuxt.mjs',
];

let totalPass = 0;
let totalFail = 0;
const failures = [];

function run(category, file) {
  const probe = path.join(HERE, category, file);
  if (!fs.existsSync(probe)) {
    console.log(`[SKIP] ${category}/${file} — file missing`);
    return;
  }
  console.log(`\n==== ${category}/${file} ====`);
  const r = spawnSync('bun', [probe], { stdio: 'inherit' });
  if (r.status === 0) {
    totalPass++;
    console.log(`[PASS] ${category}/${file}`);
  } else {
    totalFail++;
    failures.push(`${category}/${file}`);
    console.log(`[FAIL] ${category}/${file} — exit ${r.status}`);
  }
}

console.log('# X5G functional probes');
for (const f of FUNCTIONAL) run('functional', f);

console.log('\n# X5G regression probes');
for (const f of REGRESSION) run('regression', f);

if (process.env.NIMBUS_X5G_E2E === '1') {
  console.log('\n# X5G e2e probes (NIMBUS_X5G_E2E=1)');
  for (const f of E2E) run('e2e', f);
} else {
  console.log('\n# X5G e2e probes — set NIMBUS_X5G_E2E=1 to run');
}

console.log('\n=========================================');
console.log(`X5G summary: ${totalPass} passed, ${totalFail} failed`);
if (failures.length > 0) {
  console.log('failures:');
  for (const f of failures) console.log(`  - ${f}`);
}
console.log('=========================================');

process.exit(totalFail > 0 ? 1 : 0);
