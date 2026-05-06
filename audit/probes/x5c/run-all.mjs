#!/usr/bin/env bun
// X.5-C run-all — execute every probe and roll up results.
//
// Usage: bun audit/probes/x5c/run-all.mjs

import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const PROBES = [
  ['functional/f1-import-walker.mjs',     'walker recurses through ESM import / export-from'],
  ['functional/f2-hash-chunk-greedy.mjs', 'greedyAddMainEntries pulls hash-chunk siblings'],
  ['functional/f3-cycle-safe.mjs',        'mutual ESM imports terminate cleanly'],
  ['regression/r1-single-resolver-source.mjs',  'single resolver impl invariant'],
  ['regression/r2-w35-fixes-still-green.mjs',   'W3.5 integration shim still PASS'],
  ['regression/r3-install-pipeline-coverage.mjs', 'W3-class CJS packages still load'],
  ['regression/r4-prefetch-bound-cap.mjs',      'prefetch caps fire on huge trees'],
  ['e2e/e1-react-remove-scroll.mjs',  'react-remove-scroll loads end-to-end'],
  ['e2e/e2-pathe-via-nuxt.mjs',       'pathe transitive chunk through deep ESM'],
  ['e2e/e3-radix-react-dialog.mjs',   'radix-dialog + sibling cluster'],
];

let passed = 0, failed = 0;
const results = [];

for (const [rel, desc] of PROBES) {
  const probe = path.join(HERE, rel);
  process.stdout.write(`\n══ ${rel}\n   ${desc}\n`);
  let exit = 0, out = '';
  try {
    out = execSync(`bun ${probe}`, { encoding: 'utf8', timeout: 90000 });
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
