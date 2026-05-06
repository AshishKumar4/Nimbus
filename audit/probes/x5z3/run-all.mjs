#!/usr/bin/env bun
// X.5-Z3 run-all — exercises every x5z3 probe + cross-wave guards.
//
// Functional + regression run unconditionally (Node-side, no
// wrangler).
// E2E gated on NIMBUS_X5Z3_E2E=1 (matches X.5-R precedent).
// Heavy regression suites (mossaic, w1) gated on NIMBUS_X5Z3_HEAVY=1.

import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');

const local = [
  'functional/f1-readfilesync-asset.mjs',
  'functional/f2-asset-extensions.mjs',
  'functional/f3-skip-dynamic.mjs',
  'regression/r1-no-bundle-cap-blowup.mjs',
  'regression/r2-vfs-not-found.mjs',
  'regression/r3-existing-bundle-untouched.mjs',
];

const e2eList = [
  'e2e/e1-jsdom-loads.mjs',
  'e2e/e2-jsdom-window.mjs',
  'e2e/e3-tailwindcss-vite-pre-existing-fail.mjs',
];

const crossWave = [
  // X.5-R precedent: wrap the X.5-F install-pipeline-coverage-shim,
  // which is a non-WS Node-side shim that exercises the SAME install
  // pipeline check the live coverage probe runs but without depending
  // on wrangler dev OR on packages that have pre-existing W2.6b cap
  // issues (e.g. typescript / ts-jest).
  ['../x5f/regression/install-pipeline-coverage-shim.mjs', null],
  ['../x5f/regression/single-resolver-source.mjs', null],
];

const heavy = [
  ['../run-mossaic-prod-w2.mjs',    'NIMBUS_X5Z3_HEAVY'],
  ['../x5r/regression/r-w1.mjs',    'NIMBUS_X5Z3_HEAVY'],
];

const runE2E   = process.env.NIMBUS_X5Z3_E2E === '1';
const runHeavy = process.env.NIMBUS_X5Z3_HEAVY === '1';

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

console.log('── X.5-Z3 functional + regression ─────────────────────────');
for (const f of local) run(f);

console.log('── cross-wave guards ──────────────────────────────────────');
for (const [f, gate] of crossWave) {
  if (gate && process.env[gate] !== '1') {
    console.log(`[SKIP] ${f} (set ${gate}=1 to run)`);
    continue;
  }
  // Skip if file does not exist (probe layout has shifted across waves).
  try {
    const abs = path.resolve(HERE, f);
    const fs = await import('fs');
    if (!fs.existsSync(abs)) {
      console.log(`[SKIP] ${f} (not present at this branch tip)`);
      continue;
    }
  } catch {}
  run(f);
}

if (runHeavy) {
  console.log('── heavy regressions ──────────────────────────────────────');
  for (const [f, gate] of heavy) {
    run(f);
  }
} else {
  console.log('── heavy regressions skipped (NIMBUS_X5Z3_HEAVY=1 to run)');
}

if (runE2E) {
  console.log('── e2e (NIMBUS_X5Z3_E2E=1) ────────────────────────────────');
  for (const f of e2eList) run(f);
} else {
  console.log('── e2e skipped (NIMBUS_X5Z3_E2E=1 to run; BASE=http://127.0.0.1:8787 required)');
}

const pass = results.filter(r => r.ok).length;
const fail = results.filter(r => !r.ok).length;
console.log('');
console.log(`──── x5z3 run-all: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
