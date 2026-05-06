#!/usr/bin/env bun
// X.5-26b regression: cross-wave run-all sanity sweep.
// Drives every prior X.5-* run-all (and the W6+ wave run-alls that are
// still part of the cross-wave invariant set per X5M3-retro AUDIT
// summary).
//
// Asserts: each run-all exits 0 (or known pre-existing fail per
// X5M3-retro is logged but not counted as new regression).
//
// Pre-existing known reject (NOT a regression introduced by X.5-26b):
//   - x5z5-build/run-all: tlw-vite/lightningcss native-binding gap (per
//     x5z5-build-retro). With X.5-26b's lightningcss REJECT_INSTALL add,
//     this may flip to fully passing — verified in audit.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, summary } from '../../w6/_tap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..', '..');

// X.5 + W wave run-alls per X5M3-retro AUDIT summary's "cross-wave-x5-runalls".
// Listed in commit-order (oldest to newest).
const RUN_ALLS = [
  // Note: w1 has no run-all; covered by mossaic + w2/w3 cascade.
  'audit/probes/w3/run-all.mjs',
  'audit/probes/w3.5/run-all.mjs',
  'audit/probes/w4/run-all.mjs',
  'audit/probes/w5/run-all.mjs',
  'audit/probes/w6/run-all.mjs',
  // X.5 family
  'audit/probes/x5c/run-all.mjs',
  'audit/probes/x5f/run-all.mjs',
  'audit/probes/x5g/run-all.mjs',
  'audit/probes/x5j/run-all.mjs',
  'audit/probes/x5l/run-all.mjs',
  'audit/probes/x5m/run-all.mjs',
  'audit/probes/x5npqo/run-all.mjs',
  'audit/probes/x5r/run-all.mjs',
  'audit/probes/x5z3/run-all.mjs',
  'audit/probes/x5z5-build/run-all.mjs',
  'audit/probes/x5m3/run-all.mjs',
];

let passed = 0;
let failed = 0;
const fails = [];

for (const rel of RUN_ALLS) {
  const full = path.join(REPO, rel);
  if (!fs.existsSync(full)) {
    console.log(`SKIP (missing) ${rel}`);
    continue;
  }
  const t0 = Date.now();
  const r = spawnSync('bun', [full], {
    encoding: 'utf8',
    cwd: REPO,
    timeout: 240_000,
  });
  const dt = Date.now() - t0;
  const exit = r.status ?? 1;
  if (exit === 0) {
    passed++;
    console.log(`PASS  ${rel}  (${dt}ms)`);
  } else {
    failed++;
    fails.push(rel);
    console.log(`FAIL  ${rel}  exit=${exit} (${dt}ms)`);
    // Tail on fail for triage.
    const stdout = (r.stdout || '').slice(-2000);
    const stderr = (r.stderr || '').slice(-2000);
    if (stdout.trim()) console.log(`  stdout (last 2KB):\n${stdout}`);
    if (stderr.trim()) console.log(`  stderr (last 2KB):\n${stderr}`);
  }
}

console.log('');
ok(`cross-wave-runalls: ${passed}/${passed + failed} pass`, failed === 0,
  failed === 0 ? '' : `${failed} fail: ${fails.join(', ')}`);
summary('x526b cross-wave-runalls');
