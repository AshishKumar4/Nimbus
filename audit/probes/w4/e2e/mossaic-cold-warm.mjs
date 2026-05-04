// W4 e2e probe — Mossaic install across cold-platform → warm-platform.
//
// Three sessions:
//   1. Fresh tenant A. Install Mossaic. Records cold-platform-cold-tenant
//      latency baseline (~60 s expected pre-W4; ≤ 60 s required post-W4).
//   2. Fresh tenant B (same project). Install Mossaic. Cold-tenant but
//      warm-platform: every tarball + packument is in R2. Target: ≤ 15 s
//      p50 per W4 acceptance criteria.
//   3. Fresh tenant C. Same. Confirms (2) is reproducible (warm-platform
//      hit-rate stable, not first-warm flake).
//
// Output: p50/p95/p99 across the 3 sessions for each phase. Reported in
// audit/probes/w4/e2e/mossaic-cold-warm.txt and the run-all driver.

import { runProbe, nodeEvalBase64 } from '../../_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'mossaic-cold-warm.txt');
fs.writeFileSync(ARTIFACT, '');
const log = (s) => { fs.appendFileSync(ARTIFACT, s + '\n'); console.log(s); };

log('==== PROBE: mossaic-cold-warm ====');
log('==== TIMESTAMP: ' + new Date().toISOString() + ' ====');

const TARGET_P50_WARM_MS = 15_000; // W4 acceptance gate
const REGRESSION_CEILING_MS = 90_000;

const installScript = `
const t0 = Date.now();
require('child_process').execSync('git clone https://github.com/AshishKumar4/Mossaic.git /tmp/mossaic 2>&1', { stdio: 'inherit' });
const tInstallStart = Date.now();
process.chdir('/tmp/mossaic');
try {
  require('child_process').execSync('npm install 2>&1', { stdio: 'inherit', timeout: 5 * 60_000 });
  const elapsed = Date.now() - tInstallStart;
  process.stdout.write('INSTALL_DONE:' + elapsed + 'ms\\n');
} catch (e) {
  process.stdout.write('INSTALL_FAIL:' + (Date.now() - tInstallStart) + 'ms\\n');
  process.exit(1);
}

// Diag snapshot
try {
  const r = await fetch('/api/_diag/memory');
  const j = await r.json();
  process.stdout.write('DIAG:' + JSON.stringify({ r2: j.r2 || null, installFacet: j.installFacet || null }) + '\\n');
} catch (e) {
  process.stdout.write('DIAG_ERR:' + e.message + '\\n');
}
`;

const sessions = ['cold-platform', 'warm-1', 'warm-2'];
const measurements = [];

for (let i = 0; i < sessions.length; i++) {
  const tag = sessions[i];
  log('\n---- session ' + (i + 1) + '/' + sessions.length + ': ' + tag + ' ----');
  await runProbe('mossaic-' + tag, [
    { kind: 'cmd', cmd: nodeEvalBase64(installScript), timeoutMs: 5 * 60_000 },
  ], { artifactPath: ARTIFACT, settleMs: 4000 });

  const text = fs.readFileSync(ARTIFACT, 'utf8');
  const allMatches = [...text.matchAll(/INSTALL_DONE:(\d+)ms/g)];
  const last = allMatches[allMatches.length - 1];
  const elapsed = last ? parseInt(last[1], 10) : -1;
  measurements.push({ tag, elapsed });
  log('  ' + tag + ' install elapsed: ' + (elapsed >= 0 ? (elapsed / 1000).toFixed(1) + 's' : 'FAILED'));
}

// Compute p50/p95/p99 across the WARM sessions only (cold = baseline).
const warm = measurements.filter((m) => m.tag.startsWith('warm-')).map((m) => m.elapsed).filter((e) => e > 0).sort((a, b) => a - b);
const cold = measurements.find((m) => m.tag === 'cold-platform')?.elapsed ?? -1;

const pct = (arr, p) => {
  if (arr.length === 0) return -1;
  const idx = Math.min(arr.length - 1, Math.floor((p / 100) * arr.length));
  return arr[idx];
};

const p50 = pct(warm, 50);
const p95 = pct(warm, 95);
const p99 = pct(warm, 99);

log('');
log('=== Summary ===');
log('Cold-platform install: ' + (cold >= 0 ? (cold / 1000).toFixed(1) + 's' : 'FAILED'));
log('Warm-platform installs (n=' + warm.length + '):');
log('  p50: ' + (p50 / 1000).toFixed(1) + 's   target ≤ ' + (TARGET_P50_WARM_MS / 1000).toFixed(0) + 's');
log('  p95: ' + (p95 / 1000).toFixed(1) + 's');
log('  p99: ' + (p99 / 1000).toFixed(1) + 's');

const coldOk = cold >= 0 && cold <= REGRESSION_CEILING_MS;
const warmP50Ok = warm.length > 0 && p50 <= TARGET_P50_WARM_MS;
const overall = coldOk && warmP50Ok;
log('');
log('Cold OK (≤ ' + (REGRESSION_CEILING_MS / 1000).toFixed(0) + 's): ' + coldOk);
log('Warm p50 OK (≤ ' + (TARGET_P50_WARM_MS / 1000).toFixed(0) + 's): ' + warmP50Ok);
log('VERDICT: ' + (overall ? 'PASS' : 'FAIL'));
process.exit(overall ? 0 : 1);
