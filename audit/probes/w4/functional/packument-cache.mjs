// W4 functional probe — packument R2 cache wired into resolver-facet.
//
// Source-only assertions:
//   1. SupervisorRPC exposes getCachedPackument / putCachedPackument
//   2. npm-resolve-facet.ts references env.SUPERVISOR.getCachedPackument
//      with the pipelined race shape (Promise.race vs setTimeout cap)
//
// Pre-implementation: missing → fail.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'packument-cache.txt');
fs.writeFileSync(ARTIFACT, '');
const log = (s) => { fs.appendFileSync(ARTIFACT, s + '\n'); console.log(s); };

log('==== PROBE: packument-cache ====');
log('==== TIMESTAMP: ' + new Date().toISOString() + ' ====');

const supRpcPath = path.resolve(HERE, '../../../../src/supervisor-rpc.ts');
const facetPath = path.resolve(HERE, '../../../../src/npm-resolve-facet.ts');

let ok = true;
const failIfMissing = (p) => {
  if (!fs.existsSync(p)) { log('FAIL: missing ' + p); ok = false; return null; }
  return fs.readFileSync(p, 'utf8');
};

const supRpc = failIfMissing(supRpcPath);
const facet = failIfMissing(facetPath);
if (!supRpc || !facet) {
  log('VERDICT: FAIL');
  process.exit(1);
}

const checks = [
  { src: supRpc, name: 'SupervisorRPC.getCachedPackument', re: /async\s+getCachedPackument\s*\(/ },
  { src: supRpc, name: 'SupervisorRPC.putCachedPackument', re: /async\s+putCachedPackument\s*\(/ },
  { src: supRpc, name: 'getCachedPackument reads NPM_PACKUMENT_CACHE binding', re: /NPM_PACKUMENT_CACHE/ },
  { src: facet, name: 'resolve-facet calls getCachedPackument', re: /env\.SUPERVISOR\.getCachedPackument|SUPERVISOR\.getCachedPackument/ },
  { src: facet, name: 'resolve-facet has soft-fail (typeof check)', re: /typeof\s+(env\.)?SUPERVISOR\s*\.\s*getCachedPackument\s*===\s*['"]function['"]/ },
  { src: facet, name: 'resolve-facet uses Promise.race with timeout cap', re: /Promise\.race\s*\(/ },
];

for (const c of checks) {
  if (c.re.test(c.src)) log('  PASS: ' + c.name);
  else { log('  FAIL: ' + c.name); ok = false; }
}

log('');
log('VERDICT: ' + (ok ? 'PASS' : 'FAIL'));
process.exit(ok ? 0 : 1);
