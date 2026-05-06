#!/usr/bin/env bun
// X.5-M3 regression: every prior X.5 wave run-all must remain green
// (with previously-known pre-existing fails preserved but not new ones).
//
// Each run-all is its own gate. We invoke them sequentially and report
// per-suite verdict.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../../..');

// Per X5Z3-retro §6: x5z5-build has a pre-existing `tailwindcss-vite e2e`
// FAIL gated on a different fix class (lightningcss native binding —
// wasm-swap-registry territory, NOT M3's URL fix). It was FAIL at HEAD
// before X.5-M3 started, so we mark it expected-fail at the run-all level
// and gate on its presence rather than its overall exit code.
const suites = [
  { name: 'x5f',        path: 'audit/probes/x5f/run-all.mjs',        expectedExit: 0 },
  { name: 'x5g',        path: 'audit/probes/x5g/run-all.mjs',        expectedExit: 0 },
  { name: 'x5c',        path: 'audit/probes/x5c/run-all.mjs',        expectedExit: 0 },
  { name: 'x5j',        path: 'audit/probes/x5j/run-all.mjs',        expectedExit: 0 },
  { name: 'x5l',        path: 'audit/probes/x5l/run-all.mjs',        expectedExit: 0 },
  { name: 'x5m',        path: 'audit/probes/x5m/run-all.mjs',        expectedExit: 0 },
  { name: 'x5npqo',     path: 'audit/probes/x5npqo/run-all.mjs',     expectedExit: 0 },
  // Pre-existing tailwindcss-vite e2e fail (lightningcss); see
  // X5Z5-build-retro §1 + X5Z3-retro §6. Not an M3 regression.
  { name: 'x5z5-build', path: 'audit/probes/x5z5-build/run-all.mjs', expectedExit: 1, preExistingFails: ['tailwindcss-vite e2e'] },
  { name: 'x5r',        path: 'audit/probes/x5r/run-all.mjs',        expectedExit: 0 },
  { name: 'x5z3',       path: 'audit/probes/x5z3/run-all.mjs',       expectedExit: 0 },
];

let passed = 0, failed = 0;
const results = [];

// Strip BASE + NIMBUS_*_E2E so downstream run-alls only run their
// non-e2e gates. We are checking source-text + functional invariants
// here; e2e behavior is owned by each wave's own e2e suite (which we
// invoke separately from the x5m3 run-all driver). Without this scrub,
// X.5-NPQO triggers its full charter-pass-but-not-strict-✅ e2e battery
// (documented in X5NPQO-retro §"E2E observation") and the cross-wave
// probe would falsely fail.
const cleanEnv = { ...process.env };
delete cleanEnv.BASE;
for (const k of Object.keys(cleanEnv)) {
  if (/^NIMBUS_X5\w*_E2E$/.test(k)) delete cleanEnv[k];
  if (/^NIMBUS_X5\w*_HEAVY$/.test(k)) delete cleanEnv[k];
}

for (const s of suites) {
  const abs = path.resolve(repoRoot, s.path);
  const r = spawnSync('bun', [abs], { cwd: repoRoot, encoding: 'utf8', env: cleanEnv });
  const stdout = r.stdout || '';
  // A suite is OK if (a) it exits with the expected code AND (b) any
  // FAIL lines are limited to documented pre-existing failures.
  let ok_ = r.status === (s.expectedExit ?? 0);
  if (ok_ && s.preExistingFails) {
    const failLines = stdout.split('\n').filter(l => /^\s*FAIL\s+/i.test(l) || /\[FAIL\]/.test(l));
    for (const fl of failLines) {
      const isExpected = s.preExistingFails.some(p => fl.includes(p));
      if (!isExpected) {
        ok_ = false;
        results.push({ name: s.name, status: r.status, ok: false, unexpected: fl.trim() });
      }
    }
  }
  if (ok_) passed++; else failed++;
  if (!results.some(x => x.name === s.name)) {
    results.push({ ...s, status: r.status, ok: ok_, tailErr: (r.stderr || '').slice(-200), tailOut: stdout.slice(-400) });
  }
  console.log(`${ok_ ? 'OK ' : 'FAIL'} ${s.name} (exit ${r.status}${s.expectedExit !== 0 ? `, expected ${s.expectedExit}` : ''})`);
}

console.log('');
console.log(`# cross-wave-x5-runalls: ${passed} passed, ${failed} failed of ${suites.length}`);
if (failed > 0) {
  console.log('# failures:');
  for (const r of results) if (!r.ok) {
    console.log(`#   - ${r.name} (exit ${r.status})`);
    if (r.tailOut) console.log('     STDOUT-tail:', r.tailOut.replace(/\n/g, '\n      '));
    if (r.tailErr) console.log('     STDERR-tail:', r.tailErr.replace(/\n/g, '\n      '));
  }
  process.exit(1);
}
process.exit(0);
