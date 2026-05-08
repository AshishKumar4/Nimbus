// W4 functional probe — manual cache invalidation surface.
//
// Asserts r2-cache.ts exposes a delete() / purge() shape AND that
// supervisor-rpc.ts has a corresponding admin/management method
// (or that the cache prefix bump pattern is documented).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'r2-cache-invalidate.txt');
fs.writeFileSync(ARTIFACT, '');
const log = (s) => { fs.appendFileSync(ARTIFACT, s + '\n'); console.log(s); };

log('==== PROBE: r2-cache-invalidate ====');
log('==== TIMESTAMP: ' + new Date().toISOString() + ' ====');

const cachePath = path.resolve(HERE, '../../../../src/npm/r2-cache.ts');
if (!fs.existsSync(cachePath)) {
  log('FAIL: src/r2-cache.ts missing (pre-implementation)');
  log('VERDICT: FAIL');
  process.exit(1);
}

const src = fs.readFileSync(cachePath, 'utf8');
let ok = true;
const checks = [
  // We accept ANY one of: explicit deleteTarball/deletePackument, OR a versioned
  // prefix constant that supports atomic invalidation by prefix bump.
  { name: 'delete OR prefix-version invalidation surface', re: /(deleteTarball|deletePackument|R2_CACHE_PREFIX\s*=\s*['"]v\d+['"]|delete\s*\()/ },
  { name: 'invalidation rationale in JSDoc', re: /invalidat|TTL|prefix.*bump|stale/i },
];
for (const c of checks) {
  if (c.re.test(src)) log('  PASS: ' + c.name);
  else { log('  FAIL: ' + c.name); ok = false; }
}

log('');
log('VERDICT: ' + (ok ? 'PASS' : 'FAIL'));
process.exit(ok ? 0 : 1);
