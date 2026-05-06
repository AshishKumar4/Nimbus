#!/usr/bin/env bun
// X5J run-all: orchestrates functional + regression probes.
// E2E probes (e2e/) are gated behind NIMBUS_X5J_E2E=1 and require a
// live wrangler dev (BASE=http://127.0.0.1:8787 per AGENTS.md).

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const FUNCTIONAL = [
  'r25-rejects-optional-peer-supervisor.mjs',
  'r25-rejects-optional-peer-facet.mjs',
  'r2-required-peer-still-throws.mjs',
  'synth-fixture-package-rejects-soft-skip.mjs',
];

const REGRESSION = [
  'single-resolver-source.mjs',
  'loud-reject-still-loud-top-level.mjs',
  'loud-reject-still-loud-required-peer.mjs',
  'r25-still-installs-non-rejected-peers.mjs',
  'tsc-baseline-preserved.mjs',
];

const E2E = [
  'drizzle-orm.mjs',
  'ts-node.mjs',
  'framer-motion.mjs',
  'parcel.mjs',
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

console.log('# X5J functional probes');
for (const f of FUNCTIONAL) run('functional', f);

console.log('\n# X5J regression probes');
for (const f of REGRESSION) run('regression', f);

if (process.env.NIMBUS_X5J_E2E === '1') {
  console.log('\n# X5J e2e probes (NIMBUS_X5J_E2E=1)');
  for (const f of E2E) run('e2e', f);
} else {
  console.log('\n# X5J e2e probes — set NIMBUS_X5J_E2E=1 to run');
}

console.log('\n=========================================');
console.log(`X5J summary: ${totalPass} passed, ${totalFail} failed`);
if (failures.length > 0) {
  console.log('failures:');
  for (const f of failures) console.log(`  - ${f}`);
}
console.log('=========================================');

process.exit(totalFail > 0 ? 1 : 0);
