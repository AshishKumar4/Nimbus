#!/usr/bin/env bun
// X.5-S run-all — exercises every x5s probe + cross-wave guards.
// Functional + regression run unconditionally (Node-side, no wrangler).
// E2E gated on NIMBUS_X5S_E2E=1.
// Heavy cross-wave (mossaic + w1) gated on NIMBUS_X5S_HEAVY=1.

import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');

const local = [
  'functional/f1-conditional-param-drop-marker.mjs',
  'functional/f2-eval-no-collision.mjs',
  'functional/f3-clean-body-still-binds-dirname.mjs',
  'investigation/repro.mjs',
  'regression/install-pipeline-coverage-shim.mjs',
  'regression/single-resolver-source.mjs',
  'regression/cross-wave-x5-runalls.mjs',
];

const e2eList = [
  'e2e/e1-vite-loads.mjs',
];

const heavy = [
  ['../run-mossaic-prod-w2.mjs',    'NIMBUS_X5S_HEAVY'],
  ['../x5r/regression/r-w1.mjs',    'NIMBUS_X5S_HEAVY'],
];

const runE2E   = process.env.NIMBUS_X5S_E2E === '1';
const runHeavy = process.env.NIMBUS_X5S_HEAVY === '1';

const results = [];

function run(rel, label) {
  const abs = path.resolve(HERE, rel);
  const r = spawnSync('bun', [abs], {
    cwd: ROOT,
    env: { ...process.env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const ok = r.status === 0;
  results.push({ label: label || rel, ok, out });
  process.stdout.write(`[${ok ? 'PASS' : 'FAIL'}] ${label || rel}\n`);
  if (!ok) process.stdout.write(out.split('\n').slice(-30).map(l => '    ' + l).join('\n') + '\n');
}

console.log('── X.5-S functional + regression ──────────────────────────');
for (const f of local) run(f);

if (runHeavy) {
  console.log('── heavy regressions ──────────────────────────────────────');
  for (const [f] of heavy) run(f);
} else {
  console.log('── heavy regressions skipped (NIMBUS_X5S_HEAVY=1 to run)');
}

if (runE2E) {
  console.log('── e2e (NIMBUS_X5S_E2E=1) ─────────────────────────────────');
  for (const f of e2eList) run(f);
} else {
  console.log('── e2e skipped (NIMBUS_X5S_E2E=1 to run; BASE=http://127.0.0.1:8787 required)');
}

const pass = results.filter(r => r.ok).length;
const fail = results.filter(r => !r.ok).length;
console.log('');
console.log(`──── x5s run-all: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
