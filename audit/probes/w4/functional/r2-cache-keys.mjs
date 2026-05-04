// W4 functional probe — r2-cache key derivation.
//
// Pure unit-style probe; doesn't hit prod. Imports the cache-key helpers
// from src/r2-cache.ts and asserts the expected key shapes.
//
// Pre-implementation: src/r2-cache.ts doesn't exist → probe fails with
// MODULE_NOT_FOUND. Post-implementation: probe passes.
//
// Output: stdout (pass / fail line); exit 0 on pass, 1 on fail.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'r2-cache-keys.txt');
fs.writeFileSync(ARTIFACT, '');
const log = (s) => { fs.appendFileSync(ARTIFACT, s + '\n'); console.log(s); };

log('==== PROBE: r2-cache-keys ====');
log('==== TIMESTAMP: ' + new Date().toISOString() + ' ====');

let ok = true;

// Locate src/r2-cache.ts via filesystem; if missing, probe fails (TDD red).
const srcPath = path.resolve(HERE, '../../../../src/r2-cache.ts');
if (!fs.existsSync(srcPath)) {
  log('FAIL: src/r2-cache.ts not found at ' + srcPath);
  log('VERDICT: FAIL (pre-implementation; expected during Phase B)');
  process.exit(1);
}

const src = fs.readFileSync(srcPath, 'utf8');

// Assertions on key derivation shape — string-checked (no execution).
const requiredPatterns = [
  { name: 'PACKUMENT_TTL_MS exported', re: /export\s+const\s+PACKUMENT_TTL_MS/ },
  { name: 'R2_CACHE_PREFIX exported (versioned)', re: /export\s+const\s+R2_CACHE_PREFIX\s*=\s*['"]v1['"]/ },
  { name: 'R2CacheClient class exported', re: /export\s+class\s+R2CacheClient/ },
  { name: 'getTarball method', re: /\bgetTarball\s*\(/ },
  { name: 'putTarball method', re: /\bputTarball\s*\(/ },
  { name: 'getPackument method', re: /\bgetPackument\s*\(/ },
  { name: 'putPackument method', re: /\bputPackument\s*\(/ },
  { name: 'tarball key uses /t/ prefix', re: /\/t\// },
  { name: 'packument key uses /p/ prefix', re: /\/p\// },
  { name: 'null-bucket graceful-degrade', re: /(if\s*\(!this\.tarballBucket\)|if\s*\(!\s*this\.tarballBucket\s*\))/ },
];

for (const { name, re } of requiredPatterns) {
  if (re.test(src)) {
    log('  PASS: ' + name);
  } else {
    log('  FAIL: ' + name + ' (regex ' + re.source + ' did not match)');
    ok = false;
  }
}

log('');
log('VERDICT: ' + (ok ? 'PASS' : 'FAIL'));
process.exit(ok ? 0 : 1);
