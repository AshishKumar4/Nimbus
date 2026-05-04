// W4 run-all driver — runs functional → regression → e2e probes in order.
// Writes summary to audit/probes/w4/results-build.txt
//
// Skips e2e + prod-hitting regression probes by default (run with --full).
// During Phase B (TDD red), only functional probes are expected to fail
// against pre-impl source; the run-all reports those failures in the
// expected-fail bucket.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const RESULTS = path.join(HERE, 'results-build.txt');

const args = process.argv.slice(2);
const fullMode = args.includes('--full');
const phaseTag = (args.find((a) => a.startsWith('--phase=')) || '--phase=unspecified').slice(8);

fs.writeFileSync(RESULTS, '');
const log = (s) => { fs.appendFileSync(RESULTS, s + '\n'); console.log(s); };

log('==== W4 run-all ====');
log('==== TIMESTAMP: ' + new Date().toISOString() + ' ====');
log('==== PHASE: ' + phaseTag + ' ====');
log('==== MODE: ' + (fullMode ? 'full (incl. e2e + prod)' : 'fast (functional only)') + ' ====');

const probes = [
  // Functional — pure source / static checks; safe to run anywhere.
  { tier: 'functional', file: 'functional/r2-cache-keys.mjs' },
  { tier: 'functional', file: 'functional/r2-cache-expire.mjs' },
  { tier: 'functional', file: 'functional/r2-cache-invalidate.mjs' },
  { tier: 'functional', file: 'functional/packument-cache.mjs' },
  { tier: 'functional', file: 'functional/tarball-cache.mjs' },
  { tier: 'functional', file: 'functional/pipelining-ordering.mjs' },
  // Regression — re-runs existing probes; require deployed prod.
  { tier: 'regression', file: 'regression/install-pipeline-coverage-rerun.mjs', needsProd: true },
  { tier: 'regression', file: 'regression/wave1-contract-rerun.mjs', needsProd: true },
  { tier: 'regression', file: 'regression/mossaic-cold-install.mjs', needsProd: true },
  // E2E — long-running, prod-hitting, multi-session.
  { tier: 'e2e', file: 'e2e/mossaic-cold-warm.mjs', needsProd: true },
  // Functional — hits prod for diag fields; skip in fast mode.
  { tier: 'functional', file: 'functional/r2-cache-hit-miss.mjs', needsProd: true },
];

const summary = [];
for (const p of probes) {
  if (p.needsProd && !fullMode) {
    log('SKIP (' + p.tier + '): ' + p.file + ' [requires --full]');
    summary.push({ ...p, status: 'SKIP', exit: -1, ms: 0 });
    continue;
  }
  log('');
  log('---- ' + p.tier + ': ' + p.file + ' ----');
  const t0 = Date.now();
  const r = spawnSync('bun', [path.join(HERE, p.file)], {
    cwd: ROOT,
    stdio: 'inherit',
    timeout: p.tier === 'e2e' ? 30 * 60_000 : 10 * 60_000,
  });
  const ms = Date.now() - t0;
  const status = r.status === 0 ? 'PASS' : 'FAIL';
  log('  → ' + status + ' (exit=' + r.status + ', ms=' + ms + ')');
  summary.push({ ...p, status, exit: r.status, ms });
}

log('');
log('==== Summary ====');
for (const s of summary) {
  log('  [' + s.status + '] ' + s.tier + '/' + s.file + (s.status === 'PASS' || s.status === 'FAIL' ? ' (' + s.ms + 'ms)' : ''));
}

const ranProbes = summary.filter((s) => s.status !== 'SKIP');
const passes = ranProbes.filter((s) => s.status === 'PASS').length;
const fails = ranProbes.filter((s) => s.status === 'FAIL').length;
log('');
log('Ran ' + ranProbes.length + ' probes: ' + passes + ' pass, ' + fails + ' fail.');
log(phaseTag === 'B-tdd-red'
  ? 'Phase B expectation: ALL functional probes FAIL (TDD red). 0 passes is the goal.'
  : 'Phase D expectation: ALL probes PASS. Failures are bugs.');

process.exit(fails === 0 ? 0 : 1);
