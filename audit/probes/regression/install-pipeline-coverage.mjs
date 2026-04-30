// Regression probe — install-pipeline coverage.
//
// Asserts that fs.readdirSync sees ALL packages reported by `npm install`,
// not just a subset. Catches the W2.5 bug shape (in-memory children-index
// missing entries while SQL has them — pre-W2.5a, ~37 of 46 packages per
// fastify install were invisible to user code).
//
// Test set: 4 multi-dep packages where the W2.5a fix should turn ⚠️ → ✅:
//   - fastify        (46 deps, 1928 files; pre-W2.5a only 9 visible)
//   - express        (~70 deps; transitive deps were empty pre-W2.5a)
//   - ts-jest        (245 deps; typescript was missing pre-W2.5a)
//   - redis          (7 deps; @redis/client/dist/lib was empty pre-W2.5a)
//
// Per scenario, also checks Mossaic / Wave-1 contracts via /api/stats
// to ensure no unrelated regression.
//
// Output: audit/probes/regression/install-pipeline-coverage.txt
//
// Exit 0 if all packages have at least 1 visible entry under their root;
// non-zero if any expected-package shows readdir.length === 0.

import { runProbe, nodeEvalBase64 } from '../_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'install-pipeline-coverage.txt');

fs.writeFileSync(ARTIFACT, '');
const log = (s) => { fs.appendFileSync(ARTIFACT, s.endsWith('\n') ? s : s + '\n'); console.log(s); };

log('==== INSTALL PIPELINE COVERAGE PROBE ====');
log('==== TIMESTAMP: ' + new Date().toISOString() + ' ====');

const SCENARIOS = [
  {
    label: 'fastify',
    install: 'fastify',
    // Subset of fastify's transitive deps that were empty pre-W2.5a
    mustHaveAtLeastOne: [
      'fastify', 'avvio', 'fastq', 'pino', 'semver', 'fast-json-stringify',
      'rfdc', 'toad-cache', 'secure-json-parse', 'process-warning',
      'find-my-way', 'light-my-request',
      '@fastify/error', '@fastify/ajv-compiler', 'abstract-logging',
    ],
  },
  {
    label: 'express',
    install: 'express',
    mustHaveAtLeastOne: [
      'express', 'get-intrinsic', 'es-object-atoms', 'has-symbols',
      'function-bind', 'mime-types', 'mime-db',
    ],
  },
  {
    label: 'ts-jest',
    install: 'ts-jest jest typescript',
    mustHaveAtLeastOne: [
      'ts-jest', 'jest', 'typescript',
    ],
  },
  {
    label: 'redis',
    install: 'redis',
    mustHaveAtLeastOne: [
      'redis', '@redis/client', '@redis/bloom', 'cluster-key-slot',
    ],
  },
];

const results = [];
let anyFail = false;

for (const sc of SCENARIOS) {
  log('');
  log('--- scenario: ' + sc.label + ' ---');
  log('install: npm install ' + sc.install);

  const probe = `
const fs = require('fs');
const NM = '/home/user/app/node_modules';
function ls(p) { try { return fs.readdirSync(p); } catch { return null; } }
const expected = ${JSON.stringify(sc.mustHaveAtLeastOne)};
const result = {};
for (const n of expected) {
  const e = ls(NM + '/' + n);
  result[n] = e ? e.length : -1;
}
// Single-line marker+payload to defeat supervisor stdout-stream interleaving
// (concurrent console.log calls were arriving in non-deterministic order in
// the artifact, hiding successful coverage maps from the regex parser).
console.log('---COVERAGE-MAP---' + JSON.stringify(result) + '---END-COVERAGE-MAP---');
`;

  const r = await runProbe('cov-' + sc.label, [
    { kind: 'cmd', cmd: 'cd app && npm install ' + sc.install, timeoutMs: 240_000 },
    { kind: 'cmd', cmd: nodeEvalBase64(probe), timeoutMs: 30_000 },
  ], { artifactPath: ARTIFACT, settleMs: 3000 });

  // Extract the result map from the artifact tail (search for the LAST
  // marker — earlier scenarios' maps may still be in the artifact).
  const tail = fs.readFileSync(ARTIFACT, 'utf8').slice(-5000);
  const allMatches = [...tail.matchAll(/---COVERAGE-MAP---(\{.*?\})---END-COVERAGE-MAP---/g)];
  let covMap = null;
  if (allMatches.length > 0) {
    try { covMap = JSON.parse(allMatches[allMatches.length - 1][1]); } catch { /* malformed */ }
  }

  if (!covMap) {
    log('  !! could not parse coverage map; scenario inconclusive');
    results.push({ scenario: sc.label, ok: false, error: 'no coverage-map captured' });
    anyFail = true;
    continue;
  }

  const missing = Object.entries(covMap).filter(([_, v]) => v <= 0).map(([n]) => n);
  if (missing.length === 0) {
    log('  PASS — all ' + sc.mustHaveAtLeastOne.length + ' expected packages visible');
    results.push({ scenario: sc.label, ok: true });
  } else {
    log('  FAIL — missing/empty packages: ' + missing.join(', '));
    log('  full map: ' + JSON.stringify(covMap));
    results.push({ scenario: sc.label, ok: false, missing, covMap });
    anyFail = true;
  }
}

log('');
log('=========================================');
log('SUMMARY:');
let okCount = 0;
for (const r of results) {
  log('  ' + (r.ok ? 'PASS' : 'FAIL') + '  ' + r.scenario + (r.missing ? ' (missing: ' + r.missing.join(', ') + ')' : ''));
  if (r.ok) okCount++;
}
log('=========================================');
log('Overall: ' + okCount + '/' + results.length + ' scenarios pass');
log('==== END PROBE ====');

process.exit(anyFail ? 1 : 0);
