#!/usr/bin/env bun
// X5M run-all: run functional + regression probes (always), and e2e probes
// when BASE is set. Writes a summary to audit/probes/x5m/run-all.txt.
//
// Usage:
//   bun audit/probes/x5m/run-all.mjs                              # functional+regression only
//   BASE=http://127.0.0.1:8788 bun audit/probes/x5m/run-all.mjs   # add e2e

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'run-all.txt');
fs.writeFileSync(OUT, `==== X5M RUN-ALL ====\n==== ${new Date().toISOString()} ====\n\n`);
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
  { label: 'M-1 functional', file: 'audit/probes/x5m/functional/m1-http-server-setTimeout.mjs' },
  { label: 'M-2 functional', file: 'audit/probes/x5m/functional/m2-dns-promises-subpath.mjs' },
  { label: 'M-3 functional', file: 'audit/probes/x5m/functional/m3-url-lenient-null-base.mjs' },
];

const REGRESSION = [
  { label: 'single-resolver-source', file: 'audit/probes/x5m/regression/single-resolver-source.mjs' },
  { label: 'install-pipeline-coverage-shim', file: 'audit/probes/x5m/regression/install-pipeline-coverage-shim.mjs' },
  { label: 'builtins-coverage', file: 'audit/probes/x5m/regression/builtins-coverage.mjs' },
];

const E2E = [
  { label: 'fastify e2e', file: 'audit/probes/x5m/e2e/fastify.mjs' },
  { label: 'redis e2e', file: 'audit/probes/x5m/e2e/redis.mjs' },
  { label: 'vite e2e (charter-pass acceptable)', file: 'audit/probes/x5m/e2e/vite.mjs' },
];

const results = {};

for (const t of FUNCTIONAL.concat(REGRESSION)) {
  results[t.label] = run(t.label, 'bun', [t.file]);
}

if (process.env.BASE) {
  for (const t of E2E) {
    results[t.label] = run(t.label, 'bun', [t.file], { BASE: process.env.BASE });
  }
} else {
  log('### Skipping E2E (set BASE=http://... to enable) ###');
}

log('');
log('==== SUMMARY ====');
let allOk = true;
for (const [label, ok] of Object.entries(results)) {
  log(`  ${ok ? '✓' : '✗'}  ${label}`);
  if (!ok) allOk = false;
}
log(allOk ? '## ALL OK' : '## FAIL');
process.exit(allOk ? 0 : 1);
