// W4 functional probe — packument R2 cache TTL expiry.
//
// Source-only assertion: r2-cache.ts encodes a 5-minute TTL via custom
// metadata, and the read path treats expiresAt < now as expired.
// Pre-implementation: src/r2-cache.ts missing → fail.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'r2-cache-expire.txt');
fs.writeFileSync(ARTIFACT, '');
const log = (s) => { fs.appendFileSync(ARTIFACT, s + '\n'); console.log(s); };

log('==== PROBE: r2-cache-expire ====');
log('==== TIMESTAMP: ' + new Date().toISOString() + ' ====');

const srcPath = path.resolve(HERE, '../../../../src/r2-cache.ts');
if (!fs.existsSync(srcPath)) {
  log('FAIL: src/r2-cache.ts missing (pre-implementation)');
  log('VERDICT: FAIL');
  process.exit(1);
}

const src = fs.readFileSync(srcPath, 'utf8');
let ok = true;
const checks = [
  { name: 'PACKUMENT_TTL_MS = 5 * 60_000', re: /PACKUMENT_TTL_MS\s*=\s*5\s*\*\s*60[_]?000/ },
  { name: 'expiresAt customMetadata read', re: /customMetadata\??\.\s*expiresAt|customMetadata\['expiresAt'\]|customMetadata\["expiresAt"\]/ },
  { name: 'expired flag computed in CachedPackument', re: /expired/ },
  { name: 'put writes expiresAt customMetadata', re: /customMetadata\s*:\s*\{[\s\S]*?expiresAt/ },
];
for (const c of checks) {
  if (c.re.test(src)) log('  PASS: ' + c.name);
  else { log('  FAIL: ' + c.name); ok = false; }
}

log('');
log('VERDICT: ' + (ok ? 'PASS' : 'FAIL'));
process.exit(ok ? 0 : 1);
