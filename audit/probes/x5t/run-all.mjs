#!/usr/bin/env bun
// X.5-T run-all: functional + regression + e2e.
//
// Usage:
//   BASE=http://127.0.0.1:8790 bun audit/probes/x5t/run-all.mjs
//   bun audit/probes/x5t/run-all.mjs --no-e2e        (skip e2e)

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const OUT = path.join(HERE, 'run-all.txt');
fs.writeFileSync(OUT, `==== X5T RUN-ALL ====\n==== ${new Date().toISOString()} ====\n\n`);
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
  { label: 'realpath-native-defined', file: 'audit/probes/x5t/functional/realpath-native-defined.mjs' },
];

const REGRESSION = [
  { label: 'single-resolver-source',          file: 'audit/probes/x5t/regression/single-resolver-source.mjs' },
  { label: 'install-pipeline-coverage-shim',  file: 'audit/probes/x5t/regression/install-pipeline-coverage-shim.mjs' },
  // cross-wave-runalls is heavy (~10 minutes); included but separately gated
];

const E2E = [
  { label: 'ts-jest real-install', file: 'audit/probes/x5t/e2e/ts-jest-real-install.mjs' },
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
    const ok = run(t.label, t.file, { timeout: 300_000 });
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
