// X.5-F local probe driver.
//
// Runs functional + regression first (fast, no server). Runs e2e only
// when NIMBUS_X5F_E2E=1 AND a wrangler dev is reachable at BASE.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'run-all.txt');
fs.writeFileSync(ARTIFACT, '');
const log = (s) => { fs.appendFileSync(ARTIFACT, s + '\n'); console.log(s); };

log('==== X5F run-all ====');
log('==== TIMESTAMP: ' + new Date().toISOString() + ' ====');

const FUNCTIONAL = [
  'r1-toplevel-bypass.mjs',
  'r2-peerdep-resolution.mjs',
  'r3-cjs-priority.mjs',
  'r3-esm-fallback.mjs',
];
const REGRESSION = [
  'single-resolver-source.mjs',
  'skip-still-skips-transitive.mjs',
  'install-pipeline-coverage-shim.mjs',
];
const E2E = [
  'run-x5f-packages.mjs',
];

let passCount = 0, failCount = 0;
const results = [];

function run(label, dir, probe) {
  const full = path.join(HERE, dir, probe);
  log('');
  log('---- ' + label + ': ' + probe + ' ----');
  const t0 = Date.now();
  const r = spawnSync('bun', [full], { stdio: 'inherit', env: process.env });
  const elapsed = Date.now() - t0;
  const ok = r.status === 0;
  log('  [' + (ok ? 'PASS' : 'FAIL') + '] ' + probe + ' (' + elapsed + 'ms)');
  results.push({ label, probe, ok, elapsed });
  if (ok) passCount++; else failCount++;
}

for (const p of FUNCTIONAL) run('functional', 'functional', p);
for (const p of REGRESSION) run('regression', 'regression', p);
if (process.env.NIMBUS_X5F_E2E === '1') {
  for (const p of E2E) run('e2e', 'e2e', p);
} else {
  log('');
  log('!! e2e SKIPPED (set NIMBUS_X5F_E2E=1 to enable; needs wrangler dev at BASE)');
}

log('');
log('=========================================');
log('SUMMARY:');
for (const r of results) {
  log('  ' + (r.ok ? 'PASS' : 'FAIL') + '  ' + r.label + '/' + r.probe + ' (' + r.elapsed + 'ms)');
}
log('-----------------------------------------');
log('total ' + (passCount + failCount) + ', pass ' + passCount + ', fail ' + failCount);
process.exit(failCount === 0 ? 0 : 1);
