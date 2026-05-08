// W4 functional probe — tarball R2 cache wired into install-batch-facet.
//
// Source-only assertions:
//   1. SupervisorRPC exposes getCachedTarball / putCachedTarball
//   2. npm-install-batch-facet.ts references env.SUPERVISOR.getCachedTarball
//      with race shape and write-back captured tgz bytes
//
// Pre-implementation: fail.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'tarball-cache.txt');
fs.writeFileSync(ARTIFACT, '');
const log = (s) => { fs.appendFileSync(ARTIFACT, s + '\n'); console.log(s); };

log('==== PROBE: tarball-cache ====');
log('==== TIMESTAMP: ' + new Date().toISOString() + ' ====');

const supRpcPath = path.resolve(HERE, '../../../../src/session/supervisor-rpc.ts');
const facetPath = path.resolve(HERE, '../../../../src/npm/install-batch-facet.ts');

let ok = true;
const need = (p) => fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : (log('FAIL: missing ' + p), ok = false, null);

const supRpc = need(supRpcPath);
const facet = need(facetPath);
if (!supRpc || !facet) { log('VERDICT: FAIL'); process.exit(1); }

const checks = [
  { src: supRpc, name: 'SupervisorRPC.getCachedTarball', re: /async\s+getCachedTarball\s*\(/ },
  { src: supRpc, name: 'SupervisorRPC.putCachedTarball', re: /async\s+putCachedTarball\s*\(/ },
  { src: supRpc, name: 'getCachedTarball reads NPM_TARBALL_CACHE binding', re: /NPM_TARBALL_CACHE/ },
  { src: facet, name: 'batch-facet calls getCachedTarball', re: /env\.SUPERVISOR\.getCachedTarball|SUPERVISOR\.getCachedTarball/ },
  { src: facet, name: 'batch-facet soft-fail typeof check', re: /typeof\s+(env\.)?SUPERVISOR\s*\.\s*getCachedTarball\s*===\s*['"]function['"]/ },
  { src: facet, name: 'batch-facet captures compressed bytes for putCachedTarball', re: /putCachedTarball\s*\(/ },
  { src: facet, name: 'batch-facet uses Promise.race for cache vs network', re: /Promise\.race\s*\(/ },
];

for (const c of checks) {
  if (c.re.test(c.src)) log('  PASS: ' + c.name);
  else { log('  FAIL: ' + c.name); ok = false; }
}

log('');
log('VERDICT: ' + (ok ? 'PASS' : 'FAIL'));
process.exit(ok ? 0 : 1);
