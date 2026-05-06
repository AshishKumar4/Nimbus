#!/usr/bin/env bun
// X.5-26b run-all: functional + regression + e2e.
//
// Usage:
//   BASE=http://127.0.0.1:8789 bun audit/probes/x526b/run-all.mjs
//
// (BASE is only required for e2e; functional + regression are pure data.)

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const OUT = path.join(HERE, 'run-all.txt');
fs.writeFileSync(OUT, `==== X526B RUN-ALL ====\n==== ${new Date().toISOString()} ====\n\n`);
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
  { label: 'oxide-rejected',         file: 'audit/probes/x526b/functional/oxide-rejected.mjs' },
  { label: 'lightningcss-rejected',  file: 'audit/probes/x526b/functional/lightningcss-rejected.mjs' },
  { label: 'preamble-mirror-sync',   file: 'audit/probes/x526b/functional/preamble-mirror-sync.mjs' },
];

const REGRESSION = [
  { label: 'single-resolver-source',          file: 'audit/probes/x526b/regression/single-resolver-source.mjs' },
  { label: 'install-pipeline-coverage-shim',  file: 'audit/probes/x526b/regression/install-pipeline-coverage-shim.mjs' },
  // cross-wave-runalls is heavy (~10 minutes); included but separately gated
];

const E2E = [
  { label: 'oxide e2e',                       file: 'audit/probes/x526b/e2e/oxide-e2e.mjs' },
  { label: 'lightningcss e2e',                file: 'audit/probes/x526b/e2e/lightningcss-e2e.mjs' },
  { label: 'tailwindcss-vite transitive e2e', file: 'audit/probes/x526b/e2e/tailwindcss-vite-transitive-e2e.mjs' },
];

const skipE2E = process.argv.includes('--no-e2e') || !process.env.BASE;

let pass = 0;
let fail = 0;
const ran = [];
for (const t of [...FUNCTIONAL, ...REGRESSION]) {
  const ok = run(t.label, t.file);
  ran.push({ ...t, ok });
  ok ? pass++ : fail++;
}
if (!skipE2E) {
  for (const t of E2E) {
    const ok = run(t.label, t.file, { timeout: 240_000 });
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
