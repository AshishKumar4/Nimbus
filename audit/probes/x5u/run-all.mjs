#!/usr/bin/env bun
// X.5-U run-all: functional + regression + e2e.
//
// Usage:
//   BASE=http://127.0.0.1:8791 bun audit/probes/x5u/run-all.mjs
//   bun audit/probes/x5u/run-all.mjs --no-e2e        (skip e2e)

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const OUT = path.join(HERE, 'run-all.txt');
fs.writeFileSync(OUT, `==== X5U RUN-ALL ====\n==== ${new Date().toISOString()} ====\n\n`);
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
  { label: 'f1-dotfile-prefetch', file: 'audit/probes/x5u/functional/f1-dotfile-prefetch.mjs' },
  { label: 'f2-tsjest-shape',     file: 'audit/probes/x5u/functional/f2-tsjest-shape.mjs' },
];

const REGRESSION = [
  { label: 'r1-no-overshoot',                 file: 'audit/probes/x5u/regression/r1-no-overshoot.mjs' },
  { label: 'r2-budget-respected',             file: 'audit/probes/x5u/regression/r2-budget-respected.mjs' },
  { label: 'r3-z3-untouched',                 file: 'audit/probes/x5u/regression/r3-z3-untouched.mjs' },
  { label: 'single-resolver-source',          file: 'audit/probes/x5u/regression/single-resolver-source.mjs' },
  { label: 'install-pipeline-coverage-shim',  file: 'audit/probes/x5u/regression/install-pipeline-coverage-shim.mjs' },
];

const E2E = [
  { label: 'ts-jest-digest-readable', file: 'audit/probes/x5u/e2e/ts-jest-digest-readable.mjs', opts: { timeout: 240_000 } },
];

const skipE2E = process.argv.includes('--no-e2e') || !process.env.BASE;

let pass = 0, fail = 0;
log('==== FUNCTIONAL ====');
for (const t of FUNCTIONAL) (run(t.label, t.file, t.opts) ? pass++ : fail++);
log('==== REGRESSION ====');
for (const t of REGRESSION) (run(t.label, t.file, t.opts) ? pass++ : fail++);
if (!skipE2E) {
  log('==== E2E ====');
  for (const t of E2E) (run(t.label, t.file, t.opts) ? pass++ : fail++);
} else {
  log('(skipping E2E — no BASE / --no-e2e)');
}

log('');
log(`==== SUMMARY: ${pass} pass / ${fail} fail ====`);
process.exit(fail === 0 ? 0 : 1);
