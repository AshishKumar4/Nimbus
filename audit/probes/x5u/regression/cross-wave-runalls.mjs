#!/usr/bin/env bun
// X.5-U regression: cross-wave run-all sanity sweep. Same shape as
// x5t/regression/cross-wave-runalls.mjs but extended to include
// x5-drizzle (X.5-drizzle merged before X.5-U). The dispatch's explicit
// set: "ALL prior X.5 probes (J/L/M/NPQO/Z5/R/Z3/M3/S/26b/peer-gap/T/drizzle)".
//
// Asserts: each run-all exits 0. Pre-existing known failures (per
// X5Z5-build-retro / X5M3-retro) are documented per-row.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, summary } from '../../w6/_tap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..', '..');

const RUN_ALLS = [
  { rel: 'audit/probes/x5j/run-all.mjs',          args: [] },
  { rel: 'audit/probes/x5l/run-all.mjs',          args: [] },
  { rel: 'audit/probes/x5m/run-all.mjs',          args: [] },
  { rel: 'audit/probes/x5npqo/run-all.mjs',       args: [] },
  { rel: 'audit/probes/x5z5-build/run-all.mjs',   args: [] }, // pre-existing FAIL
  { rel: 'audit/probes/x5r/run-all.mjs',          args: [] },
  { rel: 'audit/probes/x5z3/run-all.mjs',         args: [] },
  { rel: 'audit/probes/x5m3/run-all.mjs',         args: [] },
  { rel: 'audit/probes/x5s/run-all.mjs',          args: [] },
  { rel: 'audit/probes/x526b/run-all.mjs',        args: ['--no-e2e'] },
  { rel: 'audit/probes/x5t/run-all.mjs',          args: ['--no-e2e'] },
  { rel: 'audit/probes/x5-drizzle/run-all.mjs',   args: [] },
];

// Pre-existing failures NOT introduced by X.5-U. Per X5Z5-build-retro §3:
// x5z5-build's tailwindcss-vite e2e fails on lightningcss native binding
// (downstream — out of Z5 scope).
const KNOWN_FAILS = new Set([
  'audit/probes/x5z5-build/run-all.mjs',
]);

let passed = 0;
let failed = 0;
let knownFailed = 0;
const fails = [];

for (const { rel, args } of RUN_ALLS) {
  const full = path.join(REPO, rel);
  if (!fs.existsSync(full)) {
    console.log(`SKIP (missing) ${rel}`);
    continue;
  }
  const t0 = Date.now();
  const r = spawnSync('bun', [full, ...args], {
    encoding: 'utf8',
    cwd: REPO,
    timeout: 240_000,
  });
  const dt = Date.now() - t0;
  const exit = r.status ?? 1;
  if (exit === 0) {
    passed++;
    console.log(`PASS  ${rel}  (${dt}ms)`);
  } else if (KNOWN_FAILS.has(rel)) {
    knownFailed++;
    console.log(`KNOWN-FAIL  ${rel}  exit=${exit} (${dt}ms) — pre-existing per X5Z5-build-retro`);
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
console.log(`# new pass: ${passed}, known-fail (pre-existing): ${knownFailed}, NEW fail: ${failed}`);
ok(`cross-wave-runalls: ${passed} pass + ${knownFailed} known-fail; 0 NEW regressions`,
  failed === 0,
  failed === 0 ? '' : `${failed} NEW fail: ${fails.join(', ')}`);
summary('x5u cross-wave-runalls');
