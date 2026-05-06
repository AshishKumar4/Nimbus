#!/usr/bin/env bun
// X.5-drizzle run-all: functional + regression + e2e.
//
// Usage:
//   bun audit/probes/x5-drizzle/run-all.mjs                  # functional + regression only
//   BASE=http://127.0.0.1:8789 bun audit/probes/x5-drizzle/run-all.mjs   # also e2e
//
// (BASE is only required for e2e; functional + regression are pure data.)

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const OUT = path.join(HERE, 'run-all.txt');
fs.writeFileSync(OUT, `==== X5-DRIZZLE RUN-ALL ====\n==== ${new Date().toISOString()} ====\n\n`);
const log = (s) => { fs.appendFileSync(OUT, s + '\n'); console.log(s); };

function run(label, file, opts = {}) {
  log(`==== ${label} ====`);
  log(`$ bun ${file}`);
  const r = spawnSync('bun', [file], {
    encoding: 'utf8',
    cwd: REPO,
    timeout: opts.timeout || 300_000,
    env: { ...process.env, ...(opts.env || {}) },
  });
  log(r.stdout || '');
  if (r.stderr) log('STDERR: ' + r.stderr);
  log(`EXIT=${r.status}\n`);
  return r.status === 0;
}

const FUNCTIONAL = [
  { label: 'detect-aware-on-starter',          file: 'audit/probes/x5-drizzle/functional/detect-aware-on-starter.mjs' },
  { label: 'detect-aware-preserves-frameworks', file: 'audit/probes/x5-drizzle/functional/detect-aware-preserves-frameworks.mjs' },
  { label: 'installer-detect-source-shape',    file: 'audit/probes/x5-drizzle/functional/installer-detect-source-shape.mjs' },
];

const REGRESSION = [
  { label: 'single-resolver-source',                  file: 'audit/probes/x5-drizzle/regression/single-resolver-source.mjs' },
  { label: 'install-pipeline-coverage-shim',          file: 'audit/probes/x5-drizzle/regression/install-pipeline-coverage-shim.mjs' },
  { label: 'w11-frameworks-still-detect',             file: 'audit/probes/x5-drizzle/regression/w11-frameworks-still-detect.mjs' },
  { label: 'w11-vite-generic-still-detects-as-vite',  file: 'audit/probes/x5-drizzle/regression/w11-vite-generic-still-detects-as-vite.mjs' },
  { label: 'mossaic-regression-coverage',             file: 'audit/probes/x5-drizzle/regression/mossaic-regression-coverage.mjs' },
  // prior-x5-runalls is heavy (~5 minutes); included but separately gated.
];

const HEAVY_REGRESSION = [
  { label: 'prior-x5-runalls-shim',  file: 'audit/probes/x5-drizzle/regression/prior-x5-runalls-shim.mjs' },
];

const E2E = [
  { label: 'drizzle-orm-installs',         file: 'audit/probes/x5-drizzle/e2e/drizzle-orm-installs.mjs' },
  { label: 'drizzle-orm-smoke',            file: 'audit/probes/x5-drizzle/e2e/drizzle-orm-smoke.mjs' },
  { label: 'drizzle-orm-no-vite-pulled',   file: 'audit/probes/x5-drizzle/e2e/drizzle-orm-no-vite-pulled.mjs' },
];

const skipE2E = process.argv.includes('--no-e2e') || !process.env.BASE;
const heavy = process.argv.includes('--heavy');

let pass = 0;
let fail = 0;
const ran = [];
for (const t of [...FUNCTIONAL, ...REGRESSION]) {
  const ok = run(t.label, t.file);
  ran.push({ ...t, ok });
  ok ? pass++ : fail++;
}
if (heavy) {
  for (const t of HEAVY_REGRESSION) {
    const ok = run(t.label, t.file, { timeout: 600_000 });
    ran.push({ ...t, ok });
    ok ? pass++ : fail++;
  }
}
if (!skipE2E) {
  for (const t of E2E) {
    const ok = run(t.label, t.file, { timeout: 360_000 });
    ran.push({ ...t, ok });
    ok ? pass++ : fail++;
  }
} else {
  log('==== SKIPPING E2E (BASE not set or --no-e2e flag) ====');
}

log('==== SUMMARY ====');
for (const t of ran) log(`  ${t.ok ? 'PASS' : 'FAIL'}  ${t.label}`);
log(`\nTotal: ${pass} pass, ${fail} fail (out of ${ran.length})`);
process.exit(fail === 0 ? 0 : 1);
