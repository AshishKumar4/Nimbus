#!/usr/bin/env bun
// X.5-NPQO run-all: functional + regression always; e2e when BASE is set.
// Writes summary to audit/probes/x5npqo/run-all.txt.
//
// Usage:
//   bun audit/probes/x5npqo/run-all.mjs                              # functional+regression
//   BASE=http://127.0.0.1:8788 bun audit/probes/x5npqo/run-all.mjs   # add e2e

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'run-all.txt');
fs.writeFileSync(OUT, `==== X5NPQO RUN-ALL ====\n==== ${new Date().toISOString()} ====\n\n`);
const log = (s) => { fs.appendFileSync(OUT, s + '\n'); console.log(s); };

function run(label, cmd, args, env = {}) {
  log(`==== ${label} ====`);
  log(`$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { encoding: 'utf8', env: { ...process.env, ...env }, cwd: path.resolve(HERE, '..', '..', '..') });
  log(r.stdout || '');
  if (r.stderr) log('STDERR: ' + r.stderr);
  log(`EXIT=${r.status}`);
  log('');
  return r.status === 0;
}

const FUNCTIONAL = [
  { label: 'P functional', file: 'audit/probes/x5npqo/functional/p-parent-dir.mjs' },
  { label: 'Q functional', file: 'audit/probes/x5npqo/functional/q-util-types.mjs' },
  { label: 'O functional', file: 'audit/probes/x5npqo/functional/o-fs-url.mjs' },
];

const REGRESSION = [
  { label: 'single-resolver-source', file: 'audit/probes/x5npqo/regression/single-resolver-source.mjs' },
  { label: 'install-pipeline-coverage-shim', file: 'audit/probes/x5npqo/regression/install-pipeline-coverage-shim.mjs' },
  { label: 'builtins-coverage', file: 'audit/probes/x5npqo/regression/builtins-coverage.mjs' },
];

const E2E = [
  { label: 'fastify e2e', file: 'audit/probes/x5npqo/e2e/fastify.mjs' },
  { label: 'redis e2e',   file: 'audit/probes/x5npqo/e2e/redis.mjs' },
  { label: 'jsdom e2e',   file: 'audit/probes/x5npqo/e2e/jsdom.mjs' },
  { label: 'vite e2e',    file: 'audit/probes/x5npqo/e2e/vite.mjs' },
];

const results = {};

for (const t of FUNCTIONAL.concat(REGRESSION)) {
  results[t.label] = run(t.label, 'bun', [t.file]);
}

if (process.env.BASE) {
  log(`==== E2E enabled (BASE=${process.env.BASE}) ====`);
  for (const t of E2E) {
    results[t.label] = run(t.label, 'bun', [t.file], { BASE: process.env.BASE });
  }
} else {
  log(`==== E2E SKIPPED (no BASE env) ====`);
}

log('==== SUMMARY ====');
let allOk = true;
for (const [k, v] of Object.entries(results)) {
  log(`  ${v ? 'PASS' : 'FAIL'}  ${k}`);
  if (!v) allOk = false;
}
log(`\nOVERALL: ${allOk ? 'PASS' : 'FAIL'}`);
process.exit(allOk ? 0 : 1);
