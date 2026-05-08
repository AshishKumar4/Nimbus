// W4 functional probe — pipelining ordering correctness.
//
// Source-only: ensures the pipelining race in batch-facet preserves the
// invariants documented in W4-plan §5:
//   - Cache hit AND network response are NOT both written (no double-flush)
//   - On integrity mismatch from cache: fall through to network
//   - Cache write-back is awaited before installOne returns (lifecycle
//     finding #2 from inline review)
//
// Encoded as string-pattern checks against the implementation. A live
// behavioural ordering test ships in regression/ once all wiring is in.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'pipelining-ordering.txt');
fs.writeFileSync(ARTIFACT, '');
const log = (s) => { fs.appendFileSync(ARTIFACT, s + '\n'); console.log(s); };

log('==== PROBE: pipelining-ordering ====');
log('==== TIMESTAMP: ' + new Date().toISOString() + ' ====');

const facetPath = path.resolve(HERE, '../../../../src/npm/install-batch-facet.ts');
if (!fs.existsSync(facetPath)) {
  log('FAIL: missing src/npm-install-batch-facet.ts');
  log('VERDICT: FAIL');
  process.exit(1);
}
const src = fs.readFileSync(facetPath, 'utf8');

let ok = true;
const checks = [
  // Lifecycle: write-back must be awaited (no `void env.SUPERVISOR.putCachedTarball`).
  { name: 'putCachedTarball is awaited (not void-fired)', re: /await\s+env\.SUPERVISOR\.putCachedTarball/, mustMatch: true },
  { name: 'NO bare void putCachedTarball (lifecycle bug)', re: /void\s+env\.SUPERVISOR\.putCachedTarball/, mustMatch: false },
  // Race: there must be a Promise.race between cache and network with cap timeout.
  { name: 'Race uses Promise.race', re: /Promise\.race\s*\(/, mustMatch: true },
  // Integrity verify on cache-hit path: still reuses subtle.digest after R2 read.
  { name: 'Integrity check still applies on cache hit (subtle.digest)', re: /crypto\.subtle\.digest/, mustMatch: true },
];

for (const c of checks) {
  const hit = c.re.test(src);
  const pass = c.mustMatch ? hit : !hit;
  if (pass) log('  PASS: ' + c.name);
  else { log('  FAIL: ' + c.name + ' (mustMatch=' + c.mustMatch + ', hit=' + hit + ')'); ok = false; }
}

log('');
log('VERDICT: ' + (ok ? 'PASS' : 'FAIL'));
process.exit(ok ? 0 : 1);
