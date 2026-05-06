#!/usr/bin/env bun
// X.5-L run-all — execute every probe and roll up results.
//
// Usage: bun audit/probes/x5l/run-all.mjs

import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const PROBES = [
  ['functional/f1-bare-subpath-walker.mjs',         'walker resolves bare-spec legacy directory subpath'],
  ['functional/f2-bare-subpath-with-exports.mjs',   'modern exports map still works'],
  ['functional/f3-bare-subpath-fallback-index.mjs', 'directory-with-index.js fallback still works'],
  ['functional/f4-bare-subpath-up-pointing.mjs',    'up-pointing nested-pkg main normalizes correctly'],
  ['regression/r1-single-resolver-source.mjs',      'single resolver impl invariant'],
  ['regression/r2-install-pipeline-coverage.mjs',   'W3-class CJS packages still load'],
  ['regression/r3-x5c-fixes-still-green.mjs',       'X.5-C suite still PASS'],
  ['e2e/e1-react-remove-scroll-real.mjs',           'react-remove-scroll loads end-to-end (real files)'],
  ['e2e/e2-radix-react-dialog-real.mjs',            'radix-react-dialog loads end-to-end (real files)'],
  ['e2e/e3-nuxt-defu-investigation.mjs',            'defu chain isolation (bonus / nuxt root-cause check)'],
];

let passed = 0, failed = 0;
const results = [];

for (const [rel, desc] of PROBES) {
  const probe = path.join(HERE, rel);
  process.stdout.write(`\n══ ${rel}\n   ${desc}\n`);
  let exit = 0, out = '';
  try {
    out = execSync(`bun ${probe}`, { encoding: 'utf8', timeout: 240_000 });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
    exit = e.status || 1;
  }
  process.stdout.write(out);
  if (exit === 0) { passed++; results.push({ probe: rel, status: '✓' }); }
  else { failed++; results.push({ probe: rel, status: '✗', exit }); }
}

console.log('');
console.log('══════════════════════════════════════════════════════════════');
console.log(`  ${passed} pass / ${failed} fail / ${PROBES.length} total`);
console.log('══════════════════════════════════════════════════════════════');
for (const r of results) {
  console.log(`  ${r.status}  ${r.probe}${r.exit ? ' (exit=' + r.exit + ')' : ''}`);
}

const SUMMARY = path.join(HERE, '_results', 'run-all.json');
fs.mkdirSync(path.dirname(SUMMARY), { recursive: true });
fs.writeFileSync(SUMMARY, JSON.stringify({ passed, failed, total: PROBES.length, results }, null, 2));

process.exit(failed > 0 ? 1 : 0);
