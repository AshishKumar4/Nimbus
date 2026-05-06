#!/usr/bin/env bun
// X.5-drizzle regression: cross-wave run-all sanity sweep.
// Drives every prior X.5-* run-all (and the W6+ wave run-alls that are
// part of the cross-wave invariant set per X5M3-retro AUDIT summary,
// extended with x5s + x526b which merged after that summary was written).
//
// Asserts: each run-all exits 0 modulo known pre-existing rejects.
//
// Known pre-existing failures (NOT regressions introduced by X.5-drizzle):
//   - audit/probes/x5z5-build/run-all.mjs: per x5z5-build-retro,
//     known-rejected (tailwindcss-vite native-binding gap; rolled up
//     under X.5-26b's lightningcss REJECT once 26b shipped). Whitelisted
//     to fail-allowed below.
//   - run-alls that require a live BASE/wrangler skip e2e cleanly when
//     BASE is unset; non-e2e portions still run pure-data.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, summary } from '../../w11/_tap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..', '..');

const RUN_ALLS = [
  'audit/probes/w3/run-all.mjs',
  'audit/probes/w3.5/run-all.mjs',
  'audit/probes/w4/run-all.mjs',
  'audit/probes/w5/run-all.mjs',
  'audit/probes/w6/run-all.mjs',
  // X.5 family — 13 buckets per VERIFY-9D4B61D §1
  'audit/probes/x5c/run-all.mjs',
  'audit/probes/x5f/run-all.mjs',
  'audit/probes/x5g/run-all.mjs',
  'audit/probes/x5j/run-all.mjs',
  'audit/probes/x5l/run-all.mjs',
  'audit/probes/x5m/run-all.mjs',
  'audit/probes/x5m3/run-all.mjs',
  'audit/probes/x5npqo/run-all.mjs',
  'audit/probes/x5r/run-all.mjs',
  'audit/probes/x5s/run-all.mjs',
  'audit/probes/x5z3/run-all.mjs',
  'audit/probes/x5z5-build/run-all.mjs', // known-rejected per retro; whitelisted
  'audit/probes/x526b/run-all.mjs',
];

const KNOWN_FAIL_ALLOWED = new Set([
  'audit/probes/x5z5-build/run-all.mjs', // retro-documented; not introduced by us
]);

let passed = 0;
let failed = 0;
let allowed = 0;
const fails = [];

for (const rel of RUN_ALLS) {
  const full = path.join(REPO, rel);
  if (!fs.existsSync(full)) {
    console.log(`SKIP (missing)  ${rel}`);
    continue;
  }
  const t0 = Date.now();
  const r = spawnSync('bun', [full, '--no-e2e'], {
    encoding: 'utf8',
    cwd: REPO,
    timeout: 240_000,
    env: { ...process.env, BASE: '' }, // force e2e skip in run-alls that branch on BASE
  });
  const dt = Date.now() - t0;
  const exit = r.status ?? 1;
  if (exit === 0) {
    passed++;
    console.log(`PASS  ${rel}  (${dt}ms)`);
  } else if (KNOWN_FAIL_ALLOWED.has(rel)) {
    allowed++;
    console.log(`ALLOWED-FAIL  ${rel}  exit=${exit} (${dt}ms) — pre-existing per retro`);
  } else {
    failed++;
    fails.push(rel);
    console.log(`FAIL  ${rel}  exit=${exit} (${dt}ms)`);
    const stdout = (r.stdout || '').slice(-2000);
    const stderr = (r.stderr || '').slice(-2000);
    if (stdout.trim()) console.log(`  stdout (last 2KB):\n${stdout}`);
    if (stderr.trim()) console.log(`  stderr (last 2KB):\n${stderr}`);
  }
}

console.log('');
console.log(`Summary: ${passed} pass / ${failed} new-fail / ${allowed} allowed-fail`);
ok(`prior-x5-runalls (excl. ${KNOWN_FAIL_ALLOWED.size} known)`, failed === 0,
   failed === 0 ? '' : `new failures: ${fails.join(', ')}`);
await summary('x5-drizzle/regression/prior-x5-runalls-shim');
