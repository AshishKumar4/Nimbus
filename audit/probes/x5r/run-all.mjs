#!/usr/bin/env bun
// X.5-R run-all — sequential driver across all probes.
//
// Default: functional + regression (3 + 4 = 7 probes). Fast, no
// wrangler dependency.
//
// E2E gated on NIMBUS_X5R_E2E=1 (requires live wrangler dev or prod
// at $BASE). +3 probes.
//
// Output: audit/probes/x5r/run-all.txt (raw transcript).

import { spawnSync } from 'child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'run-all.txt');
fs.writeFileSync(OUT, '');

const log = (s) => { fs.appendFileSync(OUT, s.endsWith('\n') ? s : s + '\n'); console.log(s); };

const probes = [
  { tier: 'functional', file: 'functional/r-stream-eventemitter-shape.mjs' },
  { tier: 'functional', file: 'functional/r-stream-prototype-still-pointed.mjs' },
  { tier: 'functional', file: 'functional/r-ee-lazy-init-still-works.mjs' },
  { tier: 'regression', file: 'regression/r-single-resolver-source.mjs' },
  { tier: 'regression', file: 'regression/r-install-pipeline-coverage.mjs' },
];
// Heavy regressions only on demand (mossaic+W1 take 3-5 min each):
if (process.env.NIMBUS_X5R_HEAVY === '1') {
  probes.push({ tier: 'regression', file: 'regression/r-mossaic.mjs' });
  probes.push({ tier: 'regression', file: 'regression/r-w1.mjs' });
}
if (process.env.NIMBUS_X5R_E2E === '1') {
  probes.push({ tier: 'e2e', file: 'e2e/r-cache-class-extends.mjs' });
  probes.push({ tier: 'e2e', file: 'e2e/r-redis-loads.mjs' });
  probes.push({ tier: 'e2e', file: 'e2e/r-fastify-still-loads.mjs' });
}

let passed = 0, failed = 0;
const fails = [];

for (const p of probes) {
  const abs = path.join(HERE, p.file);
  log('');
  log(`==== ${p.tier}: ${p.file} ====`);
  const start = Date.now();
  const r = spawnSync('bun', [abs],
    { encoding: 'utf8', env: { ...process.env }, timeout: 360_000 });
  const dur = Date.now() - start;
  log((r.stdout || '').trimEnd());
  if (r.stderr) log('STDERR: ' + r.stderr.trim());
  log(`---- ${p.file} exit=${r.status} dur=${dur}ms ----`);
  if (r.status === 0) passed++;
  else { failed++; fails.push(p.file); }
}

log('');
log('====================================================');
log(`x5r run-all: ${passed} passed, ${failed} failed of ${probes.length} probes`);
if (failed > 0) {
  log('Failures:');
  for (const f of fails) log(`  - ${f}`);
}
log('====================================================');
process.exit(failed === 0 ? 0 : 1);
