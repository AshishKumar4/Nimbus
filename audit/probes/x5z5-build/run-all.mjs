#!/usr/bin/env bun
// X.5-Z5 build wave run-all: functional + regression + e2e.
//
// Usage:
//   bun audit/probes/x5z5-build/run-all.mjs

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'run-all.txt');
fs.writeFileSync(OUT, `==== X5Z5-BUILD RUN-ALL ====\n==== ${new Date().toISOString()} ====\n\n`);
const log = (s) => { fs.appendFileSync(OUT, s + '\n'); console.log(s); };

function run(label, file) {
  log(`==== ${label} ====`);
  log(`$ bun ${file}`);
  const r = spawnSync('bun', [file], {
    encoding: 'utf8',
    cwd: path.resolve(HERE, '..', '..', '..'),
    timeout: 240_000,
  });
  log(r.stdout || '');
  if (r.stderr) log('STDERR: ' + r.stderr);
  log(`EXIT=${r.status}\n`);
  return r.status === 0;
}

const FUNCTIONAL = [
  // express §1 — Defect-A + Defect-B + EE-shim mixin lazy-init follow-on.
  { label: 'express-stream-prototype', file: 'audit/probes/x5z5-build/functional/e-express-stream-prototype.mjs' },
  { label: 'express-inherits-guard',   file: 'audit/probes/x5z5-build/functional/e-express-inherits-guard.mjs' },
  { label: 'events-shim-lazy-init',    file: 'audit/probes/x5z5-build/functional/e-events-shim-lazy-init.mjs' },
  // tailwindcss-vite §3 — looksLikeEsm + prefetch walker + v8 stub follow-ons.
  { label: 'tailwindcss-vite-looksLikeEsm',     file: 'audit/probes/x5z5-build/functional/v-tailwindcss-vite-looks-like-esm.mjs' },
  { label: 'tailwindcss-vite-prefetch-walker',  file: 'audit/probes/x5z5-build/functional/v-tailwindcss-vite-prefetch-walker.mjs' },
  { label: 'v8-shim-stub',                       file: 'audit/probes/x5z5-build/functional/v-v8-shim-stub.mjs' },
];

const REGRESSION = [
  { label: 'single-resolver-source', file: 'audit/probes/x5z5-build/regression/single-resolver-source.mjs' },
  { label: 'install-pipeline-coverage-shim', file: 'audit/probes/x5z5-build/regression/install-pipeline-coverage-shim.mjs' },
  { label: 'builtins-coverage', file: 'audit/probes/x5z5-build/regression/builtins-coverage.mjs' },
];

const E2E = [
  { label: 'express e2e',          file: 'audit/probes/x5z5-build/e2e/express.mjs' },
  { label: 'tailwindcss-vite e2e', file: 'audit/probes/x5z5-build/e2e/tailwindcss-vite.mjs' },
];

const results = {};
for (const t of FUNCTIONAL.concat(REGRESSION, E2E)) {
  results[t.label] = run(t.label, t.file);
}

log('==== SUMMARY ====');
let allOk = true;
for (const [k, v] of Object.entries(results)) {
  log(`  ${v ? 'PASS' : 'FAIL'}  ${k}`);
  if (!v) allOk = false;
}
log(`\nOVERALL: ${allOk ? 'PASS' : 'FAIL'}`);
process.exit(allOk ? 0 : 1);
