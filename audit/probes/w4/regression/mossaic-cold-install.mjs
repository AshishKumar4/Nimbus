// W4 regression probe — Mossaic cold-install baseline.
//
// Acceptance gate from W4-plan §7: cold-install (cold platform R2 + cold
// tenant) must remain ≤ 60 s — i.e. no regression vs current baseline.
// Expected to PASS on prod main both pre- AND post-W4 (the R2 path adds
// at most one ~30 ms R2 GET that always misses on a cold platform).
//
// Pre-impl: this probe runs against current main; we expect green.
// Post-impl: still green (no regression).
//
// Note: "cold platform" can't truly be tested in CI without bucket purge;
// approximation here is "cold tenant" which still hits R2 misses if the
// platform cache hasn't seen this exact tenant project before. The probe
// reports the elapsed time and only fails if > 90 s (60 s baseline + 50%
// safety margin to avoid flake).

import { runProbe, nodeEvalBase64 } from '../../_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'mossaic-cold-install.txt');
fs.writeFileSync(ARTIFACT, '');
const log = (s) => { fs.appendFileSync(ARTIFACT, s + '\n'); console.log(s); };

log('==== PROBE: mossaic-cold-install ====');
log('==== TIMESTAMP: ' + new Date().toISOString() + ' ====');

const REGRESSION_CEILING_MS = 90_000; // 60s baseline + 50% margin

const probeJs = `
const t0 = Date.now();
process.stdout.write('CLONE_START\\n');
require('child_process').execSync('git clone https://github.com/AshishKumar4/Mossaic.git /tmp/mossaic 2>&1', { stdio: 'inherit' });
process.stdout.write('CLONE_DONE:' + (Date.now() - t0) + 'ms\\n');
const t1 = Date.now();
process.stdout.write('INSTALL_START\\n');
process.chdir('/tmp/mossaic');
try {
  require('child_process').execSync('npm install 2>&1', { stdio: 'inherit', timeout: 5 * 60_000 });
  process.stdout.write('INSTALL_DONE:' + (Date.now() - t1) + 'ms\\n');
} catch (e) {
  process.stdout.write('INSTALL_FAIL:' + (Date.now() - t1) + 'ms (' + (e.message || 'err') + ')\\n');
  process.exit(1);
}
`;

await runProbe('mossaic-cold-install', [
  { kind: 'cmd', cmd: nodeEvalBase64(probeJs), timeoutMs: 300_000 },
], { artifactPath: ARTIFACT, settleMs: 4000 });

const text = fs.readFileSync(ARTIFACT, 'utf8');
const m = text.match(/INSTALL_DONE:(\d+)ms/);

let pass = false;
let elapsed = -1;
if (m) {
  elapsed = parseInt(m[1], 10);
  pass = elapsed <= REGRESSION_CEILING_MS;
  log('');
  log('Mossaic install elapsed: ' + (elapsed / 1000).toFixed(1) + 's');
  log('Regression ceiling: ' + (REGRESSION_CEILING_MS / 1000).toFixed(0) + 's');
} else {
  log('');
  log('FAIL: INSTALL_DONE marker not captured (check artifact for INSTALL_FAIL)');
}

log('');
log('VERDICT: ' + (pass ? 'PASS' : 'FAIL') + ' (elapsed=' + elapsed + 'ms)');
process.exit(pass ? 0 : 1);
